/**
 * 给背搭配功能批量生成英文例句 + 中文翻译（写入 vocab_words.example_en / example_zh）。
 * 用 glm-4-flash 免费档，每批 15 条，已生成的自动跳过（可断点续跑）。
 * 用法：npx tsx scripts/vocab/_gen_collocation_examples.ts [--limit N]
 */
import { pool } from '../../apps/server/src/db/pool';
import { complete } from '../../apps/server/src/agent/llm';

const BATCH = 15;
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 100000;

// 走免费备援通道
const FALLBACK = {
  modelOverride: process.env.LLM_FALLBACK_MODEL || 'glm-4-flash',
  baseUrlOverride: process.env.LLM_FALLBACK_BASE_URL,
  apiKeyOverride: process.env.LLM_FALLBACK_API_KEY || undefined,
  temperature: 0.2,
  maxTokens: 1800,
};

function parseJson(text: string): any[] | null {
  let s = text.replace(/```(?:json)?/g, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end < 0) return null;
  s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch { return null; }
}

async function main() {
  const { rows } = await pool.query<{ id: number; word: string; meaning: string }>(
    `SELECT id, word, meaning FROM vocab_words
      WHERE kind='phrase' AND (example_en='' OR example_en IS NULL)
      ORDER BY id LIMIT $1`, [LIMIT],
  );
  console.log(`待生成例句 ${rows.length} 条`);
  let done = 0, failed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const list = batch.map((b, idx) => `${idx + 1}. ${b.word} —— ${b.meaning}`).join('\n');
    const prompt = `你是湖南专升本英语老师。给下面每个固定搭配造一个简单、地道的英文例句，并给出中文翻译。

要求：
1. 例句必须用上该搭配，句子简短（8-15 词），用词基础，贴合专升本难度。
2. 中文翻译准确自然。
3. 只输出 JSON 数组，格式：[{"i":1,"en":"英文例句","zh":"中文翻译"}, ...]，序号 i 与题目一一对应，不要解释。

搭配清单：
${list}`;

    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        const res = await complete(
          [{ role: 'user', content: prompt }],
          FALLBACK as any,
        );
        const arr = parseJson(res.content);
        if (!arr || arr.length < batch.length) throw new Error(`返回 ${arr?.length ?? 0} 条，不足 ${batch.length}`);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (let j = 0; j < batch.length; j += 1) {
            const item = arr.find((x: any) => Number(x.i) === j + 1);
            if (!item || typeof item.en !== 'string' || typeof item.zh !== 'string') continue;
            if (!item.en.trim() || !item.zh.trim()) continue;
            await client.query(
              `UPDATE vocab_words SET example_en=$1, example_zh=$2 WHERE id=$3`,
              [item.en.trim().slice(0, 500), item.zh.trim().slice(0, 500), batch[j].id],
            );
          }
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
        done += batch.length;
        ok = true;
        process.stdout.write(`\r已生成 ${done}/${rows.length}`);
      } catch (e: any) {
        if (attempt === 3) {
          failed += batch.length;
          console.log(`\n批次 ${i / BATCH + 1} 失败：${e?.message ?? e}`);
        } else {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }
  const stat = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM vocab_words WHERE kind='phrase' AND example_en<>''`,
  );
  console.log(`\n完成：成功 ${done}，失败 ${failed}；库内已有例句短语 ${stat.rows[0].n} 条`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
