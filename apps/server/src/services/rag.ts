import { env } from '../config/env';
import { logger } from '../lib/logger';
import { tokenize, toTsQuery } from '../lib/tokenize';
import { parseLooseJson } from '../lib/json';
import * as chunksRepo from '../repos/chunks';
import { listWhitelist } from '../repos/meta';
import { complete, embedTexts, rerank } from '../agent/llm';

/** 检索命中的一个知识块：内容、来源、考点及多路排序分数 */
export interface RetrievedChunk {
  id: number;
  subject: string;
  chapter: string | null;
  kpCodes: string[];
  sourceName: string;
  content: string;
  score: number;
  rrfScore?: number;
  rerankScore?: number;
}

/** 检索选项：章节过滤、是否重排序、返回条数、是否改写查询 */
export interface RetrieveOptions {
  chapter?: string | null;
  rerank?: boolean;
  topK?: number;
  rewrite?: boolean;
}

/**
 * 检索结果：chunks 为最终结果，queries 为实际检索用查询，rerankApplied 表示是否用上重排序，
 * degraded 标记降级原因（rerank_fallback / rerank_low_discrimination / embedding_fallback / no_rerank_config），ms 为耗时。
 */
export interface RetrieveResult {
  chunks: RetrievedChunk[];
  queries: string[];
  rerankApplied: boolean;
  degraded?: 'rerank_fallback' | 'rerank_low_discrimination' | 'embedding_fallback' | 'no_rerank_config';
  ms: number;
}

/**
 * 把长文本切成约 500 字、50 字重叠的块，优先在句末断开，过短片段（<20 字）丢弃。
 * @param text 原始文本
 * @param size 每块目标字数
 * @param overlap 相邻块重叠字数
 * @returns 切块字符串数组
 */
export function chunkText(text: string, size = 500, overlap = 50): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < clean.length) {
    let end = Math.min(pos + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(pos + Math.floor(size * 0.5), end);
      const lastBreak = Math.max(
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('；'),
        window.lastIndexOf('\n'),
      );
      if (lastBreak >= 0) end = pos + Math.floor(size * 0.5) + lastBreak + 1;
    }
    const piece = clean.slice(pos, end).trim();
    if (piece.length >= 20) chunks.push(piece);
    if (end >= clean.length) break;
    pos = Math.max(end - overlap, pos + 1);
  }
  return chunks;
}

/**
 * 用 LLM 把口语化问题改写成 1-2 条适合检索的短查询（补全术语）。
 * LLM 失败时兜底返回原问题，不阻断检索。
 * @param question 学生原始问题
 * @returns 改写后的查询列表（至少含原问题）
 */
async function rewriteQuery(question: string): Promise<string[]> {
  try {
    const { content } = await complete(
      [
        {
          role: 'system',
          content:
            '你是湖南专升本知识库的检索查询改写器。把学生口语化的问题改写成 1-2 条适合全文检索的短查询，' +
            '补全可能的专业术语，保留原意，不要回答问题。只输出 JSON：{"queries":["查询1","查询2"]}',
        },
        { role: 'user', content: question },
      ],
      { temperature: 0.1, maxTokens: 200, jsonMode: true },
    );
    const data = parseLooseJson<{ queries?: unknown }>(content);
    const list = Array.isArray(data.queries)
      ? data.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 2)
      : [];
    return list.length > 0 ? list : [question];
  } catch (err) {
    logger.debug({ err: (err as Error).message }, '[rag] query rewrite failed, use original');
    return [question];
  }
}

/**
 * RRF（倒数排序融合）：把多路召回的排名列表按 1/(k+排名) 累加成统一分数。
 * @param lists 每路召回的 {id, rank} 列表
 * @param k 平滑常数
 * @returns 文档 id 到融合分数的映射
 */
function rrfFuse(lists: { id: number; rank: number }[][], k = 60): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const item of list) {
      scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + item.rank + 1));
    }
  }
  return scores;
}

