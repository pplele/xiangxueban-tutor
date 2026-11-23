import { many, one, query } from '../db/pool';

/** 知识分块表原始行结构；score 为检索相似度/排序分，非表字段 */
export interface ChunkRow {
  id: string | number;
  subject: string;
  chapter: string | null;
  kp_codes: string[];
  source_name: string;
  content: string;
  score?: number;
}

/** 待写入 knowledge_chunks 的分块：含向量与全文检索文本 */
export interface NewChunk {
  subject: string;
  chapter?: string | null;
  kpCodes?: string[];
  sourceName: string;
  content: string;
  embedding: number[];
  tsvText: string;
}

/**
 * 从 knowledge_chunks 表删除某科目下指定来源的全部分块（重导入前清旧数据）。
 * @param subject 科目
 * @param sourceName 来源文件名
 * @returns 删除的分块数量
 */
export async function deleteBySource(subject: string, sourceName: string): Promise<number> {
  const rows = await many<{ id: string }>(
    `DELETE FROM knowledge_chunks WHERE subject = $1 AND source_name = $2 RETURNING id`,
    [subject, sourceName],
  );
  return rows.length;
}

/**
 * 批量向 knowledge_chunks 表插入分块，逐条写入；embedding 转向量字面量，tsvText 生成全文检索向量。
 * @param chunks 待插入的分块数组（含向量与检索文本）
 * @returns 成功插入的分块数量
 */
export async function insertChunks(chunks: NewChunk[]): Promise<number> {
  let inserted = 0;
  for (const c of chunks) {
    await query(
      `INSERT INTO knowledge_chunks (subject, chapter, kp_codes, source_name, content, embedding, tsv)
       VALUES ($1,$2,$3::text[],$4,$5,$6::vector, to_tsvector('simple', $7))`,
      [
        c.subject,
        c.chapter ?? null,
        c.kpCodes ?? [],
        c.sourceName,
        c.content,
        `[${c.embedding.join(',')}]`,
        c.tsvText,
      ],
    );
    inserted += 1;
  }
  return inserted;
}

/**
 * 在 knowledge_chunks 表按向量余弦距离做相似度检索；chapter 为空则不限章节。
 * 返回列的 score = 1 - 余弦距离，越大越相似。
 * @param subject 科目
 * @param embedding 查询向量
 * @param limit 最多返回条数
 * @param chapter 可选，限定章节
 * @returns 按相似度从高到低排列的分块
 */
export async function vectorSearch(
  subject: string,
  embedding: number[],
  limit: number,
  chapter?: string | null,
): Promise<ChunkRow[]> {
  return many<ChunkRow>(
    `SELECT id, subject, chapter, kp_codes, source_name, content,
            1 - (embedding <=> $1::vector) AS score
       FROM knowledge_chunks
      WHERE subject = $2
        AND ($3::text IS NULL OR chapter = $3)
      ORDER BY embedding <=> $1::vector
      LIMIT $4`,
    [`[${embedding.join(',')}]`, subject, chapter ?? null, limit],
  );
}

/**
 * 在 knowledge_chunks 表用 to_tsquery('simple') 做全文关键词检索，按 ts_rank 排序；非法/空查询返回空数组。
 * @param subject 科目
 * @param tsQuery 全文检索查询串
 * @param limit 最多返回条数
 * @param chapter 可选，限定章节
 * @returns 按相关度从高到低排列的分块；查询异常时返回空数组
 */
export async function keywordSearch(
  subject: string,
  tsQuery: string,
  limit: number,
  chapter?: string | null,
): Promise<ChunkRow[]> {
  if (!tsQuery.trim()) return [];
  try {
    return await many<ChunkRow>(
      `SELECT id, subject, chapter, kp_codes, source_name, content,
              ts_rank(tsv, query) AS score
         FROM knowledge_chunks, to_tsquery('simple', $1) AS query
        WHERE subject = $2
          AND ($3::text IS NULL OR chapter = $3)
          AND tsv @@ query
        ORDER BY score DESC
        LIMIT $4`,
      [tsQuery, subject, chapter ?? null, limit],
    );
  } catch {
    return [];
  }
}

/**
 * 统计 knowledge_chunks 表分块总数；传入 subject 时只统计该科目。
 * @param subject 可选，科目
 * @returns 分块数量
 */
export async function countChunks(subject?: string): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM knowledge_chunks ${subject ? 'WHERE subject = $1' : ''}`,
    subject ? [subject] : [],
  );
  return Number(row?.count ?? 0);
}
