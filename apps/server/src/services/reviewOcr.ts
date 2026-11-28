/**
 * 复习单词 · 照片识别：
 *   手写单词表照片 → 视觉模型逐行转录 → 结构化词条（英文词条 + 中文释义 + 单词/短语）
 * 识别结果不直接落库，先回前端给用户核对/删改，再调用导入接口，避免手写体误识别污染词表。
 */
import { describeImage } from '../agent/llm';
import { parseLooseJson } from '../lib/json';
import { badRequest } from '../lib/errors';
import { logger } from '../lib/logger';

/** 视觉模型词表转录 System Prompt */
const OCR_PROMPT = [
  '你在把一张手写英语单词/短语笔记照片转录成结构化词条，供专升本学生背单词用。',
  '',
  '只输出 JSON 数组，每个元素形如：',
  '[{"term":"abandon","meaning":"放弃","kind":"word"},{"term":"at the risk of","meaning":"冒…的风险","kind":"phrase"}]',
  '',
  '规则：',
  '1. term 只放英文词条本身。单词照抄并修正明显手写笔误（如 cigaret→cigarette、Se detary→secretary）；',
  '   固定搭配/短语（如 at the cost of、charge sb with sth、keep in shape）整条作为一个 term，kind 填 phrase。',
  '2. meaning 放同一行里的中文释义（如「一次」「失控」「绝不，一点也不」），没有就空字符串 ""。不要自己翻译、不要补充。',
  '3. 忽略：勾选符号 ✓、划掉重写的痕迹、红笔批注、页眉页码、L1/L2/L3 之类的分组标记、背面透过来的淡字。',
  '4. 逐行逐栏抄，不要合并、不要漏；同一词根的不同词形（administer / administration / administrative）各算一条。',
  '5. 词条里中文和英文混排时，英文进 term、中文进 meaning（如「in effect 实际上」→ term="in effect", meaning="实际上"）。',
  '6. 只输出 JSON 数组，不输出任何解释文字。',
].join('\n');

/** 识别出的单条词条 */
export interface OcrWordItem {
  term: string;
  meaning: string;
  kind: 'word' | 'phrase';
}

/** 模型可能返回 {words:[...]} 或直接 [...] */
interface RawItem {
  term?: unknown;
  word?: unknown;
  meaning?: unknown;
  kind?: unknown;
}

/** 把模型返回的任意结构规整为词条数组并清洗 */
function normalize(data: unknown): OcrWordItem[] {
  let arr: unknown[] = [];
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['words', 'items', 'list', 'terms', 'data']) {
      if (Array.isArray(obj[key])) { arr = obj[key] as unknown[]; break; }
    }
  }
  const out: OcrWordItem[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as RawItem;
    const term = String(r.term ?? r.word ?? '').trim().replace(/\s+/g, ' ');
    if (!term) continue;
    // 只保留含英文字母的词条，滤掉纯中文/纯数字行
    if (!/[a-zA-Z]/.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const meaning = String(r.meaning ?? '').trim().slice(0, 80);
    const kind: 'word' | 'phrase' = String(r.kind) === 'phrase' || /[\s/]+/.test(term.trim()) ? 'phrase' : 'word';
    out.push({ term, meaning, kind });
  }
  return out;
}

/**
 * 识别手写单词表照片，返回待确认的词条列表。
 * @param imageBase64 图片 base64（可带 data URL 前缀）
 * @returns 识别出的词条
 */
export async function recognizeReviewWords(imageBase64: string): Promise<OcrWordItem[]> {
  // 智谱视觉模型 max_tokens 上限为 2048，超过会返回 400；词表一页约 100 词，2048 足够
  const raw = await describeImage(imageBase64, OCR_PROMPT, { maxTokens: 2048, temperature: 0 });
  let items: OcrWordItem[] = [];
  try {
    items = normalize(parseLooseJson<unknown>(raw));
  } catch {
    logger.warn({ event: 'review_ocr_json_failed' }, '[review] 词表识别结果不是合法 JSON');
  }
  if (items.length === 0) throw badRequest('没能识别出单词，请换张更清晰的照片或手动输入');
  return items;
}
