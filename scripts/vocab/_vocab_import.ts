// 把合并好的词表写进 vocab_words（按 lower(word) 幂等 upsert）
// 用法：npx tsx scripts/vocab/_vocab_import.ts [json路径] [--append]
//   --append  只新增不覆盖已有词，且新词排在词表末尾（用于外部补充的词表，避免覆盖已校对内容）
import fs from 'node:fs';
import { pool } from '../../apps/server/src/db/pool';

interface Row {
  word: string;
  phonetic: string;
  meaning: string;
  page: number | null;
  sort: number;
}

async function main() {
  const args = process.argv.slice(2);
  const append = args.includes('--append');
  const file = args.find((a) => !a.startsWith('--')) ?? 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/data/vocab/vocab.json';
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as Row[];
  // 目录页/封面混进来的单字母条目：单个字母且释义里堆了一串词性，直接丢
  const cleaned = list.filter((r) => {
    if (!r.word || !String(r.word).trim()) return false;
    if (/^[A-Za-z]$/.test(r.word) && /(adj|adv|prep|conj)\./.test(r.meaning ?? '')) return false;
    if (!(r.meaning ?? '').trim()) return false;
    return true;
  });
  console.log('待入库', cleaned.length, '（过滤掉', list.length - cleaned.length, '条无效/目录噪声）');

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    let baseSort = 0;
    if (append) {
      const r = await client.query('SELECT COALESCE(MAX(sort_no), 0)::int AS mx FROM vocab_words');
      baseSort = r.rows[0].mx + 1;
    }
    for (let i = 0; i < cleaned.length; i += 1) {
      const r = cleaned[i];
      // 带空格或用省略号占位（如 carry...through）的都算短语，避免被误判成单词
      const kind = /[\s.]/.test(r.word) ? 'phrase' : 'word';
      const sql = append
        ? `INSERT INTO vocab_words (subject, word, phonetic, meaning, kind, source_page, sort_no)
           VALUES ('english', $1, $2, $3, $4, $5, $6)
           ON CONFLICT (subject, lower(word)) DO NOTHING
           RETURNING 1 AS is_new`
        : `INSERT INTO vocab_words (subject, word, phonetic, meaning, kind, source_page, sort_no)
           VALUES ('english', $1, $2, $3, $4, $5, $6)
           ON CONFLICT (subject, lower(word)) DO UPDATE
             SET phonetic = EXCLUDED.phonetic,
                 meaning  = EXCLUDED.meaning,
                 kind     = EXCLUDED.kind,
                 source_page = EXCLUDED.source_page,
                 sort_no  = EXCLUDED.sort_no
           RETURNING (xmax = 0) AS is_new`;
      const res = await client.query(sql, [
        r.word,
        r.phonetic ?? '',
        r.meaning ?? '',
        kind,
        r.page ?? null,
        baseSort + i,
      ]);
      if (res.rowCount) inserted += 1;
      else skipped += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const stat = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE kind = 'word')::int AS words,
            count(*) FILTER (WHERE kind = 'phrase')::int AS phrases
       FROM vocab_words`,
  );
  console.log(append ? `新增 ${inserted} | 已存在跳过 ${skipped}` : `新增 ${inserted}`, '| 库内:', stat.rows[0]);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
