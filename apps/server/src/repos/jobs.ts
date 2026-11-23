import { many, one, query } from '../db/pool';
import type { VariantJobDto, VariantProgress } from '@tutor/shared';

export interface JobRow {
  id: string | number;
  question_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  attempts: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  subject?: string;
  chapter?: string;
  stem?: string;
}

/**
 * 将 variant_jobs 表原始行映射为前端 VariantJobDto（id 转数字、时间转 ISO 字符串）。
 * @param row variant_jobs 表查询结果行
 * @returns 前端变式任务 DTO
 */
function mapJob(row: JobRow): VariantJobDto {
  return {
    id: Number(row.id),
    questionId: row.question_id,
    subject: row.subject,
    chapter: row.chapter,
    stem: row.stem,
    status: row.status,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/**
 * 入队（幂等）到 variant_jobs 表：同一题在 queued/running 状态时不重复排队；
 * done 状态下重复调用会重新排队，用于手动补充新一套变式。
 * @param questionId 题目 id
 * @returns 任务 DTO 与本次是否真正入队（enqueued）
 */
export async function enqueue(questionId: string): Promise<{ job: VariantJobDto; enqueued: boolean }> {
  const updated = await many<JobRow>(
    `INSERT INTO variant_jobs (question_id, status)
     VALUES ($1, 'queued')
     ON CONFLICT (question_id) DO UPDATE
       SET status = 'queued', error = NULL, attempts = 0, created_at = now(),
           started_at = NULL, finished_at = NULL
       WHERE variant_jobs.status IN ('failed', 'done')
     RETURNING *`,
    [questionId],
  );
  if (updated[0]) {
    return { job: mapJob(updated[0]), enqueued: true };
  }
  const existing = await one<JobRow>(`SELECT * FROM variant_jobs WHERE question_id = $1`, [questionId]);
  return { job: mapJob(existing!), enqueued: false };
}

/**
 * 领取下一个 queued 任务：用 FOR UPDATE SKIP LOCKED 并发安全地取一条，置为 running、attempts +1。
 * @returns 领取到的任务行，队列为空返回 null
 */
export async function claimNext(): Promise<JobRow | null> {
  const rows = await many<JobRow>(
    `UPDATE variant_jobs
        SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM variant_jobs
         WHERE status = 'queued'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
  );
  return rows[0] ?? null;
}

/**
 * 将 variant_jobs 表中某题任务标记为 done，清空错误并写完成时间。
 * @param questionId 题目 id
 */
export async function markDone(questionId: string): Promise<void> {
  await query(
    `UPDATE variant_jobs SET status = 'done', error = NULL, finished_at = now() WHERE question_id = $1`,
    [questionId],
  );
}

/**
 * 将 variant_jobs 表中某题任务标记为 failed，记录错误（截断至 800 字）并写完成时间。
 * @param questionId 题目 id
 * @param error 错误信息
 */
export async function markFailed(questionId: string, error: string): Promise<void> {
  await query(
    `UPDATE variant_jobs SET status = 'failed', error = $2, finished_at = now() WHERE question_id = $1`,
    [questionId, error.slice(0, 800)],
  );
}

/**
 * 重置 variant_jobs 表中卡住的 running 任务（开始时间超过 10 分钟）为 queued，供重新领取。
 * @returns 被重置的任务数量
 */
export async function resetStaleRunning(): Promise<number> {
  const rows = await many<{ id: string }>(
    `UPDATE variant_jobs SET status = 'queued', started_at = NULL
      WHERE status = 'running' AND started_at < now() - interval '10 minutes'
      RETURNING id`,
  );
  return rows.length;
}

/**
 * 变式任务概览：统计 variant_jobs 各状态数量，并取最近 30 条任务（关联 questions 取科目/章节/题干片段）。
 * @returns 各状态计数与最近任务 DTO 列表
 */
export async function progress(): Promise<VariantProgress> {
  const counts = await many<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM variant_jobs GROUP BY status`,
  );
  const summary = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const c of counts) {
    if (c.status in summary) summary[c.status as keyof typeof summary] = c.count;
  }
  const rows = await many<JobRow>(
    `SELECT j.*, q.subject, q.chapter, left(q.text_body, 120) AS stem
       FROM variant_jobs j JOIN questions q ON q.id = j.question_id
      ORDER BY j.id DESC LIMIT 30`,
  );
  return { counts: summary, jobs: rows.map(mapJob) };
}

/**
 * 统计 variant_jobs 表中活跃任务（queued + running）数量，用于 Worker 并发控制。
 * @returns 活跃任务数
 */
export async function activeCount(): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM variant_jobs WHERE status IN ('queued','running')`,
  );
  return Number(row?.count ?? 0);
}
