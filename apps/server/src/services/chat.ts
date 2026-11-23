import type { ChatMessageDto, ChatSessionDto, Citation, QuestionCard } from '@tutor/shared';
import { badRequest, notFound } from '../lib/errors';
import { truncate } from '../lib/text';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { assemblePrompt } from '../agent/prompts/assemble';
import { complete } from '../agent/llm';
import { runAgent, type AgentEvent } from '../agent/loop';
import { retrieve, tagKpCodes } from './rag';
import { embedTexts } from '../agent/llm';
import { getProfile } from './profile';
import * as sessionRepo from '../repos/sessions';
import * as questionRepo from '../repos/questions';
import * as variantRepo from '../repos/variants';

/**
 * 新建答疑会话。
 * @param subject 科目
 * @param title 可选标题
 * @returns 新会话
 */
export function createSession(subject: string, title?: string): Promise<ChatSessionDto> {
  return sessionRepo.createSession(subject, title);
}

/**
 * 按科目列出答疑会话。
 * @param subject 可选科目过滤
 * @returns 会话列表
 */
export function listSessions(subject?: string): Promise<ChatSessionDto[]> {
  return sessionRepo.listSessions(subject);
}

/**
 * 读取会话元数据与全部消息；会话不存在抛 404。
 * @param id 会话 id
 */
export async function getSessionMessages(id: string): Promise<{ session: ChatSessionDto; messages: ChatMessageDto[] }> {
  const session = await sessionRepo.getSession(id);
  if (!session) throw notFound('会话不存在');
  const messages = await sessionRepo.listMessages(id);
  return { session, messages };
}

/** 把最近 20 条消息压成简短历史摘要（角色名 + 截断内容），用于组 Prompt */
function buildHistorySummary(messages: ChatMessageDto[]): string {
  if (messages.length === 0) return '';
  const lines = messages.slice(-20).map((m) => {
    const who = m.role === 'user' ? '学生' : m.role === 'assistant' ? '老师' : '工具';
    return `${who}：${truncate(m.content.replace(/\s+/g, ' '), 100)}`;
  });
  return lines.join('\n');
}

/** 做题页小窗注入的当前题目上下文：题目/变式 id 与学生答案 */
export interface FocusAskContext {
  questionId?: string;
  variantId?: number | null;
  studentAnswer?: string;
}

/** 答疑请求选项：会话、问题、可选题卡上下文、中止信号、流式事件回调 */
export interface AskOptions {
  sessionId: string;
  content: string;
  focus?: FocusAskContext;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}

/**
 * 把做题页当前题目的上下文拼成 Prompt 片段；同时带出考点，用于召回同知识点的错题备注。
 * 题目/变式查询失败时返回空上下文，不阻断答疑。
 * @param subject 科目
 * @param focus 可选题卡上下文
 * @returns 题卡文本片段与去重考点
 */
async function buildFocusContext(
  subject: string,
  focus?: FocusAskContext,
): Promise<{ text: string; kpCodes: string[] }> {
  const empty = { text: '', kpCodes: [] as string[] };
  if (!focus?.questionId) return empty;
  const question = await questionRepo.getQuestionById(focus.questionId);
  if (!question || question.subject !== subject) return empty;

  let stem = question.textBody;
  let answer = question.answer ?? '';
  let solution = question.solution ?? '';
  let kpCodes = question.kpCodes;
  let questionType = question.questionType;
  let options = question.options ?? [];
  let targetTrap = '';
  let label = '错题原题';

  if (focus.variantId) {
    const variant = await variantRepo.getVariant(focus.variantId);
    if (variant && variant.questionId === question.id) {
      stem = variant.stem;
      answer = variant.answer;
      solution = variant.solution;
      kpCodes = variant.kpCodes;
      questionType = '变式题';
      options = [];
      targetTrap = variant.targetTrap ?? '';
      label = `变式 ${variant.level}`;
    }
  }

  const lines = [
    `- 题号：${question.id}`,
    `- 当前题卡：${label}`,
    `- 章节：${question.chapter}`,
    `- 考点：${kpCodes.join('、') || '未标注'}`,
    `- 题型：${questionType}`,
    `- 题干：${truncate(stem, 1500)}`,
  ];
  if (options.length > 0) lines.push(`- 选项：${options.join('；')}`);
  if (targetTrap) lines.push(`- 本题埋坑：${targetTrap}`);
  lines.push(`- 标准答案（教师参考，不要直接整段念出）：${truncate(answer || '暂缺', 800)}`);
  lines.push(`- 参考解析（教师参考）：${truncate(solution || '暂缺', 1200)}`);
  if (focus.studentAnswer) lines.push(`- 学生当前填写/选择：${truncate(focus.studentAnswer, 600)}`);
  return { text: lines.join('\n'), kpCodes: [...new Set(kpCodes)] };
}

