import { cut_for_search } from 'jieba-wasm';

/** 中文停用词表：过滤无检索意义的虚词与提问套话 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '有', '为', '对', '中', '上', '下', '里',
  '我', '你', '他', '她', '它', '这', '那', '什么', '如何', '怎么', '怎样', '为什么', '请', '问',
  '吗', '呢', '吧', '啊', '也', '都', '就', '要', '会', '能', '可以', '哪些', '哪个', '下列',
  '关于', '一个', '一下', '这个', '那个', '还有', '以及', '如果', '那么', '所以', '因为',
  '求', '计算', '判断', '说明', '解释', '老师', '题目', '问题', '一道', '帮我', '看看',
]);

/**
 * 中文分词：用 jieba 切词并过滤公式、停用词、非中英文数字与重复项。
 * @param text 原始文本
 * @returns 适合写入 tsvector 的去重词项数组
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const cleaned = text
    .replace(/\$[^$]*\$/g, ' ') // 去掉行内公式，避免把 LaTeX 命令当词
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ');
  let words: string[] = [];
  try {
    words = cut_for_search(cleaned, true);
  } catch {
    words = cleaned.split(/\s+/);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    if (!w) continue;
    if (w.length < 1) continue;
    if (STOPWORDS.has(w)) continue;
    if (/^[^\p{Script=Han}A-Za-z0-9]+$/u.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * 把文本分词后拼接为空格分隔的词串，供写入 tsvector 列。
 * @param text 原始文本
 * @returns 空格分隔的词项字符串
 */
export function toTsvText(text: string): string {
  return tokenize(text).join(' ');
}

/**
 * 把词项转成 OR 连接的 tsquery 字符串（调用方负责 cast 为 tsquery）。
 * @param tokens 词项数组
 * @returns 形如 "词1 | 词2" 的查询串，最多 24 项
 */
export function toTsQuery(tokens: string[]): string {
  const safe = tokens
    .map((t) => t.replace(/[^0-9A-Za-z一-鿿]/g, ''))
    .filter((t) => t.length > 0)
    .slice(0, 24);
  return safe.join(' | ');
}