/** 按 id 去重，保留首次出现顺序 */
function dedupeById<T extends { id: number | string }>(items: T[]): T[] {
  const seen = new Set<number | string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * 知识库检索主流程：查询改写 → 向量检索 + 关键词检索双路召回 → RRF 融合 → 重排序。
 * 兜底链：embedding 不可用退化为纯关键词（embedding_fallback）；rerank 分数 saturated（区分度<0.02）
 * 或服务失败/未配置时回退到 RRF 融合序，并在 degraded 中标明原因。
 * @param subject 科目
 * @param question 学生问题
 * @param options 检索选项
 * @returns 命中块、实际查询、是否重排序、降级原因与耗时
 */
export async function retrieve(
  subject: string,
  question: string,
  options: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const started = Date.now();
  const rewrite = options.rewrite ?? true;
  const queries = rewrite ? await rewriteQuery(question) : [question];
  const allQueries = [...new Set([question, ...queries])].slice(0, 3);

  const vectorLists: chunksRepo.ChunkRow[][] = [];
  const keywordLists: chunksRepo.ChunkRow[][] = [];
  let degraded: RetrieveResult['degraded'];
  let embeddingOk = true;

  let embeddings: number[][] = [];
  try {
    embeddings = await embedTexts(allQueries);
  } catch (err) {
    embeddingOk = false;
    degraded = 'embedding_fallback';
    logger.warn(
      { event: 'embedding_fallback', subject, err: (err as Error).message },
      '[rag] embedding unavailable, keyword-only retrieval',
    );
  }

  for (let i = 0; i < allQueries.length; i++) {
    const q = allQueries[i];
    if (embeddingOk && embeddings[i]) {
      try {
        const rows = await chunksRepo.vectorSearch(subject, embeddings[i], env.rag.topKVector, options.chapter ?? null);
        vectorLists.push(rows);
      } catch (err) {
        logger.warn({ event: 'vector_search_error', err: (err as Error).message }, '[rag] vector search failed');
      }
    }
    const tokens = tokenize(q);
    if (tokens.length > 0) {
      const rows = await chunksRepo.keywordSearch(
        subject,
        toTsQuery(tokens),
        env.rag.topKKeyword,
        options.chapter ?? null,
      );
      keywordLists.push(rows);
    }
  }

  const vectorRows = dedupeById(vectorLists.flat());
  const keywordRows = dedupeById(keywordLists.flat());
  if (vectorRows.length === 0 && keywordRows.length === 0) {
    return { chunks: [], queries: allQueries, rerankApplied: false, degraded, ms: Date.now() - started };
  }

  const byId = new Map<number, chunksRepo.ChunkRow>();
  for (const row of [...vectorRows, ...keywordRows]) byId.set(Number(row.id), row);
  const fused = rrfFuse(
    [
      vectorRows.map((r, idx) => ({ id: Number(r.id), rank: idx })),
      keywordRows.map((r, idx) => ({ id: Number(r.id), rank: idx })),
    ],
    env.rag.rrfK,
  );
  const fusedRows = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(12, env.rag.topKFinal * 2))
    .map(([id, score]) => ({ row: byId.get(id)!, rrf: score }))
    .filter((x) => x.row);

  const topK = options.topK ?? env.rag.topKFinal;
  const wantRerank = options.rerank ?? env.switches.rerank;
  let finalRows: RetrievedChunk[];
  let rerankApplied = false;

  if (wantRerank && env.rerank.baseUrl && env.rerank.apiKey) {
    try {
      const docs = fusedRows.map((x) => x.row.content.slice(0, 1600));
      const ranked = await rerank(question, docs, topK);
      // 低区分度检测：智谱 rerank 对同域文本会输出饱和分数（0.99~1.0），
      // 此时其排序信息量低于 RRF 融合序，强行采用反而更差，故探测到后回退。
      const spread = ranked.length > 1 ? ranked[0].score - ranked[ranked.length - 1].score : 1;
      if (ranked.length > 1 && spread < 0.02) {
        logger.warn(
          { event: 'rerank_saturated', subject, spread: Number(spread.toFixed(4)) },
          '[rag] rerank scores saturated, falling back to RRF order',
        );
        degraded = 'rerank_low_discrimination';
        finalRows = fusedRows.slice(0, topK).map((x) => toChunk(x.row, x.rrf, x.rrf));
      } else {
        finalRows = ranked
          .slice(0, topK)
          .map((r) => {
            const item = fusedRows[r.index];
            return toChunk(item.row, r.score, item.rrf, r.score);
          })
          .filter(Boolean) as RetrievedChunk[];
        if (finalRows.length === 0) throw new Error('rerank returned empty result');
        rerankApplied = true;
        if (degraded !== 'embedding_fallback') degraded = undefined;
      }
    } catch (err) {
      logger.warn(
        { event: 'rerank_fallback', subject, err: (err as Error).message },
        '[rag] rerank failed, falling back to RRF order',
      );
      degraded = 'rerank_fallback';
      finalRows = fusedRows.slice(0, topK).map((x) => toChunk(x.row, x.rrf, x.rrf));
    }
  } else {
    if (wantRerank) {
      degraded = degraded ?? 'no_rerank_config';
      logger.warn(
        { event: 'rerank_fallback', subject, reason: 'disabled_or_not_configured' },
        '[rag] reranker disabled/not configured, using RRF order',
      );
    }
    finalRows = fusedRows.slice(0, topK).map((x) => toChunk(x.row, x.rrf, x.rrf));
  }

  logger.info(
    {
      event: 'retrieval',
      subject,
      queries: allQueries.length,
      vector: vectorRows.length,
      keyword: keywordRows.length,
      final: finalRows.length,
      rerank: rerankApplied ? 'applied' : degraded ?? 'off',
      ms: Date.now() - started,
    },
    '[rag] retrieval done',
  );

  return { chunks: finalRows, queries: allQueries, rerankApplied, degraded, ms: Date.now() - started };
}

