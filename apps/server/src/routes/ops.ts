import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { offlineOpSchema } from '@flil/shared';
import { getDb, newId, nowIso } from '../db.js';
import { config } from '../config.js';
import { ah, ok } from '../http/respond.js';
import { authenticate, requireOwner } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { errors } from '../http/errors.js';
import { createBackup, exportAll, listBackups, restoreBackup } from '../services/backup.js';
import { addTags, createInspiration, requireInspiration } from '../services/inspirations.js';
import { subscribe } from '../services/events.js';
import { recomputeHitRate } from '../services/calibration.js';
import { toJson } from '../db.js';

export const opsRouter = Router();

/** 健康检查：不需要登录，用于运维与冒烟脚本 */
opsRouter.get(
  '/health',
  ah(async (_req, res) => {
    const db = getDb();
    let dbOk = true;
    try {
      db.prepare('SELECT 1 AS x').get();
    } catch {
      dbOk = false;
    }
    const dirs = Object.fromEntries(
      Object.entries({
        uploads: config.uploadDir,
        thumbs: config.thumbDir,
        share: config.shareDir,
        backups: config.backupDir,
      }).map(([k, dir]) => {
        try {
          fs.accessSync(dir, fs.constants.W_OK);
          return [k, 'ok'];
        } catch {
          return [k, 'unwritable'];
        }
      }),
    );

    ok(res, {
      ok: dbOk && Object.values(dirs).every((v) => v === 'ok'),
      db: dbOk ? 'ok' : 'error',
      dirs,
      weatherProvider: config.weatherProvider,
      weatherDegraded: config.weatherProvider === 'off',
      shareEnabled: config.enableShare,
      version: '1.0.0',
      time: nowIso(),
    });
  }),
);

/**
 * 注意：Router.use() 对「所有经过该 router 的请求」生效，
 * 所以这里必须显式放过公开路径，否则后面的公开分享路由永远收不到请求。
 */
opsRouter.use((req, res, next) => {
  if (req.path.startsWith('/share/')) return next();
  return authenticate()(req, res, next);
});

/** 图片与数据库一致性巡检：找出缺失文件与孤儿记录 */
opsRouter.get(
  '/health/verify-assets',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const rows = getDb().prepare('SELECT id, file_path, thumb_path FROM asset WHERE library_id = ?').all(
      ctx.libraryId,
    ) as { id: string; file_path: string; thumb_path: string | null }[];
    const missing = rows.filter((r) => !fs.existsSync(r.file_path)).map((r) => r.id);
    const missingThumbs = rows.filter((r) => r.thumb_path && !fs.existsSync(r.thumb_path)).map((r) => r.id);
    ok(res, { total: rows.length, missing, missingThumbs });
  }),
);

opsRouter.post(
  '/backup',
  ah(async (_req, res) => {
    const info = await createBackup();
    ok(res, info, 201);
  }),
);

opsRouter.get(
  '/backup/list',
  ah(async (_req, res) => {
    ok(res, { items: listBackups() });
  }),
);

opsRouter.post(
  '/backup/restore',
  ah(async (req, res) => {
    requireOwner(req);
    const input = z.object({ name: z.string().min(1), confirm: z.boolean() }).parse(req.body);
    const result = await restoreBackup(input.name, input.confirm);
    ok(res, {
      ...result,
      note: '还原已完成，读写已立即恢复；还原前状态已自动备份为安全备份，可用其回滚。',
    });
  }),
);

opsRouter.get(
  '/export/inspirations.json',
  ah(async (req, res) => {
    requireOwner(req);
    const ctx = ctxOf(req);
    const data = exportAll(ctx.libraryId);
    res.setHeader('content-disposition', 'attachment; filename="inspirations-export.json"');
    res.setHeader('content-type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  }),
);

/**
 * 离线补录：client_op_id 唯一约束保证幂等。
 * 重复提交返回 200 与原结果（OFFLINE_OP_DUPLICATE 属于幂等成功，不是错误）。
 */
opsRouter.post(
  '/offline/apply',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = offlineOpSchema.parse(req.body);
    const db = getDb();

    const existing = db
      .prepare('SELECT * FROM offline_op WHERE client_op_id = ?')
      .get(input.clientOpId) as Record<string, unknown> | undefined;
    if (existing) {
      return ok(res, {
        duplicate: true,
        code: 'OFFLINE_OP_DUPLICATE',
        result: existing.result ? JSON.parse(existing.result as string) : null,
      });
    }

    let result: Record<string, unknown> = {};
    if (input.opType === 'create_inspiration') {
      const payload = z.object({ title: z.string().min(1).max(200), note: z.string().max(5000).nullable().optional() }).parse(
        input.payload,
      );
      const id = createInspiration({
        libraryId: ctx.libraryId,
        title: payload.title,
        note: payload.note ?? null,
      });
      result = { inspirationId: id };
    } else if (input.opType === 'tag') {
      const payload = z
        .object({ inspirationId: z.string().min(1), addTagIds: z.array(z.string()).default([]) })
        .parse(input.payload);
      requireInspiration(payload.inspirationId, ctx.libraryId);
      const added = addTags(payload.inspirationId, payload.addTagIds, 'bulk');
      result = { inspirationId: payload.inspirationId, added };
    } else if (input.opType === 'fill_result') {
      const payload = z
        .object({
          planId: z.string().min(1),
          hitLevel: z.enum(['hit', 'partial', 'miss']),
          missReasons: z.array(z.string()).default([]),
        })
        .parse(input.payload);
      const plan = db
        .prepare('SELECT * FROM shoot_plan WHERE id = ? AND library_id = ?')
        .get(payload.planId, ctx.libraryId) as Record<string, unknown> | undefined;
      if (!plan) throw errors.notFound('计划');
      const exists = db.prepare('SELECT id FROM shoot_result WHERE plan_id = ?').get(payload.planId);
      if (!exists) {
        db.prepare(
          `INSERT INTO shoot_result (id, library_id, plan_id, inspiration_id, hit_level, miss_reasons, filled_at, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(
          newId(),
          ctx.libraryId,
          payload.planId,
          plan.inspiration_id as string,
          payload.hitLevel,
          toJson(payload.missReasons),
          nowIso(),
          nowIso(),
        );
        db.prepare("UPDATE shoot_plan SET status = 'done', updated_at = ? WHERE id = ?").run(nowIso(), payload.planId);
        recomputeHitRate(plan.inspiration_id as string);
      }
      result = { planId: payload.planId, applied: true };
    } else {
      const payload = z.object({ inspirationId: z.string().min(1), note: z.string().max(5000) }).parse(input.payload);
      requireInspiration(payload.inspirationId, ctx.libraryId);
      db.prepare('UPDATE inspiration SET note = ?, updated_at = ? WHERE id = ?').run(
        payload.note,
        nowIso(),
        payload.inspirationId,
      );
      result = { inspirationId: payload.inspirationId, updated: true };
    }

    db.prepare(
      'INSERT INTO offline_op (id, library_id, client_op_id, op_type, payload, result, applied_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      newId(),
      ctx.libraryId,
      input.clientOpId,
      input.opType,
      toJson(input.payload),
      toJson(result),
      nowIso(),
      nowIso(),
    );

    ok(res, { duplicate: false, result }, 201);
  }),
);

/** SSE：图片处理完成、窗口判定变化、提醒状态变化 */
opsRouter.get('/events/stream', (req, res) => {
  const ctx = ctxOf(req);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ libraryId: ctx.libraryId })}\n\n`);
  const unsubscribe = subscribe(ctx.libraryId, res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});
