/** 从评测结果 JSON 计算排序维度指标：top-1 / top-3 / 任一命中 expected_source 的比例 */
import fs from 'node:fs';
import path from 'node:path';

function latestResult(): string {
  const files = fs
    .readdirSync('eval/results')
    .filter((f) => f.endsWith('.json'))
    .sort();
  return path.join('eval/results', files[files.length - 1]);
}

const questions = new Map<string, { expected_source?: string | string[] }>();
for (const line of fs.readFileSync('eval/questions.jsonl', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const q = JSON.parse(line);
  questions.set(q.id, { expected_source: q.expected_source });
}

const file = process.argv[2] ?? latestResult();
const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
  limit: number;
  details: { config: string; id: string; chunks: string[] }[];
};
console.log(`结果文件：${file}（limit=${data.limit}）`);

const byConfig = new Map<string, { n: number; top1: number; top3: number; any: number }>();
for (const d of data.details) {
  const exp = questions.get(d.id)?.expected_source;
  if (!exp) continue;
  const cands = Array.isArray(exp) ? exp : [exp];
  const s = byConfig.get(d.config) ?? { n: 0, top1: 0, top3: 0, any: 0 };
  s.n += 1;
  const hits = d.chunks.map((c) => cands.some((x) => c.includes(x)));
  if (hits[0]) s.top1 += 1;
  if (hits.slice(0, 3).some(Boolean)) s.top3 += 1;
  if (hits.some(Boolean)) s.any += 1;
  byConfig.set(d.config, s);
}

const pct = (a: number, b: number) => (b === 0 ? '-' : `${((a / b) * 100).toFixed(1)}%`);
console.log('\n配置            样本  top-1   top-3   任一命中');
for (const [cfg, s] of byConfig) {
  console.log(
    `${cfg.padEnd(15)} ${String(s.n).padStart(4)}  ${pct(s.top1, s.n).padStart(6)}  ${pct(s.top3, s.n).padStart(6)}  ${pct(s.any, s.n).padStart(6)}`,
  );
}
