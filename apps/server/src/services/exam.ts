import fs from 'node:fs';
import path from 'node:path';
import type {
  ExamBlueprint,
  ExamMode,
  ExamPaper,
  ExamPaperItem,
  ExamPaperSummary,
  QuestionCard,
} from '@tutor/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { complete } from '../agent/llm';
import { parseLooseJson } from '../lib/json';
import { gradeObjective, isSelfRating, type SelfRating } from './attempt';
import * as questionRepo from '../repos/questions';
import * as attemptRepo from '../repos/attempts';
import * as variantRepo from '../repos/variants';
import * as examRepo from '../repos/exams';
import { removeExamUploads } from './examUpload';
import { recordExamEvent, refreshNarratives, removeExamRecord } from './profile';

/**
 * 读取考试蓝图：数学用 exam_blueprint.json，英语用 exam_blueprint_english.json。
 * 从 cwd 逐级向上及构建产物位置查找；英语蓝图缺失时回退数学蓝图，保证旧数据仍能打开。
 * @param subject 科目代码
 * @returns 考试蓝图
 */
export function loadBlueprint(subject = 'math'): ExamBlueprint {
  const file = subject === 'english' ? 'exam_blueprint_english.json' : 'exam_blueprint.json';
  const dirs = [
    path.resolve(process.cwd(), 'data'),
    path.resolve(process.cwd(), 'apps/server/data'),
    path.resolve(__dirname, '../data'),
    path.resolve(__dirname, '../../data'),
    path.resolve(__dirname, '../../../data'),
  ];
  const found =
    dirs.map((d) => path.join(d, file)).find((p) => fs.existsSync(p)) ??
    dirs.map((d) => path.join(d, 'exam_blueprint.json')).find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 exam_blueprint.json');
  return JSON.parse(fs.readFileSync(found, 'utf8')) as ExamBlueprint;
}

/** 蓝图 section key 到题型名的映射 */
const SECTION_TYPES: Record<string, string> = {
  choice: '选择题',
  blank: '填空题',
  solve: '计算题',
};

/** 到点后宽限 2 分钟再强制判分（前端时钟和服务器可能有偏差） */
const FORCE_GRACE_MS = 2 * 60 * 1000;

/** 按题号取该 section 的分值：数组按位置取值（超出取末位），否则返回固定分 */
function pointsFor(section: { points: number | number[] }, index: number): number {
  if (Array.isArray(section.points)) {
    return section.points[Math.min(index, section.points.length - 1)] ?? 0;
  }
  return section.points;
}

/** 组卷选项：科目、考试模式、章节范围 */
export interface GenerateExamOptions {
  subject?: string;
  /** mock=模拟考试（全考纲）；chapter=章节考试（range 小范围） */
  mode?: ExamMode;
  range?: string[] | null;
}

/**
 * 组卷：出题池 = 错题原题 + 变式（同一张卷里母题和它的变式不重复）。
 * 被抽过的题 / 变式打「考过」标记，下次组卷优先跳过；题池不足时按
 * 变式 → 全库（仅模拟考试）→ 同范围复用 的顺序回退，保证卷面完整。
 * @param options 科目、模式（mock/chapter）、章节范围
 * @returns 生成的试卷（未交卷，不含答案）
 */
