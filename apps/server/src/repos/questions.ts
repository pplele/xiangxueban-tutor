import { many, one, query } from '../db/pool';
import type { PoolClient } from 'pg';
import type { QuestionCard } from '@tutor/shared';

/** questions 表原始行结构；variant_count/attempt_count 为关联子查询统计值 */
export interface QuestionRow {
  id: string;
  subject: string;
  chapter: string;
  kp_codes: string[];
  kp_levels: string[];
  question_type: string;
  title: string | null;
  text_body: string;
  options: unknown;
  answer: string | null;
  solution: string | null;
  note: string | null;
  tags: string[];
  no: string;
  fingerprint: string;
  status: string;
  source: string;
  schema_version: number;
  meta: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  variant_count?: number;
  attempt_count?: number;
}

// 列表/单题统一查询列：含变式数、作答数两个关联子查询
const SELECT_COLS = `
  q.id, q.subject, q.chapter, q.kp_codes, q.kp_levels, q.question_type, q.title, q.text_body,
  q.options, q.answer, q.solution, q.note, q.tags, q.no, q.fingerprint, q.status, q.source,
  q.schema_version, q.meta, q.created_at, q.updated_at,
  (SELECT count(*)::int FROM variants v WHERE v.question_id = q.id) AS variant_count,
  (SELECT count(*)::int FROM attempts a WHERE a.question_id = q.id) AS attempt_count
`;

/**
 * 将 questions 表原始行映射为前端 QuestionCard（数组字段兜底、时间转 ISO、补关联统计数）。
 * @param row questions 表查询结果行
 * @returns 前端题目卡片
 */
export function mapQuestion(row: QuestionRow): QuestionCard {
  return {
    id: row.id,
    subject: row.subject,
    chapter: row.chapter,
    kpCodes: row.kp_codes ?? [],
    kpLevels: row.kp_levels ?? [],
    questionType: row.question_type,
    title: row.title ?? '',
    textBody: row.text_body,
    options: Array.isArray(row.options) ? (row.options as string[]) : null,
    answer: row.answer,
    solution: row.solution,
    note: row.note,
    tags: row.tags ?? [],
    fingerprint: row.fingerprint,
    status: row.status,
    source: row.source,
    schemaVersion: row.schema_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    variantCount: row.variant_count ?? 0,
    attemptCount: row.attempt_count ?? 0,
  };
}

/** 题目列表筛选与分页条件 */
export interface ListFilter {
  subject?: string;
  chapter?: string;
  status?: string;
  search?: string;
  page: number;
  pageSize: number;
}

/**
 * 分页查询 questions 表题目列表，并统计满足条件的总数；search 模糊匹配题干与标题。
 * 内部箭头函数 add 把 ? 占位符替换为 $n 并收集参数。
 * @param filter 筛选与分页条件
 * @returns 题目卡片列表与总数
 */
