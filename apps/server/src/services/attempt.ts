import type { QuestionCard, VariantItem, Verdict } from '@tutor/shared';
import { badRequest, notFound } from '../lib/errors';
import { extractChoiceLetter, isNumericEqual, normalizeAnswer } from '../lib/text';
import * as questionRepo from '../repos/questions';
import * as variantRepo from '../repos/variants';
import * as attemptRepo from '../repos/attempts';

/** 学生自评取值：掌握 / 部分掌握 / 未掌握 */
export type SelfRating = 'self_pass' | 'self_partial' | 'self_fail';

/**
 * 客观题判分：选择题提取选项字母比对，填空题做标准化后相等或数值等价判断。
 * @param questionType 题型（选择题/填空题）
 * @param correctAnswer 标准答案
 * @param userAnswer 学生答案
 * @returns correct / wrong
 */
export function gradeObjective(questionType: string, correctAnswer: string | null, userAnswer: string): Verdict {
  if (!correctAnswer) return 'wrong';
  if (questionType === '选择题') {
    const expected = extractChoiceLetter(correctAnswer);
    const got = extractChoiceLetter(userAnswer);
    return expected && got && expected === got ? 'correct' : 'wrong';
  }
  if (questionType === '填空题') {
    const expected = normalizeAnswer(correctAnswer);
    const got = normalizeAnswer(userAnswer);
    if (!got) return 'wrong';
    return expected === got || isNumericEqual(correctAnswer, userAnswer) ? 'correct' : 'wrong';
  }
  return 'wrong';
}

/** 类型守卫：判断未知值是否为合法的自评取值 */
export function isSelfRating(v: unknown): v is SelfRating {
  return v === 'self_pass' || v === 'self_partial' || v === 'self_fail';
}

/** 提交作答的入参 */
export interface SubmitAttemptInput {
  questionId: string;
  variantId?: number | null;
  answer: string;
  source: 'practice' | 'exam';
  selfRating?: SelfRating | null;
}

/** 提交作答的返回值：作答记录、判定、是否掌握、标准答案与解析、更新后题目状态 */
export interface SubmitAttemptResult {
  attempt: Awaited<ReturnType<typeof attemptRepo.insertAttempt>>;
  verdict: Verdict;
  correct: boolean;
  expectedAnswer: string | null;
  solution: string | null;
  questionStatus: string;
}

/**
 * 提交单题作答：优先用学生自评，其次按变式/客观题规则判分；判错则把题目置为「待复习」，最后落一条作答记录。
 * 解答题无自评时拒绝（不支持自动判分）。
 * @param input 作答输入（题目 id、可选变式、答案、来源、自评）
 * @returns 作答结果与判定，供前端展示标准答案与解析
 */
export async function submitAttempt(input: SubmitAttemptInput): Promise<SubmitAttemptResult> {
  const question = await questionRepo.getQuestionById(input.questionId);
  if (!question) throw notFound('题目不存在');

  let variant: VariantItem | null = null;
  if (input.variantId) {
    variant = await variantRepo.getVariant(input.variantId);
    if (!variant || variant.questionId !== question.id) throw notFound('变式题不存在或不属于该错题');
  }
  if (!input.answer && !input.selfRating) throw badRequest('答案不能为空');

  const expectedAnswer = variant ? variant.answer : question.answer ?? null;
  const solution = variant ? variant.solution : question.solution ?? null;
  let verdict: Verdict;

  if (input.selfRating) {
    verdict = input.selfRating;
  } else if (variant) {
    const expectedNorm = normalizeAnswer(expectedAnswer);
    const gotNorm = normalizeAnswer(input.answer);
    const expectedLetter = extractChoiceLetter(expectedAnswer);
    const gotLetter = extractChoiceLetter(input.answer);
    if (expectedLetter && gotLetter && expectedLetter === gotLetter) verdict = 'correct';
    else if (expectedNorm && gotNorm && (expectedNorm === gotNorm || isNumericEqual(expectedAnswer ?? '', input.answer))) {
      verdict = 'correct';
    } else {
      verdict = 'wrong';
    }
  } else if (question.questionType === '选择题' || question.questionType === '填空题') {
    verdict = gradeObjective(question.questionType, question.answer ?? null, input.answer);
  } else {
    throw badRequest('解答题暂不支持自动判分，请提交 self_rating 自评（self_pass/self_partial/self_fail）');
  }

  let questionStatus = question.status;
  if (verdict === 'wrong' || verdict === 'self_fail') {
    questionStatus = '待复习';
    await questionRepo.updateStatus(question.id, '待复习');
  }

  const attempt = await attemptRepo.insertAttempt({
    questionId: question.id,
    variantId: variant?.id ?? null,
    subject: question.subject,
    answer: input.answer ?? '',
    verdict,
    source: input.source,
  });

  return {
    attempt,
    verdict,
    correct: verdict === 'correct' || verdict === 'self_pass',
    expectedAnswer,
    solution,
    questionStatus,
  };
}

/**
 * 考试单题判分：有自评时按满分/半分/零分折算，否则用客观题规则判分。
 * @param question 题目卡片
 * @param answer 学生答案
 * @param selfRating 可选自评
 * @returns 判定、得分比例（0~1）与理由
 */
export function gradeExamItem(
  question: QuestionCard,
  answer: string,
  selfRating?: SelfRating | null,
): { verdict: Verdict; earned: number; reason: string } {
  if (selfRating) {
    const verdict = selfRating;
    const ratio = selfRating === 'self_pass' ? 1 : selfRating === 'self_partial' ? 0.5 : 0;
    return {
      verdict,
      earned: ratio,
      reason:
        selfRating === 'self_pass'
          ? '自评已掌握，按满分计'
          : selfRating === 'self_partial'
            ? '自评部分掌握，按半分计'
            : '自评未掌握，本题不得分',
    };
  }
  const verdict = gradeObjective(question.questionType, question.answer ?? null, answer);
  return {
    verdict,
    earned: verdict === 'correct' ? 1 : 0,
    reason:
      verdict === 'correct'
        ? '客观题判定正确'
        : question.answer
          ? `客观题判定错误，标准答案为 ${question.answer}`
          : '题目缺少标准答案，判定为错误',
  };
}
