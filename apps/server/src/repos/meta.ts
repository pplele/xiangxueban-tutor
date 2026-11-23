import { many } from '../db/pool';

/** 考点白名单表行：考点编码、名称、层级、所属章节 */
export interface KpRow {
  kp_code: string;
  kp_name: string;
  level: string | null;
  chapter: string;
}

/**
 * 从 kp_whitelist 表按科目读取考点白名单，按章节、考点编码排序。
 * @param subject 科目
 * @returns 该科目的考点列表
 */
export async function listWhitelist(subject: string): Promise<KpRow[]> {
  return many<KpRow>(
    `SELECT kp_code, kp_name, level, chapter
       FROM kp_whitelist
      WHERE subject = $1
      ORDER BY chapter, kp_code`,
    [subject],
  );
}

/**
 * 从 kp_whitelist 表读取全部科目考点，按科目、章节、考点编码排序。
 * @returns 全部考点（含所属科目）
 */
export async function listAllWhitelist(): Promise<(KpRow & { subject: string })[]> {
  return many<KpRow & { subject: string }>(
    `SELECT subject, kp_code, kp_name, level, chapter
       FROM kp_whitelist
      ORDER BY subject, chapter, kp_code`,
  );
}

/**
 * 从 kp_whitelist 表按科目 + 考点编码精确查询一个考点。
 * @param subject 科目
 * @param kpCode 考点编码
 * @returns 考点行，不存在返回 null
 */
export async function getKp(subject: string, kpCode: string): Promise<KpRow | null> {
  const rows = await many<KpRow>(
    `SELECT kp_code, kp_name, level, chapter FROM kp_whitelist WHERE subject = $1 AND kp_code = $2`,
    [subject, kpCode],
  );
  return rows[0] ?? null;
}

/**
 * 写入/更新 kp_whitelist 表考点：以 (subject, kp_code) 冲突时更新名称、层级、章节。
 * @param subject 科目
 * @param kp 考点数据
 */
export async function upsertKp(subject: string, kp: KpRow): Promise<void> {
  await many(
    `INSERT INTO kp_whitelist (subject, kp_code, kp_name, level, chapter)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subject, kp_code) DO UPDATE
       SET kp_name = EXCLUDED.kp_name, level = EXCLUDED.level, chapter = EXCLUDED.chapter`,
    [subject, kp.kp_code, kp.kp_name, kp.level, kp.chapter],
  );
}

/** 章节聚合结果：某科目某章节的考点数与该章节最小考点编码（代表作序） */
export interface ChapterAggregate {
  subject: string;
  chapter: string;
  kpCount: number;
  firstCode: string;
}

/**
 * 从 kp_whitelist 表按科目、章节聚合考点数，排除空章节。
 * @returns 各科目各章节的聚合列表
 */
export async function listChapters(): Promise<ChapterAggregate[]> {
  return many<ChapterAggregate>(
    `SELECT subject, chapter, count(*)::int AS "kpCount", min(kp_code) AS "firstCode"
       FROM kp_whitelist
      WHERE chapter <> ''
      GROUP BY subject, chapter`,
  );
}

/**
 * 从 kp_whitelist 表读取某科目某章节下的全部考点编码，按编码排序。
 * @param subject 科目
 * @param chapter 章节
 * @returns 考点编码数组
 */
export async function getChapterKps(subject: string, chapter: string): Promise<string[]> {
  const rows = await many<{ kp_code: string }>(
    `SELECT kp_code FROM kp_whitelist WHERE subject = $1 AND chapter = $2 ORDER BY kp_code`,
    [subject, chapter],
  );
  return rows.map((r) => r.kp_code);
}

/**
 * 从 kp_whitelist 表按科目 + 一组考点编码批量查询层级；空数组直接返回空。
 * @param subject 科目
 * @param kpCodes 考点编码数组
 * @returns 各考点层级（无层级用空字符串）
 */
export async function getLevelByKp(subject: string, kpCodes: string[]): Promise<string[]> {
  if (kpCodes.length === 0) return [];
  const rows = await many<{ level: string | null }>(
    `SELECT level FROM kp_whitelist WHERE subject = $1 AND kp_code = ANY($2::text[])`,
    [subject, kpCodes],
  );
  return rows.map((r) => r.level ?? '');
}