export async function generateExam(options: GenerateExamOptions = {}): Promise<ExamPaper> {
  const subject = options.subject || 'math';
  const mode: ExamMode = options.mode === 'chapter' ? 'chapter' : 'mock';
  const blueprint = loadBlueprint(subject);
  const rangeSet = options.range && options.range.length > 0 ? new Set(options.range) : null;
  if (mode === 'chapter' && !rangeSet) {
    throw badRequest('章节考试必须选择至少一个章节');
  }

  const pool = await questionRepo.countQuestions(subject);
  if (pool === 0) {
    throw badRequest('该科目暂无错题，无法组卷。请先在错题本导入题目或运行迁移脚本。');
  }

  const usedQuestionIds: string[] = [];
  const usedVariantIds: number[] = [];
  const items: ExamPaperItem[] = [];
  let no = 0;
  let reused = 0;

  for (const section of blueprint.sections) {
    const questionType = section.type || SECTION_TYPES[section.key] || '选择题';
    let sectionIndex = 0;

    for (const module of blueprint.modules) {
      const key = section.key as 'choice' | 'blank' | 'solve';
      const count = Number(module[key] ?? 0);
      if (count <= 0) continue;
      const chapters = module.chapters.filter((c) => !rangeSet || rangeSet.has(c));
      if (chapters.length === 0) continue;

      let orig = await questionRepo.pickQuestionsForExam(subject, chapters, [questionType], count, usedQuestionIds);
      let need = count - orig.length;
      const vars: variantRepo.ExamVariantCandidate[] = [];

      if (need > 0) {
        const pickedV = await variantRepo.pickVariantsForExam(subject, chapters, [questionType], need, usedQuestionIds);
        vars.push(...pickedV);
        need -= pickedV.length;
      }
      if (need > 0 && mode === 'mock') {
        const more = await questionRepo.pickAnyQuestions(subject, [questionType], need, [
          ...usedQuestionIds,
          ...orig.map((p) => p.id),
        ]);
        orig = [...orig, ...more];
        need -= more.length;
      }
      if (need > 0) {
        // 题池不足：允许同范围复用（章节考试不越界、模拟考试不跨题型乱抓）
        const extra = await questionRepo.pickQuestionsForExam(subject, chapters, [questionType], need, []);
        orig = [...orig, ...extra];
        need -= extra.length;
        if (need > 0) {
          const extraV = await variantRepo.pickVariantsForExam(subject, chapters, [questionType], need, []);
          vars.push(...extraV);
        }
        reused += need > 0 ? 0 : 0;
      }

      const picked: Array<{ kind: 'orig'; q: QuestionCard } | { kind: 'variant'; v: variantRepo.ExamVariantCandidate }> = [
        ...orig.map((q) => ({ kind: 'orig' as const, q })),
        ...vars.map((v) => ({ kind: 'variant' as const, v })),
      ];

      for (const p of picked.slice(0, count)) {
        no += 1;
        const points = pointsFor(section, sectionIndex);
        sectionIndex += 1;
        if (p.kind === 'orig') {
          usedQuestionIds.push(p.q.id);
          items.push({
            no,
            sectionKey: section.key,
            sectionName: section.name,
            module: module.name,
            questionId: p.q.id,
            variantId: null,
            points,
            questionType: p.q.questionType,
            stem: p.q.textBody,
            options: p.q.options ?? null,
            kpCodes: p.q.kpCodes,
            answer: p.q.answer ?? null,
            solution: p.q.solution ?? null,
          });
        } else {
          usedQuestionIds.push(p.v.questionId);
          usedVariantIds.push(p.v.variantId);
          items.push({
            no,
            sectionKey: section.key,
            sectionName: section.name,
            module: module.name,
            questionId: p.v.questionId,
            variantId: p.v.variantId,
            points,
            questionType: p.v.questionType,
            stem: p.v.stem,
            options: null,
            kpCodes: p.v.kpCodes,
            answer: p.v.answer ?? null,
            solution: p.v.solution ?? null,
          });
        }
      }
    }
  }

  if (items.length === 0) {
    throw badRequest(mode === 'chapter' ? '组卷失败：所选章节暂无可用题目' : '组卷失败：当前题库没有可用题目');
  }

  // 抽中的原题与变式打「考过」标记
  await variantRepo.markExamUsed(usedQuestionIds, usedVariantIds);

  const maxScore = items.reduce((sum, it) => sum + it.points, 0);
  const paperNo = (await examRepo.countExamsByMode(subject, mode)) + 1;

  let title: string;
  let durationMin: number;
  if (mode === 'mock') {
    title = `${blueprint.meta?.title || '模拟卷'} · 第 ${paperNo} 套`;
    durationMin = blueprint.meta?.minutes ?? 120;
  } else {
    const pickedChapters = blueprint.modules
      .flatMap((m) => m.chapters)
      .filter((c) => rangeSet?.has(c));
    const label =
      pickedChapters.length <= 3
        ? pickedChapters.join('、')
        : `${pickedChapters.slice(0, 3).join('、')}等 ${pickedChapters.length} 章`;
    title = `章节考试 第 ${paperNo} 套 · ${label}`;
    // 章节考试题量少，时长按题量等比缩放（不低于 20 分钟）
    const full = blueprint.meta?.question_count ?? items.length;
    durationMin = Math.max(20, Math.round(((blueprint.meta?.minutes ?? 120) * items.length) / full));
  }

  const row = await examRepo.insertExam({
    subject,
    title,
    mode,
    paperNo,
    blueprint,
    items,
    maxScore,
    durationMin,
  });

  logger.info(
    {
      event: 'exam.generated',
      examId: row.id,
      mode,
      paperNo,
      items: items.length,
      variants: usedVariantIds.length,
      maxScore,
    },
    '[exam] paper generated',
  );

  return toPaper(row, false);
}

