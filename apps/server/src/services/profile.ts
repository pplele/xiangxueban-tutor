import type { ExamEvent, TeacherNarrative, UserProfile } from '@tutor/shared';
import { complete } from '../agent/llm';
import { englishTeacher } from '../agent/prompts/english';
import { mathTeacher } from '../agent/prompts/math';
import { badRequest } from '../lib/errors';
import { logger } from '../lib/logger';
import * as profileRepo from '../repos/profile';
import * as vocabRepo from '../repos/vocab';

/**
 * 读取当前学生学习画像。
 * @returns 用户画像
 */
export async function getProfile(): Promise<UserProfile> {
  return profileRepo.getProfile();
}

/** 画像中系统预置的标签键 */
export const PROFILE_LABEL_KEYS = ['base_level', 'target', 'weak_kp', 'target_score', 'self_level'] as const;

/** 自评水平合法取值 */
const SELF_LEVELS = ['weak', 'medium', 'strong'] as const;

/**
 * 清洗并校验画像标签：键名格式、数量上限、target_score 范围、self_level 枚举、值类型与长度。
 * 非法值直接抛 400。
 */
function sanitizeLabels(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(patch);
  if (entries.length > 20) throw badRequest('画像标签数量过多（最多 20 个）');
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(key)) {
      throw badRequest(`画像标签名不合法：${key}`);
    }
    if (key === 'target_score') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 150) throw badRequest('目标分数应在 0~150 之间');
      out[key] = Math.round(n);
      continue;
    }
    if (key === 'self_level') {
      const s = String(value);
      if (!SELF_LEVELS.includes(s as (typeof SELF_LEVELS)[number])) {
        throw badRequest('自评水平只能是 weak / medium / strong');
      }
      out[key] = s;
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.slice(0, 500);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.filter((v) => typeof v === 'string').map((v) => String(v).slice(0, 100)).slice(0, 30);
    } else {
      throw badRequest(`画像标签 ${key} 的值类型不支持`);
    }
  }
  return out;
}

/**
 * 局部更新画像标签：清洗后合并入库，返回最新画像。
 * @param input 含可选 labels 的更新入参
 */
export async function patchProfile(input: { labels?: Record<string, unknown> }): Promise<UserProfile> {
  if (input.labels) {
    await profileRepo.mergeLabels(sanitizeLabels(input.labels));
  }
  return getProfile();
}

/**
 * 每次交卷都记一笔：分数 + 失分知识点，画像随之更新。
 * @param event 考试事件
 */
export async function recordExamEvent(event: ExamEvent): Promise<void> {
  await profileRepo.appendExamEvent(event);
  logger.info(
    { event: 'profile.exam_recorded', subject: event.subject, score: event.score, examId: event.id },
    '[profile] exam score recorded',
  );
}

/**
 * 手动删卷时同步移除画像里的对应考试记录。
 * @param examId 试卷 id
 */
export async function removeExamRecord(examId: string): Promise<void> {
  await profileRepo.removeExamEventById(examId);
}

/**
 * 清除测试 / 旧数据：抹掉全部考试事件与老师点评，只保留学生填的目标与自评。
 * @returns 清理后的画像
 */
export async function resetExamData(): Promise<UserProfile> {
  const profile = await profileRepo.clearExamData();
  logger.info({ event: 'profile.data_reset' }, '[profile] exam events and narratives cleared');
  return profile;
}

/**
 * 单词测试概况：轮次、最近一轮三色分布、历轮趋势，供英语词汇评价使用。
 * @param username 用户名
 * @returns 概况，无记录返回 null
 */
