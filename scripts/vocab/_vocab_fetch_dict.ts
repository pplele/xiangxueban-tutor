// 从有道词典接口补齐考纲词表的音标与释义
// 用法：npx tsx scripts/vocab/_vocab_fetch_dict.ts [输入json] [输出json]
// 输入：[{ "word": "able", "level": "base" }, ...]
// 输出：[{ "word": "able", "phonetic": "[ˈeɪb(ə)l]", "meaning": "adj. 能够，有能力的；聪明能干的", "page": null }]
// 可断点续跑：已抓到的词直接跳过
import fs from 'node:fs';

interface In { word: string; level?: string }
interface Out { word: string; phonetic: string; meaning: string; page: number | null }

const IN = process.argv[2] ?? 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/miss.json';
const OUT = process.argv[3] ?? 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/fetched.json';
const CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

/** 简洁化释义：去掉人名词典信息，每个词性最多留 2 个义项，总长压到 70 字内 */
function simplifyMeaning(raw: string): string {
  const segs = raw
    .split('；')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('【'))   // 【名】（英）埃布尔 这类人名词条噪声
    .filter((s) => !/^（[^）]*）（[^）]*）(人名|姓氏)/.test(s));
  const kept = segs.slice(0, 2);
  let out = kept.join('；');
  if (out.length > 70) out = out.slice(0, 70).replace(/[，、]$/, '') + '…';
  return out;
}

async function fetchOne(word: string): Promise<Out | null> {
  const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d: any = await res.json();
      const w = d?.ec?.word?.[0];
      const phoneticRaw = String(w?.usphone || w?.ukphone || '').trim();
      const trs: any[] = w?.trs ?? [];
      const lines: string[] = [];
      for (const t of trs.slice(0, 2)) {
        const txt = t?.tr?.[0]?.l?.i?.[0];
        if (typeof txt !== 'string' || !txt.trim()) continue;
        const clean = simplifyMeaning(txt.trim());
        if (clean) lines.push(clean);
      }
      if (!lines.length) return null;              // 无释义，视为未获取
      return {
        word,
        phonetic: phoneticRaw ? `[${phoneticRaw}]` : '',
        meaning: lines.join(' | '),
        page: null,
      };
    } catch (e: any) {
      if (attempt === 3) {
        console.warn('失败', word, e.message);
        return null;
      }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return null;
}

async function main() {
  const inputs = JSON.parse(fs.readFileSync(IN, 'utf8')) as In[];
  const done = new Map<string, Out>();
  if (fs.existsSync(OUT)) {
    for (const x of JSON.parse(fs.readFileSync(OUT, 'utf8')) as Out[]) done.set(x.word.toLowerCase(), x);
    console.log('已抓取', done.size, '条，续跑');
  }
  const todo = inputs.filter((x) => !done.has(x.word.toLowerCase()));
  console.log('待抓取', todo.length, '条，并发', CONCURRENCY);

  let idx = 0;
  const failed: string[] = [];
  const flush = () => fs.writeFileSync(OUT, JSON.stringify([...done.values()], null, 1));

  async function worker(id: number) {
    while (idx < todo.length) {
      const cur = todo[idx];
      idx += 1;
      const r = await fetchOne(cur.word);
      if (r) {
        done.set(cur.word.toLowerCase(), r);
        if (done.size % 50 === 0) {
          flush();
          console.log(`[w${id}] 进度 ${done.size}/${inputs.length}`);
        }
      } else {
        failed.push(cur.word);
      }
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
  flush();
  console.log('完成。总计', done.size, '| 失败', failed.length);
  if (failed.length) {
    console.log('失败词:', failed.slice(0, 40).join(', '));
    fs.writeFileSync('F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/failed.json', JSON.stringify(failed, null, 1));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
