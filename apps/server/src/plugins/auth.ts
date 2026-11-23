import type { FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors';

export interface AuthUser {
  sub: string;
  typ: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: boolean;
  }
}

/**
 * Fastify preHandler 鉴权钩子：除显式标记 auth:false 的路由外均要求 JWT 有效。
 * @param request 当前请求对象
 * @throws JWT 校验失败时抛出 401 UNAUTHORIZED
 */
export async function authHook(request: FastifyRequest): Promise<void> {
  const config = request.routeOptions?.config as { auth?: boolean } | undefined;
  if (config?.auth === false) return;
  try {
    await request.jwtVerify();
  } catch {
    throw unauthorized();
  }
}
