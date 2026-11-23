import { pool } from './src/db/pool';
async function main() {
  const dist = await pool.query(`
    SELECT subject,
           count(*) FILTER (WHERE note IS NOT NULL AND btrim(note) <> '') AS with_note,
           count(*) AS total
    FROM questions GROUP BY subject ORDER BY subject`);
  console.log('=== note 分布 ===');
  console.table(dist.rows);
  const samples = await pool.query(`
    SELECT subject, chapter, left(note, 400) AS note, kp_codes
    FROM questions
    WHERE note IS NOT NULL AND btrim(note) <> ''
    ORDER BY updated_at DESC LIMIT 15`);
  console.log('=== 最近 15 条备注 ===');
  for (const r of samples.rows) {
    console.log(`[${r.subject}] ${r.chapter} | ${r.kp_codes?.join(',')}`);
    console.log(`   ${(r.note||'').replace(/\n/g,' ⏎ ')}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
