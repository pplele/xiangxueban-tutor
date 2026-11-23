import { many, one, query } from '../db/pool';

/**
 * 向 refresh_tokens 表写入一条刷新令牌（存哈希，不存明文）。
 * @param tokenHash 令牌哈希
 * @param username 所属用户名
 * @param expiresAt 过期时间
 */
export async function storeToken(tokenHash: string, username: string, expiresAt: Date): Promise<void> {
  await query(
    `INSERT INTO refresh_tokens (token_hash, username, expires_at) VALUES ($1,$2,$3)`,
    [tokenHash, username, expiresAt],
  );
}

/**
 * 从 refresh_tokens 表查找未撤销且未过期的令牌；用于校验刷新令牌是否有效。
 * @param tokenHash 令牌哈希
 * @returns 令牌 id 与用户名，无匹配返回 null
 */
export async function findValidToken(tokenHash: string): Promise<{ id: string; username: string } | null> {
  return one<{ id: string; username: string }>(
    `SELECT id, username FROM refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
}

/**
 * 撤销 refresh_tokens 表中指定令牌（幂等：只更新尚未撤销的记录）。
 * @param tokenHash 令牌哈希
 */
export async function revokeToken(tokenHash: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    tokenHash,
  ]);
}

/**
 * 撤销某用户 refresh_tokens 表中全部未撤销的令牌（如改密/登出所有设备）。
 * @param username 用户名
 */
export async function revokeAllForUser(username: string): Promise<void> {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE username = $1 AND revoked_at IS NULL`, [
    username,
  ]);
}

/**
 * 清理 refresh_tokens 表中已过期超过一天的令牌（保留 1 天缓冲便于审计）。
 * @returns 被删除的令牌数量
 */
export async function cleanupExpired(): Promise<number> {
  const rows = await many<{ id: string }>(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day' RETURNING id`,
  );
  return rows.length;
}
