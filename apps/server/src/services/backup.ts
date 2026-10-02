import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb, nowIso } from '../db.js';
import { config } from '../config.js';
import { ApiError, errors } from '../http/errors.js';
import { logger } from '../logger.js';

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 备份目录名必须唯一：同一秒内的安全备份不得覆盖同名旧备份（否则回滚目标会被悄悄改写） */
function uniqueBackupName(): string {
  let name = stamp();
  let suffix = 1;
  while (fs.existsSync(path.join(config.backupDir, name))) {
    suffix += 1;
    name = `${stamp()}-${suffix}`;
  }
  return name;
}

export interface BackupInfo {
  name: string;
  path: string;
  createdAt: string;
  bytes: number;
}

function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

/** 备份 = SQLite 快照（WAL 安全）+ 图片目录拷贝 */
export async function createBackup(): Promise<BackupInfo> {
  const name = uniqueBackupName();
  const target = path.join(config.backupDir, name);
  fs.mkdirSync(target, { recursive: true });

  await getDb().backup(path.join(target, 'app.db'));

  for (const [sub, dir] of Object.entries({
    uploads: config.uploadDir,
    thumbs: config.thumbDir,
    share: config.shareDir,
  })) {
    if (fs.existsSync(dir)) fs.cpSync(dir, path.join(target, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(target, 'manifest.json'),
    JSON.stringify({ createdAt: nowIso(), version: 1, dirs: ['uploads', 'thumbs', 'share'] }, null, 2),
  );

  pruneBackups();
  return { name, path: target, createdAt: nowIso(), bytes: dirSize(target) };
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs
    .readdirSync(config.backupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(config.backupDir, e.name);
      return {
        name: e.name,
        path: full,
        createdAt: fs.statSync(full).birthtime.toISOString(),
        bytes: dirSize(full),
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function pruneBackups(): void {
  for (const old of listBackups().slice(config.backupKeep)) {
    fs.rmSync(old.path, { recursive: true, force: true });
  }
}

/**
 * 用 sourceDir 里的快照覆盖当前库文件与图片目录。
 * 调用前必须已 closeDb()：SQLite 连接关闭后才能安全替换库文件。
 */
function swapIn(sourceDir: string): void {
  // 清掉旧库的 WAL/SHM 残留，避免旧日志被重放到新换入的快照上造成损坏
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(config.databaseFile + suffix, { force: true });
  }
  fs.copyFileSync(path.join(sourceDir, 'app.db'), config.databaseFile);
  for (const [sub, dir] of Object.entries({
    uploads: config.uploadDir,
    thumbs: config.thumbDir,
    share: config.shareDir,
  })) {
    const from = path.join(sourceDir, sub);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(from, dir, { recursive: true });
  }
}

/** 换库后立即重开连接并验证新库可读 —— 还原结束时不允许停留在「连接已关闭」状态 */
function reopenAndVerify(): void {
  getDb().prepare('SELECT count(*) AS n FROM sqlite_master').get();
}

/**
 * 还原：**先把当前状态自动备份一份（安全回滚路径）**，再覆盖；需 confirm=true 二次确认。
 * 无论成功还是失败，返回前连接都已重开，读写立即可用；
 * 失败时自动回滚到安全备份，并通过错误详情告知回滚目标。
 */
export async function restoreBackup(name: string, confirm: boolean): Promise<{ safetyBackup: string }> {
  if (!confirm) throw errors.badRequest('还原是破坏性操作，需要 confirm=true 二次确认');
  const source = path.join(config.backupDir, name);
  if (!fs.existsSync(source)) throw errors.notFound('备份');
  if (!fs.existsSync(path.join(source, 'app.db'))) {
    throw errors.badRequest('该备份缺少 app.db 快照，无法还原');
  }

  const safety = await createBackup();

  closeDb();
  try {
    swapIn(source);
    reopenAndVerify();
  } catch (cause) {
    // 失败回滚：换回安全备份并重开连接，服务不得停留在失败后的关闭状态
    try {
      closeDb();
      swapIn(safety.path);
      reopenAndVerify();
    } catch (rollbackErr) {
      // 回滚本身异常也不能让服务死掉：getDb() 会在下次请求时按当前库文件自愈
      logger.error('还原失败且回滚异常，连接将在下次请求时自愈', { error: String(rollbackErr) });
    }
    throw new ApiError('RESTORE_FAILED_ROLLED_BACK', 500, '还原失败，已自动回滚到还原前的安全备份', {
      safetyBackup: safety.name,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return { safetyBackup: safety.name };
}

/** 全量导出（含精确坐标，仅 owner，用于数据自持；文档 13.3 允许） */
export function exportAll(libraryId: string): Record<string, unknown> {
  const db = getDb();
  const tables = [
    'inspiration',
    'asset',
    'tag',
    'inspiration_tag',
    'composition_note',
    'timing',
    'repro_window',
    'reminder',
    'shoot_plan',
    'shoot_result',
    'calibration_log',
    'album',
    'album_item',
    'album_gap',
    'album_snapshot',
    'share_link',
    'place',
    'spot',
  ];
  const out: Record<string, unknown> = { exportedAt: nowIso(), libraryId };
  for (const table of tables) {
    const hasLibrary = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === 'library_id',
    );
    out[table] = hasLibrary
      ? db.prepare(`SELECT * FROM ${table} WHERE library_id = ?`).all(libraryId)
      : db.prepare(`SELECT * FROM ${table}`).all();
  }
  return out;
}
