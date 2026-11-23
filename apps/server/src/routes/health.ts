import type { FastifyInstance } from 'fastify';
import { checkDatabase } from '../db/pool';
import { env } from '../config/env';

/** 只暴露模型名与协议层，不暴露 key / 完整地址，方便确认当前接的是哪家 */
function safeBase(url: string): string {
  // 有些网关把 token 塞在 query 里，这里一并去掉
  return url.split('?')[0]
}

/** 汇总当前接入的各通道模型信息（仅模型名/协议层，不含密钥与完整地址） */
function modelInfo() {
  return {
    llm: {
      base: safeBase(env.llm.baseUrl),
      model: env.llm.model,
      fallback: env.llm.fallbackModel || null,
    },
    embedding: {
      base: safeBase(env.embedding.baseUrl),
      model: env.embedding.model,
      dim: env.embedding.dim,
    },
    vision: { model: env.vision.model },
    rerank: env.rerank.enabled && env.rerank.baseUrl ? env.rerank.model : 'disabled',
  };
}

/**
 * 健康检查路由注册：存活探针 / 就绪探针
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** GET /health - 存活探针：返回运行状态、运行时长与模型信息；鉴权：公开（auth:false） */
  app.get('/health', { config: { auth: false } }, async () => ({
    status: 'ok',
    service: 'tutor-system',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    models: modelInfo(),
  }));

  /** GET /ready - 就绪探针：检查数据库连接，失败返回 503；鉴权：公开（auth:false） */
  app.get('/ready', { config: { auth: false } }, async (request, reply) => {
    try {
      await checkDatabase();
      return { status: 'ready', db: 'ok', timestamp: new Date().toISOString() };
    } catch (err) {
      request.log.error({ err: (err as Error).message }, '[health] database not ready');
      return reply.code(503).send({
        error: { code: 'NOT_READY', message: '数据库连接不可用' },
      });
    }
  });
}
