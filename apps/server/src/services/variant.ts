import type { VariantItem } from '@tutor/shared';
import { complete, type LlmMessage } from '../agent/llm';
import { parseLooseJson } from '../lib/json';
import { normalizeForFingerprint } from '../lib/crypto';
import { truncate } from '../lib/text';
import { logger } from '../lib/logger';
import { listWhitelist } from '../repos/meta';
import * as questionRepo from '../repos/questions';
import * as variantRepo from '../repos/variants';

/** 科目代码到考纲中文名的映射（用于 Prompt） */
const SUBJECT_NAME: Record<string, string> = {
  math: '高等数学',
  english: '大学英语',
  computer: '计算机基础',
  cs: '计算机基础',
};

/** 从 LLM JSON 解析出的单道变式草稿 */
interface VariantItemDraft {
  level: string;
  stem: string;
  answer: string;
  solution: string;
  kpCodes: string[];
  targetTrap: string | null;
}

/**
 * 判断第三道变式的层次：当所有考点要求都仅为「了解」时降级为 L1，否则为 L5。
 * @param kpLevels 各考点的要求层次
 */
function needsL1Third(kpLevels: string[]): boolean {
  if (kpLevels.length === 0) return false;
  return kpLevels.every((level) => {
    const parts = level.split(/[\/、,，\s]+/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => p.trim() === '了解');
  });
}

/**
 * 拼装变式生成 Prompt：固定 L1 换数 / L2 改问法 / 第三道（L5 或降级 L1）配比，
 * 注入原题、考点白名单与硬性规则，要求只输出 JSON。
 */
function buildPrompt(params: {
  subject: string;
  questionType: string;
  stem: string;
  options: string[];
  kpText: string;
  levelText: string;
  answer: string;
  thirdLevel: string;
  whitelistText: string;
}): string {
  const name = SUBJECT_NAME[params.subject] ?? params.subject;
  const isEnglish = params.subject === 'english';
  /** 英语按「换语境 / 改考法 / 概念辨析」出题，数学按「换数 / 改问法 / 概念辨析」 */
  const levelRules = isEnglish
    ? `- 第 1 道 L1 同类换语境：考点、题型、问法完全不变，只换句子、词汇或语境（换名词、换时间状语、换一段同难度材料）。
- 第 2 道 L2 改问法或改条件：同一知识点换考法（语法题换考另一类从句、阅读题从细节题改推理题、翻译题换句型或改英译汉为汉译英），**不允许只换词**。
- 第 3 道 ${params.thirdLevel}：${
        params.thirdLevel === 'L5'
          ? '概念辨析：给一个常见语法结论或错误译文让判断/改正，必须附「为什么错」的解析；题型仍与原题一致。'
          : '因考纲要求层次仅为「了解」，降级为 L1：同类换语境、题型与问法不变。'
      }`
    : `- 第 1 道 L1 同类换数：结构与问法不变，只换数值、函数或词汇。
- 第 2 道 L2 改问法或改条件：知识点同类但问法/条件变化，**不允许只换数字**。
- 第 3 道 ${params.thirdLevel}：${
        params.thirdLevel === 'L5'
          ? '概念辨析：判断题或选择题，考定义、定理成立条件、常见错误结论，必须附「为什么错」的解析。'
          : '因考纲要求层次仅为「了解」，降级为 L1：同类换数、结构与问法不变。'
      }`;
  const englishTypeRules = isEnglish
    ? `6. 英语错题只有选择题和翻译题两种，三道变式的题型必须和【原题题型】完全一致：
   - 原题是选择题：三道都得是选择题，把 A. B. C. D. 四个选项写在 stem 末尾（每个选项单独一行），answer 只写字母。
   - 原题是翻译题：三道都得是翻译句，stem 写待译原句，answer 写参考译文（英译汉写中文，汉译英写英文），不要写选项、不要出选择题。
   - 绝对不许输出填空题、写作题。`
    : '';
  return `你是湖南省专升本${name}命题老师。学生做错了一道题，请出 3 道变式，检验他是真懂还是只会这一道。

【原题题型】${params.questionType || '未标注'}
【原题】${truncate(params.stem, 1200)}
【选项】${params.options.length > 0 ? params.options.join(' ') : '无'}
【考点】${params.kpText}
【考纲要求层次】${params.levelText || '未标注'}
【标准答案】${truncate(params.answer, 800)}

【考纲考点白名单（kp_codes 只能从中选择）】
${params.whitelistText}

【固定配比，不得改动】
${levelRules}

【硬性规则】
1. kp_codes 只填考点编号（如 "1.1"），不要带名称；且必须全部来自上面的考纲白名单，超纲即废题。
2. 不得与原题相同。第 2 道必须真的改变问法或条件。
3. 每题给：level、stem、answer、solution（逐步解析）、kp_codes、target_trap（埋的坑）。
4. ${
    params.subject === 'math'
      ? '公式用 $...$，中文表述，不使用超出考纲的记号。'
      : '英语/计算机题用人话和原文表述，不要套用 LaTeX 公式；解析用中文。'
  }
5. JSON 字符串里不许出现未转义的英文双引号：需要引用英文原词或原句时用中文引号「」，代码用反引号包裹，否则整段 JSON 会解析失败。
${englishTypeRules}

【输出 JSON】
{"level_combo":"L1+L2+${params.thirdLevel}","items":[{"level":"L1","stem":"","answer":"","solution":"","kp_codes":[],"target_trap":""},{"level":"L2","stem":"","answer":"","solution":"","kp_codes":[],"target_trap":""},{"level":"${params.thirdLevel}","stem":"","answer":"","solution":"","kp_codes":[],"target_trap":""}]}
只输出 JSON，不要解释。`;
}

