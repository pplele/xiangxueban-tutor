/** 常见全角字符到半角的映射表（数字、选项字母、标点） */
const FULL_WIDTH_MAP: Record<string, string> = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd',
  '．': '.', '，': ',', '：': ':', '；': ';', '（': '(', '）': ')', '－': '-', '＋': '+', '＝': '=',
};

/**
 * 把字符串中的全角数字/字母/标点转换为半角。
 * @param input 原始字符串
 * @returns 转换后的字符串
 */
export function toHalfWidth(input: string): string {
  return input.replace(/[０-９Ａ-Ｄａ-ｄ．，：；（）－＋＝]/g, (ch) => FULL_WIDTH_MAP[ch] ?? ch);
}

/**
 * 客观题判分用的宽松归一化：转半角、去公式/标点/空白、去选项前缀、转小写。
 * @param input 学生答案，可为 null/undefined
 * @returns 归一化后的答案字符串，空输入返回空串
 */
export function normalizeAnswer(input: string | null | undefined): string {
  if (!input) return '';
  return toHalfWidth(String(input))
    .replace(/\$+/g, '')
    .replace(/\\[()[\]]/g, '')
    .replace(/\s+/g, '')
    .replace(/[。；：，、,.;:!?！？]/g, '')
    .replace(/^[A-D][.．、]/, (m) => m[0])
    .toLowerCase()
    .trim();
}

/**
 * 从「B」「B. [3,5]」「选B」等形式中提取选项字母。
 * @param input 学生答案文本
 * @returns 大写选项字母（A-D），无法识别返回 null
 */
export function extractChoiceLetter(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = toHalfWidth(String(input)).trim();
  const direct = /^([A-D])(?:[.、\s）)]|$)/i.exec(text);
  if (direct) return direct[1].toUpperCase();
  const found = /(?:答案|选|应为|为)?\s*([A-D])(?:[.、\s）)]|$)/i.exec(text);
  return found ? found[1].toUpperCase() : null;
}

/**
 * 把答案文本解析为数值：支持普通小数、分数 a/b 与简单 \frac{a}{b}。
 * @param input 答案文本
 * @returns 解析出的数值；无法识别或分母为 0 时返回 null
 */
export function parseNumberLike(input: string): number | null {
  const text = normalizeAnswer(input).replace(/[，,]/g, '');
  if (!text) return null;
  // 分数 a/b
  const frac = /^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(text);
  if (frac) {
    const b = Number(frac[2]);
    if (b !== 0) return Number(frac[1]) / b;
  }
  // 简单 LaTeX 分数 \frac{a}{b}
  const latexFrac = /^\\?frac\{(-?\d+(?:\.\d+)?)\}\{(-?\d+(?:\.\d+)?)\}$/.exec(normalizeAnswer(input).replace(/\s/g, ''));
  if (latexFrac) {
    const b = Number(latexFrac[2]);
    if (b !== 0) return Number(latexFrac[1]) / b;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return null;
}

/**
 * 判断两个答案的数值是否相等（容差 1e-9）。
 * @param a 答案 A
 * @param b 答案 B
 * @returns 均能解析为数值且差值小于容差时返回 true
 */
export function isNumericEqual(a: string, b: string): boolean {
  const na = parseNumberLike(a);
  const nb = parseNumberLike(b);
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) < 1e-9;
}

/**
 * 截断文本到指定长度，超出部分以省略号替代。
 * @param text 原始文本
 * @param max 最大保留字符数
 * @returns 截断后的文本
 */
export function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 等待指定毫秒后 resolve（用于重试退避）。
 * @param ms 等待毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 转义 SQL LIKE 模式中的通配符（\ % _），防止其被当作模式匹配。
 * @param input 原始字符串
 * @returns 转义后的字符串
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 把日期格式化为 YYYY-MM-DD（本地时区）。
 * @param d 日期对象
 * @returns 格式化日期字符串
 */
export function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 计算日期 a 到日期 b 之间相隔的天数（向下取整）。
 * @param a 起始日期字符串
 * @param b 结束日期，默认当前时间
 * @returns 相隔天数；a 非法时返回 +Infinity
 */
export function daysBetween(a: string, b: Date = new Date()): number {
  const da = new Date(a);
  if (Number.isNaN(da.getTime())) return Number.POSITIVE_INFINITY;
  const ms = b.getTime() - da.getTime();
  return Math.floor(ms / (24 * 3600 * 1000));
}
