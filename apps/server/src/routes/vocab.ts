import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { badRequest, notFound, unauthorized } from '../lib/errors';
import { getBoard, listRounds, roundDetail, submitRound, teacherOverview } from '../services/vocab';
import { listCourse, resolveCourseFile } from '../services/course';
import {
  createEssay,
  deleteEssay,
  getEssay,
  listEssays,
  updateEssay,
} from '../repos/essays';
import {
  createCustom,
  deleteCustom,
  listCards,
  resetProgress,
  stats as collocationStats,
  upsertProgress,
} from '../repos/collocations';
import {
  checkinAllStories,
  checkinStory,
  createStory,
  deleteStory,
  listStories,
  uncheckinStory,
  updateStory,
} from '../repos/stories';

const stateEnum = z.enum(['green', 'yellow', 'red']);

const submitSchema = z.object({
  // 只提交本轮点过的词也可以，没提交的按红色算
  states: z
    .array(z.object({ wordId: z.number().int().positive(), state: stateEnum }))
    .max(8000),
  startedAt: z.string().max(40).optional(),
  // word=只测单词（默认），all=连短语一起测
  scope: z.enum(['word', 'all']).default('word'),
});

/** 作文新建：标题、正文必填，题目要求/文体/标签可选 */
const essayCreateSchema = z.object({
  title: z.string().trim().min(1, '作文标题不能为空').max(200),
  prompt: z.string().max(4000).default(''),
  genre: z.string().trim().max(40).default('其它'),
  body: z.string().trim().min(1, '作文正文不能为空').max(50_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});

/** 作文局部更新：不带 default，未传字段保持原值 */
const essayPatchSchema = z.object({
  title: z.string().trim().min(1, '作文标题不能为空').max(200).optional(),
  prompt: z.string().max(4000).optional(),
  genre: z.string().trim().max(40).optional(),
  body: z.string().trim().min(1, '作文正文不能为空').max(50_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

const essayIdSchema = z.object({ id: z.string().uuid() });

// ========== 单词趣味记忆：故事 / 谚语 / 近似词 + 每日复习打卡 ==========
/** 日期字符串 YYYY-MM-DD，用于记录日期 */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const memoryModeEnum = z.enum(['story', 'proverb', 'similar']);
const modeQuerySchema = z.object({ mode: memoryModeEnum.default('story') });

const storyCreateSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200),
  body: z.string().trim().min(1, '正文不能为空').max(100_000),
  storyDate: dateStr.optional(),
  mode: memoryModeEnum.default('story'),
});

const storyPatchSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200).optional(),
  body: z.string().trim().min(1, '正文不能为空').max(100_000).optional(),
  storyDate: dateStr.optional(),
});

const storyIdSchema = z.object({ id: z.string().uuid() });
const checkinAllSchema = z.object({ mode: memoryModeEnum.default('story') });

/**
 * 单词掌握度路由注册：词表/轮次测试、教师概览与导出、单词课目录与视频流
 */
