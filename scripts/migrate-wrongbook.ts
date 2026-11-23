/**
 * 把 F:\wrongbook 的 56 张 v3 错题卡、考纲、变式与作答记录迁移到 PostgreSQL。
 * 幂等：按 id / 指纹判重，重跑不会产生重复数据。
 *
 * 用法：
 *   npm run migrate:wrongbook
 *   npm run migrate:wrongbook -- --dir F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/_archive/wrongbook-legacy --force
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool, closePool, query } from '../apps/server/src/db/pool';
import { upsertKp } from '../apps/server/src/repos/meta';
import * as questionRepo from '../apps/server/src/repos/questions';
import * as variantRepo from '../apps/server/src/repos/variants';
import * as attemptRepo from '../apps/server/src/repos/attempts';
import { importCards, type ImportCard } from '../apps/server/src/services/wrongbook';

interface SourceCard {
  id: string;
  chapter: string;
  kp_codes: string[];
  kp_levels?: string[];
  question_type: string;
  text_latex: string;
  options?: string[] | null;
  answer?: string;
  solution?: string;
  note?: string;
  title?: string;
  tags?: string[];
  no?: string;
  fingerprint: string;
  status?: string;
  source?: string;
  schema_version?: number;
  created_at?: string;
  variant_sets?: {
    set_id: string;
    created_at?: string;
    items: {
      level: string;
      stem: string;
      answer: string;
      solution: string;
      kp_codes: string[];
      target_trap?: string;
    }[];
  }[];
  attempts?: { answer?: string; verdict?: string; source?: string; at?: string }[];
  [key: string]: unknown;
}

function parseArgs(): { dir: string; force: boolean } {
  const args = process.argv.slice(2);
  let dir = process.env.WRONGBOOK_DIR || 'F:/基于大语言模型Agent的专升本个性化自适应学习系统设计与实现/_archive/wrongbook-legacy';
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dir' && args[i + 1]) dir = args[++i];
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length);
    else if (arg === '--force') force = true;
  }
  return { dir, force };
}

async function seedWhitelists(dir: string): Promise<void> {
  // 高等数学：来自 wrongbook 的 62 考点白名单
  const syllabusPath = path.join(dir, 'agent', 'rules', 'syllabus.json');
  if (fs.existsSync(syllabusPath)) {
    const syllabus = JSON.parse(fs.readFileSync(syllabusPath, 'utf8'));
    let count = 0;
    for (const chapter of syllabus.chapters ?? []) {
      for (const kp of chapter.kp ?? []) {
        await upsertKp('math', {
          kp_code: String(kp.code),
          kp_name: String(kp.name),
          level: kp.level ? String(kp.level) : null,
          chapter: String(chapter.name),
        });
        count += 1;
      }
    }
    console.log(`[seed] math 考纲考点 ${count} 个（${path.basename(syllabusPath)}）`);
  } else {
    console.warn(`[seed] 未找到 ${syllabusPath}，跳过数学考纲导入`);
  }

  // 英语 / 计算机：项目内示例考纲（可替换为官方考纲）
  for (const subject of ['english', 'cs']) {
    const file = path.resolve(__dirname, '../data/kp', `${subject}.json`);
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let count = 0;
    for (const chapter of data.chapters ?? []) {
      for (const kp of chapter.kp ?? []) {
        await upsertKp(subject, {
          kp_code: String(kp.code),
          kp_name: String(kp.name),
          level: kp.level ? String(kp.level) : null,
          chapter: String(chapter.name),
        });
        count += 1;
      }
    }
    console.log(`[seed] ${subject} 考纲考点 ${count} 个（${path.basename(file)}）`);
  }
}

function toImportCard(card: SourceCard): ImportCard {
  return {
    id: card.id,
    subject: 'math',
    chapter: card.chapter,
    kpCodes: card.kp_codes ?? [],
    kpLevels: card.kp_levels ?? [],
    questionType: card.question_type,
    title: card.title ?? '',
    textBody: card.text_latex,
    options: card.options ?? null,
    answer: card.answer ?? '',
    solution: card.solution ?? '',
    note: card.note ?? '',
    tags: card.tags ?? [],
    no: card.no ?? '',
    fingerprint: card.fingerprint,
    status: card.status ?? '待变式',
    source: card.source ?? 'json',
    schemaVersion: card.schema_version ?? 3,
    createdAt: card.created_at ?? null,
    meta: {
      chapter_confirm: card.chapter_confirm,
      chapter_auto_guess: card.chapter_auto_guess,
      active_chapter: card.active_chapter,
      dup_forced: card.dup_forced,
    },
    variantSets: (card.variant_sets ?? []).map((set) => ({
      setId: set.set_id,
      createdAt: set.created_at ?? null,
      items: (set.items ?? []).map((item) => ({
        level: item.level,
        stem: item.stem,
        answer: item.answer,
        solution: item.solution,
        kpCodes: item.kp_codes ?? [],
        targetTrap: item.target_trap ?? null,
      })),
    })),
    attempts: (card.attempts ?? []).map((a) => ({
      answer: a.answer ?? null,
      verdict: a.verdict ?? null,
      source: a.source ?? 'practice',
      at: a.at ?? null,
    })),
  };
}

async function main(): Promise<void> {
  const { dir, force } = parseArgs();
  const questionsDir = path.join(dir, 'agent', 'kb', 'questions');
  if (!fs.existsSync(questionsDir)) {
    console.error(`[migrate] 找不到错题目录：${questionsDir}`);
    process.exitCode = 1;
    return;
  }

  await seedWhitelists(dir);

  const files = fs.readdirSync(questionsDir).filter((f) => f.endsWith('.json')).sort();
  const cards: SourceCard[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(questionsDir, file), 'utf8')) as SourceCard;
      if (!raw.id || !raw.text_latex) {
        console.warn(`[migrate] 跳过字段不完整的卡片：${file}`);
        continue;
      }
      cards.push(raw);
    } catch (err) {
      console.warn(`[migrate] 解析失败 ${file}: ${(err as Error).message}`);
    }
  }
  console.log(`[migrate] 读取源错题卡 ${cards.length} 张`);

  const importResult = await importCards(cards.map(toImportCard), {
    subject: 'math',
    force,
    source: 'legacy',
    allowDuplicateFingerprint: true,
  });

  // 变式与作答：幂等补齐（即使题已存在也确保集合完整）
  let variantCount = 0;
  let attemptCount = 0;
  for (const card of cards) {
    const question = await questionRepo.getQuestionRow(card.id);
    if (!question) continue;
    for (const set of card.variant_sets ?? []) {
      const items = (set.items ?? [])
        .filter((it) => it.stem && it.answer && it.solution)
        .map((it) => ({
          level: it.level,
          stem: it.stem,
          answer: it.answer,
          solution: it.solution,
          kpCodes: it.kp_codes ?? [],
          targetTrap: it.target_trap ?? null,
          createdAt: set.created_at ?? null,
        }));
      if (items.length > 0) {
        const inserted = await variantRepo.insertVariantSet(card.id, set.set_id, items);
        variantCount += inserted.length;
      }
    }
    const existingAttempts = await attemptRepo.countAttempts(card.id);
    if (existingAttempts === 0 && (card.attempts ?? []).length > 0) {
      for (const a of card.attempts ?? []) {
        await attemptRepo.insertAttempt({
          questionId: card.id,
          subject: 'math',
          answer: a.answer ?? '',
          verdict: a.verdict ?? 'self_partial',
          source: a.source ?? 'practice',
          at: a.at ?? null,
        });
        attemptCount += 1;
      }
    }
  }

  const qCount = await query<{ count: string }>('SELECT count(*)::text AS count FROM questions');
  const vCount = await query<{ count: string }>('SELECT count(*)::text AS count FROM variants');
  const aCount = await query<{ count: string }>('SELECT count(*)::text AS count FROM attempts');
  const sourceVariantTotal = cards.reduce(
    (sum, c) => sum + (c.variant_sets ?? []).reduce((s, set) => s + (set.items?.length ?? 0), 0),
    0,
  );
  const sourceAttemptTotal = cards.reduce((sum, c) => sum + (c.attempts?.length ?? 0), 0);

  console.log('\n===== 迁移结果 =====');
  console.log(`本次新建题目 ${importResult.imported.filter((x) => x.action === 'created').length} 道，更新 ${importResult.imported.filter((x) => x.action === 'updated').length} 道，跳过重复 ${importResult.skipped.length} 道`);
  if (importResult.warnings.length > 0) console.log(`警告：${importResult.warnings.join('；')}`);
  if (importResult.errors.length > 0) console.log(`失败：${importResult.errors.map((e) => e.reason).join('；')}`);
  console.log(`本次补齐变式 ${variantCount} 条，作答 ${attemptCount} 条`);
  console.log(`数据库现状：questions=${qCount.rows[0].count}，variants=${vCount.rows[0].count}，attempts=${aCount.rows[0].count}`);
  console.log(`源 JSON 合计：questions=${cards.length}，variants=${sourceVariantTotal}，attempts=${sourceAttemptTotal}`);
  const ok =
    Number(qCount.rows[0].count) >= cards.length &&
    Number(vCount.rows[0].count) >= sourceVariantTotal &&
    Number(aCount.rows[0].count) >= sourceAttemptTotal;
  console.log(ok ? '✅ 校验通过：题卡与关联数据已完整入库（重跑不会重复）' : '❌ 校验失败：数量少于源数据，请检查错误信息');
  if (!ok) process.exitCode = 1;
}

void main()
  .catch(async (err) => {
    console.error('[migrate] 失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
