/**
 * 复习单词种子数据导入（幂等）：读取 data/vocab/review-seed.json，按 group_key 批量写入公共内置词条。
 * 明天要加载全部数据时，只需往 JSON 对应 key 的数组里追加词条，重跑本脚本即可，已存在的会自动跳过。
 *
 * 用法：node scripts/vocab/import-review-seed.mjs
 * 可选：REVIEW_SEED_OWNER=ytl 改为导入到某个账号（默认 '*' 公共内置）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SEED = path.join(ROOT, 'data/vocab/review-seed.json');

// 复用项目 .env 里的数据库连接，避免脚本里再写一份凭据
function loadEnv() {
  const env = {};
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (m && !m[1].startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function dbConfig(env) {
  const url = env.DATABASE_URL;
  if (url) return { connectionString: url };
  return {
    host: env.PGHOST || 'localhost',
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER || 'tutor',
    password: env.PGPASSWORD || 'tutor',
    database: env.PGDATABASE || 'tutor',
  };
}

async function main() {
  const env = loadEnv();
  const owner = process.env.REVIEW_SEED_OWNER || '*';
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const client = new pg.Client(dbConfig(env));
  await client.connect();
  let grand = 0;
  try {
    for (const [groupKey, items] of Object.entries(seed)) {
      if (groupKey.startsWith('_') || !Array.isArray(items)) continue;
      let n = 0;
      let base = Number(
        (await client.query(
          'SELECT COALESCE(MAX(sort_no),0)::int AS n FROM review_words WHERE group_key=$1 AND username=$2',
          [groupKey, owner],
        )).rows[0].n,
      );
      for (const it of items) {
        const term = String(it.term || '').trim();
        if (!term) continue;
        const { rowCount } = await client.query(
          `INSERT INTO review_words (username, group_key, term, meaning, kind, sort_no)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (username, group_key, lower(term)) DO NOTHING`,
          [owner, groupKey, term, String(it.meaning || '').trim(), it.kind === 'phrase' ? 'phrase' : 'word', ++base],
        );
        n += rowCount ?? 0;
      }
      grand += n;
      console.log(`${groupKey}: 新增 ${n} 条 / 文件 ${items.length} 条`);
    }
  } finally {
    await client.end();
  }
  console.log(`完成，共新增 ${grand} 条（owner=${owner}）。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
