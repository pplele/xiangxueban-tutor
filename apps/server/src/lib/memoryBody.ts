/**
 * 记忆正文规范化（接口层兜底）。
 *
 * 前端「标准填入」已经保证字段化生成的正文是 `**word**（释义）`，
 * 但直接调接口、或从别处粘贴的内容可能写成 `trust信任，truth相信`，
 * 这种存进去既读不出音、翻转也藏不住。这里在写入前统一收一遍格式，
 * 让「怎么填都能用」。
 */

/** 含中文（或全角括号）才算释义部分 */
const CJK_START = /^[\u4e00-\u9fff（(]/;

/** 英文词 + 中文释义的散写形态 */
const PAIR_RE = /^([A-Za-z][A-Za-z'’\-. ]{0,40}?)\s*[：:\-–—]?\s*([\u4e00-\u9fff（(].*)$/;

/** 中文说明行前缀，整行视为译文/辨析，不拆 */
const NOTE_PREFIX = /^(译|辨|记|例|注|总结|例句)[：:]/;

/**
 * 规范化一行散写词条。
 * @param raw 原始行
 * @returns 规范化后的行；非词条行原样返回
 */
export function normalizeMemoryLine(raw: string): string {
  const line = raw.trim();
  if (!line) return '';
  if (line.startsWith('#')) return line;
  if (NOTE_PREFIX.test(line)) return line;
  if (line.includes('**')) return line;
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
    if (word.split(/\s+/).length > 4) return seg;
    converted += 1;
    return `**${word}**（${gloss}）`;
  });

  return converted ? output.join(' · ') : line;
}

/**
 * 按模式规范化整段正文；故事是自由散文，不做处理。
 * @param body 原始正文
 * @param mode 记忆模式
 * @returns 规范化后的正文
 */
export function normalizeMemoryBody(body: string, mode: string): string {
  if (mode === 'story') return body;
  return body
    .split('\n')
    .map(normalizeMemoryLine)
    .filter((line) => line.trim() !== '')
    .join('\n');
}
