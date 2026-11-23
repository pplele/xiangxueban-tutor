import { badRequest, notFound } from '../lib/errors';
import * as repo from '../repos/vocab';
import type { VocabState } from '../repos/vocab';

export interface BoardWord {
  id: number;
  word: string;
  phonetic: string;
  meaning: string;
  kind: string;
  /** 上一轮所在区域；第一次测是 new */
  zone: 'green' | 'yellow' | 'red' | 'new';
}

/**
 * 取整张词表（附上轮分区）：第一次测的词标记为 new。
 * @param username 用户名
 * @returns 词表、最近一轮与下一轮编号
 */
export async function getBoard(username: string): Promise<{
  words: BoardWord[];
  lastRound: repo.VocabRound | null;
  nextRoundNo: number;
}> {
  const [words, last] = await Promise.all([repo.listWords('english'), repo.latestRound(username)]);
  const states = last ? await repo.lastStates(last.id) : new Map<number, VocabState>();
  return {
    words: words.map((w) => ({
      id: w.id,
      word: w.word,
      phonetic: w.phonetic,
      meaning: w.meaning,
      kind: w.kind,
      zone: (states.get(w.id) ?? 'new') as BoardWord['zone'],
    })),
    lastRound: last,
    nextRoundNo: (last?.roundNo ?? 0) + 1,
  };
}

/**
 * 提交一轮：点过的词用本次标记；没点的词保留上一轮原区（第一次出现的词按遗忘算红）。
 * zone 取上一轮结果（第一次是 new），用于教师端分析「原来会的现在忘了」。
 * @param username 用户名
 * @param input 本轮标记（含 scope：word 只测单词 / all 连短语）
 * @returns 新轮次、轮次 id 与分区变化数
 */
export async function submitRound(
  username: string,
  input: { states: { wordId: number; state: VocabState }[]; startedAt?: string; scope?: 'word' | 'all' },
): Promise<{ round: repo.VocabRound; roundId: string; changed: number }> {
  const all = await repo.listWords('english');
  // scope=word 只测单词，短语不进本轮记录（否则未提交的短语会被误判成遗忘）
  const words = (input.scope ?? 'word') === 'all' ? all : all.filter((w) => w.kind === 'word');
  if (words.length === 0) throw badRequest('词表为空，请先导入单词');

  const last = await repo.latestRound(username);
  const prevStates = last ? await repo.lastStates(last.id) : new Map<number, VocabState>();
  const valid = new Set(words.map((w) => w.id));

  const given = new Map<number, VocabState>();
  for (const item of input.states) {
    if (!valid.has(item.wordId)) continue;
    if (!['green', 'yellow', 'red'].includes(item.state)) throw badRequest('状态只能是 green/yellow/red');
    given.set(item.wordId, item.state);
  }

  const items: { wordId: number; zone: string; state: VocabState }[] = [];
  let green = 0;
  let yellow = 0;
  let red = 0;
  let changed = 0;
  for (const w of words) {
    // 没点 = 保留原本区域；只有真正点过的词才改变分区
    const state = given.get(w.id) ?? prevStates.get(w.id) ?? 'red';
    const zone = prevStates.get(w.id) ?? 'new';
    if (state === 'green') green += 1;
    else if (state === 'yellow') yellow += 1;
    else red += 1;
    if (prevStates.size > 0 && zone !== 'new' && zone !== state) changed += 1;
    items.push({ wordId: w.id, zone, state });
  }

  const roundNo = (last?.roundNo ?? 0) + 1;
  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
  const roundId = await repo.insertRound({
    username,
    roundNo,
    green,
    yellow,
    red,
    startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
    items,
  });
  const round = await repo.latestRound(username);
  if (!round) throw badRequest('提交失败');
  return { round, roundId, changed };
}

/**
 * 列出用户的历史测试轮次。
 * @param username 用户名
 */
export async function listRounds(username: string): Promise<repo.VocabRound[]> {
  return repo.listRounds(username);
}

/**
 * 查看单轮明细，记录不存在抛 404。
 * @param roundId 轮次 id
 */
export async function roundDetail(roundId: string) {
  const detail = await repo.roundDetail(roundId);
  if (!detail.round) throw notFound('该轮测试记录不存在');
  return detail;
}

/**
 * 教师视角：所有学生的完成情况 + 最近一轮三色分布 + 词表数量统计。
 */
export async function teacherOverview(): Promise<{
  students: Awaited<ReturnType<typeof repo.studentsOverview>>;
  words: { total: number; words: number; phrases: number };
}> {
  const [students, words] = await Promise.all([repo.studentsOverview(), repo.countWords()]);
  return { students, words };
}