/** 计算试卷截止时间（创建时间 + 考试时长） */
function deadlineOf(row: examRepo.ExamRow): string {
  return new Date(row.created_at.getTime() + row.duration_min * 60000).toISOString();
}

/**
 * 数据库行 → 对外试卷结构；未交卷时抹掉每题答案/解析/判定等字段。
 * @param submitted 是否已交卷（决定是否展示答案）
 */
function toPaper(row: examRepo.ExamRow, submitted: boolean): ExamPaper {
  const items = Array.isArray(row.items) ? row.items : [];
  return {
    id: row.id,
    subject: row.subject,
    title: row.title ?? '模拟卷',
    mode: row.mode,
    paperNo: row.paper_no ?? null,
    durationMin: row.duration_min,
    maxScore: Number(row.max_score ?? items.reduce((s, it) => s + it.points, 0)),
    totalScore: row.total_score === null || row.total_score === undefined ? null : Number(row.total_score),
    createdAt: row.created_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    deadline: deadlineOf(row),
    items: submitted
      ? items
      : items.map((it) => ({
          ...it,
          answer: undefined,
          solution: undefined,
          verdict: undefined,
          earned: undefined,
          reason: undefined,
          suggestion: undefined,
          userAnswer: undefined,
        })),
    answers: submitted ? undefined : (row.answers ?? {}),
    uploads: Array.isArray(row.uploads) ? row.uploads : [],
  };
}

/**
 * 读取试卷详情：到点未交卷超过宽限时间时，用自动保存的作答强制交卷判分后返回。
 * @param id 试卷 id
 * @returns 试卷，不存在返回 null
 */
export async function getExamPaper(id: string): Promise<ExamPaper | null> {
  const row = await examRepo.getExam(id);
  if (!row) return null;
  if (!row.submitted_at && Date.now() > new Date(deadlineOf(row)).getTime() + FORCE_GRACE_MS) {
    // 到点未交：用自动保存过的作答判分，不能按空白卷处理（否则学生白答）
    const saved = await finalize(row, answerMapFrom(row), true);
    return toPaper(saved!, true);
  }
  return toPaper(row, Boolean(row.submitted_at));
}

/**
 * 历史试卷列表（只含摘要字段）与总数。
 * @param limit 最多返回套数
 */
export async function listExams(limit = 200): Promise<{ items: ExamPaperSummary[]; total: number }> {
  const [rows, total] = await Promise.all([examRepo.listExams(limit), examRepo.countExams()]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      title: r.title ?? '模拟卷',
      mode: r.mode,
      paperNo: r.paper_no ?? null,
      maxScore: Number(r.max_score ?? 0),
      totalScore: r.total_score === null || r.total_score === undefined ? null : Number(r.total_score),
      createdAt: r.created_at.toISOString(),
      submittedAt: r.submitted_at?.toISOString() ?? null,
      uploads: Array.isArray(r.uploads) ? r.uploads : [],
    })),
    total,
  };
}

/**
 * 手动删除试卷：同时清理答题卡照片；错题本中的作答记录作为学习数据保留。
 * 同步移除画像里的对应考试记录，避免留下幽灵分数。
 * @param id 试卷 id
 */
export async function deleteExamPaper(id: string): Promise<void> {
  const row = await examRepo.getExam(id);
  if (!row) throw notFound('模拟卷不存在');
  await removeExamUploads(id);
  await examRepo.deleteExam(id);
  // 同步移除该卷在画像里的考试记录，避免删卷后画像还留着幽灵分数
  await removeExamRecord(id).catch((err) => logger.warn({ err }, '[exam] remove exam event failed'));
  logger.info({ examId: id }, '[exam] paper deleted');
}

/** 交卷单题作答：题目 id、答案、可选自评 */
export interface ExamAnswer {
  questionId: string;
  answer?: string;
  selfRating?: SelfRating | null;
}

/**
 * 自动保存：把前端增量作答合并进 exams.answers（不判分、不限次）；已交卷拒绝修改。
 * @param id 试卷 id
 * @param patch 题目 id → 作答/自评 的增量更新
 */
