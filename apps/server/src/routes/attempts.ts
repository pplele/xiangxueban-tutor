import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { submitAttempt } from '../services/attempt';

/**
 * 作答路由注册：提交单题作答
 */
export async function attemptRoutes(app: FastifyInstance): Promise<void> {
  /** POST /attempts - 提交一道题的作答（练习/考试、自评），触发判分与画像更新，返回判分结果（201）；鉴权：需登录 */
  app.post('/attempts', async (request, reply) => {
    const body = parseInput(
      z.object({
        questionId: z.string().min(1).max(100),
        variantId: z.number().int().positive().optional().nullable(),
        answer: z.string().max(5000).optional().default(''),
        source: z.enum(['practice', 'exam']).default('practice'),
        selfRating: z.enum(['self_pass', 'self_partial', 'self_fail']).optional().nullable(),
      }),
      request.body,
    );
    const result = await submitAttempt({
      questionId: body.questionId,
      variantId: body.variantId ?? null,
      answer: body.answer,
      source: body.source,
      selfRating: body.selfRating ?? null,
    });
    return reply.code(201).send(result);
  });
}
