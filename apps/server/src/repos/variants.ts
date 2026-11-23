import crypto from 'node:crypto';
import { many, one, query } from '../db/pool';
import type { VariantItem } from '@tutor/shared';

/** variants 表原始行结构 */
export interface VariantRow {
  id: string | number;
  question_id: string;
  set_id: string;
  level: string;
  stem: string;
  answer: string;
  solution: string;
  kp_codes: string[];
  target_trap: string | null;
  created_at: Date;
}

/**
 * 将 variants 表原始行映射为前端 VariantItem（id 转数字、时间转 ISO、考点兜底空数组）。
 * @param row variants 表查询结果行
 * @returns 前端变式题 DTO
 */
export function mapVariant(row: VariantRow): VariantItem {
  return {
    id: Number(row.id),
    questionId: row.question_id,
    setId: row.set_id,
    level: row.level,
    stem: row.stem,
    answer: row.answer,
    solution: row.solution,
    kpCodes: row.kp_codes ?? [],
    targetTrap: row.target_trap,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 从 variants 表读取某题全部变式，按套号、难度（L1<L2<其他）排序。
 * @param questionId 母题 id
 * @returns 变式题列表
 */
export async function listVariants(questionId: string): Promise<VariantItem[]> {
  const rows = await many<VariantRow>(
    `SELECT * FROM variants WHERE question_id = $1 ORDER BY set_id, CASE level WHEN 'L1' THEN 1 WHEN 'L2' THEN 2 ELSE 3 END`,
    [questionId],
  );
  return rows.map(mapVariant);
}

/**
 * 从 variants 表按 id 读取单个变式。
 * @param id 变式 id
 * @returns 变式题 DTO，不存在返回 null
 */
export async function getVariant(id: number): Promise<VariantItem | null> {
  const rows = await many<VariantRow>(`SELECT * FROM variants WHERE id = $1`, [id]);
  return rows[0] ? mapVariant(rows[0]) : null;
}

/**
 * 从 variants 表取某题已有变式的最大套号（set_id 中数字部分），用于生成下一套编号。
 * @param questionId 母题 id
 * @returns 最大套号，无变式返回 0
 */
export async function maxSetNumber(questionId: string): Promise<number> {
  const row = await one<{ max: string | null }>(
    `SELECT max(NULLIF(regexp_replace(set_id, '\\D', '', 'g'), '')::int)::text AS max
       FROM variants WHERE question_id = $1`,
    [questionId],
  );
  return row?.max ? Number(row.max) : 0;
}

/** 待写入 variants 表的单条变式 */
export interface NewVariant {
  level: string;
  stem: string;
  answer: string;
  solution: string;
  kpCodes: string[];
  targetTrap?: string | null;
  createdAt?: string | null;
}

/**
 * 向 variants 表批量插入一整套变式；用 (setId:level:stem) 的 md5 作 dedupe_key 去重（冲突跳过）。
 * @param questionId 母题 id
 * @param setId 套号标识
 * @param items 变式数组
 * @returns 实际插入成功的变式列表（含去重后）
 */
export async function insertVariantSet(
  questionId: string,
  setId: string,
  items: NewVariant[],
): Promise<VariantItem[]> {
  const inserted: VariantItem[] = [];
  for (const item of items) {
    const dedupeKey = crypto
      .createHash('md5')
      .update(`${setId}:${item.level}:${item.stem}`)
      .digest('hex');
    const rows = await many<VariantRow>(
      `INSERT INTO variants (question_id, set_id, level, stem, answer, solution, kp_codes, target_trap, created_at, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8, COALESCE($9::timestamptz, now()), $10)
       ON CONFLICT (question_id, dedupe_key) DO NOTHING
       RETURNING *`,
      [
        questionId,
        setId,
        item.level,
        item.stem,
        item.answer,
        item.solution,
        item.kpCodes,
        item.targetTrap ?? null,
        item.createdAt ?? null,
        dedupeKey,
      ],
    );
    if (rows[0]) inserted.push(mapVariant(rows[0]));
  }
  return inserted;
}

/**
 * 统计 variants 表变式总数；传入 questionId 时只统计该母题。
 * @param questionId 可选，母题 id
 * @returns 变式数量
 */
export async function countVariants(questionId?: string): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM variants ${questionId ? 'WHERE question_id = $1' : ''}`,
    questionId ? [questionId] : [],
  );
  return Number(row?.count ?? 0);
}

/**
 * 从 variants 表删除某母题的全部变式。
 * @param questionId 母题 id
 */
export async function removeVariantsOfQuestion(questionId: string): Promise<void> {
  await query(`DELETE FROM variants WHERE question_id = $1`, [questionId]);
}

/** 组卷用变式候选：章节/题型/考点继承自母题 questions 表 */
export interface ExamVariantCandidate {
  variantId: number;
  /** 变式的母题 id（章节 / 题型 / 考点都继承母题） */
  questionId: string;
  chapter: string;
  questionType: string;
  stem: string;
  answer: string;
  solution: string;
  kpCodes: string[];
  examUsedAt: Date | null;
}

/**
 * 组卷用：从 variants 表联 questions 表按科目/章节/题型挑变式（与原题共用候选池）。
 * 排除 excludeQuestionIds（同卷母题与变式不重复），未考过的（exam_used_at IS NULL）优先、其余随机。
 * @param subject 科目
 * @param chapters 章节数组（空数组表示不限）
 * @param types 题型数组
 * @param limit 最多返回条数
 * @param excludeQuestionIds 要排除的母题 id
 * @returns 变式候选列表
 */
export async function pickVariantsForExam(
  subject: string,
  chapters: string[],
  types: string[],
  limit: number,
  excludeQuestionIds: string[] = [],
): Promise<ExamVariantCandidate[]> {
  const rows = await many<
    ExamVariantCandidate & {
      variant_id: number;
      question_id: string;
      kp_codes: string[];
      question_type: string;
      exam_used_at: Date | null;
    }
  >(
    `SELECT v.id AS variant_id, v.question_id, q.chapter, q.question_type,
            v.stem, v.answer, v.solution, v.kp_codes, v.exam_used_at
       FROM variants v
       JOIN questions q ON q.id = v.question_id
      WHERE q.subject = $1
        AND ($2::text[] = '{}'::text[] OR q.chapter = ANY($2::text[]))
        AND q.question_type = ANY($3::text[])
        AND NOT (v.question_id = ANY($4::text[]))
      ORDER BY (v.exam_used_at IS NOT NULL), random()
      LIMIT $5`,
    [subject, chapters, types, excludeQuestionIds, limit],
  );
  return rows.map((r) => ({
    variantId: Number(r.variant_id),
    questionId: r.question_id,
    chapter: r.chapter,
    questionType: r.question_type,
    stem: r.stem,
    answer: r.answer,
    solution: r.solution,
    kpCodes: r.kp_codes ?? [],
    examUsedAt: r.exam_used_at,
  }));
}

/**
 * 给被抽中的题/变式打「考过」标记（写 exam_used_at = now()），下次组卷优先跳过。
 * @param questionIds 被抽中的题目 id 数组
 * @param variantIds 被抽中的变式 id 数组
 */
export async function markExamUsed(questionIds: string[], variantIds: number[]): Promise<void> {
  if (questionIds.length > 0) {
    await query(`UPDATE questions SET exam_used_at = now() WHERE id = ANY($1::text[])`, [questionIds]);
  }
  if (variantIds.length > 0) {
    await query(`UPDATE variants SET exam_used_at = now() WHERE id = ANY($1::bigint[])`, [variantIds]);
  }
}

/**
 * 清空某科目题目与变式的 exam_used_at 标记（前端「重置出题池」入口用）。
 * @param subject 科目
 * @returns 被重置的题目与变式总数
 */
export async function clearExamUsed(subject: string): Promise<number> {
  const q1 = await one<{ count: string }>(
    `WITH upd AS (UPDATE questions SET exam_used_at = NULL WHERE subject = $1 AND exam_used_at IS NOT NULL RETURNING 1)
     SELECT count(*)::text AS count FROM upd`,
    [subject],
  );
  const q2 = await one<{ count: string }>(
    `WITH upd AS (UPDATE variants SET exam_used_at = NULL
                   WHERE exam_used_at IS NOT NULL AND question_id IN (SELECT id FROM questions WHERE subject = $1)
                  RETURNING 1)
     SELECT count(*)::text AS count FROM upd`,
    [subject],
  );
  return Number(q1?.count ?? 0) + Number(q2?.count ?? 0);
}
