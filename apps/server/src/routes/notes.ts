import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { notFound } from '../lib/errors';
import {
  countBySubject,
  countDigestBySubject,
  createNote,
  deleteNote,
  getNote,
  listNoteDigest,
  listNotes,
  updateNote,
} from '../repos/notes';

const subjectEnum = z.enum(['math', 'english']);

const listSchema = z.object({
  subject: subjectEnum.optional(),
  q: z.string().max(120).optional(),
});
const idSchema = z.object({ id: z.string().uuid() });
const createSchema = z.object({
  subject: subjectEnum,
  title: z.string().trim().min(1, '标题不能为空').max(200),
  body: z.string().max(20_000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});
const patchSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200).optional(),
  body: z.string().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

/**
 * 笔记路由注册：笔记增删改查 / 错题备注精华汇总
 */
export async function noteRoutes(app: FastifyInstance): Promise<void> {
  /** GET /notes - 学生笔记列表（可按科目过滤、按关键词搜索），附按科目计数；鉴权：需登录 */
  app.get('/notes', async (request) => {
    const username = request.user.sub;
    const { subject, q } = parseInput(listSchema, request.query);
    const keyword = q?.trim() || undefined;
    const [notes, counts, digestCounts] = await Promise.all([
      listNotes(username, { subject, q: keyword }),
      countBySubject(username),
      countDigestBySubject(),
    ]);
    return { notes, counts, digestCounts };
  });

  /**
   * GET /notes/digest - 错题备注精华：只读汇总，按科目取、按章节分组，不含题干/选项/答案。
   * 注意：必须注册在 /notes/:id 之前，否则 "digest" 会被当成 id 匹配。鉴权：需登录
   */
  app.get('/notes/digest', async (request) => {
    const { subject } = parseInput(listSchema.pick({ subject: true }), request.query);
    const target = subject ?? 'math';
    const groups = await listNoteDigest(target);
    const total = groups.reduce((sum, g) => sum + g.items.length, 0);
    return { subject: target, groups, total };
  });

  /** POST /notes - 学生新建笔记（科目、标题、正文、标签）；鉴权：需登录 */
  app.post('/notes', async (request) => {
    const username = request.user.sub;
    const input = parseInput(createSchema, request.body);
    return createNote(username, input);
  });

  /** GET /notes/:id - 学生读取单篇自己的笔记，不存在返回 404；鉴权：需登录 */
  app.get('/notes/:id', async (request) => {
    const { id } = parseInput(idSchema, request.params);
    const note = await getNote(id, request.user.sub);
    if (!note) throw notFound('笔记不存在或已被删除');
    return note;
  });

  /** PATCH /notes/:id - 学生编辑单篇笔记（标题/正文/标签），不存在返回 404；鉴权：需登录 */
  app.patch('/notes/:id', async (request) => {
    const { id } = parseInput(idSchema, request.params);
    const patch = parseInput(patchSchema, request.body);
    const note = await updateNote(id, request.user.sub, patch);
    if (!note) throw notFound('笔记不存在或已被删除');
    return note;
  });

  /** DELETE /notes/:id - 学生删除单篇笔记，不存在返回 404；鉴权：需登录 */
  app.delete('/notes/:id', async (request) => {
    const { id } = parseInput(idSchema, request.params);
    const ok = await deleteNote(id, request.user.sub);
    if (!ok) throw notFound('笔记不存在或已被删除');
    return { ok: true };
  });
}
