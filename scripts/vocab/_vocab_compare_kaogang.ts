// 比对考纲 3000 词表与库内词表的覆盖情况
// 用法：npx tsx scripts/vocab/_vocab_compare_kaogang.ts [考纲json] [缺失输出json]
// 考纲词表由 extract.py 从教育部课程标准 PDF 提取（见 README）
import fs from 'node:fs';
import { pool } from '../../apps/server/src/db/pool';

interface KG { word: string; level: string }

const KG_FILE = process.argv[2] ?? 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/kaogang.json';
const MISS_OUT = process.argv[3] ?? 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/miss.json';

async function main() {
  const kg = JSON.parse(fs.readFileSync(KG_FILE, 'utf8')) as KG[];
  const r = await pool.query(`SELECT word, lower(word) AS lw FROM vocab_words`);
  const db = new Set<string>(r.rows.map((x: any) => String(x.lw).trim()));

  // 去掉全部空白再比：PDF 抽取会把 "personal computer" 粘成 "personal co mputer"，
  // 保留空格比对会把库里正确的形式误判成缺失
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').trim();

  const hit: KG[] = [];
  const miss: KG[] = [];
  const dbNorm = new Set<string>();
  for (const w of db) dbNorm.add(norm(w));
  for (const k of kg) (dbNorm.has(norm(k.word)) ? hit : miss).push(k);

  const kgSet = new Set(kg.map((k) => norm(k.word)));
  let extra = 0;
  for (const w of dbNorm) if (!kgSet.has(w)) extra += 1;

  console.log('=== 考纲 3000 词覆盖情况 ===');
  console.log('考纲词数', kg.length);
  console.log('库中已有', hit.length, '(' + (hit.length / kg.length * 100).toFixed(1) + '%)');
  console.log('库中缺失', miss.length);
  console.log('库内总量', db.size, '| 其中考纲外', extra);

  const byLevel: Record<string, [number, number]> = {};
  for (const k of kg) {
    byLevel[k.level] = byLevel[k.level] ?? [0, 0];
    byLevel[k.level][1] += 1;
    if (dbNorm.has(norm(k.word))) byLevel[k.level][0] += 1;
  }
  console.log('=== 分级覆盖 ===');
  for (const [lv, [h, t]] of Object.entries(byLevel)) {
    console.log(` ${lv}: ${h}/${t} (${(h / t * 100).toFixed(1)}%)`);
  }

  fs.writeFileSync(MISS_OUT, JSON.stringify(miss, null, 1));
  if (miss.length) console.log('缺失词已写入', MISS_OUT, '| 前 40:', miss.slice(0, 40).map((m) => m.word).join(', '));
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
