import { many, query } from '../db/pool';
import type { AttemptItem } from '@tutor/shared';

/** attempts 表原始行结构（数据库列，snake_case） */
export interface AttemptRow {
  id: string | number;
  question_id: string;
  variant_id: string | number | null;
  subject: string;
  answer: string | null;
  verdict: string | null;
  source: string;
  at: Date;
}

/**
 * 将 attempts 表原始行映射为前端 AttemptItem（id 转数字、时间转 ISO 字符串）。
 * @param row attempts 表查询结果行
 * @returns 前端作答记录
 */
export function mapAttempt(row: AttemptRow): AttemptItem {
  return {
    id: Number(row.id),
    questionId: row.question_id,
    variantId: row.variant_id === null ? null : Number(row.variant_id),
    subject: row.subject,
    answer: row.answer,
    verdict: row.verdict,
    source: row.source,
    at: row.at.toISOString(),
  };
}

/** 新增作答记录的输入结构（前端字段，camelCase） */
export interface NewAttempt {
  questionId: string;
  variantId?: number | null;
  subject: string;
  answer: string;
  verdict: string;
  source: string;
  at?: string | null;
}

/**
 * 向 attempts 表插入一条作答记录；at 为空时用数据库当前时间。
 * @param input 新作答记录（题目、变式、科目、答案、判定、来源、时间）
 * @returns 插入后的作答记录
 */
export async function insertAttempt(input: NewAttempt): Promise<AttemptItem> {
  const rows = await many<AttemptRow>(
    `INSERT INTO attempts (question_id, variant_id, subject, answer, verdict, source, at)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()))
     RETURNING *`,
    [
      input.questionId,
      input.variantId ?? null,
      input.subject,
      input.answer,
      input.verdict,
      input.source,
      input.at ?? null,
    ],
  );
  return mapAttempt(rows[0]);
}

/**
 * 从 attempts 表按题目 id 查询全部作答，按作答时间倒序、id 倒序返回。
 * @param questionId 题目 id
 * @returns 该题目的作答记录列表（最新在前）
 */
export async function listAttempts(questionId: string): Promise<AttemptItem[]> {
  const rows = await many<AttemptRow>(
    `SELECT * FROM attempts WHERE question_id = $1 ORDER BY at DESC, id DESC`,
    [questionId],
  );
  return rows.map(mapAttempt);
}

/**
 * 统计 attempts 表作答总数；传入 questionId 时只统计该题目。
 * @param questionId 可选，题目 id；不传则统计全部
 * @returns 作答数量
 */
export async function countAttempts(questionId?: string): Promise<number> {
  const rows = await many<{ count: string }>(
    `SELECT count(*)::text AS count FROM attempts ${questionId ? 'WHERE question_id = $1' : ''}`,
    questionId ? [questionId] : [],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * 从 attempts 表查询某科目最近若干条作答，按时间倒序。
 * @param subject 科目
 * @param limit 最多返回条数，默认 5
 * @returns 最近的作答记录列表
 */
export async function recentAttemptsForSubject(subject: string, limit = 5): Promise<AttemptItem[]> {
  const rows = await many<AttemptRow>(
    `SELECT * FROM attempts WHERE subject = $1 ORDER BY at DESC LIMIT $2`,
    [subject, limit],
  );
  return rows.map(mapAttempt);
}

/**
 * 从 attempts 表删除某题目的全部作答记录（删除题目时的清理）。
 * @param questionId 题目 id
 */
export async function deleteAttemptsForQuestion(questionId: string): Promise<void> {
  await query(`DELETE FROM attempts WHERE question_id = $1`, [questionId]);
}