/** 答疑结果：消息 id、回答正文、引用出处 */
export interface AskResult {
  messageId?: number;
  content: string;
  citations: Citation[];
}

/**
 * 答疑主流程：落学生消息 → 以历史首问为锚点检索知识库 → 加载画像/题卡上下文 →
 * 确定考点（题卡 > 检索 > LLM 标注兜底）→ 召回同考点错题备注（向量补齐，再退化为最近错题）→
 * 组 Prompt 并调用 agent 流式生成 → 落老师消息。支持中止信号与流式事件回调。
 * @param options 答疑选项
 * @returns 回答与引用
 */
export async function ask(options: AskOptions): Promise<AskResult> {
  const { sessionId, content } = options;
  const question = content.trim();
  if (!question) throw badRequest('问题不能为空');
  if (question.length > 4000) throw badRequest('问题过长，请分次提问');

  const session = await sessionRepo.getSession(sessionId);
  if (!session) throw notFound('会话不存在');

  const historyMessages = await sessionRepo.recentMessages(sessionId, 20);
  const history = historyMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: truncate(m.content, 1500) }));

  await sessionRepo.insertMessage(sessionId, 'user', question);
  await sessionRepo.touchSession(sessionId, session.title ? undefined : truncate(question, 30));

  // 追问通常只有「为什么这一步」「再举个例子」，单靠这句话检索会跑到别的知识点上。
  // 用本轮之前学生说过的第一句话（即原始题目/提问）做锚点，连同追问一起检索。
  const anchor = history.find((m) => m.role === 'user')?.content ?? '';
  const retrievalQuery = anchor ? `${truncate(anchor, 300)}\n${question}` : question;

  const retrieval = await retrieve(session.subject, retrievalQuery, {
    rerank: env.switches.rerank,
    topK: env.rag.topKFinal,
  });

  let profile = null;
  if (env.switches.profileInject) {
    profile = await getProfile().catch((err) => {
      logger.warn({ err: (err as Error).message }, '[chat] profile load failed');
      return null;
    });
  }

  const focus = await buildFocusContext(session.subject, options.focus).catch((err) => {
    logger.warn({ err: (err as Error).message }, '[chat] focus context build failed');
    return { text: '', kpCodes: [] as string[] };
  });

  // 知识点锚点优先级：当前做题的考点 > 教材检索命中的考点 > 用考纲白名单标注问题文本
  let kpCodes = [...focus.kpCodes];
  if (!kpCodes.length) {
    kpCodes = [...new Set(retrieval.chunks.flatMap((c) => [...(c.kpCodes ?? [])]))].filter(Boolean);
  }
  if (!kpCodes.length) {
    try {
      kpCodes = (await tagKpCodes(session.subject, [retrievalQuery]))[0] ?? [];
    } catch {
      // 考点标注失败时退回无考点兜底，不影响答疑主流程
    }
  }

  // 按同知识点召回学生自己写过备注的错题；不足时用题干相似概念补齐
  let wrongbook: QuestionCard[] = [];
  let myWrongHits: QuestionCard[] = [];
  if (env.switches.wrongbookInject) {
    if (kpCodes.length) {
      myWrongHits = await questionRepo
        .relevantWithNotesForSubject(session.subject, kpCodes, 3)
        .catch(() => []);
    }
    if (myWrongHits.length < 3) {
      try {
        const [vec] = await embedTexts([retrievalQuery.slice(0, 900)]);
        const more = await questionRepo
          .similarWithNotesForSubject(
            session.subject,
            vec,
            myWrongHits.map((q) => q.id),
            3 - myWrongHits.length,
          )
          .catch(() => []);
        myWrongHits = [...myWrongHits, ...more];
      } catch {
        // 向量服务不可用时保持已有命中
      }
    }
    if (!myWrongHits.length) {
      wrongbook = await questionRepo.recentForSubject(session.subject, 3).catch(() => []);
    }
  }

  const assembled = assemblePrompt({
    subject: session.subject,
    chunks: retrieval.chunks,
    wrongbook,
    myWrongHits,
    profile,
    focusContext: focus.text,
    historySummary: buildHistorySummary(historyMessages),
    switches: {
      profileInject: env.switches.profileInject,
      wrongbookInject: env.switches.wrongbookInject,
    },
  });

  logger.info(
    {
      event: 'chat.ask',
      sessionId,
      subject: session.subject,
      chunks: retrieval.chunks.length,
      rerank: retrieval.rerankApplied,
      degraded: retrieval.degraded,
      focus: Boolean(focus.text),
      kpCodes,
      myWrongHits: myWrongHits.length,
    },
    '[chat] assembled prompt',
  );

  const result = await runAgent({
    systemPrompt: assembled.system,
    history,
    question,
    subject: session.subject,
    sessionId,
    initialCitations: assembled.citations,
    signal: options.signal,
    emit: options.emit,
  });

  if (!result.content) {
    throw new Error('模型未生成有效回答');
  }

  const saved = await sessionRepo.insertMessage(sessionId, 'assistant', result.content, result.citations);
  await sessionRepo.touchSession(sessionId);
  return { messageId: saved.id, content: result.content, citations: result.citations };
}