/** 把数据库行转换为对外的命中块结构，携带各路分数 */
function toChunk(
  row: chunksRepo.ChunkRow,
  score: number,
  rrfScore?: number,
  rerankScore?: number,
): RetrievedChunk {
  return {
    id: Number(row.id),
    subject: row.subject,
    chapter: row.chapter,
    kpCodes: row.kp_codes ?? [],
    sourceName: row.source_name,
    content: row.content,
    score,
    rrfScore,
    rerankScore,
  };
}

/** 把考点白名单拼成 Prompt 文本（编号 名称 层次 · 章节） */
function whitelistPrompt(subject: string, rows: { kp_code: string; kp_name: string; level: string | null; chapter: string }[]): string {
  return rows.map((r) => `${r.kp_code} ${r.kp_name}（${r.level ?? '掌握'}）· ${r.chapter}`).join('\n');
}

/**
 * 批量让 LLM 给切块标注考点编号（供入库与补标脚本复用）：每 8 条一批，失败批次留空，不阻断入库。
 * @param subject 科目
 * @param texts 待标注文本数组
 * @returns 与输入等长的二维数组，每项是命中考点编号
 */
export async function tagKpCodes(subject: string, texts: string[]): Promise<string[][]> {
  if (texts.length === 0) return [];
  const whitelist = await listWhitelist(subject);
  if (whitelist.length === 0) return texts.map(() => []);
  const out: string[][] = [];
  // 分批，避免大文档一次塞爆上下文；失败批次留空，不阻断入库
  for (let start = 0; start < texts.length; start += 8) {
    const batch = texts.slice(start, start + 8);
    out.push(...(await tagBatch(subject, batch, whitelist)));
  }
  return out;
}

/**
 * 标注一批文本：先整批请求；若模型未按片段数对齐（glm 系常见按句拆分标签），
 * 兜底退化为逐条标注，保证不会整批丢标签。
 */
async function tagBatch(
  subject: string,
  texts: string[],
  whitelist: Awaited<ReturnType<typeof listWhitelist>>,
): Promise<string[][]> {
  // 一次请求标注整批；模型若未按片段数对齐（glm 系常见：按句子拆分标签），
  // 则退化为逐条标注，保证不会整批丢标签
  const batch = await tagOnce(subject, texts, whitelist);
  if (batch) return batch;

  logger.warn(
    { event: 'kp_tag_retry_single', subject, size: texts.length },
    '[rag] label count mismatch, retrying one by one',
  );
  const out: string[][] = [];
  for (const text of texts) {
    const single = await tagOnce(subject, [text], whitelist);
    out.push(single ? single[0] : []);
  }
  return out;
}

/**
 * 标注一批：调用 LLM 严格返回与片段数一致的 labels（每项 1-3 个白名单考点）。
 * @returns 标注结果；调用失败或数量不匹配时返回 null
 */
