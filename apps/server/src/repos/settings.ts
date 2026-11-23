import { pool, withTransaction } from '../db/pool';

/**
 * 从 app_settings 表一次性读回全部键值配置（量小，几十条），转为 key → value 对象。
 * @returns 全部配置项映射
 */
export async function getAll(): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ key: string; value: string }>('SELECT key, value FROM app_settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * 批量写入 app_settings 表配置：在单个事务内逐条 upsert（按 key 冲突则更新 value）。
 * @param values 待写入的键值映射；空对象直接返回
 */
export async function setMany(values: Record<string, string>): Promise<void> {
  const keys = Object.keys(values);
  if (keys.length === 0) return;
  await withTransaction(async (client) => {
    for (const key of keys) {
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, values[key]],
      );
    }
  });
}
