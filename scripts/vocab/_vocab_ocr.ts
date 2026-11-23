// 批量识别单词页的每一栏：256 个裁剪图，结果落盘可续跑
// 用法：npx tsx scripts/_vocab_ocr.ts
import fs from 'node:fs';
import path from 'node:path';
import { describeImage } from '../../apps/server/src/agent/llm';

const SRC = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/pages';
const OUT = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/ocr';
fs.mkdirSync(OUT, { recursive: true });

const PROMPT = [
  '这是英语词汇书扫描页的一栏（左栏或右栏）。请从上到下逐条转录这一栏里的所有词条，不要漏、不要改顺序。',
  '每条一行，格式严格为：单词 | 音标 | 词性及中文释义',
  '规则：',
  '1. 音标照抄，用方括号括起；没有音标的短语条目音标写 -',
  '2. 释义照抄中文，保留 ①②③ 等序号和 [pl.]、&、adj.、v. 等标记，不要翻译、不要精简、不要合并',
  '3. 例句、页码、页眉、栏目标题（如「第一部分 必背词汇」）都不要输出',
  '4. 只输出这一栏完整可见的条目，跨栏被截断的不要猜',
  '5. 最后单独一行输出：PAGE|页码，页码取页脚中间的数字（例如 - 12 - 就写 12），看不到写 PAGE|?',
  '只输出词条行和最后的 PAGE 行，不要任何说明。',
].join('\n');

function parse(raw: string) {
  const entries: { word: string; phonetic: string; meaning: string }[] = [];
  let pageNo: number | null = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const pm = t.match(/^PAGE\s*\|\s*(\d{1,3}|\?)/i);
    if (pm) {
      pageNo = pm[1] === '?' ? null : Number(pm[1]);
      continue;
    }
    const parts = t.replace(/｜/g, '|').split('|').map((s) => s.trim());
    if (parts.length < 2) continue;
    const word = parts[0];
    if (!/[A-Za-z]/.test(word)) continue;
    if (word.length > 60) continue;

    // 模型偶尔只给一个竖线，把音标和释义一起塞进第二段；这里再拆一次，
    // 否则音标字段会吞掉整条释义、meaning 变成空
    let rest = parts.slice(1).join(' | ').trim();
    let phonetic = '';
    const ph = rest.match(/^\[([^\]]{0,60})\]\s*([\s\S]*)$/);
    if (ph) {
      phonetic = ph[1];
      rest = ph[2];
    }
    // raw 为 `word | [ipa] | 释义` 时释义会残留开头的竖线，去掉
    rest = rest.replace(/^[\s|｜]+/, '').trim();
    if (!rest) continue;
    entries.push({ word, phonetic, meaning: rest });
  }
  return { entries, pageNo };
}

async function one(key: string) {
  const outFile = path.join(OUT, `${key}.json`);
  if (fs.existsSync(outFile)) return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const b64 = fs.readFileSync(path.join(SRC, `${key}.jpg`)).toString('base64');
  let raw = '';
  let err = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      raw = await describeImage(b64, PROMPT, { maxTokens: 2048, temperature: 0 });
      break;
    } catch (e) {
      err = (e as Error).message;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  const parsed = parse(raw);
  const result = { key, pageNo: parsed.pageNo, count: parsed.entries.length, entries: parsed.entries, raw, err };
  fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
  return result;
}

async function main() {
  const keys = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => f.replace(/\.jpg$/, ''))
    .sort();
  console.log('待处理', keys.length, '栏');

  let cursor = 0;
  let done = 0;
  const bad: string[] = [];

  async function worker() {
    while (cursor < keys.length) {
      const key = keys[cursor];
      cursor += 1;
      const t0 = Date.now();
      try {
        const r = await one(key);
        done += 1;
        const flag = r.count === 0 ? ' ⚠️空' : r.err ? ' ❌' + r.err.slice(0, 30) : '';
        if (done % 10 === 0 || r.count === 0) {
          console.log(`[${done}/${keys.length}] ${key} ${r.count}条 页${r.pageNo ?? '?'} ${Date.now() - t0}ms${flag}`);
        }
        if (r.err || r.count === 0) bad.push(key);
      } catch (e) {
        console.error(key, '失败', (e as Error).message);
        bad.push(key);
      }
    }
  }

  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log('完成。异常栏:', bad.length ? bad.join(',') : '无');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
