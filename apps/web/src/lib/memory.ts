/**
 * 单词趣味记忆：正文规范化。
 *
 * 记忆卡片能「点词朗读」和「翻转藏译文」，前提是正文里每个词都写成
 * `**word**（释义）`。用户往往直接写 `trust信任，truth相信`，既读不出音、
 * 翻转也藏不住——这里把这几种散写统一收成标准格式，给「标准填入」当兜底。
 *
 * 只对 proverb / similar 生效；story 是自由散文，正文里本来就可能中英混排，
 * 强行切分会把句子拆坏。
 */

type MemoryModeLike = 'story' | 'proverb' | 'similar' | string;

/** 含中文（或全角括号）才算「释义」部分 */
const CJK_START = /^[\u4e00-\u9fff（(]/;

/**
 * 一段「英文 + 中文释义」的匹配：
 *  - 英文开头，最多 4 个词，允许连字符/撇号/点
 *  - 中间可有 : ： - – — 分隔，也可直接黏在一起（trust信任）
 *  - 后半段以中文或全角括号开头
 */
const PAIR_RE = /^([A-Za-z][A-Za-z'’\-. ]{0,40}?)\s*[：:\-–—]?\s*([\u4e00-\u9fff（(].*)$/;

/** 中文说明行前缀：翻转时整行一起藏起来 */
const NOTE_PREFIX = /^(译|辨|记|例|注|总结|例句)[：:]/;

/**
 * 规范化一行：把散写的词义对转成 `**word**（释义）`，多组用 ` · ` 连接。
 * 已是标准格式、标题行、中文说明行、以及像句子的长行都原样返回。
 * @param raw 原始行
 * @returns 规范化后的行
 */
export function normalizeMemoryLine(raw: string): string {
  const line = raw.trim();
  if (!line) return '';
  if (line.startsWith('#')) return line;
  if (NOTE_PREFIX.test(line)) return line;
  // 已经标过 ** ** 的行交给渲染层，别动
  if (line.includes('**')) return line;
  // 太长的基本是句子，不是词条
  if (line.length > 80) return line;

  const segments = line
    .split(/[，,、;；|·]/)
    .map((s) => s.trim())
    .filter(Boolean);

  let converted = 0;
  const output = segments.map((seg) => {
    const m = seg.match(PAIR_RE);
    if (!m) return seg;
    const word = m[1].trim();
    const gloss = m[2].trim();
    if (!word || !gloss) return seg;
    if (!CJK_START.test(gloss)) return seg;
    // 英文部分超过 4 个词，视为句子而不是词条
    if (word.split(/\s+/).length > 4) return seg;
    converted += 1;
    return `**${word}**（${gloss}）`;
  });

  return converted ? output.join(' · ') : line;
}

/**
 * 规范化整段正文（逐行）。
 * @param body 原始正文
 * @param mode 记忆模式；story 模式不做处理
 * @returns 规范化后的正文
 */
export function normalizeMemoryBody(body: string, mode: MemoryModeLike): string {
  if (mode === 'story') return body;
  return body
    .split('\n')
    .map(normalizeMemoryLine)
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** 标准填入的单个词条 */
export interface MemoryPair {
  /** 英文单词/短语 */
  word: string;
  /** 中文释义 */
  gloss: string;
}

/** 标准填入的字段集合 */
export interface MemoryDraft {
  /** 近似=词组标题；谚语=英文原句 */
  headline: string;
  /** 谚语中文译文（近似模式可留空） */
  translation: string;
  /** 近似=辨析说明；谚语=记忆点 */
  note: string;
  /** 词条列表 */
  pairs: MemoryPair[];
}

/**
 * 把字段化输入拼成规范正文，保证生成内容必然支持朗读与翻转。
 * @param mode 记忆模式
 * @param draft 字段值
 * @returns 正文与错误提示（二选一）
 */
export function buildMemoryBody(
  mode: MemoryModeLike,
  draft: MemoryDraft,
): { body?: string; error?: string } {
  const headline = draft.headline.trim();
  const pairs = draft.pairs
    .map((p) => ({ word: p.word.trim(), gloss: p.gloss.trim() }))
    .filter((p) => p.word);

  if (!headline) {
    return { error: mode === 'proverb' ? '先填英文原句' : '先填词组标题' };
  }
  if (!pairs.length) {
    return { error: '至少填一个英文单词，否则这条读不出音也没法翻转' };
  }

  const renderPair = (p: MemoryPair) => (p.gloss ? `**${p.word}**（${p.gloss}）` : `**${p.word}**`);
  const lines: string[] = [`## ${headline}`];

  if (mode === 'proverb') {
    // 谚语：词条排成一行，方便整句连着读
    lines.push(pairs.map(renderPair).join(' · '));
    if (draft.translation.trim()) lines.push(`译：${draft.translation.trim()}`);
    if (draft.note.trim()) lines.push(`记：${draft.note.trim()}`);
  } else {
    // 近似：一个词一行，区别看得清
    pairs.forEach((p) => lines.push(renderPair(p)));
    if (draft.note.trim()) lines.push(`辨：${draft.note.trim()}`);
  }

  return { body: lines.join('\n') };
}
