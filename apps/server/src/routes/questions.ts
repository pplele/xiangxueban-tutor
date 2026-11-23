import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../lib/errors';
import { parseInput } from '../lib/validate';
import { getQuestionDetail, importCards, parseImportContent } from '../services/wrongbook';
import { enqueueMany } from '../services/queue';
import * as questionRepo from '../repos/questions';

const subjectEnum = z.enum(['math', 'english', 'cs']);

const importSchema = z.object({
  content: z.string().min(2).max(1_500_000),
  subject: subjectEnum.default('math'),
  force: z.boolean().default(false),
});

const listSchema = z.object({
  subject: subjectEnum.optional(),
  chapter: z.string().max(100).optional(),
  status: z.string().max(40).optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

/**
 * 错题库路由注册：批量导入 / 列表统计 / 详情 / 变式 / 备注更新
 */
export async function questionRoutes(app: FastifyInstance): Promise<void> {
  /** POST /questions/import - 解析导入文本为卡片并入库（force 可覆盖），新题自动入队生成变式；鉴权：需登录 */
  app.post('/questions/import', async (request) => {
    const body = parseInput(importSchema, request.body);
    const cards = parseImportContent(body.content, body.subject);
    const result = await importCards(cards, {
      subject: body.subject,
      force: body.force,
      source: 'import',
      migrateRelations: true,
    });
    const enqueued = await enqueueMany(result.imported.filter((x) => x.action === 'created').map((x) => x.id));
    return {
      ...result,
      enqueued,
      enqueuedCount: enqueued.filter((e) => e.enqueued).length,
      parsedCount: cards.length,
    };
  });

  /** GET /questions - 分页查询题目列表（按科目/章节/状态/关键词过滤）；鉴权：需登录 */
  app.get('/questions', async (request) => {
    const query = parseInput(listSchema, request.query);
    const { items, total } = await questionRepo.listQuestions({
      subject: query.subject,
      chapter: query.chapter,
      status: query.status,
      search: query.search,
      page: query.page,
      pageSize: query.pageSize,
    });
    return { items, total, page: query.page, pageSize: query.pageSize };
  });

  /** GET /questions/stats - 按科目统计题目数量分布；鉴权：需登录 */
  app.get('/questions/stats', async (request) => {
    const query = parseInput(z.object({ subject: subjectEnum.default('math') }), request.query);
    return questionRepo.stats(query.subject);
  });

  /** GET /questions/:id - 读取错题详情（题目本体 + 变式 + 变式组 + 作答记录），不存在返回 404；鉴权：需登录 */
  app.get('/questions/:id', async (request) => {
    const params = parseInput(z.object({ id: z.string().min(1).max(100) }), request.params);
    const detail = await getQuestionDetail(params.id);
    if (!detail) throw notFound('错题不存在');
    return {
      ...detail.question,
      variants: detail.variants,
      variantSets: detail.variantSets,
      attempts: detail.attempts,
    };
  });

  /** PATCH /questions/:id/note - 更新错题备注，不存在返回 404；鉴权：需登录 */
  app.patch('/questions/:id/note', async (request) => {
    const params = parseInput(z.object({ id: z.string().min(1).max(100) }), request.params);
    const body = parseInput(z.object({ note: z.string().max(5000) }), request.body);
    const updated = await questionRepo.updateNote(params.id, body.note);
    if (!updated) throw notFound('错题不存在');
    return updated;
  });

  /** GET /questions/:id/variants - 读取指定错题的变式与变式组列表，不存在返回 404；鉴权：需登录 */
  app.get('/questions/:id/variants', async (request) => {
    const params = parseInput(z.object({ id: z.string().min(1).max(100) }), request.params);
    const detail = await getQuestionDetail(params.id);
    if (!detail) throw notFound('错题不存在');
    return { variants: detail.variants, variantSets: detail.variantSets };
  });
}
