import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { env } from './config/env';
import { logger } from './lib/logger';
import { authHook } from './plugins/auth';
import { registerErrorHandler } from './plugins/errors';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { subjectRoutes } from './routes/subjects';
import { chatRoutes } from './routes/chat';
import { captureRoutes } from './routes/capture';
import { questionRoutes } from './routes/questions';
import { variantRoutes } from './routes/variants';
import { attemptRoutes } from './routes/attempts';
import { profileRoutes } from './routes/profile';
import { examRoutes } from './routes/exams';
import { evalRoutes } from './routes/eval';
import { vocabRoutes } from './routes/vocab';
import { reviewRoutes } from './routes/review';
import { lessonRoutes } from './routes/lessons';
import { settingsRoutes } from './routes/settings';
import { noteRoutes } from './routes/notes';
import { prefsRoutes } from './routes/prefs';

/**
 * 构建并配置 Fastify 应用实例：日志脱敏、CORS、安全头、限流、JWT、错误处理与全部路由。
 * /api 前缀下的路由统一挂 authHook 鉴权；根路径提供健康检查探针。
 * @returns 已完成插件注册的 Fastify 实例（尚未 listen）
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.logLevel,
      base: undefined,
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'token', 'refreshToken', 'apiKey', 'password'],
        censor: '[REDACTED]',
      },
      // <img>/<video> 流的 token 挂在 URL 上，redact 只清 body/headers，不会动 req.url
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url.replace(/([?&]token=)[^&]+/i, '$1[REDACTED]'),
          hostname: request.hostname,
          remoteAddress: request.ip,
        }),
      },
      ...(env.isProd
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
            },
          }),
    },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    disableRequestLogging: false,
  });

  app.server.requestTimeout = 0;
  app.server.headersTimeout = 65_000;
  app.server.keepAliveTimeout = 72_000;

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Type'],
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: {
        code: 'RATE_LIMITED',
        message: `请求过于频繁，请在 ${Math.ceil(Number(context.ttl) / 1000)} 秒后重试`,
      },
    }),
  });

  await app.register(jwt, { secret: env.jwtSecret });

  registerErrorHandler(app);

  // 存活/就绪探针放在根路径，便于运维直接访问
  await app.register(healthRoutes);

  await app.register(
    async (api) => {
      api.addHook('preHandler', authHook);
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(subjectRoutes);
      await api.register(chatRoutes);
      await api.register(captureRoutes);
      await api.register(questionRoutes);
      await api.register(variantRoutes);
      await api.register(attemptRoutes);
      await api.register(profileRoutes);
      await api.register(examRoutes);
      await api.register(evalRoutes);
      await api.register(vocabRoutes);
      await api.register(reviewRoutes);
      await api.register(lessonRoutes);
      await api.register(settingsRoutes);
      await api.register(noteRoutes);
      await api.register(prefsRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
