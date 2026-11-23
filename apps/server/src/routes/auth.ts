import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { parseInput } from '../lib/validate';
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken, verifyCredentials } from '../services/auth';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10).max(500),
});

/**
 * 签发 access token（JWT，sub=用户名、typ=access，按环境配置设置过期时间）
 * @param app Fastify 实例，用于调用 jwt.sign
 * @param username 用户名，写入 sub 声明
 * @returns 签名后的 access token 字符串
 */
function accessToken(app: FastifyInstance, username: string): string {
  return app.jwt.sign({ sub: username, typ: 'access' }, { expiresIn: env.jwtExpiresIn });
}

/**
 * 认证路由注册：登录 / 刷新令牌 / 登出
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /auth/login - 账号密码登录：校验凭据，签发 access + refresh token
   * 鉴权：公开接口（auth:false），限流 10 次/分钟
   */
  app.post(
    '/auth/login',
    {
      config: {
        auth: false,
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request) => {
      const body = parseInput(loginSchema, request.body);
      verifyCredentials(body.username, body.password);
      const refresh = await issueRefreshToken(body.username);
      request.log.info({ event: 'auth.login' }, 'login success');
      return {
        accessToken: accessToken(app, body.username),
        refreshToken: refresh.refreshToken,
        expiresIn: env.jwtExpiresIn,
        tokenType: 'Bearer',
        user: { username: body.username },
      };
    },
  );

  /** POST /auth/refresh - 刷新令牌：用 refresh token 轮换出新的 access + refresh token；鉴权：公开（auth:false） */
  app.post('/auth/refresh', { config: { auth: false } }, async (request) => {
    const body = parseInput(refreshSchema, request.body);
    const rotated = await rotateRefreshToken(body.refreshToken);
    return {
      accessToken: accessToken(app, rotated.username),
      refreshToken: rotated.refreshToken,
      expiresIn: env.jwtExpiresIn,
      tokenType: 'Bearer',
      user: { username: rotated.username },
    };
  });

  /** POST /auth/logout - 登出：若带 refreshToken 则撤销该刷新令牌；鉴权：需登录 */
  app.post('/auth/logout', async (request) => {
    const body = parseInput(z.object({ refreshToken: z.string().max(500).optional() }), request.body ?? {});
    if (body.refreshToken) await revokeRefreshToken(body.refreshToken);
    return { ok: true };
  });
}