export async function autosaveAnswers(
  id: string,
  patch: Record<string, { answer?: string; selfRating?: string | null }>,
): Promise<void> {
  const row = await examRepo.getExam(id);
  if (!row) throw notFound('模拟卷不存在');
  if (row.submitted_at) throw conflict('已交卷，不能再修改作答');

  const merged: Record<string, { answer?: string; selfRating?: string | null }> = { ...(row.answers ?? {}) };
  for (const [qid, v] of Object.entries(patch ?? {})) {
    if (!qid || !v || typeof v !== 'object') continue;
    const prev = merged[qid] ?? {};
    const next: { answer?: string; selfRating?: string | null } = { ...prev };
    if (typeof v.answer === 'string') next.answer = v.answer;
    if (v.selfRating === null) delete next.selfRating;
    else if (typeof v.selfRating === 'string') {
      if (!isSelfRating(v.selfRating)) throw badRequest('selfRating 只能是 self_pass / self_partial / self_fail');
      next.selfRating = v.selfRating;
    }
    merged[qid] = next;
  }
  await examRepo.saveAnswers(id, merged);
}

/**
 * 从 exams.answers 还原作答表（自动保存与强制交卷共用，避免两条路径口径不一致）。
 */
function answerMapFrom(row: examRepo.ExamRow): Map<string, ExamAnswer> {
  const answerMap = new Map<string, ExamAnswer>();
  for (const [qid, v] of Object.entries(row.answers ?? {})) {
    if (v && typeof v === 'object') answerMap.set(qid, { ...(v as ExamAnswer), questionId: qid });
  }
  return answerMap;
}

/**
 * 交卷：以自动保存作答打底、本次提交覆盖，调用 finalize 判分（重复交卷拒绝）。
 * @param id 试卷 id
 * @param answers 本次提交的作答
 * @returns 已判分的试卷
 */
export async function submitExam(id: string, answers: ExamAnswer[]): Promise<ExamPaper> {
  const row = await examRepo.getExam(id);
  if (!row) throw notFound('模拟卷不存在');
  if (row.submitted_at) throw conflict('该试卷已交卷，不能重复提交');

  // 自动保存的作答打底，本次提交覆盖
  const answerMap = answerMapFrom(row);
  for (const a of answers) {
    if (a && a.questionId) answerMap.set(a.questionId, a);
  }

  const saved = await finalize(row, answerMap, false);
  return toPaper(saved!, true);
}

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

/** 单题判分结果：判定、得分比例、理由、可选改进建议 */
interface GradeResult {
  verdict: string;
  ratio: number;
  reason: string;
  suggestion?: string | null;
}

/**
 * 判分并落卷：客观题直接判、填空交给 gradeBlank（LLM 数学等价兜底）、解答题优先用照片转录交给
 * gradeSolve（AI 步骤评分），无照片则按自评或 0 分。每题落一条作答记录、判错置「待复习」；
 * 交卷后异步记画像事件并刷新老师点评（失败只记日志，不阻塞响应）。
 * @param row 试卷行
 * @param answerMap 作答表
 * @param forced 是否为到点强制交卷
 * @returns 判分后的试卷行
 */
