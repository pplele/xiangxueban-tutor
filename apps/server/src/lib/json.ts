/**
 * 宽松 JSON 解析：处理模型输出中常见的代码围栏、LaTeX 反斜杠、尾逗号问题。
 */
export function parseLooseJson<T = unknown>(raw: string): T {
  if (!raw || !raw.trim()) throw new Error('empty output');
  let text = raw.trim();

  // 去掉 ```json ... ``` 围栏
  if (text.startsWith('```')) {
    const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
    if (m) text = m[1].trim();
  }

  const candidates = [text];
  // 截取第一个 { 或 [ 到最后一个 } 或 ]
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(text.slice(arrStart, arrEnd + 1));

  let lastErr: unknown = null;
  for (const candidate of candidates) {
    for (const variant of [candidate, fixCommonIssues(candidate)]) {
      try {
        return JSON.parse(variant) as T;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('invalid json');
}

/**
 * 修复模型输出 JSON 的常见非法写法：LaTeX 反斜杠、尾逗号、中文引号。
 * 先把合法转义换成占位符，避免二次转义破坏 \n 等序列。
 * @param text JSON 候选字符串
 * @returns 修补后的字符串
 */
function fixCommonIssues(text: string): string {
  return (
    text
      // 先把合法的转义序列换成占位符，避免被下面的补反斜杠二次处理
      .replace(/\\(["\\/])/g, '\u0001$1')
      .replace(/\\u([0-9a-fA-F]{4})/g, '\u0002$1')
      // \n \t 这类只有后面不接字母才算换行/制表；\frac、\tan、\beta、\nabla 都是 LaTeX
      .replace(/\\([bfnrt])(?![a-zA-Z])/g, '\u0003$1')
      // 剩下的单个反斜杠一律加倍（\frac \pi \xi …）
      .replace(/\\/g, '\\\\')
      .replace(/\u0001/g, '\\')
      .replace(/\u0002/g, '\\u')
      .replace(/\u0003/g, '\\')
      // 尾逗号
      .replace(/,\s*([}\]])/g, '$1')
      // 中文引号替换
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
  );
}

export interface LooseFields {
  text?: string;
  type?: string;
  subject?: string;
  options?: string[];
  uncertain?: string[];
  hasHandwriting?: boolean;
}

/**
 * 从索引 i 起跳过空白字符。
 * @param s 源字符串
 * @param i 起始索引
 * @returns 第一个非空白字符的索引
 */
function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

/**
 * 从引号开始读一个字符串值：只还原 \" 与 \\，其余 \x 原样保留（LaTeX 靠这一步存活）。
 * @param s 源字符串
 * @param quoteIdx 起始双引号的索引
 * @returns 解析出的值与结束索引；无闭合引号时返回 null
 */
function readQuoted(s: string, quoteIdx: number): { value: string; end: number } | null {
  if (s[quoteIdx] !== '"') return null;
  let i = quoteIdx + 1;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === '"' || next === '\\') {
        out += next;
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

/**
 * 从索引 from 起查找 "key": 模式，返回冒号后值开始的位置。
 * @param s 源字符串
 * @param key 字段名
 * @param from 起始搜索索引
 * @returns 值起始索引；未找到返回 -1
 */
function findKey(s: string, key: string, from: number): number {
  const re = new RegExp(`"${key}"\\s*:\\s*`, 'g');
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? m.index + m[0].length : -1;
}

/**
 * 读取指定字段的字符串值（基于位置扫描，不依赖合法 JSON）。
 * @param s 源字符串
 * @param key 字段名
 * @param from 起始搜索索引
 * @returns 字段值与结束索引；未找到返回 null
 */
function readStringField(s: string, key: string, from: number): { value: string; end: number } | null {
  const at = findKey(s, key, from);
  if (at < 0) return null;
  return readQuoted(s, skipWs(s, at));
}

/**
 * 读取指定字段的字符串数组值（基于位置扫描）。
 * @param s 源字符串
 * @param key 字段名
 * @param from 起始搜索索引
 * @returns 数组值与结束索引；未找到返回 null
 */
function readArrayField(s: string, key: string, from: number): { value: string[]; end: number } | null {
  const at = findKey(s, key, from);
  if (at < 0) return null;
  let i = skipWs(s, at);
  if (s[i] !== '[') return null;
  i += 1;
  const items: string[] = [];
  while (i < s.length) {
    i = skipWs(s, i);
    if (s[i] === ']') return { value: items, end: i + 1 };
    if (s[i] === ',') {
      i += 1;
      continue;
    }
    const item = readQuoted(s, i);
    if (!item) return { value: items, end: i };
    items.push(item.value);
    i = item.end;
  }
  return { value: items, end: i };
}

/**
 * 不依赖合法 JSON 的按字段提取，专治模型输出里的裸 LaTeX。
 * 例：{"text": "…$[\frac{\pi}{6}]$"} —— 严格 JSON 认为 \f 是换页符、\p 是非法转义，
 * 这里按位置扫描字符串边界，\frac 就能原样取出来。
 */
export function extractLooseFields(raw: string): LooseFields {
  const src = raw ?? '';
  const out: LooseFields = {};
  const text = readStringField(src, 'text', 0);
  if (text) out.text = text.value;
  const cursor = text ? text.end : 0;
  const type = readStringField(src, 'type', cursor);
  if (type) out.type = type.value;
  const options = readArrayField(src, 'options', cursor);
  if (options) out.options = options.value;
  const subject = readStringField(src, 'subject', cursor);
  if (subject) out.subject = subject.value;
  const uncertain = readArrayField(src, 'uncertain', cursor);
  if (uncertain) out.uncertain = uncertain.value;
  const hand = /"hasHandwriting"\s*:\s*(true|false)/.exec(src);
  if (hand) out.hasHandwriting = hand[1] === 'true';
  return out;
}
