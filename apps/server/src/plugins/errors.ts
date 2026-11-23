import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/**
 * 注册全局错误处理器与 404 处理器（副作用：改写 app 的错误响应行为）。
 * 将 AppError、ZodError、Fastify 4xx、常见 pg 错误映射为统一 { error: {...} } 响应结构。
 * @param app Fastify 实例
 */
export function registerErrorHandler(app: FastifyInstance): void {
  // 统一错误响应：5xx 记 error 日志、4xx 记 info 日志，未知错误归为 500
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        logger.error({ requestId, code: error.code, err: error.message }, '[http] app error');
      } else {
        logger.info({ requestId, code: error.code, err: error.message }, '[http] client error');
      }
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }

    if (error instanceof ZodError) {
      const details: Record<string, string> = {};
      for (const issue of error.issues) details[issue.path.join('.') || '_'] = issue.message;
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: '请求参数不合法', details },
      });
    }

    if ((error as any)?.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: '请求参数不合法' },
      });
    }

    // Fastify 自身的 4xx（如请求体不是合法 JSON、请求体过大）
    const fastifyStatus = (error as any)?.statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      const messageMap: Record<number, string> = {
        400: '请求格式不正确（请检查 JSON 是否合法）',
        413: '请求体过大',
        415: '不支持的 Content-Type',
        429: '请求过于频繁，请稍后再试',
      };
      return reply.code(fastifyStatus).send({
        error: { code: 'BAD_REQUEST', message: messageMap[fastifyStatus] ?? '请求不合法' },
      });
    }

    const pg = error as PgError;
    if (pg.code === '23505') {
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: '数据已存在，请勿重复提交' },
      });
    }
    if (pg.code === '23503') {
      return reply.code(400).send({
        error: { code: 'REFERENCE_ERROR', message: '关联数据不存在或已被删除' },
      });
    }
    if (pg.code === '22P02' || pg.code === '22007' || pg.code === '22003') {
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '请求参数格式不正确' },
      });
    }

    const unknownError = error as Error & { stack?: string };
    logger.error(
      { requestId, err: error, message: unknownError.message, stack: unknownError.stack },
      '[http] unhandled error',
    );
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误，请稍后重试' },
    });
  });

  // 未匹配路由统一返回 404 NOT_FOUND，回显请求方法与路径
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `接口不存在：${request.method} ${request.url.split('?')[0]}` },
    });
  });
}
