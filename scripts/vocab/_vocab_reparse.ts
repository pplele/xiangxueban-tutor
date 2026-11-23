// 重新解析已落盘的 raw（不重新调用模型），修正 parse 缺陷后覆盖 entries
// 缺陷：raw 为 `word | [ipa] | 释义` 时，parts.slice(1).join(' | ') 会让释义残留开头的竖线
// 用法：npx tsx scripts/vocab/_vocab_reparse.ts
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/ocr';

interface Entry {
  word: string;
  phonetic: string;
  meaning: string;
}

function parse(raw: string) {
  const entries: Entry[] = [];
  let pageNo: number | null = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const pm = t.match(/^PAGE\s*\|\s*(\d{1,3}|\?)/i);
    if (pm) {
      pageNo = pm[1] === '?' ? null : Number(pm[1]);
      continue;
    }
    // 全角竖线也当分隔符
    const parts = t.replace(/｜/g, '|').split('|').map((s) => s.trim());
    if (parts.length < 2) continue;
    const word = parts[0];
    if (!/[A-Za-z]/.test(word)) continue;
    if (word.length > 60) continue;

    let rest = parts.slice(1).join(' | ').trim();
    let phonetic = '';
    const ph = rest.match(/^\[([^\]]{0,60})\]\s*([\s\S]*)$/);
    if (ph) {
      phonetic = ph[1];
      rest = ph[2];
    }
    // 关键修复：去掉释义开头残留的竖线（半角/全角）
    rest = rest.replace(/^[\s|｜]+/, '').trim();
    if (!rest) continue;
    entries.push({ word, phonetic, meaning: rest });
  }
  return { entries, pageNo };
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.json'));
let fixed = 0;
let changed = 0;

for (const f of files) {
  const p = path.join(SRC, f);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!j.raw || !j.raw.trim()) continue;
  const before = JSON.stringify(j.entries);
  const parsed = parse(j.raw);
  j.entries = parsed.entries;
  j.count = parsed.entries.length;
  if (parsed.pageNo != null) j.pageNo = parsed.pageNo;
  if (JSON.stringify(j.entries) !== before) changed += 1;
  fs.writeFileSync(p, JSON.stringify(j, null, 1));
  fixed += 1;
}

console.log('重新解析文件:', fixed, '其中结果有变化:', changed);

// 统计竖线残留
let dirty = 0;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
  for (const e of j.entries || []) if (/^[\s|｜]/.test(e.meaning)) dirty += 1;
}
console.log('释义仍以竖线开头:', dirty);
