import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../config/env';

/** 全局 PostgreSQL 连接池，连接串来自 DATABASE_URL */
export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'tutor-system',
});

pool.on('error', (err) => {
  // 空闲连接异常不应导致进程退出
  // eslint-disable-next-line no-console
  console.error('[pg] idle client error:', err.message);
});

/**
 * 执行 SQL 并返回原始 QueryResult（含 rowCount 等元信息）。
 * @param text SQL 语句（支持 $1 占位符）
 * @param params 参数数组
 * @returns pg 的查询结果
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as any[]);
}

/**
 * 执行 SQL 并返回全部结果行。
 * @param text SQL 语句
 * @param params 参数数组
 * @returns 结果行数组，无数据时为空数组
 */
export async function many<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows;
}

/**
 * 执行 SQL 并返回首行结果。
 * @param text SQL 语句
 * @param params 参数数组
 * @returns 首行数据，无数据时返回 null
 */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await pool.query<T>(text, params as any[]);
  return res.rows[0] ?? null;
}

/**
 * 在单个连接上执行事务：BEGIN → fn → COMMIT，异常时 ROLLBACK 并释放连接。
 * @param fn 接收事务客户端的回调，内部的所有查询都走该 client
 * @returns 回调的返回值
 * @throws 透传回调或提交过程中的异常（已回滚）
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 数据库连通性探测，执行 SELECT 1。
 * @throws 连接失败时抛出异常
 */
export async function checkDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

/**
 * 关闭全局连接池（停机时调用，释放所有连接）。
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
