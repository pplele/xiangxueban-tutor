/**
 * 给已有错题补向量，让"拍照查重"的相似层对老数据也生效。
 * 用法：npx tsx scripts/backfill-question-embed.ts [--dry]
 */
import { pool } from '../apps/server/src/db/pool';
import { embedTexts } from '../apps/server/src/agent/llm';

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const { rows } = await pool.query<{ id: string; text_body: string }>(
    `SELECT id, text_body FROM questions WHERE embedding IS NULL ORDER BY id`,
  );
  console.log(`待补向量题目：${rows.length} 条${dry ? '（试运行，不写库）' : ''}`);
  if (dry || rows.length === 0) {
    await pool.end();
    return;
  }

  let done = 0;
  for (let i = 0; i < rows.length; i += 8) {
    const batch = rows.slice(i, i + 8);
    try {
      const vectors = await embedTexts(batch.map((r) => r.text_body.slice(0, 900)));
      for (let k = 0; k < batch.length; k += 1) {
        const vec = vectors[k];
        if (!vec || vec.length === 0) continue;
        await pool.query(`UPDATE questions SET embedding = $2::vector WHERE id = $1`, [
          batch[k].id,
          `[${vec.join(',')}]`,
        ]);
        done += 1;
      }
      console.log(`  已补 ${done}/${rows.length}`);
    } catch (err) {
      console.warn(`  批次 ${i} 失败：${(err as Error).message}`);
    }
  }
  console.log(`完成，实际写入 ${done} 条`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
