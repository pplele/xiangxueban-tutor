// 合并外部（Zcode 等）分批产出的词表：F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/extra-parts/*.json → F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/vocab-extra.json
// 容错：允许数组/对象包裹、允许字段名写成 translation / meaning_cn、允许带 markdown 代码块
// 用法：npx tsx scripts/vocab/_vocab_extra_merge.ts
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/extra-parts';
const OUT = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/vocab-extra.json';

interface Entry {
  word: string;
  phonetic: string;
  meaning: string;
  page: number | null;
  sort: number;
}

/** 从任意 JSON 结构里挖出条目数组 */
function pickList(json: unknown): any[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    for (const k of ['words', 'data', 'list', 'items', 'entries', 'result', 'vocabulary']) {
      if (Array.isArray(o[k])) return o[k] as any[];
    }
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/** 字段名归一化 */
function normalize(item: any) {
  const word = str(item.word ?? item.en ?? item.english ?? item.单词 ?? item.name);
  const phoneticRaw = str(item.phonetic ?? item.ipa ?? item.音标 ?? item.pronunciation);
  const meaning = str(
    item.meaning ?? item.translation ?? item.meaning_cn ?? item.cn ?? item.chinese ?? item.释义 ?? item.翻译,
  );
  const pageRaw = item.page ?? item.pageNo ?? item.页码;
  const page = Number.isFinite(Number(pageRaw)) && pageRaw !== null && pageRaw !== '' ? Number(pageRaw) : null;
  return { word, phonetic: cleanPhonetic(phoneticRaw), meaning, page };
}

/**
 * 音标清洗：
 * 1. 只取第一个 [...] 里的内容——模型常把过去式标注塞进音标字段，
 *    如 `[kʌt]（cut, cut）]`、`[miːt] (met, met)]`
 * 2. 键盘替代符统一成标准 IPA：' → ˈ（主重音）、: → ː（长音）
 */
function cleanPhonetic(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/\[([^\]]*)\]/);
  let p = m ? m[1] : raw.replace(/^\[?|\]?$/g, '');
  p = p.replace(/^[\s|｜]+/, '').trim();
  // 去掉括号注释残留（`（cut, cut）`、`（= auto）`），但保留合法的儿化标记 (r)/(t)
  p = p.replace(/[（(]([^）)]*)[）)]\s*\]?\s*$/, (whole, inner: string) => {
    const t = String(inner).trim();
    if (/[,，=]/.test(t)) return '';
    if (/^[a-z]{1,2}$/i.test(t)) return `(${t})`;
    return '';
  });
  p = p.replace(/'/g, 'ˈ').replace(/:/g, 'ː');
  return p.trim();
}

function cleanWord(raw: string): string {
  let w = raw.replace(/\s+/g, ' ').trim();
  w = w.replace(/^[\d.、,)（(]+/, '').trim();
  w = w.replace(/[.,;:]+$/, '').trim();
  return w;
}

function cleanMeaning(raw: string): string {
  return raw
    .replace(/^[\s|｜:：]+/, '')
    .replace(/\s*\|\s*/g, '｜')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('目录不存在:', SRC);
    process.exit(1);
  }
  const files = fs.readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  console.log('待合并文件:', files.length);

  const seen = new Map<string, Entry>();
  let rawCount = 0;
  let dropped = 0;
  const dropSamples: string[] = [];

  for (const f of files) {
    let text = fs.readFileSync(path.join(SRC, f), 'utf8');
    text = text.replace(/^\uFEFF/, '').replace(/```json/gi, '').replace(/```/g, '').trim();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.warn(`  跳过 ${f}：JSON 解析失败 ${(e as Error).message.slice(0, 60)}`);
      continue;
    }
    const list = pickList(json);
    console.log(`  ${f}: ${list.length} 条`);
    for (const item of list) {
      rawCount += 1;
      const n = normalize(item);
      const word = cleanWord(n.word);
      if (!word) {
        dropped += 1;
        continue;
      }
      if (word.length > 40) {
        dropped += 1;
        if (dropSamples.length < 5) dropSamples.push(`超长:${word.slice(0, 30)}`);
        continue;
      }
      if (!/^[A-Za-z][A-Za-z\s'\-./&()]*$/.test(word)) {
        dropped += 1;
        if (dropSamples.length < 5) dropSamples.push(`非法字符:${word.slice(0, 30)}`);
        continue;
      }
      const meaning = cleanMeaning(n.meaning);
      if (!meaning) {
        dropped += 1;
        if (dropSamples.length < 5) dropSamples.push(`空释义:${word}`);
        continue;
      }
      const key = word.toLowerCase();
      const phonetic = n.phonetic ? `[${n.phonetic}]` : '';
      const prev = seen.get(key);
      if (prev) {
        // 重复词保留释义更完整、音标更完整的那条
        if (meaning.length > prev.meaning.length) prev.meaning = meaning;
        if (!prev.phonetic && phonetic) prev.phonetic = phonetic;
        continue;
      }
      seen.set(key, { word, phonetic, meaning, page: n.page, sort: seen.size });
    }
  }

  const list = [...seen.values()];
  fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
  console.log('---');
  console.log('原始条目:', rawCount, '| 去重后:', list.length, '| 丢弃:', dropped);
  if (dropSamples.length) console.log('丢弃样例:', dropSamples.join(' / '));
  console.log('无音标:', list.filter((x) => !x.phonetic).length, '| 短语:', list.filter((x) => x.word.includes(' ')).length);
  console.log('输出:', OUT);
  console.log('--- 抽样 ---');
  list.slice(0, 3).forEach((x) => console.log(` ${x.word} ${x.phonetic} | ${x.meaning.slice(0, 50)}`));
  list.slice(-3).forEach((x) => console.log(` ${x.word} ${x.phonetic} | ${x.meaning.slice(0, 50)}`));
}

main();
