import { pool } from '../db/pool';

/** /vocab「我的作文」里的一篇作文 */
export interface EnglishEssay {
  id: string;
  title: string;
  prompt: string;
  genre: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** english_essays 表原始行 */
interface EssayRow {
  id: string;
  title: string;
  prompt: string;
  genre: string;
  body: string;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

/**
 * 数据库行 → 对外结构（时间转 ISO，数组字段兜底）。
 * @param row english_essays 查询结果行
 * @returns 作文对象
 */
function toEssay(row: EssayRow): EnglishEssay {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    genre: row.genre,
    body: row.body,
    tags: row.tags ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * 读取某学生的全部作文，按最近修改倒序。
 * @param username 用户名
 * @returns 作文列表
 */
export async function listEssays(username: string): Promise<EnglishEssay[]> {
  const { rows } = await pool.query<EssayRow>(
    `SELECT * FROM english_essays WHERE username = $1 ORDER BY updated_at DESC, created_at DESC`,
    [username],
  );
  return rows.map(toEssay);
}

/**
 * 读取单篇作文（带 username 越权校验）。
 * @param id 作文 id
 * @param username 用户名
 * @returns 作文，不存在返回 null
 */
export async function getEssay(id: string, username: string): Promise<EnglishEssay | null> {
  const { rows } = await pool.query<EssayRow>(
    `SELECT * FROM english_essays WHERE id = $1 AND username = $2`,
    [id, username],
  );
  return rows[0] ? toEssay(rows[0]) : null;
}

/** 新建/更新作文的可写字段 */
export interface EssayInput {
  title: string;
  prompt: string;
  genre: string;
  body: string;
  tags: string[];
}

/**
 * 插入一篇作文。
 * @param username 用户名
 * @param input 作文内容
 * @returns 新建的作文
 */
export async function createEssay(username: string, input: EssayInput): Promise<EnglishEssay> {
  const { rows } = await pool.query<EssayRow>(
    `INSERT INTO english_essays (username, title, prompt, genre, body, tags)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [username, input.title, input.prompt, input.genre, input.body, input.tags],
  );
  return toEssay(rows[0]);
}

/** 局部更新：只覆盖传入的字段 */
export type EssayPatch = Partial<EssayInput>;

/**
 * 更新一篇作文并刷新 updated_at（带 username 越权校验）。
 * @param id 作文 id
 * @param username 用户名
 * @param patch 待更新字段
 * @returns 更新后的作文，不存在返回 null
 */
export async function updateEssay(
  id: string,
  username: string,
  patch: EssayPatch,
): Promise<EnglishEssay | null> {
  const { rows } = await pool.query<EssayRow>(
    `UPDATE english_essays
        SET title   = COALESCE($3, title),
            prompt  = COALESCE($4, prompt),
            genre   = COALESCE($5, genre),
            body    = COALESCE($6, body),
            tags    = COALESCE($7, tags),
            updated_at = now()
      WHERE id = $1 AND username = $2
      RETURNING *`,
    [
      id,
      username,
      patch.title ?? null,
      patch.prompt ?? null,
      patch.genre ?? null,
      patch.body ?? null,
      patch.tags ?? null,
    ],
  );
  return rows[0] ? toEssay(rows[0]) : null;
}

/**
 * 删除一篇作文（带 username 越权校验）。
 * @param id 作文 id
 * @param username 用户名
 * @returns 是否删除成功
 */
export async function deleteEssay(id: string, username: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM english_essays WHERE id = $1 AND username = $2`,
    [id, username],
  );
  return (rowCount ?? 0) > 0;
}
