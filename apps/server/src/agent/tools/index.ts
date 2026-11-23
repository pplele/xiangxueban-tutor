import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Citation, QuestionCard } from '@tutor/shared';
import type { LlmToolSchema } from '../llm';
import { logger } from '../../lib/logger';
import { badRequest, notFound } from '../../lib/errors';
import { truncate } from '../../lib/text';
import { retrieve } from '../../services/rag';
import { importCards, type ImportCard } from '../../services/wrongbook';
import { enqueueVariant, enqueueMany } from '../../services/queue';
import { generateExam } from '../../services/exam';
import { getProfile as loadProfile, patchProfile } from '../../services/profile';
import * as questionRepo from '../../repos/questions';
import * as profileRepo from '../../repos/profile';
import * as jobsRepo from '../../repos/jobs';

export interface ToolContext {
  subject: string;
  sessionId?: string;
}

export interface ToolResult {
  text: string;
  citations?: Citation[];
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

const knowledgeTool: ToolDefinition = {
  name: 'search_knowledge',
  description:
    '在湖南专升本考纲知识库中检索资料。当学生询问考纲内的定义、定理、公式、语法点或计算机概念，且当前对话上下文缺少依据时调用；不要用于闲聊、情绪安抚或明显超出考纲的问题。',
  schema: z.object({
    query: z.string().min(1).max(300).describe('检索关键词或一句完整的问题，尽量包含专业术语'),
    kp_codes: z.array(z.string()).max(6).optional().describe('可选的考点编号，用于提示检索方向'),
  }),
  /**
   * 在知识库检索资料，返回带出处的片段文本与引文。
   * @param args 含 query 与可选 kp_codes 的参数
   * @param ctx 工具上下文（科目）
   */
  async execute(args, ctx) {
    const result = await retrieve(ctx.subject, args.query, { rewrite: false, topK: 6 });
    const citations: Citation[] = result.chunks.map((c) => ({
      sourceName: c.sourceName,
      content: truncate(c.content, 1400),
      score: Number(c.score?.toFixed(4)),
      kpCodes: c.kpCodes,
      chapter: c.chapter,
    }));
    if (result.chunks.length === 0) {
      return {
        text:
          '知识库中没有检索到相关片段。回答时请明确说明「知识库未收录」，不得编造出处；可以给出通用讲解并标注。',
      };
    }
    const body = result.chunks
      .map((c, i) => `【片段${i + 1}】[出处: ${c.sourceName}]\n${truncate(c.content, 900)}`)
      .join('\n\n');
    return {
      text: `在知识库中检索到 ${result.chunks.length} 个片段：\n\n${body}`,
      citations,
      data: { count: result.chunks.length, rerankApplied: result.rerankApplied },
    };
  },
};

const wrongbookSummaryTool: ToolDefinition = {
  name: 'get_wrongbook_summary',
  description:
    '汇总当前科目错题本的总题数、考点分布和最近错题，并给出一句自然语言判断。当学生问「我有多少道错题」「我哪块薄弱」「我错过哪些题」，或需要针对个人薄弱点讲解时调用；不要用于查询其他科目的错题。回答数量时必须用返回里的【错题总数】，不要自己把考点分布相加。',
  schema: z.object({
    subject: z.string().optional().describe('科目代码，默认使用当前会话科目'),
  }),
  /**
   * 汇总当前科目错题本的总数、考点分布与最近错题（读数据库）。
   * @param args 可选 subject（必须是当前会话科目）
   * @param ctx 工具上下文（科目）
   * @throws 查询其他科目时抛 badRequest
   */
  async execute(args, ctx) {
    const subject = args.subject || ctx.subject;
    if (subject !== ctx.subject) {
      throw badRequest('只能查询当前会话科目的错题本');
    }
    const [summary, recent, count] = await Promise.all([
      questionRepo.wrongKpSummary(subject),
      questionRepo.recentForSubject(subject, 3),
      questionRepo.countBySubject(subject),
    ]);
    if (count.total === 0) {
      return { text: '当前科目错题本还是空的，暂无错题记录。', data: { total: 0 } };
    }
    const lines = summary.map(
      (s) => `- ${s.kpCode} 考点${s.kpName ? `（${s.kpName}）` : ''}：错 ${s.count} 道`,
    );
    const recentLines = recent.map(
      (q) => `- [${q.id}] ${q.chapter}｜${truncate(q.textBody, 80)}${q.note ? `｜备注：${truncate(q.note, 80)}` : ''}`,
    );
    return {
      text: [
        `【错题总数】${count.total} 道${count.withoutKp > 0 ? `（其中 ${count.withoutKp} 道未标注考点）` : ''}`,
        '【考点分布】只列错得最多的几个考点；同题可命中多个考点，各项相加不等于总数，切勿累加当总数',
        ...lines,
        '',
        '【最近 3 条错题】',
        ...recentLines,
        '',
        '回答「我有多少道错题」时直接引用【错题总数】这一行的数字。',
      ].join('\n'),
      data: { total: count.total, summary, recent: recent.map((q) => q.id) },
    };
  },
};

const addQuestionTool: ToolDefinition = {
  name: 'add_question',
  description:
    '把学生刚做错的一道题写入错题本并自动排队生成变式。当学生明确提供完整错题（题干，最好含答案或解析）并要求「记下来/入库」时调用；信息不足时先追问，不要凭空补造答案。',
  schema: z.object({
    text_body: z.string().min(2).max(4000).describe('题目正文，可用 LaTeX'),
    chapter: z.string().max(100).optional().describe('章节名称，不确定可留空由系统推断'),
    kp_codes: z.array(z.string()).max(6).optional().describe('考纲考点编号，如 ["1.6"]'),
    question_type: z
      .enum(['选择题', '填空题', '计算题', '证明题', '应用题', '翻译题', '简答题', '编程题'])
      .optional()
      .describe(
        '题型。数学用选择题/填空题/计算题/证明题；英语只能用选择题或翻译题（我只有这两种英语错题）；计算机用选择题/填空题/简答题/编程题。省略时按有无选项与当前科目推断',
      ),
    options: z.array(z.string()).max(8).optional().describe('选择题选项，如 ["A. 1","B. 2"]'),
    answer: z.string().max(2000).optional().describe('标准答案'),
    solution: z.string().max(6000).optional().describe('解析过程'),
    note: z.string().max(1000).optional().describe('学生备注或错因'),
    title: z.string().max(100).optional(),
  }),
  /**
   * 把错题写入错题本并排队生成变式（副作用：写数据库 + 入队）。
   * @param args 题目正文、章节、考点、答案等字段
   * @param ctx 工具上下文（科目）
   */
  async execute(args, ctx) {
    const card: ImportCard = {
      subject: ctx.subject,
      chapter: args.chapter || '',
      kpCodes: args.kp_codes ?? [],
      questionType:
        args.question_type ||
        (args.options ? '选择题' : ctx.subject === 'math' ? '计算题' : ctx.subject === 'english' ? '翻译题' : '填空题'),
      textBody: args.text_body,
      options: args.options ?? null,
      answer: args.answer ?? null,
      solution: args.solution ?? null,
      note: args.note ?? null,
      title: args.title ?? '',
      source: 'agent',
    };
    const result = await importCards([card], { subject: ctx.subject, source: 'agent' });
    if (result.imported.length > 0) {
      const item = result.imported[0];
      const enq = await enqueueVariant(item.id);
      return {
        text: `已入库，编号 ${item.id}${enq.enqueued ? '，正在排队生成变式' : '，变式已在队列中'}。可以在错题本查看。`,
        data: { questionId: item.id, enqueued: enq.enqueued },
      };
    }
    if (result.skipped.length > 0) {
      return {
        text: `这道题已经入库过了（编号 ${result.skipped[0].id}），没有重复添加。`,
        data: { questionId: result.skipped[0].id, duplicate: true },
      };
    }
    return {
      text: `入库失败：${result.errors[0]?.reason ?? '题目信息不完整'}。请把题干、答案或解析补充完整后再试。`,
    };
  },
};

const generateVariantTool: ToolDefinition = {
  name: 'generate_variant',
  description:
    '为错题本中的某道题触发一组新的 L1/L2/L5 变式题。当学生说「给我出几道同类题」且能定位到具体错题编号时调用；如果学生只是想要普通练习题，不要调用，直接讲解即可。',
  schema: z.object({
    question_id: z.string().min(1).describe('错题编号，如 Q-20261022-001'),
  }),
  /**
   * 为指定错题触发一组变式题生成任务（副作用：入队；校验题目归属当前科目）。
   * @param args 含 question_id
   * @param ctx 工具上下文（科目）
   * @throws 题目不存在抛 notFound，跨科目抛 badRequest
   */
  async execute(args, ctx) {
    const question = await questionRepo.getQuestionById(args.question_id);
    if (!question) throw notFound(`题目 ${args.question_id} 不存在`);
    if (question.subject !== ctx.subject) throw badRequest('该错题不属于当前科目');
    const result = await enqueueVariant(question.id);
    const counts = await jobsRepo.progress();
    return {
      text: result.enqueued
        ? `已为 ${question.id} 排队生成变式，当前队列中还有 ${counts.counts.queued + counts.counts.running} 个任务。生成完成后可在错题本查看。`
        : `该题的变式正在生成中（状态：${result.job.status}），请稍后在错题本查看。`,
      data: { questionId: question.id, enqueued: result.enqueued, status: result.job.status },
    };
  },
};

const getProfileTool: ToolDefinition = {
  name: 'get_profile',
  description:
    '读取学生的跨科目全局画像（目标分数、自评水平、考试分数历史、失分知识点、老师点评）。在需要个性化调整讲解难度，或学生提到自己的基础/目标/考试情况时调用；不要凭空编造画像内容。',
  schema: z.object({}),
  /**
   * 读取学生跨科目全局画像并格式化为文本（读数据库）。
   * @returns 含目标分数、自评、基础、薄弱考点与最近考试的画像文本
   */
  async execute() {
    const profile = await loadProfile();
    const labels = profile.labels ?? {};
    const exams = (profile.examEvents ?? []).slice(-3);
    const levelText: Record<string, string> = { weak: '弱', medium: '中', strong: '强' };
    return {
      text: [
        '【全局画像】',
        `目标分数：${labels.target_score ?? '未设置'}/150`,
        `学生自评：${levelText[String(labels.self_level)] ?? labels.self_level ?? '未设置'}`,
        `基础水平：${labels.base_level ?? '未设置'}`,
        `薄弱考点：${Array.isArray(labels.weak_kp) && labels.weak_kp.length > 0 ? labels.weak_kp.join('、') : '未设置'}`,
        exams.length > 0
          ? `最近考试：\n${exams.map((e) => `- ${String(e.date).slice(0, 10)}｜${e.subject}｜${e.score}/${e.maxScore}｜失分考点 ${(e.lostKps ?? []).join('、') || '无'}`).join('\n')}`
          : '最近考试：暂无记录',
      ].join('\n'),
      data: profile,
    };
  },
};

const updateProfileTool: ToolDefinition = {
  name: 'update_profile',
  description:
    '合并更新学生的全局画像标签。当学生明确说出基础水平、目标分数、薄弱考点等信息时调用；不确定的信息不要写入。考试分数与失分知识点由交卷自动记录，无需手动写入。',
  schema: z.object({
    patch: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
      .describe('要合并的标签，如 {"base_level":"薄弱","target":"一本","weak_kp":["1.6"]}'),
  }),
  /**
   * 合并更新学生全局画像标签（副作用：写数据库）。
   * @param args 含 patch（要合并的标签对象）
   */
  async execute(args) {
    const profile = await patchProfile({ labels: args.patch });
    const labels = profile.labels ?? {};
    return {
      text: `画像已更新。当前关键标签：基础水平=${labels.base_level ?? '未设置'}；目标=${labels.target ?? '未设置'}；薄弱考点=${
        Array.isArray(labels.weak_kp) ? labels.weak_kp.join('、') || '未设置' : '未设置'
      }。`,
      data: profile,
    };
  },
};

const assembleExamTool: ToolDefinition = {
  name: 'assemble_exam',
  description:
    '按湖南专升本组卷规则生成一套当前科目的模拟卷。当学生明确要求「出一套模拟卷/整卷」时调用；只想要几道练习题时不要调用，改用错题变式。',
  schema: z.object({
    range: z.array(z.string()).max(20).optional().describe('限定章节范围；不填则按完整考纲组卷'),
  }),
  /**
   * 按组卷规则生成一套当前科目的模拟卷（副作用：生成试卷数据）。
   * @param args 可选 range（限定章节范围）
   * @param ctx 工具上下文（科目）
   */
  async execute(args, ctx) {
    const paper = await generateExam({ subject: ctx.subject, range: args.range ?? null });
    const sections = paper.items.reduce<Record<string, number>>((acc, it) => {
      acc[it.sectionName] = (acc[it.sectionName] ?? 0) + 1;
      return acc;
    }, {});
    return {
      text: `已生成《${paper.title}》，共 ${paper.items.length} 题，满分 ${paper.maxScore} 分，考试时长 ${paper.durationMin} 分钟。卷面结构：${Object.entries(
        sections,
      )
        .map(([k, v]) => `${k} ${v} 题`)
        .join('；')}。试卷编号 ${paper.id}，可在「模拟卷」页面作答。`,
      data: { examId: paper.id, itemCount: paper.items.length, maxScore: paper.maxScore },
    };
  },
};

export const TOOLS: ToolDefinition[] = [
  knowledgeTool,
  wrongbookSummaryTool,
  addQuestionTool,
  generateVariantTool,
  getProfileTool,
  updateProfileTool,
  assembleExamTool,
];

/** 工具名到工具定义的索引，供 executeTool 快速查找 */
const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * 把所有工具的 zod schema 转换为 OpenAI Function Calling 所需的 JSON Schema。
 * @returns LlmToolSchema 数组（已移除 $schema 字段）
 */
export function getToolSchemas(): LlmToolSchema[] {
  return TOOLS.map((tool) => {
    const jsonSchema = (zodToJsonSchema as unknown as (s: unknown, o: unknown) => Record<string, unknown>)(
      tool.schema,
      { target: 'jsonSchema7' },
    );
    delete jsonSchema.$schema;
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: jsonSchema,
      },
    };
  });
}

