import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closeDb, getDb, migrate, nowIso } from '../db.js';
import { config } from '../config.js';
import { ApiError, errors } from '../http/errors.js';

/** 受还原/备份管理的三个素材目录 */
const managedDirs: Record<string, string> = {
  uploads: config.uploadDir,
  thumbs: config.thumbDir,
  share: config.shareDir,
};

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 生成**不与现有备份冲突**的目录名。
 * 时间戳只到秒，同一秒内连续备份（典型：还原时自动建安全备份）必须避免
 * 落到同名目录而把源备份静默覆盖。
 */
function uniqueBackupName(): string {
  const base = stamp();
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(config.backupDir, name))) {
    name = `${base}-${i++}`;
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

/**
 * 备份 = SQLite 快照（WAL 安全）+ 图片目录拷贝。
 * skipPrune 供「还原时自动建安全备份」使用：还原源是最老一份备份且正好达到
 * 保留上限时，普通清理会把它删掉导致还原中途失败，此时跳过清理。
 */
export async function createBackup(skipPrune = false): Promise<BackupInfo> {
  const name = uniqueBackupName();
  const target = path.join(config.backupDir, name);
  fs.mkdirSync(target, { recursive: true });

  await getDb().backup(path.join(target, 'app.db'));

  for (const [sub, dir] of Object.entries(managedDirs)) {
    if (fs.existsSync(dir)) fs.cpSync(dir, path.join(target, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(target, 'manifest.json'),
    JSON.stringify({ createdAt: nowIso(), version: 1, dirs: ['uploads', 'thumbs', 'share'] }, null, 2),
  );

  if (!skipPrune) pruneBackups();
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

/** 还原是否正在进行：串行化，拒绝并发还原（破坏性操作不允许交错） */
let restoreInProgress = false;

/** 备份内容是否可用：在动活库**之前**校验，坏备份直接 400，服务不受影响 */
function assertSourceUsable(source: string): void {
  const sourceDb = path.join(source, 'app.db');
  if (!fs.existsSync(sourceDb)) throw errors.badRequest('备份缺少 app.db，无法还原');
  let probe: Database.Database | null = null;
  try {
    probe = new Database(sourceDb, { readonly: true, fileMustExist: true });
    const row = probe.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    if (!row || Object.values(row)[0] !== 'ok') {
      throw errors.badRequest('备份数据库完整性校验失败（quick_check 非 ok），拒绝还原');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw errors.badRequest('备份数据库无法打开，可能已损坏');
  } finally {
    probe?.close();
  }
}

/** 用备份快照的内容同步素材目录；from 不存在时得到空目录 */
function syncDirFrom(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
  else fs.mkdirSync(to, { recursive: true });
}

/**
 * 关闭旧句柄 → 用快照原子替换主库 → 重新打开并补齐迁移。
 *
 * 关键：必须先删掉旧主库**连同旧的 -wal/-shm**，再落新主库文件。
 * 若新主库文件就位时旁边还留着旧 -wal，SQLite 会按该文件重放旧页
 * （WAL salt 对不上也可能被当作恢复内容），导致已还原的数据“复活”/错乱。
 */
function restartWithDbFile(snapshotDb: string): void {
  closeDb();
  // 先落临时主库，再把旧主库及其 -wal/-shm 一并删掉，最后原子改名就位。
  // 顺序不能反：新主库就位时若旁边残留旧 -wal，重开后 SQLite 会重放旧页。
  const tmp = `${config.databaseFile}.restore-tmp`;
  fs.copyFileSync(snapshotDb, tmp);
  for (const target of [config.databaseFile, `${config.databaseFile}-wal`, `${config.databaseFile}-shm`]) {
    fs.rmSync(target, { force: true });
  }
  fs.renameSync(tmp, config.databaseFile);
  getDb();
  migrate();
}

/** 把数据库与素材目录恢复到指定备份，并确保服务重新可读可写 */
function applySnapshot(snapshotDir: string): void {
  restartWithDbFile(path.join(snapshotDir, 'app.db'));
  for (const [sub, dir] of Object.entries(managedDirs)) {
    syncDirFrom(path.join(snapshotDir, sub), dir);
  }
}

/**
 * 还原：**先把当前状态完整备份一份（安全回滚路径）**，再原子替换。
 *
 * 保证：
 * 1. 还原成功后立即关闭旧句柄并重新 getDb() + migrate()，服务立刻恢复读写，
 *    不会继续持有「已关闭的连接」。
 * 2. 任一步骤失败 → 自动回滚到还原前的安全备份，并同样重新打开库，服务不中断。
 * 3. 并发还原返回 409。
 */
export async function restoreBackup(name: string, confirm: boolean): Promise<{ safetyBackup: string }> {
  if (!confirm) throw errors.badRequest('还原是破坏性操作，需要 confirm=true 二次确认');
  const source = path.join(config.backupDir, name);
  if (!fs.existsSync(source)) throw errors.notFound('备份');
  assertSourceUsable(source);

  if (restoreInProgress) {
    throw new ApiError('RESTORE_IN_PROGRESS', 409, '已有还原任务正在进行，请等待其完成后再试');
  }
  restoreInProgress = true;
  let safety: BackupInfo | null = null;
  try {
    // 先做完整安全备份（动任何破坏性操作之前），这是失败后的回滚来源。
    // 跳过自动清理，避免恰好达到保留上限时把本次还原源（最老一份）删掉。
    safety = await createBackup(true);

    applySnapshot(source);
    return { safetyBackup: safety.name };
  } catch (err) {
    // 自动回滚到失败前状态，并保证库被重新打开（服务始终可用）
    const safetyName = safety?.name;
    if (safety && fs.existsSync(path.join(safety.path, 'app.db'))) {
      try {
        applySnapshot(safety.path);
      } catch (rollbackErr) {
        throw new ApiError(
          'RESTORE_AND_ROLLBACK_FAILED',
          500,
          `还原失败且自动回滚也失败：${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}；` +
            `请手动用安全备份 ${safetyName} 还原`,
          { safetyBackup: safetyName ?? null },
        );
      }
    } else {
      // 安全备份都没建成（库尚未被改动）：确保句柄仍可用
      closeDb();
      getDb();
      migrate();
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      'RESTORE_FAILED_ROLLED_BACK',
      500,
      `还原失败，已自动回滚到还原前的安全备份${safetyName ? `（${safetyName}）` : ''}：${detail}`,
      { safetyBackup: safetyName ?? null, cause: detail },
    );
  } finally {
    restoreInProgress = false;
  }
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
