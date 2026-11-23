/** 固定搭配学习：卡片数据与掌握进度的数据访问层 */
import { one, many, pool } from '../db/pool';

export interface CollocationCard {
  /** 内置搭配为 vocab_words.id（正数）；自建搭配为 -user_collocations.id（负数），避免两类 id 撞车 */
  id: number;
  word: string;
  meaning: string;
  exampleEn: string;
  exampleZh: string;
  status: string;
  seen: number;
  /** true = 用户自己添加的搭配 */
  custom: boolean;
}

/** 新增自建搭配的入参 */
export interface CustomCollocationInput {
  word: string;
  meaning: string;
  exampleEn?: string;
  exampleZh?: string;
}

/** 内置 + 自建卡片合并列表；自建排在后面，按添加时间倒序。 */
export async function listCards(username: string): Promise<CollocationCard[]> {
  const [builtin, custom] = await Promise.all([
    many<CollocationCard>(
      `SELECT w.id, w.word, w.meaning,
              w.example_en AS "exampleEn", w.example_zh AS "exampleZh",
              COALESCE(p.status,'new') AS status, COALESCE(p.seen,0) AS seen,
              false AS custom
         FROM vocab_words w
         LEFT JOIN collocation_progress p ON p.word_id=w.id AND p.username=$1
        WHERE w.kind='phrase'
        ORDER BY w.sort_no, w.id`,
      [username],
    ),
    many<CollocationCard>(
      `SELECT -c.id AS id, c.word, c.meaning,
              c.example_en AS "exampleEn", c.example_zh AS "exampleZh",
              c.status, c.seen, true AS custom
         FROM user_collocations c
        WHERE c.username=$1
        ORDER BY c.created_at DESC, c.id DESC`,
      [username],
    ),
  ]);
  return [...builtin, ...custom];
}

/**
 * 保存单条搭配的学习状态：seen+1，status 取三选一。
 * id 为负数时是自建搭配，进度直接写在自己的行上。
 */
export async function upsertProgress(
  username: string,
  wordId: number,
  status: 'new' | 'learning' | 'known',
): Promise<void> {
  if (wordId < 0) {
    await pool.query(
      `UPDATE user_collocations
          SET status=$3, seen=seen+1, updated_at=now()
        WHERE id=$2 AND username=$1`,
      [username, -wordId, status],
    );
    return;
  }
  await pool.query(
    `INSERT INTO collocation_progress (username, word_id, status, seen, updated_at)
     VALUES ($1,$2,$3,1,now())
     ON CONFLICT (username, word_id) DO UPDATE
       SET status=EXCLUDED.status, seen=collocation_progress.seen+1, updated_at=now()`,
    [username, wordId, status],
  );
}

/** 重置当前用户的搭配学习进度（内置 + 自建）。 */
export async function resetProgress(username: string): Promise<void> {
  await pool.query(`DELETE FROM collocation_progress WHERE username=$1`, [username]);
  await pool.query(
    `UPDATE user_collocations SET status='new', seen=0, updated_at=now() WHERE username=$1`,
    [username],
  );
}

/** 学习统计：内置 + 自建的总数与三档数量。 */
export async function stats(username: string): Promise<{ total: number; newCount: number; learning: number; known: number; studied: number }> {
  const row = await one<{ total: string; new_count: string; learning: string; known: string; studied: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status='new')::text AS new_count,
            count(*) FILTER (WHERE status='learning')::text AS learning,
            count(*) FILTER (WHERE status='known')::text AS known,
            count(*) FILTER (WHERE studied)::text AS studied
       FROM (
              SELECT COALESCE(p.status,'new') AS status, (p.word_id IS NOT NULL) AS studied
                FROM vocab_words w
                LEFT JOIN collocation_progress p ON p.word_id=w.id AND p.username=$1
               WHERE w.kind='phrase'
              UNION ALL
              SELECT status, (seen > 0) AS studied
                FROM user_collocations
               WHERE username=$1
            ) t`,
    [username],
  );
  return {
    total: Number(row?.total ?? 0),
    newCount: Number(row?.new_count ?? 0),
    learning: Number(row?.learning ?? 0),
    known: Number(row?.known ?? 0),
    studied: Number(row?.studied ?? 0),
  };
}

/**
 * 新增一条自建搭配；同账号下短语已存在时不插入，返回 null 让路由报"已添加过"。
 * @returns 新卡片（id 为负数），或 null 表示重复
 */
export async function createCustom(
  username: string,
  input: CustomCollocationInput,
): Promise<CollocationCard | null> {
  const { rows } = await pool.query<{
    id: number; word: string; meaning: string; exampleEn: string; exampleZh: string;
  }>(
    `INSERT INTO user_collocations (username, word, meaning, example_en, example_zh)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (username, lower(word)) DO NOTHING
     RETURNING id, word, meaning,
               example_en AS "exampleEn", example_zh AS "exampleZh"`,
    [username, input.word, input.meaning, input.exampleEn ?? '', input.exampleZh ?? ''],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: -row.id,
    word: row.word,
    meaning: row.meaning,
    exampleEn: row.exampleEn,
    exampleZh: row.exampleZh,
    status: 'new',
    seen: 0,
    custom: true,
  };
}

/** 删除一条自建搭配（只删当前账号的；内置搭配不在表里，删不到）。 */
export async function deleteCustom(username: string, id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM user_collocations WHERE id=$1 AND username=$2`,
    [id, username],
  );
  return (rowCount ?? 0) > 0;
}
