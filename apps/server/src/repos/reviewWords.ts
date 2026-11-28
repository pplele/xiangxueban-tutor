/** 复习单词：分块词表 + 灰黄绿红掌握状态的数据访问层 */
import { many, one, pool } from '../db/pool';
import { REVIEW_GROUP_KEYS, type ReviewStatus } from '@tutor/shared';

/** 词条对外结构 */
export interface ReviewWord {
  id: number;
  groupKey: string;
  term: string;
  meaning: string;
  kind: 'word' | 'phrase';
  status: ReviewStatus;
  /** true = 公共内置词条（照片批量导入的教材词），false = 个人上传 */
  builtin: boolean;
}

/** 单个小块统计 */
export interface ReviewGroupStat {
  key: string;
  total: number;
  gray: number;
  green: number;
  yellow: number;
  red: number;
}

/** 导入一条词条 */
export interface ReviewImportItem {
  term: string;
  meaning?: string;
  kind?: 'word' | 'phrase';
}

/** 校验 group_key 是否在白名单内，并排除未开放的句法块 */
export function isValidGroup(key: string): boolean {
  return REVIEW_GROUP_KEYS.includes(key) && !key.startsWith('question:syntax');
}

/** 全部小块的统计（含空块），前端一次性画出 10+8 个入口。 */
export async function groupStats(username: string): Promise<ReviewGroupStat[]> {
  const rows = await many<{
    group_key: string; total: string; gray: string; green: string; yellow: string; red: string;
  }>(
    `SELECT w.group_key,
            count(*)::text AS total,
            count(*) FILTER (WHERE COALESCE(p.status,'gray')='gray')::text AS gray,
            count(*) FILTER (WHERE p.status='green')::text AS green,
            count(*) FILTER (WHERE p.status='yellow')::text AS yellow,
            count(*) FILTER (WHERE p.status='red')::text AS red
       FROM review_words w
       LEFT JOIN review_progress p ON p.word_id=w.id AND p.username=$1
      WHERE w.username IN ('*', $1)
      GROUP BY w.group_key`,
    [username],
  );
  const byKey = new Map(rows.map((r) => [r.group_key, r]));
  return REVIEW_GROUP_KEYS.filter((k) => !k.startsWith('question:syntax')).map((key) => {
    const r = byKey.get(key);
    return {
      key,
      total: Number(r?.total ?? 0),
      gray: Number(r?.gray ?? 0),
      green: Number(r?.green ?? 0),
      yellow: Number(r?.yellow ?? 0),
      red: Number(r?.red ?? 0),
    };
  });
}

/** 取某小块全部词条（公共内置 + 个人上传），带当前账号的掌握状态。 */
export async function listWords(username: string, groupKey: string): Promise<ReviewWord[]> {
  if (!isValidGroup(groupKey)) return [];
  return many<ReviewWord>(
    // bigserial 经 pg 驱动默认返回字符串，显式转 int4 才能让前端拿到 number（zod 要求 number）
    `SELECT w.id::int AS id, w.group_key AS "groupKey", w.term, w.meaning, w.kind,
            COALESCE(p.status,'gray') AS status,
            (w.username='*') AS builtin
       FROM review_words w
       LEFT JOIN review_progress p ON p.word_id=w.id AND p.username=$1
      WHERE w.username IN ('*', $1) AND w.group_key=$2
      ORDER BY w.sort_no, w.id`,
    [username, groupKey],
  );
}

/**
 * 批量导入词条（照片 OCR 识别后走这里）。
 * 公共内置用 '*'，个人上传用 username；同块内按词条小写去重，已存在的不覆盖也不新增。
 * @returns 实际新增条数
 */
export async function importWords(
  username: string,
  groupKey: string,
  items: ReviewImportItem[],
  owner: '*' | string = username,
): Promise<number> {
  if (!isValidGroup(groupKey) || items.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    let sortNo = (await client.query<{ n: string }>(
      `SELECT COALESCE(MAX(sort_no),0)::text AS n FROM review_words WHERE group_key=$1 AND username=$2`,
      [groupKey, owner],
    )).rows[0]?.n ?? '0';
    let base = Number(sortNo);
    for (const it of items) {
      const term = it.term.trim();
      if (!term) continue;
      const { rowCount } = await client.query(
        `INSERT INTO review_words (username, group_key, term, meaning, kind, sort_no)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (username, group_key, lower(term)) DO NOTHING`,
        [owner, groupKey, term, (it.meaning ?? '').trim(), it.kind === 'phrase' ? 'phrase' : 'word', ++base],
      );
      inserted += rowCount ?? 0;
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 更新一个词条的掌握状态（灰/绿/黄/红），按账号隔离。 */
export async function markWord(username: string, wordId: number, status: ReviewStatus): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO review_progress (username, word_id, status, updated_at)
     SELECT $1, w.id, $3, now()
       FROM review_words w
      WHERE w.id=$2 AND w.username IN ('*', $1)
     ON CONFLICT (username, word_id) DO UPDATE
       SET status=EXCLUDED.status, updated_at=now()`,
    [username, wordId, status],
  );
  return (rowCount ?? 0) > 0;
}

/** 批量更新状态（一次点多个词时减少请求）。 */
export async function markMany(
  username: string,
  marks: { wordId: number; status: ReviewStatus }[],
): Promise<number> {
  let n = 0;
  for (const m of marks) if (await markWord(username, m.wordId, m.status)) n += 1;
  return n;
}

/** 把某小块的所有词条状态重置为灰色（重新第一轮选择）。 */
export async function resetGroup(username: string, groupKey: string): Promise<number> {
  if (!isValidGroup(groupKey)) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM review_progress p
      USING review_words w
      WHERE p.word_id=w.id AND p.username=$1 AND w.group_key=$2`,
    [username, groupKey],
  );
  return rowCount ?? 0;
}

/** 删除一条个人上传的词条（内置词条不可删）。 */
export async function deleteWord(username: string, wordId: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM review_words WHERE id=$1 AND username=$2`,
    [wordId, username],
  );
  return (rowCount ?? 0) > 0;
}

/** 某小块总词条数（含内置 + 个人），供统计兜底。 */
export async function groupTotal(username: string, groupKey: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM review_words
      WHERE group_key=$1 AND username IN ('*', $2)`,
    [groupKey, username],
  );
  return Number(row?.n ?? 0);
}
