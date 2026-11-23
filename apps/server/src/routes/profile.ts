import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { getProfile, patchProfile, refreshNarratives, resetExamData, vocabSnapshot } from '../services/profile';

const patchSchema = z.object({
  labels: z
    .record(z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(100)).max(30)]))
    .optional(),
});

const refreshSchema = z.object({
  subjects: z.array(z.enum(['math', 'english'])).min(1).max(2).optional(),
});

/**
 * 学习画像路由注册：画像读写 / 词汇概况 / 叙述刷新 / 数据重置
 */
export async function profileRoutes(app: FastifyInstance): Promise<void> {
  /** GET /profile - 读取当前学生学习画像（含目标分、掌握度、叙述等）；鉴权：需登录 */
  app.get('/profile', async () => getProfile());

  /** GET /profile/vocab-snapshot - 英语词汇评价用的单词测试概况（来自 /vocab 记录）；鉴权：需登录 */
  app.get('/profile/vocab-snapshot', async (request) => vocabSnapshot(request.user.sub));

  /** PATCH /profile - 局部更新画像自定义标签（labels）；鉴权：需登录 */
  app.patch('/profile', async (request) => {
    const body = parseInput(patchSchema, request.body);
    return patchProfile(body);
  });

  /** POST /profile/refresh - 刷新指定科目（默认数学+英语）的画像叙述文本；鉴权：需登录 */
  app.post('/profile/refresh', async (request) => {
    const body = parseInput(refreshSchema, request.body ?? {});
    return refreshNarratives(body.subjects ?? ['math', 'english'], request.user.sub);
  });

  /** POST /profile/reset - 清除考试数据（测试用 / 用户主动重置）：只保留目标分与自评；鉴权：需登录 */
  app.post('/profile/reset', async () => resetExamData());
}
