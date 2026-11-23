import { describeImage, embedTexts } from '../agent/llm';
import { repairTex } from '@tutor/shared';
import { fingerprint as makeFingerprint } from '../lib/crypto';
import { extractLooseFields, parseLooseJson } from '../lib/json';
import { logger } from '../lib/logger';
import { badRequest } from '../lib/errors';
import { query } from '../db/pool';
import { tagKpCodes } from './rag';

/**
 * 拍照识题链路：
 *   图片 → 视觉模型转写 → 结构化题干 → （可选）考点标注
 * 刻意不做"识别完直接作答"：识别结果回给前端让用户确认，避开公式误识别。
 */

/** 视觉模型识题的 System Prompt：要求原样转写为结构化 JSON，看不清用 □ 占位 */
const OCR_PROMPT = [
  '你是专升本教材题目转写器。把图片里的题目原样转成文字，不要解题、不要补充你没看见的内容。',
  '',
  '只输出 JSON，字段如下：',
  '{',
  '  "text": "题干原文；数学公式用 $...$ LaTeX；选择题不含选项，选项放 options",',
  '  "type": "选择题 | 填空题 | 解答题 | 其他",',
  '  "options": ["A. ...", "B. ..."],',
  '  "subject": "math | english | cs",',
  '  "uncertain": [],',
  '  "hasHandwriting": true',
  '}',
  '',
  '硬性要求：',
  '1. 看不清的字用 □ 占位，并把该片段整体放进 uncertain；全部清晰时 uncertain 给空数组 []，绝不照抄本条说明。',
  '2. 多道题时只转写第一道完整题目，其余忽略。',
  '3. 不输出 JSON 以外的任何文字。',
].join('\n');

/** 识题结果：题干文本/选项/题型/科目、不确定片段与模型原始输出 */
export interface RecognizeResult {
  /** 可直接送入输入框的题目文本（含选项） */
  text: string;
  /** 题干（不含选项） */
  stem: string;
  type: string;
  options: string[];
  subject: string;
  /** 模型自己标记的不确定片段，前端用来提示"请核对" */
  uncertain: string[];
  hasHandwriting: boolean;
  /** 模型原始输出，便于排查 */
  raw: string;
}

/** 把模型输出的科目值归一化到 math/english/cs，非法则用回退值 */
function normalizeSubject(value: unknown, fallback: string): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['math', 'english', 'cs'].includes(s)) return s;
  return fallback;
}

/** 判断一段文本是不是"模型把整个 JSON 塞进来了"，这种绝不能当题干给学生看 */
function looksLikeJsonObject(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  return /"text"\s*:/.test(t) || /"options"\s*:/.test(t);
}

/** 字符串转 trim 后的字符串，非字符串返回空 */
function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 拍照识题：视觉模型转写 → 宽松提取字段（严格 JSON 常因裸 LaTeX 反斜杠失败）→ 二次兜底，
 * 识别结果不落库，由用户确认后再提问/入库。
 * @param imageBase64 图片 base64
 * @param subjectHint 科目回退提示
 * @returns 结构化简题结果
 */
export async function recognizeQuestion(imageBase64: string, subjectHint = 'math'): Promise<RecognizeResult> {
  const raw = await describeImage(imageBase64, OCR_PROMPT, { maxTokens: 1600, temperature: 0 });

  // 视觉模型输出的"JSON"经常不合法：题干里的 LaTeX 是裸反斜杠。
  // 严格解析不但会失败，\f 还会被当成换页符（\frac → 换页符+"rac"），
  // 失败后若把整段 raw 当题干，学生看到的就是一屏 JSON。所以按字段名宽松取。
  const loose = extractLooseFields(raw);
  let data: Record<string, unknown> = {};
  try {
    data = parseLooseJson<Record<string, unknown>>(raw);
  } catch {
    logger.warn({ event: 'ocr_json_loose' }, '[capture] 识题结果不是合法 JSON，按字段名宽松提取');
  }

  let stem = cleanText(loose.text) || cleanText(data.text);
  // 二次兜底：text 字段本身又被塞进了整段 JSON
  if (!stem || looksLikeJsonObject(stem)) {
    const inner = extractLooseFields(stem);
    if (inner.text && !looksLikeJsonObject(inner.text)) stem = inner.text.trim();
  }
  // 模型完全没按 JSON 输出：当成纯文本题干，但同样不能是 JSON
  if (!stem) {
    const prose = raw.replace(/^```[a-z]*\n?|```$/g, '').trim();
    if (prose && !looksLikeJsonObject(prose)) stem = prose;
  }
  if (!stem) throw badRequest('没能从图片里识别出题目，请重拍或手动输入');

  const rawOptions = loose.options && loose.options.length > 0 ? loose.options : data.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];

  const rawUncertain = loose.uncertain && loose.uncertain.length > 0 ? loose.uncertain : data.uncertain;
  const uncertain = Array.isArray(rawUncertain)
    ? rawUncertain.filter(
        (x): x is string =>
          typeof x === 'string' &&
          x.trim().length > 0 &&
          // 模型偶尔把提示词里的占位说明原样回填，过滤掉
          !/原样列出|看不清或不确定|本条说明/.test(x),
      )
    : [];

  const type = cleanText(loose.type) || cleanText(data.type);
  const hand = typeof loose.hasHandwriting === 'boolean' ? loose.hasHandwriting : data.hasHandwriting === true;
  const text = options.length > 0 ? `${stem}\n${options.join('\n')}` : stem;

  return {
    text,
    stem,
    type: type || '其他',
    options,
    subject: normalizeSubject(loose.subject || data.subject, subjectHint),
    uncertain,
    hasHandwriting: hand,
    raw,
  };
}