/**
 * 校验并清洗 LLM 输出的变式：检查数量、字段、考点是否超白名单、是否与原题/彼此重复。
 * 考点编号带名称的写法会被截取为编号；不合法处收集到 issues。
 */
function validateOutput(
  data: unknown,
  whitelist: Set<string>,
  thirdLevel: string,
  originalStem: string,
): { items: VariantItemDraft[]; issues: string[] } {
  const issues: string[] = [];
  const obj = data as { items?: unknown };
  if (!obj || !Array.isArray(obj.items)) {
    return { items: [], issues: ['缺少 items 数组'] };
  }
  const rawItems = obj.items;
  if (rawItems.length !== 3) issues.push(`变式数量应为 3，实际为 ${rawItems.length}`);
  const expected = ['L1', 'L2', thirdLevel];
  const items: VariantItemDraft[] = [];
  const stems = new Set<string>();

  for (let i = 0; i < Math.min(rawItems.length, 3); i++) {
    const raw = rawItems[i] as Record<string, unknown>;
    const level = String(raw.level ?? '').trim().toUpperCase();
    const stem = String(raw.stem ?? '').trim();
    const answer = String(raw.answer ?? '').trim();
    const solution = String(raw.solution ?? '').trim();
    const kpCodesRaw = (Array.isArray(raw.kp_codes)
      ? raw.kp_codes.map(String)
      : Array.isArray(raw.kpCodes)
        ? raw.kpCodes.map(String)
        : []
    ).map((code) => {
      // 容忍模型输出「1.6 极限运算法则」这类带名称的写法
      const m = /^([A-Za-z]?\d+(?:\.\d+)*)/.exec(code.trim());
      return m ? m[1] : code.trim();
    });
    if (!level) issues.push(`第 ${i + 1} 题缺少 level`);
    if (!stem) issues.push(`第 ${i + 1} 题缺少 stem`);
    if (!answer || answer.length < 1) issues.push(`第 ${i + 1} 题答案为空`);
    if (!solution || solution.length < 2) issues.push(`第 ${i + 1} 题解析为空`);
    if (kpCodesRaw.length === 0) issues.push(`第 ${i + 1} 题缺少 kp_codes`);
    const invalid = kpCodesRaw.filter((c) => !whitelist.has(c));
    if (invalid.length > 0) issues.push(`第 ${i + 1} 题考点 ${invalid.join('、')} 超出白名单`);
    if (stem) {
      const norm = normalizeForFingerprint(stem);
      if (norm === normalizeForFingerprint(originalStem)) issues.push(`第 ${i + 1} 题与原题相同`);
      if (stems.has(norm)) issues.push(`第 ${i + 1} 题与其他变式重复`);
      stems.add(norm);
    }
    items.push({
      level,
      stem,
      answer,
      solution,
      kpCodes: kpCodesRaw.filter((c) => whitelist.has(c)),
      targetTrap: raw.target_trap ? String(raw.target_trap) : null,
    });
  }

  for (let i = 0; i < items.length; i++) {
    if (items[i].level !== expected[i]) {
      issues.push(`第 ${i + 1} 题 level 应为 ${expected[i]}，实际为 ${items[i].level || '空'}`);
    }
  }
  return { items, issues };
}