export async function vocabRoutes(app: FastifyInstance): Promise<void> {
  /** GET /vocab/board - 学生取整张词表（含上一轮的三色分区）；鉴权：需登录 */
  app.get('/vocab/board', async (request) => {
    const username = request.user.sub;
    return getBoard(username);
  });

  /** POST /vocab/rounds - 学生提交一轮单词掌握标记（绿/黄/红），更新画像；鉴权：需登录 */
  app.post('/vocab/rounds', async (request) => {
    const username = request.user.sub;
    const body = parseInput(submitSchema, request.body);
    if (body.states.length === 0) throw badRequest('本轮没有任何标记，先点几个词再提交');
    return submitRound(username, body);
  });

  /** GET /vocab/rounds - 学生查看自己的历史测试轮次；鉴权：需登录 */
  app.get('/vocab/rounds', async (request) => {
    const username = request.user.sub;
    return { rounds: await listRounds(username) };
  });

  /** GET /vocab/rounds/:id - 查看单轮明细（学生看自己、老师看学生均可，单账号系统下不细分）；鉴权：需登录 */
  app.get('/vocab/rounds/:id', async (request) => {
    const params = parseInput(z.object({ id: z.string().uuid() }), request.params);
    return roundDetail(params.id);
  });

  /** GET /vocab/teacher/overview - 教师查看所有学生的单词掌握概览；鉴权：需登录 */
  app.get('/vocab/teacher/overview', async () => teacherOverview());

  /** GET /vocab/teacher/export.csv - 教师导出学生概览为 CSV（带 BOM，Excel 直接打开）；鉴权：需登录 */
  app.get('/vocab/teacher/export.csv', async (request, reply) => {
    const { students } = await teacherOverview();
    const header = '学生,轮次数,最近轮次,最近测试时间,熟悉(绿),模糊(黄),遗忘(红),总词数';
    const lines = students.map((s) =>
      [
        s.username,
        s.rounds,
        s.lastRoundNo ?? '',
        s.lastAt ? new Date(s.lastAt).toLocaleString('zh-CN') : '',
        s.green,
        s.yellow,
        s.red,
        s.total,
      ].join(','),
    );
    const csv = `\uFEFF${[header, ...lines].join('\n')}`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="vocab-teacher.csv"')
      .send(csv);
  });

  // ========== 学单词：刘晓燕单词课 ==========

  /** GET /vocab/course/list - 单词课目录（Unit → Lesson 树）；鉴权：需登录 */
  app.get('/vocab/course/list', async () => ({ units: await listCourse() }));

  /**
   * GET /vocab/course/stream - 视频流：video 标签带不了 Authorization 头，改用 ?token= 传 JWT，支持 Range 拖动进度条
   * 鉴权：路由标记 auth:false，但在处理器内手动校验 access token
   */
  app.get('/vocab/course/stream', { config: { auth: false } }, async (request, reply) => {
    const query = request.query as { file?: string; token?: string };
    try {
      const payload = app.jwt.verify(String(query.token ?? '')) as { sub?: string; typ?: string };
      if (!payload.sub || payload.typ !== 'access') throw new Error('wrong token type');
    } catch {
      throw unauthorized('登录已过期，请刷新页面重新进入');
    }

    const abs = resolveCourseFile(String(query.file ?? ''));
    if (!abs) throw badRequest('视频文件不存在');
    const stat = await fsp.stat(abs);

    reply
      .header('content-type', 'video/mp4')
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'no-store');

    const range = request.headers.range;
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size || start > end) {
        return reply
          .status(416)
          .header('content-range', `bytes */${stat.size}`)
          .send();
      }
      return reply
        .status(206)
        .header('content-range', `bytes ${start}-${end}/${stat.size}`)
        .header('content-length', String(end - start + 1))
        .send(fs.createReadStream(abs, { start, end }));
    }
    return reply.header('content-length', String(stat.size)).send(fs.createReadStream(abs));
  });

  // ========== 我的作文：英语作文存档 ==========

  /** GET /vocab/essays - 读取当前学生的全部作文（按最近修改倒序）；鉴权：需登录 */
  app.get('/vocab/essays', async (request) => ({ essays: await listEssays(request.user.sub) }));

  /** GET /vocab/essays/:id - 读取单篇作文全文；鉴权：需登录 */
  app.get('/vocab/essays/:id', async (request) => {
    const { id } = parseInput(essayIdSchema, request.params);
    const essay = await getEssay(id, request.user.sub);
    if (!essay) throw notFound('作文不存在或已被删除');
    return essay;
  });

  /** POST /vocab/essays - 存入一篇写好的作文；鉴权：需登录 */
  app.post('/vocab/essays', async (request) => {
    const input = parseInput(essayCreateSchema, request.body);
    return createEssay(request.user.sub, input);
  });

  /** PATCH /vocab/essays/:id - 修改作文（标题/题目要求/文体/正文/标签）；鉴权：需登录 */
  app.patch('/vocab/essays/:id', async (request) => {
    const { id } = parseInput(essayIdSchema, request.params);
    const patch = parseInput(essayPatchSchema, request.body);
    const essay = await updateEssay(id, request.user.sub, patch);
    if (!essay) throw notFound('作文不存在或已被删除');
    return essay;
  });

  /** DELETE /vocab/essays/:id - 删除一篇作文；鉴权：需登录 */
  app.delete('/vocab/essays/:id', async (request) => {
    const { id } = parseInput(essayIdSchema, request.params);
    const ok = await deleteEssay(id, request.user.sub);
    if (!ok) throw notFound('作文不存在或已被删除');
    return { ok: true };
  });

  // ---------- 背搭配：短语卡片 + 掌握进度 ----------

  /** 新增自建搭配：短语必填，释义/例句选填；同账号重复短语返回 400 */
  const customCollocationSchema = z.object({
    word: z.string().trim().min(1, '搭配短语不能为空').max(120),
    meaning: z.string().trim().max(300).default(''),
    exampleEn: z.string().trim().max(1000).default(''),
    exampleZh: z.string().trim().max(1000).default(''),
  });

  /** GET /vocab/collocations - 内置 + 自建搭配卡片（含例句翻译与当前用户进度）；鉴权：需登录 */
  app.get('/vocab/collocations', async (request) => {
    const username = request.user.sub;
    const [cards, stat] = await Promise.all([listCards(username), collocationStats(username)]);
    return { cards, stats: stat };
  });

  /** POST /vocab/collocations - 添加一条自己的搭配；鉴权：需登录 */
  app.post('/vocab/collocations', async (request) => {
    const input = parseInput(customCollocationSchema, request.body);
    const card = await createCustom(request.user.sub, input);
    if (!card) throw badRequest('这个搭配你已经加过了');
    return card;
  });

  /** DELETE /vocab/collocations/:id - 删除一条自建搭配（只认当前账号）；鉴权：需登录 */
  app.delete('/vocab/collocations/:id', async (request) => {
    const { id } = parseInput(z.object({ id: z.string().regex(/^\d+$/) }), request.params);
    const ok = await deleteCustom(request.user.sub, Number(id));
    if (!ok) throw notFound('这条自建搭配不存在');
    return { ok: true };
  });

  /** POST /vocab/collocations/progress - 标记一条搭配的认识状态；鉴权：需登录 */
  app.post('/vocab/collocations/progress', async (request) => {
    const input = parseInput(
      z.object({
        // 正数=内置搭配，负数=自建搭配（见 repos/collocations.ts 的 id 约定）
        wordId: z.number().int().refine((n) => n !== 0, 'id 不能为 0'),
        status: z.enum(['new', 'learning', 'known']),
      }),
      request.body,
    );
    await upsertProgress(request.user.sub, input.wordId, input.status);
    return { ok: true };
  });

  /** POST /vocab/collocations/reset - 重置搭配学习进度；鉴权：需登录 */
  app.post('/vocab/collocations/reset', async (request) => {
    await resetProgress(request.user.sub);
    return { ok: true };
  });

  // ---------- 单词趣味记忆：故事 / 谚语 / 近似词 + 每日复习打卡 ----------

  /** GET /vocab/stories?mode=story|proverb|similar - 某模式的全部记录与复习统计；鉴权：需登录 */
  app.get('/vocab/stories', async (request) => {
    const { mode } = parseInput(modeQuerySchema, request.query ?? {});
    return listStories(request.user.sub, mode);
  });

  /** GET /vocab/stories/:id - 单条记录全文；鉴权：需登录 */
  app.get('/vocab/stories/:id', async (request) => {
    const { id } = parseInput(storyIdSchema, request.params);
    // 单条查询不限定模式，遍历三种模式找
    for (const mode of ['story', 'proverb', 'similar'] as const) {
      const { stories } = await listStories(request.user.sub, mode);
      const found = stories.find((s) => s.id === id);
      if (found) return found;
    }
    throw notFound('记录不存在或已被删除');
  });

  /** POST /vocab/stories - 存入一条记忆（故事/谚语/近似）；鉴权：需登录 */
  app.post('/vocab/stories', async (request) => {
    const input = parseInput(storyCreateSchema, request.body);
    return createStory(request.user.sub, input);
  });

  /** PATCH /vocab/stories/:id - 修改自建记录（内置素材不可改）；鉴权：需登录 */
  app.patch('/vocab/stories/:id', async (request) => {
    const { id } = parseInput(storyIdSchema, request.params);
    const patch = parseInput(storyPatchSchema, request.body);
    const story = await updateStory(id, request.user.sub, patch);
    if (!story) throw notFound('记录不存在、已被删除或为内置素材');
    return story;
  });

  /** DELETE /vocab/stories/:id - 删除自建记录（内置素材不可删）；鉴权：需登录 */
  app.delete('/vocab/stories/:id', async (request) => {
    const { id } = parseInput(storyIdSchema, request.params);
    const ok = await deleteStory(id, request.user.sub);
    if (!ok) throw notFound('记录不存在、已被删除或为内置素材');
    return { ok: true };
  });

  /** POST /vocab/stories/:id/checkin - 给一篇故事打卡（幂等）；鉴权：需登录 */
  app.post('/vocab/stories/:id/checkin', async (request) => {
    const { id } = parseInput(storyIdSchema, request.params);
    const created = await checkinStory(id, request.user.sub);
    return { ok: true, created };
  });

  /** DELETE /vocab/stories/:id/checkin - 撤销今天对一篇故事的打卡；鉴权：需登录 */
  app.delete('/vocab/stories/:id/checkin', async (request) => {
    const { id } = parseInput(storyIdSchema, request.params);
    const removed = await uncheckinStory(id, request.user.sub);
    return { ok: true, removed };
  });

  /** POST /vocab/stories/checkin-all - 一键给某模式全部记录打卡（今天复习完一整轮）；鉴权：需登录 */
  app.post('/vocab/stories/checkin-all', async (request) => {
    const { mode } = parseInput(checkinAllSchema, request.body ?? {});
    const count = await checkinAllStories(request.user.sub, mode);
    return { ok: true, count };
  });
}
