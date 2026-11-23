import fs from 'node:fs';
import path from 'node:path';
import { pool } from './pool';

/**
 * 在若干候选路径中定位 migrations 目录。
 * @returns 找到的目录绝对路径
 * @throws 所有候选都不存在时抛错
 */
export function findMigrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'migrations'),
    path.resolve(__dirname, '../../migrations'),
    path.resolve(__dirname, '../../../migrations'),
    path.resolve(__dirname, '../../../../apps/server/migrations'),
  ];
  const found = candidates.find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  if (!found) throw new Error('找不到 migrations 目录');
  return found;
}

/**
 * 列出待应用的迁移脚本（.sql，排除 .down.sql），按文件名排序。
 * @returns 迁移文件名数组
 */
function listMigrations(): string[] {
  const dir = findMigrationsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

/**
 * 确保 schema_migrations 记录表存在（副作用：建表）。
 */
async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 应用所有未执行的迁移脚本（副作用：按文件事务执行 SQL 并记录版本）。
 * @returns 本次新应用的迁移文件名数组
 * @throws 单个迁移失败时回滚该文件并抛错
 */
export async function migrateUp(): Promise<string[]> {
  await ensureTable();
  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
  );
  const dir = findMigrationsDir();
  const newly: string[] = [];
  for (const file of listMigrations()) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newly.push(file);
      // eslint-disable-next-line no-console
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  if (newly.length === 0) console.log('[migrate] 数据库已是最新版本');
  return newly;
}

/**
 * 回滚最近一次迁移：执行对应 .down.sql 并删除版本记录（副作用：改数据库）。
 * @returns 被回滚的迁移版本名；无可回滚项时返回 null
 * @throws 缺少回滚脚本或执行失败时抛错（已回滚）
 */
export async function migrateDown(): Promise<string | null> {
  await ensureTable();
  const last = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  const version = last.rows[0]?.version;
  if (!version) {
    console.log('[migrate] 没有可回滚的迁移');
    return null;
  }
  const dir = findMigrationsDir();
  const downFile = path.join(dir, version.replace(/\.sql$/, '.down.sql'));
  if (!fs.existsSync(downFile)) throw new Error(`缺少回滚脚本：${path.basename(downFile)}`);
  const sql = fs.readFileSync(downFile, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    await client.query('COMMIT');
    console.log(`[migrate] rolled back ${version}`);
    return version;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 查询已应用迁移的状态列表（读数据库）。
 * @returns 按版本排序的 { version, appliedAt(ISO 字符串) } 数组
 */
export async function migrationStatus(): Promise<{ version: string; appliedAt: string }[]> {
  await ensureTable();
  const res = await pool.query<{ version: string; applied_at: Date }>(
    'SELECT version, applied_at FROM schema_migrations ORDER BY version',
  );
  return res.rows.map((r) => ({ version: r.version, appliedAt: r.applied_at.toISOString() }));
}
