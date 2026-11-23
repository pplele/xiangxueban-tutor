import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { parseInput } from '../lib/validate';
import { logger } from '../lib/logger';
import { ask, createSession, getSessionMessages, listSessions, summarizeSession } from '../services/chat';

const subjectEnum = z.enum(['math', 'english', 'cs']);

const createSessionSchema = z.object({
  subject: subjectEnum,
  title: z.string().max(100).optional(),
});

const askSchema = z.object({
  sessionId: z.string().uuid(),
  content: z.string().min(1).max(4000),
  /** 做题页小窗：当前正在做的题目 / 变式，用于把题目上下文注入 Prompt */
  questionId: z.string().min(1).max(100).optional(),
  variantId: z.number().int().positive().optional().nullable(),
  studentAnswer: z.string().max(2000).optional(),
});

/**
 * 答疑会话路由注册：会话管理 / SSE 流式问答 / 非流式问答 / 会话总结
 */
export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /** POST /chat/sessions - 新建答疑会话（科目、标题），返回会话信息（201）；鉴权：需登录 */
  app.post('/chat/sessions', async (request, reply) => {
    const body = parseInput(createSessionSchema, request.body);
    const session = await createSession(body.subject, body.title);
    return reply.code(201).send(session);
  });

  /** GET /chat/sessions - 按科目列出当前用户的答疑会话；鉴权：需登录 */
  app.get('/chat/sessions', async (request) => {
    const query = parseInput(z.object({ subject: subjectEnum.optional() }), request.query);
    return { sessions: await listSessions(query.subject) };
  });

  /** GET /chat/sessions/:id/messages - 读取指定会话的完整消息历史；鉴权：需登录 */
  app.get('/chat/sessions/:id/messages', async (request) => {
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    return getSessionMessages(params.id);
  });

  /**
   * POST /chat/ask - SSE 流式答疑：hijack 原始响应，经 data: 事件逐段推送回答，
   * 支持心跳保活、客户端断连中止（AbortController），结束时发 done/error；鉴权：需登录
   */
  app.post('/chat/ask', async (request, reply) => {
    const body = parseInput(askSchema, request.body);

    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no');
    // reply.hijack() 会跳过 @fastify/cors 的 onSend 钩子，SSE 必须手动补 CORS 头，
    // 否则浏览器会拦截流式响应（预检通过但实际响应无 Access-Control-Allow-Origin）。
    const origin = request.headers.origin;
    if (origin && (env.corsOrigins.includes('*') || env.corsOrigins.includes(origin))) {
      raw.setHeader('Access-Control-Allow-Origin', origin);
      raw.setHeader('Vary', 'Origin');
      raw.setHeader('Access-Control-Allow-Credentials', 'true');
      raw.setHeader('Access-Control-Expose-Headers', 'Content-Type');
    }
    raw.flushHeaders?.();

    const send = (payload: unknown) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const controller = new AbortController();
    let finished = false;
    reply.raw.on('close', () => {
      if (!finished) {
        controller.abort();
        logger.info({ event: 'chat.client_closed' }, '[chat] client disconnected');
      }
    });

    const ping = setInterval(() => {
      if (!raw.writableEnded) raw.write(': ping\n\n');
    }, 15_000);

    send({ type: 'start', sessionId: body.sessionId, timestamp: new Date().toISOString() });

    try {
      const result = await ask({
        sessionId: body.sessionId,
        content: body.content,
        focus: {
          questionId: body.questionId,
          variantId: body.variantId ?? null,
          studentAnswer: body.studentAnswer,
        },
        signal: controller.signal,
        emit: (event) => send(event),
      });
      finished = true;
      send({
        type: 'done',
        messageId: result.messageId,
        citations: result.citations,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      finished = true;
      const isApp = err instanceof AppError;
      const message = isApp
        ? err.message
        : controller.signal.aborted
          ? '请求已取消'
          : '模型服务暂不可用，请稍后重试';
      const code = isApp ? err.code : controller.signal.aborted ? 'ABORTED' : 'LLM_UNAVAILABLE';
      logger.error(
        { event: 'chat.error', code, err: (err as Error).message, aborted: controller.signal.aborted },
        '[chat] ask failed',
      );
      send({ type: 'error', code, message });
    } finally {
      clearInterval(ping);
      if (!raw.writableEnded) raw.end();
    }
    return reply;
  });

  /**
   * POST /chat/summarize - 结束答疑时把整段对话压成「备注要点」。
   * 只读会话、不写消息，学生可以反复调用（改口再总结一次）。鉴权：需登录
   */
  app.post('/chat/summarize', async (request) => {
    const body = parseInput(z.object({ sessionId: z.string().uuid() }), request.body);
    return summarizeSession(body.sessionId);
  });

  /**
   * POST /chat/ask-sync - 非流式问答：小程序端 wx.request 的 enableChunked 解析 SSE 不稳定，
   * 小程序统一走这个接口，一次拿到完整回答与引用；网页端仍用上面的 SSE 接口。鉴权：需登录
   */
  app.post('/chat/ask-sync', async (request) => {
    const body = parseInput(askSchema, request.body);
    const result = await ask({
      sessionId: body.sessionId,
      content: body.content,
      focus: {
        questionId: body.questionId,
        variantId: body.variantId ?? null,
        studentAnswer: body.studentAnswer,
      },
      // 非流式接口：agent 内部强制要求 emit，这里给空实现丢弃中间事件
      emit: () => {},
    });
    return {
      messageId: result.messageId,
      content: result.content,
      citations: result.citations,
    };
  });
}
