import { env } from '../config/env';
import { logger } from '../lib/logger';
import { AppError, unauthorized } from '../lib/errors';
import { randomToken, sha256Hex, timingSafeEqualStr } from '../lib/crypto';
import * as authRepo from '../repos/auth';

/**
 * 校验账号密码：与环境变量中的凭据做定时安全比较，失败即抛 401。
 * @param username 用户名
 * @param password 明文密码
 */
export function verifyCredentials(username: string, password: string): void {
  const okUser = timingSafeEqualStr(username, env.authUsername);
  const okPass = timingSafeEqualStr(password, env.authPassword);
  if (!okUser || !okPass) throw unauthorized('用户名或密码错误');
}

/**
 * 签发 refresh token：生成随机令牌，仅将其 SHA-256 哈希入库（TTL 由环境配置），明文返回给客户端。
 * @param username 用户名
 * @returns 明文 refresh token、过期时间与有效天数
 */
export async function issueRefreshToken(username: string): Promise<{
  refreshToken: string;
  expiresAt: Date;
  ttlDays: number;
}> {
  const raw = randomToken(48);
  const ttlDays = env.refreshTokenTtlDays;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  await authRepo.storeToken(sha256Hex(raw), username, expiresAt);
  return { refreshToken: raw, expiresAt, ttlDays };
}

/**
 * 轮换 refresh token：校验旧令牌有效后撤销，再签发新令牌（防重放）。
 * @param rawToken 客户端提交的明文 refresh token
 * @returns 新的 refresh token 及对应用户名、过期信息
 */
export async function rotateRefreshToken(rawToken: string): Promise<{ refreshToken: string; username: string; expiresAt: Date; ttlDays: number }> {
  if (!rawToken) throw unauthorized('缺少 refresh token');
  const hash = sha256Hex(rawToken);
  const found = await authRepo.findValidToken(hash);
  if (!found) throw unauthorized('登录已过期，请重新登录');
  await authRepo.revokeToken(hash);
  const next = await issueRefreshToken(found.username);
  logger.info({ event: 'auth.refresh' }, 'refresh token rotated');
  return { ...next, username: found.username };
}

/** 撤销单个 refresh token（按明文哈希定位），空令牌直接忽略。 */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  if (!rawToken) return;
  await authRepo.revokeToken(sha256Hex(rawToken));
}

/** 撤销指定用户的全部 refresh token。 */
export async function revokeAll(username: string): Promise<void> {
  await authRepo.revokeAllForUser(username);
}

/**
 * 断言用户名为系统账号，否则抛 403（单账号系统的越权防护）。
 * @param username 待校验的用户名
 */
export function assertUsername(username: string): void {
  if (!timingSafeEqualStr(username, env.authUsername)) {
    throw new AppError(403, 'FORBIDDEN', '账号不匹配');
  }
}
