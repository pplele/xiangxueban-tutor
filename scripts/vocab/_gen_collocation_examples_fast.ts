/**
 * 并发版：给固定搭配批量生成例句 + 翻译（断点续跑，已生成的跳过）。
 * 5 批并发，显著快于串行版。用法：npx tsx scripts/vocab/_gen_collocation_examples_fast.ts
 */
import { pool } from '../../apps/server/src/db/pool';
import { complete } from '../../apps/server/src/agent/llm';

const BATCH = 15;
const CONCURRENCY = 5;
const FALLBACK: any = {
  modelOverride: process.env.LLM_FALLBACK_MODEL || 'glm-4-flash',
  baseUrlOverride: process.env.LLM_FALLBACK_BASE_URL,
  apiKeyOverride: process.env.LLM_FALLBACK_API_KEY || undefined,
  temperature: 0.2,
  maxTokens: 1800,
};

function parseJson(text: string): any[] | null {
  const s = text.replace(/```(?:json)?/g, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

type Row = { id: number; word: string; meaning: string };

async function genBatch(batch: Row[]): Promise<number> {
  const list = batch.map((b, i) => `${i + 1}. ${b.word} —— ${b.meaning}`).join('\n');
  const prompt = `你是湖南专升本英语老师。给下面每个固定搭配造一个简单、地道的英文例句，并给出中文翻译。
要求：
1. 例句必须用上该搭配，句子简短（8-15 词），用词基础，贴合专升本难度。
2. 中文翻译准确自然。
3. 只输出 JSON 数组，格式：[{"i":1,"en":"英文例句","zh":"中文翻译"}, ...]，序号 i 与题目一一对应，不要解释。

搭配清单：
${list}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await complete([{ role: 'user', content: prompt }], FALLBACK);
      const arr = parseJson(res.content);
      if (!arr || arr.length === 0) throw new Error('返回为空');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let j = 0; j < batch.length; j += 1) {
          const item = arr.find((x: any) => Number(x.i) === j + 1);
          if (!item?.en?.trim() || !item?.zh?.trim()) continue;
          await client.query('UPDATE vocab_words SET example_en=$1, example_zh=$2 WHERE id=$3',
            [String(item.en).trim().slice(0, 500), String(item.zh).trim().slice(0, 500), batch[j].id]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
      return batch.length;
    } catch (e: any) {
      if (attempt === 3) { console.log(`\n批次失败 ${batch[0].word}: ${e?.message ?? e}`); return 0; }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  return 0;
}

async function main() {
  const { rows } = await pool.query<Row>(
    `SELECT id, word, meaning FROM vocab_words
      WHERE kind='phrase' AND (example_en='' OR example_en IS NULL) ORDER BY id`,
  );
  console.log(`待生成 ${rows.length} 条，并发 ${CONCURRENCY}`);
  const batches: Row[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
  let done = 0, idx = 0;
  async function worker() {
    while (idx < batches.length) {
      const b = batches[idx++];
      done += await genBatch(b);
      process.stdout.write(`\r完成 ${done}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const stat = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM vocab_words WHERE kind='phrase' AND example_en<>''`);
  console.log(`\n最终：库内已有例句 ${stat.rows[0].n} 条`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