/** 查重返回的单条错题命中 */
export interface WrongHit {
  id: string;
  title: string;
  stem: string;
  note: string | null;
  status: string;
  /** 余弦相似度，精确命中固定为 1 */
  score: number;
  createdAt: string | null;
}

/** 查重结果：exact 为指纹完全相同的同题，similar 为向量近似的同类题 */
export interface WrongMatchResult {
  /** 指纹完全相同：同一道题，曾经错过 */
  exact: WrongHit[];
  /** 向量近似：同类型题，曾经在类似题上栽过 */
  similar: WrongHit[];
}

interface WrongRow {
  id: string;
  title: string | null;
  text_body: string;
  note: string | null;
  status: string;
  created_at: Date | null;
  score?: number;
}

/** 数据库错题行 → 对外命中结构 */
function toHit(row: WrongRow, score: number): WrongHit {
  return {
    id: row.id,
    title: row.title ?? '',
    stem: row.text_body,
    note: row.note,
    status: row.status,
    score,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
  };
}

/**
 * 错题查重：文本指纹（同一题）+ 向量相似（同类题）双层。指纹依赖文本，必须先经过识别确认环节。
 * 向量服务不可用时跳过相似查重，仍返回精确命中。
 * @param subject 科目
 * @param textBody 题干文本
 * @returns 精确命中与相似命中列表
 */
export async function matchWrong(subject: string, textBody: string): Promise<WrongMatchResult> {
  const body = textBody.trim();
  if (body.length < 4) throw badRequest('题目内容太短，无法查重');

  const fp = makeFingerprint(body);
  const exactRows = await query<WrongRow>(
    `SELECT id, title, text_body, note, status, created_at
       FROM questions
      WHERE fingerprint = $1
      ORDER BY created_at DESC
      LIMIT 3`,
    [fp],
  );

  let similar: WrongHit[] = [];
  try {
    const [vec] = await embedTexts([body.slice(0, 900)]);
    const similarRows = await query<WrongRow>(
      `SELECT id, title, text_body, note, status, created_at,
              1 - (embedding <=> $1::vector) AS score
         FROM questions
        WHERE subject = $2
          AND embedding IS NOT NULL
          AND fingerprint <> $3
        ORDER BY embedding <=> $1::vector
        LIMIT 3`,
      [`[${vec.join(',')}]`, subject, fp],
    );
    similar = similarRows.rows
      .map((r) => toHit(r, Number(r.score ?? 0)))
      .filter((r) => r.score >= 0.75);
  } catch (err) {
    logger.warn({ event: 'wrong_match_vector_failed', err: (err as Error).message }, '[capture] 向量查重跳过');
  }

  return {
    exact: exactRows.rows.map((r) => toHit(r, 1)),
    similar,
  };
}

/** 错题沉淀入参：科目、题干，可选解析/备注/考点/章节/图片/标题 */
export interface SaveWrongInput {
  subject: string;
  textBody: string;
  solution?: string | null;
  note?: string | null;
  kpCodes?: string[];
  chapter?: string | null;
  imageUrl?: string | null;
  title?: string | null;
}

/** 沉淀结果：错题 id、动作（新建/更新）、最终考点 */
export interface SaveWrongResult {
  id: string;
  action: 'created' | 'updated';
  kpCodes: string[];
}

