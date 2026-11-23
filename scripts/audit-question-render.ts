// 全库题干渲染体检：找出「公式渲染失败」「列表摘要脏」「美元符不配对」的题
// 用法：npx tsx scripts/audit-question-render.ts
import { pool } from '../apps/server/src/db/pool';
import { renderRich, plainPreview, cleanOption } from '../apps/web/src/lib/rich';

interface Issue {
  id: string;
  field: string;
  kind: string;
  detail: string;
}

const issues: Issue[] = [];

function check(id: string, field: string, text: string | null | undefined, previewMax = 0) {
  if (!text || !text.trim()) return;
  const s = String(text);

  // 1) $ 不配对：KaTeX 会把整段吞掉或原样输出
  const dollars = (s.match(/(?<!\\)\$/g) || []).length;
  if (dollars % 2 === 1) {
    issues.push({ id, field, kind: '美元符不配对', detail: `$${dollars} 个` });
  }

  // 2) KaTeX 渲染失败（rich.ts 会退化成 formula-fallback 源码）
  const fallbacks = (renderRich(s).match(/formula-fallback/g) || []).length;
  if (fallbacks > 0) {
    issues.push({ id, field, kind: '公式渲染失败', detail: `${fallbacks} 处` });
  }

  // 3) 摘要里仍残留 LaTeX 痕迹（{} 已允许：分段函数会写成 { … ；… }）
  if (previewMax > 0) {
    const p = plainPreview(s, previewMax);
    const dirty = /\\|\$|\bbegincases\b|\bendcases\b|\bfrac\b|\bsqrt\b|&/.test(p);
    if (dirty) issues.push({ id, field, kind: '摘要残留源码', detail: p.slice(0, 80) });
  }
}

async function main() {
  const q = await pool.query(
    `SELECT id, title, text_body, options, answer, solution, note FROM questions ORDER BY id`,
  );
  for (const r of q.rows) {
    check(r.id, 'title', r.title);
    check(r.id, 'text_body', r.text_body);
    check(r.id, 'text_body(列表摘要)', r.text_body, 88);
    check(r.id, 'answer', r.answer);
    check(r.id, 'solution', r.solution);
    check(r.id, 'note', r.note);
    const opts: string[] = Array.isArray(r.options) ? r.options : [];
    opts.forEach((o, i) => {
      check(r.id, `option[${i}]`, o);
      const cleaned = cleanOption(o);
      if (/^[A-Fa-f]\s*[.、．)]/.test(cleaned) && opts.length > 1) {
        issues.push({ id: r.id, field: `option[${i}]`, kind: '选项字母残留', detail: cleaned.slice(0, 40) });
      }
    });
  }

  const v = await pool.query(`SELECT id, question_id, stem, answer, solution FROM variants ORDER BY id`);
  for (const r of v.rows) {
    check(r.question_id, `variant:${r.id}`, r.stem);
    check(r.question_id, `variant:${r.id}:answer`, r.answer);
    check(r.question_id, `variant:${r.id}:solution`, r.solution);
  }

  console.log(`题目 ${q.rowCount} 道，变式 ${v.rowCount} 道，发现问题 ${issues.length} 条\n`);
  const byKind = new Map<string, Issue[]>();
  for (const it of issues) byKind.set(it.kind, [...(byKind.get(it.kind) ?? []), it]);
  for (const [kind, list] of byKind) {
    console.log(`【${kind}】${list.length} 条`);
    for (const it of list.slice(0, 12)) {
      console.log(`  ${it.id} ${it.field}: ${it.detail}`);
    }
    if (list.length > 12) console.log(`  …另有 ${list.length - 12} 条`);
    console.log('');
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
