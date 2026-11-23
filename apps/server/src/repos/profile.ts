import { one, query } from '../db/pool';
import type { ExamEvent, TeacherNarrative, UserProfile } from '@tutor/shared';

/** user_profile 表（单行 id=1）原始字段：标签、考试记录、老师点评、更新时间 */
interface ProfileRow {
  labels: Record<string, unknown>;
  exam_events: ExamEvent[];
  narratives: Record<string, TeacherNarrative>;
  updated_at: Date;
}

/**
 * 从 user_profile 表读取用户画像；无记录时返回空画像（不写库）。
 * @returns 用户画像（标签、考试记录、老师点评）
 */
export async function getProfile(): Promise<UserProfile> {
  const row = await one<ProfileRow>(
    'SELECT labels, exam_events, narratives, updated_at FROM user_profile WHERE id = 1',
  );
  if (!row) {
    return { labels: {}, examEvents: [], narratives: {} };
  }
  return {
    labels: row.labels ?? {},
    examEvents: Array.isArray(row.exam_events) ? row.exam_events : [],
    narratives: row.narratives ?? {},
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * 用 jsonb || 符合并更新 user_profile.labels（只覆盖传入的键），并刷新更新时间。
 * @param patch 待合并的标签键值
 * @returns 更新后的完整用户画像
 */
export async function mergeLabels(patch: Record<string, unknown>): Promise<UserProfile> {
  await query(
    `UPDATE user_profile SET labels = labels || $1::jsonb, updated_at = now() WHERE id = 1`,
    [JSON.stringify(patch)],
  );
  return getProfile();
}

/**
 * 向 user_profile.exam_events 追加一条考试记录，最多保留最近 60 条。
 * 第二条 UPDATE 用 jsonb_array_length + WITH ORDINALITY 做裁剪（jsonb 无原生数组下标）。
 * @param event 考试事件
 * @returns 更新后的完整用户画像
 */
export async function appendExamEvent(event: ExamEvent): Promise<UserProfile> {
  await query(
    `UPDATE user_profile
        SET exam_events = COALESCE(exam_events, '[]'::jsonb) || $1::jsonb,
            updated_at = now()
      WHERE id = 1`,
    [JSON.stringify([event])],
  );
  // exam_events 是 jsonb，不能用 PG 原生数组下标/array_length；用 jsonb_array_length + WITH ORDINALITY
  await query(
    `UPDATE user_profile p
        SET exam_events = (
              SELECT COALESCE(jsonb_agg(t.e ORDER BY t.ord), '[]'::jsonb)
                FROM jsonb_array_elements(p.exam_events) WITH ORDINALITY AS t(e, ord)
               WHERE t.ord > GREATEST(jsonb_array_length(p.exam_events) - 60, 0)
            )
      WHERE p.id = 1 AND jsonb_array_length(p.exam_events) > 60`,
  );
  return getProfile();
}

/**
 * 从 user_profile.exam_events 删除指定试卷 id 对应的考试记录（删卷时保持画像一致）。
 * @param examId 试卷 id
 */
export async function removeExamEventById(examId: string): Promise<void> {
  await query(
    `UPDATE user_profile
        SET exam_events = (
              SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(exam_events, '[]'::jsonb)) e
               WHERE e->>'id' <> $1
            ),
            updated_at = now()
      WHERE id = 1`,
    [examId],
  );
}

/**
 * 用 jsonb || 合并保存某科目的老师点评到 user_profile.narratives。
 * @param subject 科目
 * @param narrative 老师点评
 * @returns 更新后的完整用户画像
 */
export async function saveNarrative(subject: string, narrative: TeacherNarrative): Promise<UserProfile> {
  await query(
    `UPDATE user_profile
        SET narratives = COALESCE(narratives, '{}'::jsonb) || $1::jsonb,
            updated_at = now()
      WHERE id = 1`,
    [JSON.stringify({ [subject]: narrative })],
  );
  return getProfile();
}

/**
 * 从 user_profile.narratives 删除某科目的老师点评（jsonb - 键；无真实数据时不应留评价）。
 * @param subject 科目
 */
export async function deleteNarrative(subject: string): Promise<void> {
  await query(
    `UPDATE user_profile
        SET narratives = COALESCE(narratives, '{}'::jsonb) - $1::text,
            updated_at = now()
      WHERE id = 1`,
    [subject],
  );
}

/**
 * 清空 user_profile 的全部考试事件与老师点评（重置画像 / 清除测试数据）。
 * @returns 清空后的完整用户画像
 */
export async function clearExamData(): Promise<UserProfile> {
  await query(
    `UPDATE user_profile
        SET exam_events = '[]'::jsonb, narratives = '{}'::jsonb, updated_at = now()
      WHERE id = 1`,
  );
  return getProfile();
}
