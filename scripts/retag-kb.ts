/**
 * 考点补标：对 knowledge_chunks 中 kp_codes 为空的切片重新调用 LLM 标注，不重算向量。
 *
 * 用法：
 *   npx tsx scripts/retag-kb.ts                # 只补空标签
 *   npx tsx scripts/retag-kb.ts --all          # 全量重标（覆盖已有标签）
 *   npx tsx scripts/retag-kb.ts --subject math # 只处理某科
 *   npx tsx scripts/retag-kb.ts --dry          # 只看待处理数量
 */
import { pool, many, query } from '../apps/server/src/db/pool';
import { tagKpCodes } from '../apps/server/src/services/rag';
import { listWhitelist } from '../apps/server/src/repos/meta';

interface Row {
  id: string;
  subject: string;
  chapter: string | null;
  content: string;
}

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
  }
  return undefined;
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  const dry = process.argv.includes('--dry');
  const subject = arg('subject');

  const cond = all ? 'TRUE' : '(kp_codes IS NULL OR cardinality(kp_codes) = 0)';
  const params: string[] = [];
  let where = cond;
  if (subject) {
    params.push(subject);
    where += ` AND subject = $${params.length}`;
  }
  const rows = await many<Row>(
    `SELECT id::text, subject, chapter, content
       FROM knowledge_chunks
      WHERE ${where}
      ORDER BY subject, id`,
    params,
  );
  console.log(`[retag] 待处理 ${rows.length} 块（${all ? '全量重标' : '仅补空标签'}${subject ? `，科目 ${subject}` : ''}）`);
  if (dry || rows.length === 0) return;

  const bySubject = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySubject.get(r.subject) ?? [];
    list.push(r);
    bySubject.set(r.subject, list);
  }

  let updated = 0;
  let tagged = 0;
  for (const [subj, list] of bySubject) {
    const whitelist = await listWhitelist(subj);
    const chapterByKp = new Map(whitelist.map((w) => [w.kp_code, w.chapter]));
    for (let start = 0; start < list.length; start += 8) {
      const batch = list.slice(start, start + 8);
      const labels = await tagKpCodes(
        subj,
        batch.map((b) => b.content),
      );
      for (let i = 0; i < batch.length; i++) {
        const codes = labels[i] ?? [];
        if (codes.length === 0) continue;
        const chapter = batch[i].chapter ?? chapterByKp.get(codes[0]) ?? null;
        await query(`UPDATE knowledge_chunks SET kp_codes = $2::text[], chapter = $3 WHERE id = $1::bigint`, [
          batch[i].id,
          codes,
          chapter,
        ]);
        updated += 1;
        tagged += 1;
      }
      process.stdout.write(`\r[retag] ${subj} ${Math.min(start + 8, list.length)}/${list.length} 已更新 ${updated} 块`);
    }
    console.log();
  }
  console.log(`[retag] 完成：更新 ${updated} 块（其中新标上考点 ${tagged} 块）`);
}

void main()
  .catch((err) => {
    console.error('[retag] 失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
