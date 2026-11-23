import type { Citation, QuestionCard, UserProfile } from '@tutor/shared';
import { truncate } from '../../lib/text';
import type { RetrievedChunk } from '../../services/rag';
import { GLOBAL_SYSTEM_PROMPT } from './global';
import { mathTeacher } from './math';
import { englishTeacher } from './english';
import { csTeacher } from './cs';
import { renderTeacherCard, type TeacherCard } from './types';

/** 科目代码到教师素描卡的映射，未命中时默认用数学老师 */
const TEACHERS: Record<string, TeacherCard> = {
  math: mathTeacher,
  english: englishTeacher,
  cs: csTeacher,
};

export interface AssembleOptions {
  subject: string;
  chunks: RetrievedChunk[];
  wrongbook: QuestionCard[];
  /** 按当前问题知识点/概念召回的学生自己的错题（含备注），与错题兜底区分 */
  myWrongHits?: QuestionCard[];
  profile: UserProfile | null;
  historySummary?: string;
  /** 做题页小窗传入的当前题目上下文 */
  focusContext?: string;
  switches?: {
    profileInject: boolean;
    wrongbookInject: boolean;
  };
}

export interface AssembledPrompt {
  system: string;
  citations: Citation[];
  sections: Record<string, number>;
}

/**
 * 把检索到的知识库片段渲染为带出处前缀的 Prompt 文本块。
 * @param chunks RAG 检索片段列表
 * @returns Markdown 文本；无片段时返回带「知识库未收录」提醒的占位块
 */
function renderRag(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return [
      '## 知识库检索片段',
      '（本次未检索到相关片段。涉及知识性结论时，明确说明「知识库未收录」，不得编造出处。）',
    ].join('\n');
  }
  const items = chunks
    .map((c) => `[出处: ${c.sourceName}]\n${truncate(c.content, 1400)}`)
    .join('\n\n---\n\n');
  return `## 知识库检索片段（只能依据以下内容标注出处）\n\n${items}`;
}

/** 学生本人写过备注的错题：用于「同知识点/同概念，帮你瞬间想起来」，不是知识库资料 */
function renderMyWrongHits(questions: QuestionCard[]): string {
  const hits = questions.filter((q) => q?.note?.trim());
  if (hits.length === 0) return '';
  const items = hits
    .map((q) =>
      `- [${q.id}] 你自己的错题｜${q.chapter}｜考点 ${q.kpCodes.join('、') || '未标注'}` +
      `\n  当时卡住的点 / 你写的备注：${truncate(q.note ?? '', 200)}`,
    )
    .join('\n');
  return [
    '## 你自己的错题提醒（与当前问题同知识点 / 相似概念）',
    '这些是学生本人以前做错、并亲手写过备注的题。只作为「帮他瞬间想起来」的回忆线索，不是知识库资料。',
    '可以自然地说「你之前在这类题上栽过，当时你写的是……」，但备注是学生当时的想法，不一定正确，不要当成考纲结论。',
    '**不要给这部分内容标 [出处: ...]**；知识性结论仍只依据上面的知识库片段标注出处。',
    items,
  ].join('\n');
}

/**
 * 渲染本科目错题本兜底片段（最近记录，非按知识点筛选）。
 * @param subject 科目代码
 * @param questions 错题卡片列表
 * @returns Markdown 文本；无错题时返回占位说明
 */
function renderWrongbook(subject: string, questions: QuestionCard[]): string {
  if (questions.length === 0) {
    return `## 本科目错题本（兜底最近 3 条）\n（暂无错题记录。）`;
  }
  const items = questions
    .map((q) => {
      const note = q.note ? `备注/错因：${truncate(q.note, 200)}` : '备注：无';
      return `- [${q.id}] ${q.chapter}｜考点 ${q.kpCodes.join('、') || '未标注'}\n  题干：${truncate(q.textBody, 160)}\n  ${note}`;
    })
    .join('\n');
  return `## 本科目错题本（兜底最近 3 条，非按知识点筛选）\n${items}`;
}

/**
 * 渲染全局画像片段：基础/目标/自评/薄弱考点 + 考试失分统计 + 老师点评。
 * @param subject 当前科目代码，用于筛选本科目考试记录与画像
 * @param profile 用户画像，可为 null
 * @returns Markdown 文本
 */