/** 变式生成结果：变式组 id 与题目列表 */
export interface GenerateResult {
  setId: string;
  items: VariantItem[];
}

/**
 * 为单题生成一套 L1/L2/L5 变式：调用 LLM（jsonMode）→ 宽松解析 → 白名单/重复校验，
 * 校验失败或 JSON 不合法时把错误回喂模型自动重试 1 次（兜底链）；成功后入库并把题目置为「已生成变式」，
 * 两次都失败则置回「待变式」并抛错。
 * @param questionId 错题 id
 * @returns 变式组 id 与变式列表
 */
export async function generateVariantSet(questionId: string): Promise<GenerateResult> {
  const question = await questionRepo.getQuestionRow(questionId);
  if (!question) throw new Error(`题目 ${questionId} 不存在`);

  const whitelistRows = await listWhitelist(question.subject);
  const whitelist = new Set(whitelistRows.map((w) => w.kp_code));
  const kpNames = new Map(whitelistRows.map((w) => [w.kp_code, w.kp_name]));
  const kpText =
    question.kp_codes.map((c) => `${c} ${kpNames.get(c) ?? ''}`).join('；') || '未标注';
  const levelFromWhitelist = question.kp_codes.map((c) => whitelistRows.find((w) => w.kp_code === c)?.level ?? '');
  const kpLevels =
    question.kp_levels.filter(Boolean).length > 0 ? question.kp_levels.filter(Boolean) : levelFromWhitelist.filter(Boolean);
  const thirdLevel = needsL1Third(kpLevels) ? 'L1' : 'L5';
  const whitelistText = whitelistRows.map((w) => `${w.kp_code} ${w.kp_name}（${w.level ?? '掌握'}）`).join('\n');
  const options = Array.isArray(question.options) ? (question.options as string[]) : [];

  const basePrompt = buildPrompt({
    subject: question.subject,
    questionType: question.question_type,
    stem: question.text_body,
    options,
    kpText,
    levelText: kpLevels.join('、'),
    answer: question.answer ?? '',
    thirdLevel,
    whitelistText,
  });

  const messages: LlmMessage[] = [
    { role: 'system', content: basePrompt },
    { role: 'user', content: '请按固定配比输出 3 道变式题的 JSON。' },
  ];

  let lastIssues: string[] = [];
  let parsed: unknown = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { content } = await complete(messages, {
      temperature: 0.6,
      maxTokens: 3000,
      jsonMode: true,
    });
    try {
      parsed = parseLooseJson(content);
    } catch (err) {
      lastIssues = [`JSON 解析失败：${(err as Error).message}`];
      messages.push({ role: 'assistant', content: content.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: `上面的输出不是合法 JSON：${lastIssues.join('；')}。请重新输出完整合法 JSON，不要解释。`,
      });
      continue;
    }
    const validation = validateOutput(parsed, whitelist, thirdLevel, question.text_body);
    if (validation.issues.length === 0) {
      const setId = `V${(await variantRepo.maxSetNumber(questionId)) + 1}`;
      const inserted = await variantRepo.insertVariantSet(
        questionId,
        setId,
        validation.items.map((it) => ({
          level: it.level,
          stem: it.stem,
          answer: it.answer,
          solution: it.solution,
          kpCodes: it.kpCodes,
          targetTrap: it.targetTrap,
        })),
      );
      await questionRepo.updateStatus(questionId, '已生成变式');
      logger.info(
        { event: 'variant.generated', questionId, setId, items: inserted.length },
        '[variant] set generated',
      );
      return { setId, items: inserted };
    }
    lastIssues = validation.issues;
    logger.warn({ event: 'variant.validation_failed', questionId, attempt, issues: lastIssues }, '[variant] invalid output');
    messages.push({ role: 'assistant', content: JSON.stringify(parsed).slice(0, 3000) });
    messages.push({
      role: 'user',
      content:
        `上面的输出有问题：${lastIssues.join('；')}。请重新输出**完整合法**的 JSON，` +
        `必须包含 level、stem、answer、solution、kp_codes、target_trap，数量为 3，` +
        `level 顺序为 L1、L2、${thirdLevel}。不要解释，只输出 JSON。`,
    });
  }

  await questionRepo.updateStatus(questionId, '待变式');
  throw new Error(`变式校验失败：${lastIssues.join('；')}`);
}
