import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'token',
      'accessToken',
      'refreshToken',
      'apiKey',
      'password',
      '*.apiKey',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    /**
     * 精简并脱敏请求日志字段，仅保留方法、URL 与请求 ID。
     * @param req 原始请求对象（只读取 method/url/id）
     * @returns 序列化后的日志对象
     */
    req(req: { method?: string; url?: string; id?: string }) {
      return { method: req.method, url: req.url, requestId: req.id };
    },
    err: pino.stdSerializers.err,
  },
  transport: env.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
});