/** 生成形如 Q-YYYYMMDD-001 的错题 id（按当天已有序号递增） */
async function nextQuestionId(): Promise<string> {
  const day = new Date();
  const ymd = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  const res = await query<{ n: number }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '^Q-[0-9]{8}-', ''), '')::int), 0) + 1 AS n
       FROM questions
      WHERE id LIKE $1`,
    [`Q-${ymd}-%`],
  );
  const seq = Number(res.rows[0]?.n ?? 1);
  return `Q-${ymd}-${String(seq).padStart(3, '0')}`;
}

/**
 * 学生学懂后把题沉淀进错题本：修复 LaTeX → 标注考点（缺省时 LLM 标注，失败跳过）→ 反查章节 →
 * 生成向量（失败跳过）。同指纹已存在则补全解析/备注/考点，不重复插入。
 * @param input 错题内容
 * @returns 错题 id、新建/更新动作与考点
 */
export async function saveWrong(input: SaveWrongInput): Promise<SaveWrongResult> {
  const bodyRaw = input.textBody.trim();
  // 视觉模型常把 `\ln(\sin x)` 输出成 `\lnsinx`，KaTeX 遇到未知命令会整段退化成源码
  const body = repairTex(bodyRaw);
  const solution = repairTex((input.solution ?? '').trim());
  const note = repairTex((input.note ?? '').trim());
  if (body.length < 4) throw badRequest('题目内容太短，无法入库');
  const subject = normalizeSubject(input.subject, 'math');
  const fp = makeFingerprint(body);

  let kpCodes = Array.isArray(input.kpCodes) ? input.kpCodes.filter((x) => typeof x === 'string' && x) : [];
  if (kpCodes.length === 0) {
    try {
      const [labels] = await tagKpCodes(subject, [body.slice(0, 900)]);
      kpCodes = labels ?? [];
    } catch (err) {
      logger.warn({ event: 'save_wrong_tag_failed', err: (err as Error).message }, '[capture] 考点标注跳过');
    }
  }

  // chapter 是 NOT NULL，拍照录入的题没有章节信息，用考点反查考纲章节名
  let chapter = (input.chapter ?? '').trim();
  if (!chapter && kpCodes.length > 0) {
    const hit = await query<{ chapter: string }>(
      `SELECT chapter FROM kp_whitelist WHERE subject = $1 AND kp_code = $2 LIMIT 1`,
      [subject, kpCodes[0]],
    );
    chapter = hit.rows[0]?.chapter?.trim() ?? '';
  }
  if (!chapter) chapter = '未归类';

  let vec: number[] | null = null;
  try {
    const [embedded] = await embedTexts([body.slice(0, 900)]);
    vec = embedded;
  } catch (err) {
    logger.warn({ event: 'save_wrong_embed_failed', err: (err as Error).message }, '[capture] 向量写入跳过');
  }

  const existing = await query<{ id: string }>(
    `SELECT id FROM questions WHERE fingerprint = $1 ORDER BY created_at DESC LIMIT 1`,
    [fp],
  );
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await query(
      `UPDATE questions
          SET solution = COALESCE(NULLIF($2, ''), solution),
              note = COALESCE(NULLIF($3, ''), note),
              kp_codes = CASE WHEN cardinality($4::text[]) > 0 THEN $4::text[] ELSE kp_codes END,
              embedding = COALESCE($5::vector, embedding),
              updated_at = now()
        WHERE id = $1`,
      [id, solution, note, kpCodes, vec ? `[${vec.join(',')}]` : null],
    );
    return { id, action: 'updated', kpCodes };
  }

  const id = await nextQuestionId();
  const title = repairTex(input.title ?? body.split('\n')[0] ?? '').slice(0, 60);
  await query(
    `INSERT INTO questions (
       id, subject, chapter, kp_codes, kp_levels, question_type, title, text_body, options,
       answer, solution, note, tags, no, fingerprint, status, source, schema_version, meta,
       embedding, image_url, created_at
     ) VALUES (
       $1,$2,$3,$4::text[],$5::text[],$6,$7,$8,NULL,
       NULL,$9,$10,$11::text[],'', $12,'待复习','miniprogram',3,$13::jsonb,
       $14::vector,$15, now()
     )`,
    [
      id,
      subject,
      chapter,
      kpCodes,
      [],
      '解答题',
      title,
      body,
      solution || null,
      note || null,
      ['拍照录入'],
      fp,
      JSON.stringify({ source: 'miniprogram-capture' }),
      vec ? `[${vec.join(',')}]` : null,
      input.imageUrl ?? null,
    ],
  );
  return { id, action: 'created', kpCodes };
}
