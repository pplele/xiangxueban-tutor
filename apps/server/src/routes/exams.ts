import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, unauthorized } from '../lib/errors';
import { parseInput } from '../lib/validate';
import {
  autosaveAnswers,
  deleteExamPaper,
  generateExam,
  getExamPaper,
  listExams,
  loadBlueprint,
  submitExam,
} from '../services/exam';
import { saveExamUpload, uploadFilePath } from '../services/examUpload';
import * as examRepo from '../repos/exams';
import * as variantRepo from '../repos/variants';

const subjectEnum = z.enum(['math', 'english', 'cs']);

const generateSchema = z.object({
  subject: subjectEnum.default('math'),
  /** mock=模拟考试（全考纲）；chapter=章节考试（range 必填） */
  mode: z.enum(['mock', 'chapter']).default('mock'),
  range: z.array(z.string().max(100)).max(50).optional(),
});

const submitSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1).max(100),
        answer: z.string().max(5000).optional(),
        selfRating: z.enum(['self_pass', 'self_partial', 'self_fail']).optional().nullable(),
      }),
    )
    .max(100),
});

const autosaveSchema = z.object({
  answers: z
    .record(
      z.string().min(1).max(100),
      z.object({
        answer: z.string().max(5000).optional(),
        selfRating: z.enum(['self_pass', 'self_partial', 'self_fail']).optional().nullable(),
      }),
    )
    .refine((v) => Object.keys(v).length <= 100, { message: '作答条目过多' }),
});

const uploadSchema = z.object({
  section: z.enum(['blank', 'solve']),
  questionNo: z.number().int().min(1).max(100).optional().nullable(),
  image: z.string().min(32),
});

/**
 * 模拟考试路由注册：组卷 / 试卷查询 / 作答与自动保存 / 答题卡上传 / 交卷判分
 */
export async function examRoutes(app: FastifyInstance): Promise<void> {
  /** POST /exams/generate - 按科目与模式（mock 全考纲 / chapter 章节）组卷，返回试卷（201）；鉴权：需登录 */
  app.post('/exams/generate', async (request, reply) => {
    const body = parseInput(generateSchema, request.body ?? {});
    const paper = await generateExam({
      subject: body.subject,
      mode: body.mode,
      range: body.range ?? null,
    });
    return reply.code(201).send(paper);
  });

  /** GET /exams - 历史试卷列表：默认最多 200 套，只返回列表所需字段；鉴权：需登录 */
  app.get('/exams', async (request) => {
    const query = parseInput(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }),
      request.query ?? {},
    );
    return listExams(query.limit);
  });

  /** GET /exams/blueprint - 按科目读取考试蓝图（题型/分值/章节分布配置）；鉴权：需登录 */
  app.get('/exams/blueprint', async (request) => {
    const query = parseInput(z.object({ subject: subjectEnum.default('math') }), request.query ?? {});
    return loadBlueprint(query.subject);
  });

  /** GET /exams/pool - 出题池统计：原题/变式各有多少未考过；鉴权：需登录 */
  app.get('/exams/pool', async (request) => {
    const query = parseInput(z.object({ subject: subjectEnum.default('math') }), request.query ?? {});
    return examRepo.poolStats(query.subject);
  });

  /** POST /exams/pool/reset - 重置考过标记：出题池从零开始；鉴权：需登录 */
  app.post('/exams/pool/reset', async (request) => {
    const body = parseInput(z.object({ subject: subjectEnum.default('math') }), request.body ?? {});
    const cleared = await variantRepo.clearExamUsed(body.subject);
    return { cleared };
  });

  /** GET /exams/:id - 读取指定试卷详情（题目、作答状态）；鉴权：需登录 */
  app.get('/exams/:id', async (request) => {
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    const paper = await getExamPaper(params.id);
    if (!paper) throw notFound('模拟卷不存在');
    return paper;
  });

  /** DELETE /exams/:id - 手动删除试卷（连带清理该卷答题卡照片），返回 204；鉴权：需登录 */
  app.delete('/exams/:id', async (request, reply) => {
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    await deleteExamPaper(params.id);
    return reply.code(204).send();
  });

  /** PUT /exams/:id/answers - 自动保存作答（前端边做边存，到点强制交卷时以此为准）；鉴权：需登录 */
  app.put('/exams/:id/answers', async (request) => {
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    const body = parseInput(autosaveSchema, request.body ?? {});
    await autosaveAnswers(params.id, body.answers);
    return { ok: true };
  });

  /** POST /exams/:id/uploads - 答题卡照片上传：填空区一张多题 / 解答题一题一张（201）；鉴权：需登录 */
  app.post('/exams/:id/uploads', async (request, reply) => {
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    const body = parseInput(uploadSchema, request.body);
    const result = await saveExamUpload(params.id, {
      section: body.section,
      questionNo: body.questionNo ?? null,
      image: body.image,
    });
    return reply.code(201).send(result);
  });

  /**
   * GET /exams/:id/uploads/:file - 答题卡照片读取：<img> 带不了 header，走 ?token= 鉴权（与课程视频流一致）
   * 鉴权：路由标记 auth:false，但在处理器内手动校验 access token
   */
  app.get('/exams/:id/uploads/:file', { config: { auth: false } }, async (request, reply) => {
    const params = parseInput(
      z.object({ id: z.string().uuid(), file: z.string().min(1).max(64) }),
      request.params,
    );
    const token = String((request.query as Record<string, unknown>).token ?? '');
    try {
      const payload = app.jwt.verify(token) as { typ?: string };
      if (payload.typ !== 'access') throw new Error('wrong token type');
    } catch {
      throw unauthorized('登录已过期，请刷新页面重新进入');
    }
    let full: string;
    try {
      full = uploadFilePath(params.id, params.file);
    } catch {
      throw notFound('照片不存在');
    }
    if (!fs.existsSync(full)) throw notFound('照片不存在');
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=86400')
      .send(fs.createReadStream(full));
  });

  /** POST /exams/:id/submit - 交卷：提交整卷答案，触发判分、画像更新与错题沉淀；鉴权：需登录 */
  app.post('/exams/:id/submit', async (request) => {
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    const body = parseInput(submitSchema, request.body);
    return submitExam(params.id, body.answers);
  });
}