/**
 * 按名称执行工具：解析 JSON 参数 → zod 校验 → 调用 execute（副作用：依工具而定）。
 * 任何查找/解析/校验/执行错误都被捕获为 error 字段返回，不向外抛出。
 * @param name 工具名
 * @param rawArgs 模型输出的 JSON 字符串参数
 * @param ctx 工具上下文（科目、会话）
 * @returns 成功时含 result，失败时含 error
 */
export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<{ result?: ToolResult; error?: string }> {
  const tool = toolMap.get(name);
  if (!tool) return { error: `未知工具：${name}` };
  let parsedArgs: unknown;
  try {
    parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { error: `工具 ${name} 的参数不是合法 JSON` };
  }
  const parsed = tool.schema.safeParse(parsedArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；');
    return { error: `工具 ${name} 参数校验失败：${issues}` };
  }
  try {
    const result = await tool.execute(parsed.data, ctx);
    logger.info({ event: 'tool.executed', tool: name }, '[agent] tool executed');
    return { result };
  } catch (err) {
    logger.warn({ event: 'tool.failed', tool: name, err: (err as Error).message }, '[agent] tool failed');
    return { error: `工具 ${name} 执行失败：${(err as Error).message}` };
  }
}

/**
 * 批量把题目入队（变式生成任务）的便捷封装。
 * @param questionIds 题目编号数组
 * @returns 每题的入队结果
 */
export async function enqueueForImport(questionIds: string[]): Promise<{ questionId: string; enqueued: boolean }[]> {
  return enqueueMany(questionIds);
}

export type { QuestionCard };