export async function vocabSnapshot(username: string) {
  const rounds = await vocabRepo.listRounds(username, 30);
  if (rounds.length === 0) return null;
  // listRounds 按 round_no DESC，rounds[0] 是最近一轮
  const latest = rounds[0];
  const first = rounds[rounds.length - 1];
  const total = latest.total || 1;
  const isoDate = (v: string | Date) =>
    (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  return {
    rounds: rounds.length,
    latestRoundNo: latest.roundNo,
    latestAt: isoDate(latest.finishedAt),
    words: total,
    green: latest.green,
    yellow: latest.yellow,
    red: latest.red,
    greenPct: Math.round((latest.green / total) * 100),
    yellowPct: Math.round((latest.yellow / total) * 100),
    redPct: Math.round((latest.red / total) * 100),
    greenTrend: latest.green - first.green,
    recent: rounds.slice(0, 6).map((r) => ({ roundNo: r.roundNo, green: r.green, yellow: r.yellow, red: r.red })),
  };
}

/** vocabSnapshot 的返回类型 */
type VocabSnapshot = Awaited<ReturnType<typeof vocabSnapshot>>;

/**
 * 规则版画像点评兜底：英语有词汇记录即可评分，其它科目必须有真实考试记录；
 * 基于分数/失分考点/词汇三色拼出优缺点与建议。
 * @returns 点评，数据不足返回 null
 */
function fallbackNarrative(
  subject: string,
  profile: UserProfile,
  vocab: VocabSnapshot,
): TeacherNarrative | null {
  const events = profile.examEvents.filter((e) => e.subject === subject);
  const scores = events.map((e) => e.score);

  // 英语：有词汇记录就够了，不必等英语考试
  if (subject === 'english' && vocab) {
    const kpCount = new Map<string, number>();
    for (const e of events) {
      for (const kp of e.lostKps) kpCount.set(kp, (kpCount.get(kp) ?? 0) + 1);
    }
    const topKps = [...kpCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    const strengths = [`已完成 ${vocab.rounds} 轮单词测试，最近一轮认识 ${vocab.green} 词（${vocab.greenPct}%）`];
    if (vocab.greenTrend > 0) strengths.push(`熟悉词比首轮多了 ${vocab.greenTrend} 个，确实在涨`);
    const weaknesses = [`还有 ${vocab.red} 个词没记住（${vocab.redPct}%），${vocab.yellow} 个模糊词卡在中间`];
    if (scores.length) weaknesses.push(`英语闭卷最近一次 ${scores[scores.length - 1]} 分`);
    if (topKps.length) weaknesses.push(`英语反复失分考点：${topKps.join('、')}`);
    const advice = `踏实一点，别自我感动——每轮把红词和黄词单独拎出来反复过，绿词也别扔，隔几天回炉一次。现在熟悉率 ${vocab.greenPct}%，把红词啃下来这个分一定要拿到。`;
    return { strengths, weaknesses, advice, generatedAt: new Date().toISOString() };
  }

  // 其它科目：必须有真实考试记录才给评价
  if (scores.length === 0) return null;

  const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  const kpCount = new Map<string, number>();
  for (const e of events) {
    for (const kp of e.lostKps) kpCount.set(kp, (kpCount.get(kp) ?? 0) + 1);
  }
  const topKps = [...kpCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  const target = Number(profile.labels.target_score ?? 0);
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  strengths.push(`已完成 ${scores.length} 次${subject === 'math' ? '数学' : '英语'}闭卷考试，最近一次 ${scores[scores.length - 1]} 分`);
  if (target && avg >= target) strengths.push(`平均分 ${avg} 已达到目标分 ${target}`);
  if (topKps.length) weaknesses.push(`反复失分考点：${topKps.join('、')}`);
  if (target && avg && avg < target) weaknesses.push(`距离目标分 ${target} 还差 ${Math.round((target - avg) * 10) / 10} 分`);
  if (!weaknesses.length) weaknesses.push('暂时没有明显短板，继续用高分卷保持状态');
  const advice = subject === 'math'
    ? `先把上面列出来的失分考点一个一个啃下来，别贪多。每道错题写清「卡在哪一步」，下次只错同一类题才算真掌握。${target ? `目标 ${target} 分不是喊出来的，按现在的平均分往上抬，一次提 5 分就够。` : ''}咱们一步步来，是不是这个道理？`
    : `别自我感动，错题看一遍不算吃透。把上面这些失分点对应的单词和语法拎出来，每天踏实过一遍，阅读和作文的分数自然就上来了。${target ? `目标 ${target} 分，差多少心里有数，这个分一定要拿到。` : ''}`;
  return { strengths, weaknesses, advice, generatedAt: new Date().toISOString() };
}

/** 科目代码到中文名的映射（用于点评 Prompt） */
const SUBJECT_NAME: Record<string, string> = { math: '数学', english: '英语', cs: '计算机' };

/**
 * 按科目调用对应老师人设（数学/英语）生成画像点评并入库；无真实数据则删除该科已有评价；
 * LLM 调用失败时退回规则版 fallbackNarrative 兜底。
 * @param subjects 待刷新科目，默认数学+英语
 * @param username 用户名（英语词汇评价需要）
 * @returns 最新画像
 */
export async function refreshNarratives(
  subjects: string[] = ['math', 'english'],
  username?: string,
): Promise<UserProfile> {
  const profile = await getProfile();
  let vocab: VocabSnapshot = null;
  if (username && subjects.includes('english')) {
    vocab = await vocabSnapshot(username).catch((err) => {
      logger.warn({ event: 'profile.vocab_failed', error: String(err) }, '[profile] vocab snapshot failed');
      return null;
    });
  }

  for (const subject of subjects) {
    const card = subject === 'math' ? mathTeacher : subject === 'english' ? englishTeacher : null;
    if (!card) continue;

    const events = profile.examEvents.filter((e) => e.subject === subject);
    const hasVocab = subject === 'english' && Boolean(vocab);
    // 没有任何真实数据（数学没考试 / 英语既没考试也没单词记录）：不产生评价，并清掉旧的
    if (events.length === 0 && !hasVocab) {
      await profileRepo.deleteNarrative(subject);
      continue;
    }

    const kpCount = new Map<string, number>();
    for (const e of events) for (const kp of e.lostKps) kpCount.set(kp, (kpCount.get(kp) ?? 0) + 1);
    const topKps = [...kpCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const userData = JSON.stringify({
      subject: SUBJECT_NAME[subject] ?? subject,
      targetScore: profile.labels.target_score ?? null,
      selfLevel: profile.labels.self_level ?? null,
      // 英语薄弱考点来自英语考试的真实失分考点（E 编码，章节按库课教材），不用用户手填的标签，避免串进数学编码
      weakKp: subject === 'english' ? topKps.map(([k]) => k) : (profile.labels.weak_kp ?? []),
      exams: events.map((e) => ({
        date: String(e.date).slice(0, 10),
        score: e.score,
        maxScore: e.maxScore,
        lostKps: e.lostKps,
      })),
      lostKpRanking: topKps,
      // 英语专属：来自 /vocab 单词测试记录的词汇评价数据
      vocab: subject === 'english' ? vocab : undefined,
    });
    let narrative: TeacherNarrative | null = null;
    try {
      const res = await complete(
        [
          {
            role: 'system',
            content: [
              card.voiceDirective,
              '',
              '现在你要根据学生的真实学习记录写一份学习画像点评。严格输出 JSON：',
              '{"strengths":["优点1","优点2"],"weaknesses":["缺点1","缺点2"],"advice":"一段话的针对性建议"}',
              '要求：优点、缺点各 2~3 条，每条不超过 30 字；advice 80~150 字，必须引用具体分数、失分考点或单词三色数据；',
              subject === 'english'
                ? '英语评价重点看 vocab 词汇记录（绿=认识/黄=模糊/红=遗忘的单词数与占比、熟悉词趋势），并结合英语考试分数与 lostKpRanking 里的英语失分考点（E 编码，对应《库课·大学英语》笔记章节）；用刘晓艳的口吻点评词汇与错题掌握情况。'
                : '',
              '不要 Markdown 标题，不要客套开场，不要「综上所述」；只输出 JSON，不要多余文字。',
            ].filter(Boolean).join('\n'),
          },
          { role: 'user', content: userData },
        ],
        { temperature: 0.6, jsonMode: true, maxTokens: 700 },
      );
      const jsonText = res.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      const parsed = JSON.parse(jsonText) as Partial<TeacherNarrative>;
      if (Array.isArray(parsed.strengths) && Array.isArray(parsed.weaknesses) && typeof parsed.advice === 'string') {
        narrative = {
          strengths: parsed.strengths.filter((x) => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 60)),
          weaknesses: parsed.weaknesses.filter((x) => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 60)),
          advice: parsed.advice.slice(0, 600),
          generatedAt: new Date().toISOString(),
        };
      }
    } catch (err) {
      logger.warn({ event: 'profile.narrative_failed', subject, error: String(err) }, '[profile] LLM narrative failed, using fallback');
    }
    const finalNarrative = narrative ?? fallbackNarrative(subject, profile, vocab);
    if (finalNarrative) await profileRepo.saveNarrative(subject, finalNarrative);
  }
  return getProfile();
}
