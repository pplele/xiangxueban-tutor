import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { notFound } from '../lib/errors';
import { REVIEW_STATUSES } from '@tutor/shared';
import {
  deleteWord,
  groupStats,
  importWords,
  isValidGroup,
  listWords,
  markWord,
  resetGroup,
} from '../repos/reviewWords';
import { recognizeReviewWords } from '../services/reviewOcr';

const groupKeySchema = z.string().min(1).max(60).refine(isValidGroup, '不合法的复习单词分类');
const statusSchema = z.enum(REVIEW_STATUSES as [string, ...string[]]);

const listSchema = z.object({ group: groupKeySchema });

const ocrSchema = z.object({
  /** 图片 base64，允许带 data:image/...;base64, 前缀 */
  image: z.string().min(100).max(3 * 1024 * 1024),
});

const importSchema = z.object({
  group: groupKeySchema,
  items: z
    .array(
      z.object({
        term: z.string().trim().min(1).max(120),
        meaning: z.string().trim().max(200).optional(),
        kind: z.enum(['word', 'phrase']).optional(),
      }),
    )
    .min(1)
    .max(600),
});

const markSchema = z.object({
  wordId: z.number().int().positive(),
  status: statusSchema,
});

const resetSchema = z.object({ group: groupKeySchema });
const idSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * 复习单词路由：分块统计 / 词条列表 / 照片识别 / 导入 / 状态标记 / 重置 / 删除
 */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  /** GET /vocab/review/groups - 全部小块统计（词数与灰绿黄红数量）；鉴权：需登录 */
  app.get('/vocab/review/groups', async (request) => {
    return { groups: await groupStats(request.user.sub) };
  });

  /** GET /vocab/review/words?group= - 某小块词条（含当前用户状态）；鉴权：需登录 */
  app.get('/vocab/review/words', async (request) => {
    const { group } = parseInput(listSchema, request.query ?? {});
    return { words: await listWords(request.user.sub, group) };
  });

  /** POST /vocab/review/ocr - 照片识别手写词表，返回待确认词条（不落库）；鉴权：需登录 */
  app.post('/vocab/review/ocr', async (request) => {
    const { image } = parseInput(ocrSchema, request.body);
    return { items: await recognizeReviewWords(image) };
  });

  /** POST /vocab/review/import - 确认导入词条（全部初始为灰色，同块去重，归当前账号）；鉴权：需登录 */
  app.post('/vocab/review/import', async (request) => {
    const { group, items } = parseInput(importSchema, request.body);
    const inserted = await importWords(request.user.sub, group, items);
    return { ok: true, inserted };
  });

  /** POST /vocab/review/mark - 标记一个词条的掌握状态；鉴权：需登录 */
  app.post('/vocab/review/mark', async (request) => {
    const { wordId, status } = parseInput(markSchema, request.body);
    const ok = await markWord(request.user.sub, wordId, status as 'gray' | 'green' | 'yellow' | 'red');
    if (!ok) throw notFound('词条不存在');
    return { ok: true };
  });

  /** POST /vocab/review/reset - 重置某小块为全灰（重新开始第一轮）；鉴权：需登录 */
  app.post('/vocab/review/reset', async (request) => {
    const { group } = parseInput(resetSchema, request.body);
    const reset = await resetGroup(request.user.sub, group);
    return { ok: true, reset };
  });

  /** DELETE /vocab/review/words/:id - 删除一条个人上传词条（内置教材词不可删）；鉴权：需登录 */
  app.delete('/vocab/review/words/:id', async (request) => {
    const { id } = parseInput(idSchema, request.params);
    const ok = await deleteWord(request.user.sub, id);
    if (!ok) throw notFound('词条不存在，或为内置教材词不可删除');
    return { ok: true };
  });
}