export async function listQuestions(filter: ListFilter): Promise<{ items: QuestionCard[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  // 把 ? 占位符换成 $n 并收集参数值
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (filter.subject) add('q.subject = ?', filter.subject);
  if (filter.chapter) add('q.chapter = ?', filter.chapter);
  if (filter.status) add('q.status = ?', filter.status);
  if (filter.search) add('(q.text_body ILIKE ? OR q.title ILIKE ?)', `%${filter.search}%`.repeat(1));
  // ILIKE 需要两个占位符，单独处理
  let whereSql = where.join(' AND ');
  if (filter.search) {
    const idx = params.length;
    params[params.length - 1] = `%${filter.search}%`;
    params.push(`%${filter.search}%`);
    where[where.length - 1] = `(q.text_body ILIKE $${idx} OR q.title ILIKE $${idx + 1})`;
    whereSql = where.join(' AND ');
  }
  const whereClause = whereSql ? `WHERE ${whereSql}` : '';

  const totalRow = await one<{ total: string }>(
    `SELECT count(*)::text AS total FROM questions q ${whereClause}`,
    params,
  );
  const limit = filter.pageSize;
  const offset = (filter.page - 1) * filter.pageSize;
  const rows = await many<QuestionRow>(
    `SELECT ${SELECT_COLS} FROM questions q ${whereClause}
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { items: rows.map(mapQuestion), total: Number(totalRow?.total ?? 0) };
}

/**
 * 从 questions 表按 id 读取题目原始行（含关联统计），供内部复用。
 * @param id 题目 id
 * @returns 题目原始行，不存在返回 null
 */
export async function getQuestionRow(id: string): Promise<QuestionRow | null> {
  return one<QuestionRow>(`SELECT ${SELECT_COLS} FROM questions q WHERE q.id = $1`, [id]);
}

/**
 * 从 questions 表按 id 读取并映射为前端题目卡片。
 * @param id 题目 id
 * @returns 题目卡片，不存在返回 null
 */
export async function getQuestionById(id: string): Promise<QuestionCard | null> {
  const row = await getQuestionRow(id);
  return row ? mapQuestion(row) : null;
}

/**
 * 从 questions 表按科目 + 指纹查询题目，用于导入时判重。
 * @param subject 科目
 * @param fp 题目指纹
 * @returns 题目原始行，不存在返回 null
 */
export async function findByFingerprint(subject: string, fp: string): Promise<QuestionRow | null> {
  return one<QuestionRow>(`SELECT ${SELECT_COLS} FROM questions q WHERE q.subject = $1 AND q.fingerprint = $2`, [
    subject,
    fp,
  ]);
}

/**
 * 根据前缀从 questions 表生成下一个题目 id（取同前缀最大编号 +1，补零到 3 位）。
 * @param prefix id 前缀
 * @returns 形如 prefix001 的新 id
 */
export async function nextQuestionId(prefix: string): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT id FROM questions WHERE id LIKE $1 ORDER BY length(id) DESC, id DESC LIMIT 1`,
    [`${prefix}%`],
  );
  let next = 1;
  if (row?.id) {
    const m = /-(\d+)$/.exec(row.id);
    if (m) next = Number(m[1]) + 1;
  }
  return `${prefix}${String(next).padStart(3, '0')}`;
}

/** 新增/全量更新题目的输入结构（前端字段，camelCase） */
export interface InsertQuestionInput {
  id: string;
  subject: string;
  chapter: string;
  kpCodes: string[];
  kpLevels: string[];
  questionType: string;
  title?: string;
  textBody: string;
  options?: string[] | null;
  answer?: string | null;
  solution?: string | null;
  note?: string | null;
  tags?: string[];
  no?: string;
  fingerprint: string;
  status?: string;
  source?: string;
  schemaVersion?: number;
  meta?: Record<string, unknown>;
  createdAt?: string | null;
}

/**
 * 向 questions 表插入一道题；id 冲突则跳过（DO NOTHING）。可传入外部 client 纳入事务。
 * @param input 题目内容
 * @param client 可选数据库客户端（用于事务）
 * @returns 插入后的题目行；id 已存在时抛错
 */
export async function insertQuestion(input: InsertQuestionInput, client?: PoolClient): Promise<QuestionRow> {
  const sql = `
    INSERT INTO questions (
      id, subject, chapter, kp_codes, kp_levels, question_type, title, text_body, options,
      answer, solution, note, tags, no, fingerprint, status, source, schema_version, meta, created_at
    ) VALUES (
      $1,$2,$3,$4::text[],$5::text[],$6,$7,$8,$9::jsonb,$10,$11,$12,$13::text[],$14,$15,$16,$17,$18,$19::jsonb,
      COALESCE($20::timestamptz, now())
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  `;
  const params = [
    input.id,
    input.subject,
    input.chapter,
    input.kpCodes,
    input.kpLevels,
    input.questionType,
    input.title ?? '',
    input.textBody,
    input.options ? JSON.stringify(input.options) : null,
    input.answer ?? null,
    input.solution ?? null,
    input.note ?? null,
    input.tags ?? [],
    input.no ?? '',
    input.fingerprint,
    input.status ?? '待变式',
    input.source ?? 'json',
    input.schemaVersion ?? 3,
    JSON.stringify(input.meta ?? {}),
    input.createdAt ?? null,
  ];
  const res = client
    ? await client.query<QuestionRow>(sql, params)
    : await query<QuestionRow>(sql, params);
  const row = res.rows[0];
  if (!row) throw new Error(`题目 ${input.id} 已存在`);
  return row;
}

/**
 * 全量更新 questions 表题目内容（除 id 外所有字段），并刷新 updated_at。
 * @param id 题目 id
 * @param input 新的题目内容（不含 id）
 * @returns 更新后的题目行
 */
export async function updateQuestionContent(id: string, input: Omit<InsertQuestionInput, 'id'>): Promise<QuestionRow> {
  const res = await query<QuestionRow>(
    `UPDATE questions SET
       subject=$2, chapter=$3, kp_codes=$4::text[], kp_levels=$5::text[], question_type=$6,
       title=$7, text_body=$8, options=$9::jsonb, answer=$10, solution=$11, note=$12, tags=$13::text[],
       no=$14, fingerprint=$15, status=$16, source=$17, schema_version=$18, meta=$19::jsonb, updated_at=now()
     WHERE id=$1 RETURNING *`,
    [
      id,
      input.subject,
      input.chapter,
      input.kpCodes,
      input.kpLevels,
      input.questionType,
      input.title ?? '',
      input.textBody,
      input.options ? JSON.stringify(input.options) : null,
      input.answer ?? null,
      input.solution ?? null,
      input.note ?? null,
      input.tags ?? [],
      input.no ?? '',
      input.fingerprint,
      input.status ?? '待变式',
      input.source ?? 'json',
      input.schemaVersion ?? 3,
      JSON.stringify(input.meta ?? {}),
    ],
  );
  return res.rows[0];
}

/**
 * 更新 questions.note 错题备注并刷新 updated_at，返回前端题目卡片。
 * @param id 题目 id
 * @param note 备注文本
 * @returns 更新后的题目卡片，不存在返回 null
 */
export async function updateNote(id: string, note: string): Promise<QuestionCard | null> {
  const res = await query<QuestionRow>(
    `UPDATE questions SET note = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, note],
  );
  return res.rows[0] ? mapQuestion(res.rows[0]) : null;
}

/**
 * 更新 questions.status 题目状态并刷新 updated_at。
 * @param id 题目 id
 * @param status 新状态
 */
export async function updateStatus(id: string, status: string): Promise<void> {
  await query(`UPDATE questions SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
}

/**
 * 从 questions 表统计某科目各章节题数与各状态题数。
 * @param subject 科目
 * @returns 章节分布与状态分布
 */
export async function stats(subject: string): Promise<{
  chapters: { chapter: string; count: number }[];
  statuses: { status: string; count: number }[];
}> {
  const chapters = await many<{ chapter: string; count: number }>(
    `SELECT chapter, count(*)::int AS count FROM questions WHERE subject = $1 GROUP BY chapter ORDER BY count DESC`,
    [subject],
  );
  const statuses = await many<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM questions WHERE subject = $1 GROUP BY status`,
    [subject],
  );
  return { chapters, statuses };
}

/**
 * 统计某科目错题总数与未标考点数；答疑「我有多少道错题」必须以此为准（不能累加考点分布）。
 * @param subject 科目
 * @returns 错题总数、未标考点数
 */
export async function countBySubject(subject: string): Promise<{ total: number; withoutKp: number }> {
  const rows = await many<{ total: number; without_kp: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE coalesce(array_length(kp_codes, 1), 0) = 0)::int AS without_kp
       FROM questions WHERE subject = $1`,
    [subject],
  );
  return { total: rows[0]?.total ?? 0, withoutKp: rows[0]?.without_kp ?? 0 };
}

/**
 * 按考点代码召回 questions 表中本科目「带备注」的错题：数组相交 && 命中任一考点即可。
 * @param subject 科目
 * @param kpCodes 考点编码数组
 * @param limit 最多返回条数，默认 3
 * @returns 相关错题卡片；无考点时返回空数组
 */
export async function relevantWithNotesForSubject(
  subject: string,
  kpCodes: string[],
  limit = 3,
): Promise<QuestionCard[]> {
  if (!kpCodes.length) return [];
  const rows = await many<QuestionRow>(
    `SELECT ${SELECT_COLS}
       FROM questions q
      WHERE q.subject = $1
        AND q.kp_codes && $2::text[]
        AND q.note IS NOT NULL AND btrim(q.note) <> ''
      ORDER BY q.updated_at DESC, q.id DESC
      LIMIT $3`,
    [subject, kpCodes, limit],
  );
  return rows.map(mapQuestion);
}

/**
 * 题干向量相似召回 questions 表中「带备注」的错题，作为相同概念兜底；按余弦距离排序。
 * @param subject 科目
 * @param vector 查询向量
 * @param excludeIds 要排除的题目 id
 * @param limit 最多返回条数，默认 3
 * @returns 相似错题卡片；向量为空或 limit<=0 返回空数组
 */
export async function similarWithNotesForSubject(
  subject: string,
  vector: number[],
  excludeIds: string[],
  limit = 3,
): Promise<QuestionCard[]> {
  if (!vector.length || limit <= 0) return [];
  const rows = await many<QuestionRow>(
    `SELECT ${SELECT_COLS},
            1 - (q.embedding <=> $1::vector) AS sim
       FROM questions q
      WHERE q.subject = $2
        AND q.embedding IS NOT NULL
        AND q.note IS NOT NULL AND btrim(q.note) <> ''
        AND q.id <> ALL($3::text[])
      ORDER BY q.embedding <=> $1::vector
      LIMIT $4`,
    [`[${vector.join(',')}]`, subject, excludeIds, limit],
  );
  return rows.map(mapQuestion);
}

/**
 * 从 questions 表读取某科目最近创建的若干道题，按创建时间倒序。
 * @param subject 科目
 * @param limit 最多返回条数，默认 3
 * @returns 最近题目卡片
 */
export async function recentForSubject(subject: string, limit = 3): Promise<QuestionCard[]> {
  const rows = await many<QuestionRow>(
    `SELECT ${SELECT_COLS} FROM questions q WHERE q.subject = $1 ORDER BY q.created_at DESC, q.id DESC LIMIT $2`,
    [subject, limit],
  );
  return rows.map(mapQuestion);
}

/**
 * 从 questions 表展开考点（unnest kp_codes）并左连 kp_whitelist 取名称，统计某科目错题最多的前 6 个考点。
 * @param subject 科目
 * @returns 高频错题考点（编码、名称、数量）
 */
export async function wrongKpSummary(
  subject: string,
): Promise<{ kpCode: string; kpName: string; count: number }[]> {
  const rows = await many<{ kp_code: string; count: number; kp_name: string | null }>(
    `SELECT t.kp_code, count(*)::int AS count, max(w.kp_name) AS kp_name
       FROM (
         SELECT unnest(q.kp_codes) AS kp_code, q.subject
           FROM questions q
          WHERE q.subject = $1
       ) t
       LEFT JOIN kp_whitelist w ON w.subject = t.subject AND w.kp_code = t.kp_code
      GROUP BY t.kp_code
      ORDER BY count DESC
      LIMIT 6`,
    [subject],
  );
  return rows.map((r) => ({ kpCode: r.kp_code, kpName: r.kp_name ?? '', count: r.count }));
}

/**
 * 组卷选原题：按科目/章节/题型过滤并排除指定题，未考过的优先、其余随机。
 * @param subject 科目
 * @param chapters 章节数组（空数组表示不限）
 * @param types 题型数组
 * @param limit 最多返回条数
 * @param excludeIds 要排除的题目 id
 * @returns 选中的题目卡片
 */
export async function pickQuestionsForExam(
  subject: string,
  chapters: string[],
  types: string[],
  limit: number,
  excludeIds: string[] = [],
): Promise<QuestionCard[]> {
  const rows = await many<QuestionRow>(
    `SELECT ${SELECT_COLS} FROM questions q
      WHERE q.subject = $1
        AND ($2::text[] = '{}'::text[] OR q.chapter = ANY($2::text[]))
        AND q.question_type = ANY($3::text[])
        AND NOT (q.id = ANY($4::text[]))
      ORDER BY (q.exam_used_at IS NOT NULL), random()
      LIMIT $5`,
    [subject, chapters, types, excludeIds, limit],
  );
  return rows.map(mapQuestion);
}

/**
 * 组卷选任意原题：不限章节，只按科目/题型过滤并排除指定题，未考过优先、随机。
 * @param subject 科目
 * @param types 题型数组
 * @param limit 最多返回条数
 * @param excludeIds 要排除的题目 id
 * @returns 选中的题目卡片
 */
export async function pickAnyQuestions(
  subject: string,
  types: string[],
  limit: number,
  excludeIds: string[] = [],
): Promise<QuestionCard[]> {
  const rows = await many<QuestionRow>(
    `SELECT ${SELECT_COLS} FROM questions q
      WHERE q.subject = $1 AND q.question_type = ANY($2::text[])
        AND NOT (q.id = ANY($3::text[]))
      ORDER BY (q.exam_used_at IS NOT NULL), random() LIMIT $4`,
    [subject, types, excludeIds, limit],
  );
  return rows.map(mapQuestion);
}

/**
 * 统计 questions 表题目总数；传入 subject 时只统计该科目。
 * @param subject 可选，科目
 * @returns 题目数量
 */
export async function countQuestions(subject?: string): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM questions ${subject ? 'WHERE subject = $1' : ''}`,
    subject ? [subject] : [],
  );
  return Number(row?.count ?? 0);
}