/** 备注要点总结：把整段对话压成几条复习提示，不写入会话，属于一次性派生结果 */
const SUMMARY_PROMPT = `你是专升本辅导老师。下面是你和一名学生的完整答疑对话。
请把这次答疑压缩成 3~5 条备注，供学生以后翻错题本时快速回忆。

要求：
1. 每条一行，以「- 」开头，单条不超过 40 字；
2. 写关键结论、易错点、学生卡住的那个环节，不要复述题目；
3. 用学生看得懂的口语，不要出现 Markdown 标题；数学式子一律用 $...$ 包起来（如 $\\cos\\xi=0$、$\\frac{1}{x}\\to 0$），绝对不要写裸的 LaTeX（如 \\frac{1}{2} 不带 $）；
4. 只输出这几行，不要前言、不要结尾总结。`;

/**
 * 从 Markdown 里粗暴剥掉标记与公式，作为模型不可用时的兜底备注。
 * @param markdown 原始 Markdown 回答
 * @param limit 截断长度
 * @returns 纯文本摘要
 */
function plainSnippet(markdown: string, limit = 160): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$?([^$]*)\$\$?/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/^\s*[-*>]\s*/gm, '')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export interface SummaryResult {
  /** 可直接写进「备注」的要点文本 */
  note: string;
  /** 本次对话轮数（一问一答记 1 轮） */
  turns: number;
}

/**
 * 会话要点总结：LLM 把整段对话压成 3-5 条复习备注（不写会话）；失败时兜底保留老师最后一段结论。
 * @param sessionId 会话 id
 * @returns 备注要点与对话轮数
 */
export async function summarizeSession(sessionId: string): Promise<SummaryResult> {
  const session = await sessionRepo.getSession(sessionId);
  if (!session) throw notFound('会话不存在');

  const messages = await sessionRepo.listMessages(sessionId, 60);
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const turns = dialog.filter((m) => m.role === 'user').length;
  if (dialog.length === 0) return { note: '', turns: 0 };

  const transcript = dialog
    .map((m) => `${m.role === 'user' ? '学生' : '老师'}：${truncate(m.content, 1200)}`)
    .join('\n\n');

  try {
    const { content } = await complete(
      [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: truncate(transcript, 12000) },
      ],
      { maxTokens: 400, temperature: 0.2 },
    );
    const note = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => (l.startsWith('- ') || l.startsWith('·') ? l : `- ${l.replace(/^[0-9.、]+/, '')}`))
      .join('\n')
      .slice(0, 1000);
    if (note) return { note, turns };
    logger.warn({ event: 'summary.empty', sessionId }, '[chat] 要点总结为空，改用兜底');
  } catch (err) {
    logger.warn({ event: 'summary.failed', err: (err as Error).message }, '[chat] 要点总结失败，改用兜底');
  }

  // 兜底：至少把老师最后一段结论留下，不能让学生对着空备注
  const lastAnswer = [...dialog].reverse().find((m) => m.role === 'assistant');
  return { note: lastAnswer ? plainSnippet(lastAnswer.content) : '', turns };
}
