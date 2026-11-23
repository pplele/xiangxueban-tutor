/**
 * 从库课英语教材附录三「词语搭配」抽取专升本固定搭配，生成词库 JSON。
 * 表格每行形如 | 搭配 | 释义 | 搭配 | 释义 |，一行两条，解析后按 lower(word) 去重。
 * 用法：npx tsx scripts/vocab/_build_collocations.ts
 * 输出：data/vocab/collocations.json（供 _vocab_import.ts --append 入库）
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../data/kb/english/11-附录-构词法-不规则动词-词语搭配.md');
const OUT = path.resolve(__dirname, '../../data/vocab/collocations.json');

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
let inSection = false;
const seen = new Map<string, { word: string; meaning: string }>();

function add(rawWord: string, rawMeaning: string) {
  const word = rawWord.trim().replace(/\s+/g, ' ');
  const meaning = rawMeaning.trim();
  if (!word || !meaning) return;
  // 过滤标题行/表头/分隔线/纯说明
  if (/^(搭配|释义|---)\s*$/.test(word)) return;
  if (!/[\u4e00-\u9fa5]/.test(meaning)) return;       // 释义必须含中文
  if (/^\d+[\.、]/.test(word) || word.includes('【')) return;
  if (word.length > 80) return;
  const key = word.toLowerCase();
  if (!seen.has(key)) seen.set(key, { word, meaning });
}

for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i];
  if (/^##\s+附录三\s+词语搭配/.test(l)) { inSection = true; continue; }
  if (inSection && /^##\s+附录四/.test(l)) break;
  if (!inSection) continue;
  if (!l.startsWith('|')) continue;
  const cells = l.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length >= 4) {
    add(cells[0], cells[1]);
    add(cells[2], cells[3]);
  } else if (cells.length === 2) {
    add(cells[0], cells[1]);
  }
}

const list = [...seen.values()].sort((a, b) => a.word.localeCompare(b.word));
fs.writeFileSync(OUT, JSON.stringify(list.map((x) => ({
  word: x.word,
  phonetic: '',
  meaning: x.meaning,
  page: null,
  sort: 0,
})), null, 1), 'utf8');
console.log(`抽取 ${list.length} 条固定搭配 → ${OUT}`);