async function tagOnce(
  subject: string,
  texts: string[],
  whitelist: Awaited<ReturnType<typeof listWhitelist>>,
): Promise<string[][] | null> {
  try {
    const numbered = texts.map((t, i) => `【片段${i + 1}】\n${t.slice(0, 700)}`).join('\n\n');
    const { content } = await complete(
      [
        {
          role: 'system',
          content:
            `你是湖南专升本${subject}考纲标注器。下面是考纲考点白名单（编号 名称 层次 · 章节）：\n` +
            `${whitelistPrompt(subject, whitelist)}\n\n` +
            `本次共 ${texts.length} 个片段。请判断每个片段讲解或考查的知识点，标注 1-3 个最相关的考点编号。\n` +
            `判定原则：\n` +
            `1) 只要片段涉及某考点的定义、规则、公式、用法、例句、例题或解析，就标注该考点；\n` +
            `2) 仅纯目录、封面、版权页、无教学内容的作答字母等才给空数组；不要因为片段是例题、习题解析或列表形式就不标注；\n` +
            `3) 只能使用白名单中的编号。\n` +
            `硬性要求：labels 必须恰好 ${texts.length} 个元素，第 i 个元素是第 i 个片段的考点编号数组；` +
            '不得按句子拆分、不得合并片段、不得增删元素。\n' +
            `只输出 JSON：{"labels":[["E1.9"],["E1.11","E1.3"]]}`,
        },
        { role: 'user', content: numbered },
      ],
      { temperature: 0, maxTokens: 800, jsonMode: true },
    );
    const data = parseLooseJson<{ labels?: unknown }>(content);
    const valid = new Set(whitelist.map((w) => w.kp_code));
    if (!Array.isArray(data.labels) || data.labels.length !== texts.length) return null;
    return data.labels.map((label) =>
      Array.isArray(label) ? label.filter((x): x is string => typeof x === 'string' && valid.has(x)).slice(0, 3) : [],
    );
  } catch (err) {
    logger.warn({ event: 'kp_tag_failed', subject, err: (err as Error).message }, '[rag] kp tagging skipped');
    return null;
  }
}

/** 文档入库选项：科目、原文、来源名，可选章节、指定考点、是否自动标注 */
export interface IngestOptions {
  subject: string;
  content: string;
  sourceName: string;
  chapter?: string | null;
  kpCodes?: string[];
  tagging?: boolean;
}

/** 入库结果：切块数、标注考点的块数、来源名 */
export interface IngestResult {
  chunks: number;
  kpTagged: number;
  sourceName: string;
}

/**
 * 知识库文档入库：切块 → 考点标注（或沿用指定考点/不标注）→ 批量向量化 → 先删同名来源再整批写库。
 * 换 embedding 模型或维度后需重新 ingest。
 * @param options 入库选项
 * @returns 切块与标注统计
 */
export async function ingestDocument(options: IngestOptions): Promise<IngestResult> {
  const pieces = chunkText(options.content);
  if (pieces.length === 0) return { chunks: 0, kpTagged: 0, sourceName: options.sourceName };

  let labels: string[][];
  if (options.kpCodes && options.kpCodes.length > 0) {
    labels = pieces.map(() => options.kpCodes!);
  } else if (options.tagging === false) {
    labels = pieces.map(() => []);
  } else {
    labels = await tagKpCodes(options.subject, pieces);
  }

  const whitelist = await listWhitelist(options.subject);
  const chapterByKp = new Map(whitelist.map((w) => [w.kp_code, w.chapter]));

  const embeddings = await embedTexts(pieces);
  await chunksRepo.deleteBySource(options.subject, options.sourceName);
  let inserted = 0;
  let tagged = 0;
  const batch: chunksRepo.NewChunk[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const kpCodes = labels[i] ?? [];
    if (kpCodes.length > 0) tagged += 1;
    const chapter = options.chapter || (kpCodes[0] ? chapterByKp.get(kpCodes[0]) ?? null : null);
    batch.push({
      subject: options.subject,
      chapter,
      kpCodes,
      sourceName: options.sourceName,
      content: pieces[i],
      embedding: embeddings[i],
      tsvText: tokenize(pieces[i]).join(' '),
    });
  }
  inserted = await chunksRepo.insertChunks(batch);
  logger.info(
    { event: 'kb.ingest', subject: options.subject, source: options.sourceName, chunks: inserted, tagged },
    '[rag] document ingested',
  );
  return { chunks: inserted, kpTagged: tagged, sourceName: options.sourceName };
}
