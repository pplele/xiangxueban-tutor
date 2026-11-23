/**
 * 校验：用户英语错题解析/备注里出现的固定搭配，是否都已进背单词词库。
 * 从 questions 表读取 solution+note，抽取连续英文词组（2-6 词，含介词/sth/sb 的优先），
 * 与 vocab_words 的短语逐条比对，输出「覆盖 / 缺失」清单。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../../apps/server/src/db/pool';

const RAW = path.resolve(__dirname, '../../wrongbook_full.tmp');

async function main() {
  const raw = fs.readFileSync(RAW, 'utf8');
  // 按题号分块（Q-20261121-xxx<<<>>>解析<<<>>>备注），note 内换行合并
  const blocks: { id: string; text: string }[] = [];
  const re = /^(Q-\d+-\d+)<<<>>>([\s\S]*?)(?=^Q-\d+-\d+<<<>>>|\s*$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    blocks.push({ id: m[1], text: m[2].replace(/\s+/g, ' ') });
  }
  console.log(`解析到 ${blocks.length} 道错题`);

  // 词库全部短语（小写 normalized）
  const db = await pool.query(`SELECT lower(word) AS w, word, meaning FROM vocab_words WHERE kind='phrase'`);
  const dict = new Map<string, { word: string; meaning: string }>();
  for (const r of db.rows) dict.set(r.w.replace(/\s+/g, ' ').trim(), { word: r.word, meaning: r.meaning });

  // 抽取英文词组：连续英文单词（含 ... / - / 所有格），2-6 词
  const phraseRe = /\b(?:[A-Za-z]+(?:[-'][A-Za-z]+)*|sth|sb|ones)(?:[ .]{1,3}(?:[A-Za-z]+(?:[-'][A-Za-z]+)*|sth|sb|ones)){1,5}\b/gi;
  // 只保留「像搭配」的：含介词/冠词/代词占位，或是 3 词以上
  const functionWords = new Set(['in', 'on', 'at', 'of', 'to', 'for', 'with', 'from', 'about', 'by', 'as', 'into', 'over', 'between', 'a', 'an', 'the', 'no', 'sth', 'sb', 'ones', 'out', 'up', 'off', 'away', 'and', 'or', 'than', 'that', 'it', 'is', 'be', 'do', 'doing', 'make', 'take', 'get', 'give', 'have', 'come', 'go', 'look', 'find', 'show', 'speak', 'be', 'been', 'up', 'in']);

  const found = new Map<string, number>(); // 词组 -> 出现题数
  for (const b of blocks) {
    const seenInBlock = new Set<string>();
    let mm: RegExpExecArray | null;
    phraseRe.lastIndex = 0;
    while ((mm = phraseRe.exec(b.text))) {
      let p = mm[0].replace(/\s+/g, ' ').toLowerCase().trim();
      // 去掉尾部纯虚词
      p = p.replace(/\s+(?:and|or|a|an|the|is|be)$/, '').trim();
      const words = p.split(/\s+/);
      if (words.length < 2) continue;
      const hasFunc = words.some((w) => functionWords.has(w));
      if (!hasFunc) continue;
      if (words.length < 2 || words.length > 6) continue;
      seenInBlock.add(p);
    }
    for (const p of seenInBlock) found.set(p, (found.get(p) ?? 0) + 1);
  }

  // 归一化匹配：把 ... 占位统一成空格，去标点
  const norm = (s: string) => s.replace(/\.\.\./g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const dictNorm = new Map<string, { word: string; meaning: string }>();
  for (const [k, v] of dict) dictNorm.set(norm(k), v);

  const covered: string[] = [];
  const missing: { p: string; n: number }[] = [];
  for (const [p, n] of [...found.entries()].sort((a, b) => b[1] - a[1])) {
    const np = norm(p);
    // 精确 or 词库包含该词组 or 词组包含词库条目（应对 sth/ones 差异）
    let hit = dictNorm.has(np);
    if (!hit) {
      for (const dk of dictNorm.keys()) {
        if (dk.includes(np) || np.includes(dk)) {
          if (np.length >= 8 || dk.length >= 8) { hit = true; break; }
        }
      }
    }
    if (hit) covered.push(p);
    else missing.push({ p, n });
  }

  console.log(`\n=== 抽到 ${found.size} 个英文词组，词库覆盖 ${covered.length}，疑似缺失 ${missing.length} ===`);
  console.log('\n【疑似缺失（按出现题数排序，需人工确认是否真是搭配）】');
  for (const x of missing) console.log(`  ${x.n}题  ${x.p}`);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