function renderProfile(subject: string, profile: UserProfile | null): string {
  if (!profile) return '## 全局画像\n（暂无画像数据。）';
  const labels = profile.labels ?? {};
  const parts: string[] = [];
  if (labels.base_level) parts.push(`基础水平：${String(labels.base_level)}`);
  if (labels.target) parts.push(`目标：${String(labels.target)}`);
  if (labels.target_score) parts.push(`目标分数：${String(labels.target_score)}/150`);
  if (labels.self_level) {
    const levelText: Record<string, string> = { weak: '弱（不及格）', medium: '中（100 左右）', strong: '强（120 以上）' };
    parts.push(`学生自评：${levelText[String(labels.self_level)] ?? String(labels.self_level)}`);
  }
  if (Array.isArray(labels.weak_kp) && labels.weak_kp.length > 0) {
    parts.push(`薄弱考点：${labels.weak_kp.map(String).join('、')}`);
  }

  const mine = (profile.examEvents ?? []).filter((e) => e?.subject === subject).slice(-5);
  if (mine.length) {
    parts.push(
      `最近${mine.length}次${subject === 'math' ? '数学' : subject === 'english' ? '英语' : ''}考试：` +
        mine.map((e) => `${String(e.date).slice(5, 10)} ${e.score}/${e.maxScore}`).join('，'),
    );
    const lost = new Map<string, number>();
    for (const e of mine) for (const kp of e.lostKps ?? []) lost.set(kp, (lost.get(kp) ?? 0) + 1);
    const top = [...lost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([kp, n]) => `${kp}(${n}次)`);
    if (top.length) parts.push(`高频失分考点：${top.join('、')}`);
  }

  const narrative = profile.narratives?.[subject];
  if (narrative) {
    parts.push(
      `老师画像：优点 ${(narrative.strengths ?? []).join('；')}；短板 ${(narrative.weaknesses ?? []).join('；')}；建议 ${narrative.advice ?? ''}`,
    );
  }

  const extra = Object.entries(labels)
    .filter(([k]) => !['base_level', 'target', 'target_score', 'self_level', 'weak_kp'].includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  if (extra.length > 0) parts.push(extra.join('；'));

  return ['## 全局画像（考试分数 + 失分知识点，跨科目共享）', parts.length > 0 ? parts.map((p) => `- ${p}`).join('\n') : '- 尚未设置画像标签', `\n当前科目：${subject}`].join('\n');
}

/**
 * 把 RAG 片段转换为可回传前端的引文对象（内容截断到 1400 字，分数保留 4 位）。
 * @param chunks RAG 检索片段列表
 * @returns 引文数组
 */
export function citationsFromChunks(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((c) => ({
    sourceName: c.sourceName,
    content: truncate(c.content, 1400),
    score: Number(c.score?.toFixed(4)),
    kpCodes: c.kpCodes,
    chapter: c.chapter,
  }));
}

/**
 * 终极 Prompt 拼装（顺序固定）：
 * 全局设定 + 教师素描卡 + RAG 片段 + 错题本 + 全局画像 + 短期记忆
 */
export function assemblePrompt(options: AssembleOptions): AssembledPrompt {
  const { subject, chunks, wrongbook, profile } = options;
  const switches = options.switches ?? { profileInject: true, wrongbookInject: true };
  const teacher = TEACHERS[subject] ?? mathTeacher;
  const sections: Record<string, number> = {};

  const parts: string[] = [];
  parts.push(GLOBAL_SYSTEM_PROMPT);
  sections.global = GLOBAL_SYSTEM_PROMPT.length;

  const card = renderTeacherCard(teacher);
  parts.push(card);
  sections.teacher = card.length;

  const rag = renderRag(chunks);
  parts.push(rag);
  sections.rag = rag.length;

  if (switches.wrongbookInject) {
    const hits = renderMyWrongHits(options.myWrongHits ?? []);
    if (hits) {
      parts.push(hits);
      sections.myWrongHits = hits.length;
    }
    if (wrongbook.length) {
      const wb = renderWrongbook(subject, wrongbook);
      parts.push(wb);
      sections.wrongbook = wb.length;
    }
  }

  if (options.focusContext) {
    const focus = `## 学生正在做的题（本轮最高优先级上下文）\n${options.focusContext}\n\n【回答要求】先围绕这道题定位卡点或关键条件，再给出下一步；不要一上来把标准答案和完整解析全部倒出来，除非学生明确要求。`;
    parts.push(focus);
    sections.focus = focus.length;
  }

  if (switches.profileInject) {
    const prof = renderProfile(subject, profile);
    parts.push(prof);
    sections.profile = prof.length;
  }

  if (options.historySummary) {
    parts.push(`## 对话短期记忆（最近 10 轮摘要）\n${options.historySummary}`);
    sections.history = options.historySummary.length;
  }

  return {
    system: parts.filter(Boolean).join('\n\n'),
    citations: citationsFromChunks(chunks),
    sections,
  };
}