async function finalize(
  row: examRepo.ExamRow,
  answerMap: Map<string, ExamAnswer>,
  forced: boolean,
): Promise<examRepo.ExamRow> {
  const items: ExamPaperItem[] = Array.isArray(row.items) ? (row.items as ExamPaperItem[]) : [];
  const uploads = Array.isArray(row.uploads) ? row.uploads : [];
  const solveUploads = new Map<number, { ocrText: string }>();
  for (const u of uploads) {
    if (u.section === 'solve') solveUploads.set(u.questionNo, u);
  }
  const blueprint = (row.blueprint ?? {}) as ExamBlueprint;
  const grading = blueprint.grading ?? {};

  let total = 0;
  for (const item of items) {
    const submitted = answerMap.get(item.questionId);
    const userAnswer = submitted?.answer ?? '';
    const selfRating = submitted?.selfRating;
    if (selfRating && !isSelfRating(selfRating)) {
      throw badRequest('selfRating 只能是 self_pass / self_partial / self_fail');
    }

    let g: GradeResult;
    if (item.questionType === '选择题') {
      const v = gradeObjective(item.questionType, item.answer ?? null, userAnswer);
      g = {
        verdict: v,
        ratio: v === 'correct' ? 1 : 0,
        reason:
          v === 'correct'
            ? '客观题判定正确'
            : userAnswer
              ? `客观题判定错误，标准答案为 ${item.answer ?? '（缺失）'}`
              : '未作答',
      };
    } else if (item.questionType === '填空题') {
      g = await gradeBlank(item, userAnswer, grading['填空题']);
    } else {
      const up = solveUploads.get(item.no);
      if (up && up.ocrText.trim()) {
        g = await gradeSolve(item, up.ocrText, grading);
      } else if (item.questionType === '翻译题' && userAnswer.trim()) {
        // 英语翻译题：学生直接在页面输入译文，交给英语阅卷老师按采分点评分（数学解答题不走这条，保持原逻辑）
        g = await gradeSolve(item, userAnswer, grading);
      } else if (selfRating) {
        g = {
          verdict: selfRating,
          ratio: selfRating === 'self_pass' ? 1 : selfRating === 'self_partial' ? 0.5 : 0,
          reason:
            selfRating === 'self_pass'
              ? '自评已掌握，按满分计（未上传照片）'
              : selfRating === 'self_partial'
                ? '自评部分掌握，按半分计（未上传照片）'
                : '自评未掌握，本题不得分（未上传照片）',
        };
      } else {
        g = {
          verdict: 'self_fail',
          ratio: 0,
          reason: forced ? '到点强制交卷：解答题未上传照片，按未掌握计' : '解答题未上传照片且未自评，按未掌握计',
        };
      }
    }

    const earned = Math.round(item.points * g.ratio * 100) / 100;
    total += earned;
    item.userAnswer = userAnswer;
    item.verdict = g.verdict;
    item.earned = earned;
    item.reason = g.reason;
    item.suggestion = g.suggestion ?? null;

    await attemptRepo.insertAttempt({
      questionId: item.questionId,
      variantId: item.variantId ?? null,
      subject: row.subject,
      answer: userAnswer,
      verdict: g.verdict,
      source: 'exam',
    });

    if (g.verdict === 'wrong' || g.verdict === 'self_fail') {
      await questionRepo.updateStatus(item.questionId, '待复习').catch(() => undefined);
    }
  }

  const saved = await examRepo.saveSubmission(row.id, items, Math.round(total * 100) / 100);

  // 每次交卷都落一条画像事件（分数 + 失分知识点），再让对应科目老师刷新点评。
  // 画像更新不阻塞交卷响应，失败只记日志。
  const lostKps = new Set<string>();
  for (const it of items) {
    if ((it.earned ?? 0) < (it.points ?? 0)) {
      for (const kp of it.kpCodes ?? []) lostKps.add(kp);
    }
  }
  if (saved) {
    void recordExamEvent({
      id: saved.id,
      date: new Date(saved.submitted_at ?? Date.now()).toISOString(),
      subject: saved.subject,
      title: saved.title ?? undefined,
      score: Number(saved.total_score ?? total),
      maxScore: Number(saved.max_score ?? 150),
      lostKps: [...lostKps],
    })
      .then(() => refreshNarratives([saved.subject]))
      .catch((err) => logger.warn({ event: 'exam.profile_sync_failed', examId: saved.id, error: String(err) }, '[exam] profile sync failed'));
  }

  logger.info(
    { event: forced ? 'exam.force_submitted' : 'exam.submitted', examId: row.id, total, max: row.max_score },
    forced ? '[exam] deadline reached, auto submitted' : '[exam] submitted',
  );
  return saved!;
}

/**
 * 填空题判分：先字符串比对（含数值等价），不一致再让 LLM 判数学等价（如 1/2 与 0.5、区间开闭、
 * k∈Z），LLM 失败则按不等价判错。
 */
