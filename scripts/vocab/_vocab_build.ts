// 把逐栏 OCR 结果合并成词表：按页排序、页内去重、清洗字段，输出 F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/vocab.json
// 用法：npx tsx scripts/_vocab_build.ts
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/ocr';
const OUT = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/vocab.json';

interface Entry {
  word: string;
  phonetic: string;
  meaning: string;
}

interface Crop {
  key: string;
  pageNo: number | null;
  count: number;
  entries: Entry[];
}

function load(): Crop[] {
  return fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')))
    .map((c: any) => ({ key: c.key, pageNo: c.pageNo ?? null, count: c.count ?? 0, entries: c.entries ?? [] }));
}

/** s005-L1 → { sheet: 5, side: 'L', col: 1 } */
function parseKey(key: string) {
  const m = key.match(/^s(\d+)-([LR])(\d)$/);
  if (!m) return null;
  return { sheet: Number(m[1]), side: m[2] as 'L' | 'R', col: Number(m[3]) };
}

function cleanWord(raw: string): string {
  let w = raw.replace(/\s+/g, ' ').trim();
  w = w.replace(/^[\d.、,)（(]+/, '').trim();
  w = w.replace(/[.,;:]+$/, '').trim();
  return w;
}

function cleanPhonetic(raw: string): string {
  let p = (raw ?? '').trim();
  if (!p || p === '-') return '';
  p = p.replace(/^\[?|\]?$/g, '');
  p = p.replace(/[{}]/g, '');
  return p ? `[${p}]` : '';
}

function cleanMeaning(raw: string): string {
  return (raw ?? '')
    .replace(/\s*\|\s*/g, '｜')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function main() {
  const crops = load();
  console.log('读到栏数:', crops.length);

  // 按页号归并；没有页号的（封面/目录）按纸序放到最后
  const pages = new Map<string, { pageNo: number | null; crops: { crop: Crop; meta: ReturnType<typeof parseKey> }[] }>();
  for (const crop of crops) {
    const meta = parseKey(crop.key);
    if (!meta) continue;
    const pageKey = `${meta.sheet}-${meta.side}`;
    if (!pages.has(pageKey)) pages.set(pageKey, { pageNo: crop.pageNo, crops: [] });
    pages.get(pageKey)!.crops.push({ crop, meta });
    if (crop.pageNo != null) pages.get(pageKey)!.pageNo = crop.pageNo;
  }

  const sorted = [...pages.entries()].sort((a, b) => {
    const pa = a[1].pageNo;
    const pb = b[1].pageNo;
    if (pa != null && pb != null && pa !== pb) return pa - pb;
    if (pa != null && pb == null) return -1;
    if (pa == null && pb != null) return 1;
    const ma = a[1].crops[0].meta!;
    const mb = b[1].crops[0].meta!;
    if (ma.sheet !== mb.sheet) return ma.sheet - mb.sheet;
    return ma.side === mb.side ? 0 : ma.side === 'L' ? -1 : 1;
  });

  const seen = new Map<string, { word: string; phonetic: string; meaning: string; page: number | null; sort: number }>();
  const pageStats: { page: number | null; raw: number; kept: number }[] = [];
  let sortNo = 0;
  let dup = 0;

  for (const [, group] of sorted) {
    const ordered = group.crops.sort((a, b) => {
      if (a.meta!.side !== b.meta!.side) return a.meta!.side === 'L' ? -1 : 1;
      return a.meta!.col - b.meta!.col;
    });
    const rawCount = ordered.reduce((n, x) => n + x.crop.entries.length, 0);
    let kept = 0;
    for (const { crop } of ordered) {
      for (const e of crop.entries) {
        const word = cleanWord(e.word);
        if (!word || word.length > 40) continue;
        if (!/^[A-Za-z][A-Za-z\s'\-./&()]*$/.test(word)) continue;
        const key = word.toLowerCase();
        const meaning = cleanMeaning(e.meaning);
        if (seen.has(key)) {
          dup += 1;
          const prev = seen.get(key)!;
          // 同一词在相邻栏被截断重复出现时，保留释义更完整的一条
          if (meaning.length > prev.meaning.length) prev.meaning = meaning;
          continue;
        }
        seen.set(key, { word, phonetic: cleanPhonetic(e.phonetic), meaning, page: group.pageNo, sort: sortNo });
        sortNo += 1;
        kept += 1;
      }
    }
    pageStats.push({ page: group.pageNo, raw: rawCount, kept });
  }

  const list = [...seen.values()].sort((a, b) => a.sort - b.sort);
  const words = list.filter((x) => !x.word.includes(' '));
  const phrases = list.filter((x) => x.word.includes(' '));

  fs.writeFileSync(OUT, JSON.stringify(list, null, 1));
  console.log('唯一词条:', list.length, '其中单词', words.length, '短语', phrases.length, '| 去重丢弃', dup);
  console.log('空释义:', list.filter((x) => !x.meaning).length, '| 无音标:', list.filter((x) => !x.phonetic).length);
  const pagesWithNo = pageStats.filter((p) => p.page != null).map((p) => p.page!).sort((a, b) => a - b);
  console.log('识别到页码范围:', pagesWithNo[0], '~', pagesWithNo[pagesWithNo.length - 1], '共', pagesWithNo.length, '页');
  const gaps: number[] = [];
  for (let i = pagesWithNo[0]; i <= pagesWithNo[pagesWithNo.length - 1]; i += 1) {
    if (!pagesWithNo.includes(i)) gaps.push(i);
  }
  console.log('缺页码:', gaps.length ? gaps.join(',') : '无');
  console.log('--- 抽样 ---');
  list.slice(0, 5).forEach((x) => console.log(x.page, x.word, x.phonetic, '|', x.meaning.slice(0, 60)));
  list.slice(-5).forEach((x) => console.log(x.page, x.word, x.phonetic, '|', x.meaning.slice(0, 60)));
}

main();