async function gradeBlank(item: ExamPaperItem, userAnswer: string, rule?: string): Promise<GradeResult> {
  if (!userAnswer.trim()) {
    return { verdict: 'wrong', ratio: 0, reason: '未作答' };
  }
  const v = gradeObjective(item.questionType, item.answer ?? null, userAnswer);
  if (v === 'correct') {
    return { verdict: 'correct', ratio: 1, reason: '填空题答案正确' };
  }
  try {
    const res = await complete(
      [
        {
          role: 'system',
          content: '你是数学阅卷老师，只判断两个答案在数学上是否等价。只输出 JSON，不要解释。',
        },
        {
          role: 'user',
          content: [
            `【题目】${item.stem.slice(0, 400)}`,
            `【标准答案】${item.answer ?? ''}`,
            `【学生答案】${userAnswer}`,
            rule ? `【评分标准】${rule}` : '',
            '判断学生答案与标准答案是否数学等价（如 1/2 与 0.5 等价；缺 k∈Z、区间端点开闭不同算部分对）。',
            '输出 JSON：{"ratio": 1 或 0.5 或 0, "reason": "一句话理由"}',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      { maxTokens: 300, temperature: 0 },
    );
    const parsed = parseLooseJson(res.content) as { ratio?: unknown; reason?: unknown } | null;
    const ratio = Math.max(0, Math.min(1, Number(parsed?.ratio ?? 0)));
    if (Number.isFinite(ratio) && ratio > 0) {
      return {
        verdict: ratio >= 0.99 ? 'correct' : 'partial',
        ratio,
        reason: `AI 判定：${String(parsed?.reason ?? '答案等价').slice(0, 120)}`,
      };
    }
    return { verdict: 'wrong', ratio: 0, reason: `与标准答案 ${item.answer ?? '（缺失）'} 不等价` };
  } catch {
    return { verdict: 'wrong', ratio: 0, reason: `与标准答案 ${item.answer ?? '（缺失）'} 不一致` };
  }
}

/**
 * 解答题 / 翻译题：按蓝图评分规则（数学按步骤分、英语按译文采分点）由 AI 逐题打分；
 * 解析失败或分数异常时抛错，由 finalize 兜底按 0 分计。
 */
async function gradeSolve(
  item: ExamPaperItem,
  studentText: string,
  grading: Record<string, string>,
): Promise<GradeResult> {
  const isTranslation = item.questionType === '翻译题';
  const rules = [
    isTranslation
      ? (grading['翻译题'] ??
        '按关键词与短语、时态语态、从句与语序、整体意思四块给分；措辞与参考译文不同但意思准确、语法正确不扣分。')
      : (grading['计算题'] ?? grading['证明题'] ?? '按步骤给分：关键步骤各占分值，最终答案正确但缺关键说明酌情扣分。'),
    grading['AI 评卷要求'] ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await complete(
      [
        {
          role: 'system',
          content: isTranslation
            ? '你是湖南专升本大学英语阅卷老师，专评句子翻译。严格按评分标准逐题评分，宁可给分有据也不凭空扣分；解析用中文。只输出 JSON。'
            : '你是湖南专升本高等数学阅卷老师。严格按评分标准逐题评分，宁可给分有据也不凭空扣分。只输出 JSON。',
        },
        {
          role: 'user',
          content: [
            `【题目】${item.stem.slice(0, 800)}`,
            `【本题分值】${item.points} 分`,
            `【参考答案】${item.answer ?? '（无）'}`,
            `【参考解析】${(item.solution ?? '').slice(0, 800)}`,
            `【评分标准】${rules}`,
            isTranslation
              ? `【学生译文】\n${studentText.slice(0, 3000)}`
              : `【学生手写作答（照片转录，可能有 □ 表示看不清）】\n${studentText.slice(0, 3000)}`,
            '输出 JSON：{"ratio": 得分比例 0~1（一位小数）, "reason": "得分与扣分理由，引用学生原文片段", "suggestion": "一条针对性改进建议"}',
          ].join('\n\n'),
        },
      ],
      { maxTokens: 800, temperature: 0 },
    );
    const parsed = parseLooseJson(res.content) as { ratio?: unknown; reason?: unknown; suggestion?: unknown } | null;
    const ratio = Math.max(0, Math.min(1, Number(parsed?.ratio ?? 0)));
    if (!Number.isFinite(ratio)) {
      throw new Error('bad ratio');
    }
    return {
      verdict: ratio >= 0.99 ? 'correct' : ratio > 0 ? 'partial' : 'wrong',
      ratio,
      reason: String(parsed?.reason ?? '').slice(0, 400) || 'AI 按步骤评分',
      suggestion: String(parsed?.suggestion ?? '').slice(0, 200) || null,
    };
  } catch (err) {
    logger.warn({ event: 'exam.ai_grade_failed', questionId: item.questionId, err: String(err) }, '[exam] ai grade failed');
    return {
      verdict: 'self_fail',
      ratio: 0,
      reason: 'AI 评分服务暂时不可用，本题先按 0 分计；请在错题本里重新练习这道题',
    };
  }
}
