import fs from 'node:fs';
import path from 'node:path';
import type { EvalMetric, EvalResult } from '@tutor/shared';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { parseLooseJson } from '../lib/json';
import { truncate } from '../lib/text';
import { badRequest } from '../lib/errors';
import { assemblePrompt } from '../agent/prompts/assemble';
import { complete } from '../agent/llm';
import { retrieve } from './rag';
import { getProfile } from './profile';
import * as questionRepo from '../repos/questions';

/** 评测集单题：问题、科目、题型（考纲内/超纲）、期望考点与来源、参考答案 */
export interface EvalQuestion {
  id: string;
  subject: string;
  query: string;
  kind: 'fact' | 'out_of_scope';
  expected_kp?: string[];
  /** 期望命中的知识库文件；一个考点跨多个文件时用数组，命中任一即可 */
  expected_source?: string | string[];
  reference: string;
}

/** LLM 评判员输出：分数、是否命中要点、超纲识别是否合格、理由 */
interface JudgeOutput {
  score: number;
  hit: boolean;
  out_of_scope_ok: boolean;
  reason: string;
}

/** 一组消融配置：是否开启重排序 / 画像注入 / 错题上下文 */
interface Config {
  name: string;
  rerank: boolean;
  profile: boolean;
  wrongbook: boolean;
}

/** 从 cwd 逐级向上及构建产物位置查找 eval/questions.jsonl，找不到抛错 */
function findEvalFile(): string {
  const candidates: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'eval', 'questions.jsonl'));
    dir = path.dirname(dir);
  }
  candidates.push(path.resolve(__dirname, '../../../eval/questions.jsonl'));
  candidates.push(path.resolve(__dirname, '../../../../eval/questions.jsonl'));
  candidates.push(path.resolve(__dirname, '../../../../../eval/questions.jsonl'));
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 eval/questions.jsonl');
  return found;
}

/**
 * 读取评测集：逐行解析 JSONL，过滤字段不全的坏行。
 * @returns 评测题目数组
 */
export function loadEvalQuestions(): EvalQuestion[] {
  const file = findEvalFile();
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const items: EvalQuestion[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as EvalQuestion;
      if (obj.id && obj.subject && obj.query && obj.reference) items.push(obj);
    } catch {
      // 忽略坏行
    }
  }
  return items;
}

/** 受限并发地遍历处理：最多 limit 个 worker 并发执行 fn，保持结果与原数组同序 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 检索命中判定：期望来源任一命中，或期望考点与命中块的考点有交集 */
function retrievalHit(item: EvalQuestion, chunks: Awaited<ReturnType<typeof retrieve>>['chunks']): boolean {
  const expSources = item.expected_source
    ? Array.isArray(item.expected_source)
      ? item.expected_source
      : [item.expected_source]
    : [];
  const sourceHit = expSources.some((s) => chunks.some((c) => c.sourceName.includes(s)));
  if (item.expected_kp && item.expected_kp.length > 0) {
    const kpHit = chunks.some((c) => c.kpCodes.some((kp) => item.expected_kp!.includes(kp)));
    return kpHit || sourceHit;
  }
  if (expSources.length > 0) return sourceHit;
  return chunks.length > 0;
}

/** 回答是否标注了出处（显式出处标记或包含来源名） */
function containsCitation(answer: string, sources: string[]): boolean {
  if (answer.includes('[出处:') || answer.includes('（出处：') || answer.includes('(出处:')) return true;
  return sources.some((s) => s && answer.includes(s));
}

/**
 * 用 LLM 当严格评判员打分（正确性/命中/出处/超纲识别）；LLM 失败时兜底按参考答案关键词重合度估算。
 * @param item 评测题
 * @param answer 模型回答
 * @param sources 检索来源名
 * @returns 分数、命中、超纲是否合格、理由
 */
async function judgeAnswer(item: EvalQuestion, answer: string, sources: string[]): Promise<JudgeOutput> {
  try {
    const { content } = await complete(
      [
        {
          role: 'system',
          content:
            '你是湖南专升本辅导系统的严格评测员。根据【学生问题】【参考答案】【模型回答】打分。' +
            '输出 JSON：{"score":0到1的小数,"hit":true/false,"out_of_scope_ok":true/false,"reason":"一句话"}。' +
            'score 综合考虑事实正确性、是否解决问题、是否标注出处（有依据时）。' +
            'hit 表示回答是否包含参考答案的关键结论。' +
            '若问题属于超出考纲内容，out_of_scope_ok 表示模型是否明确提示「超出湖南专升本考纲」；否则填 true。只输出 JSON。',
        },
        {
          role: 'user',
          content: [
            `【学生问题】${item.query}`,
            `【题型】${item.kind === 'out_of_scope' ? '超纲识别' : '考纲内知识'}`,
            `【参考答案】${truncate(item.reference, 800)}`,
            `【检索出处】${sources.length > 0 ? sources.join('、') : '（无）'}`,
            `【模型回答】${truncate(answer, 2000)}`,
          ].join('\n'),
        },
      ],
      { temperature: 0, maxTokens: 400, jsonMode: true },
    );
    const parsed = parseLooseJson<Partial<JudgeOutput>>(content);
    return {
      score: Math.max(0, Math.min(1, Number(parsed.score ?? 0))),
      hit: Boolean(parsed.hit),
      out_of_scope_ok: parsed.out_of_scope_ok === undefined ? true : Boolean(parsed.out_of_scope_ok),
      reason: String(parsed.reason ?? ''),
    };
  } catch (err) {
    logger.warn({ event: 'eval.judge_failed', id: item.id, err: (err as Error).message }, '[eval] judge failed');
    const overlap = tokenOverlap(answer, item.reference);
    return {
      score: overlap,
      hit: overlap > 0.25,
      out_of_scope_ok: item.kind === 'out_of_scope' ? answer.includes('超出') && answer.includes('考纲') : true,
      reason: `judge 失败，按关键词重合度估算：${overlap.toFixed(2)}`,
    };
  }
}

/** 计算回答与参考答案的关键词（中文词/英文词/数字）重合比例，用于 judge 失败兜底 */
function tokenOverlap(answer: string, reference: string): number {
  const tokens = (s: string) => new Set((s.match(/[一-龥]{2,}|[A-Za-z]{3,}|\d+/g) ?? []).slice(0, 200));
  const a = tokens(answer);
  const b = tokens(reference);
  if (b.size === 0) return 0;
  let hit = 0;
  for (const t of b) if (a.has(t)) hit += 1;
  return hit / b.size;
}

/** 评测运行选项：样本上限、要跑的消融项 */
export interface RunEvalOptions {
  limit?: number;
  ablations?: string[];
}

/** 支持的消融开关全集：rerank / profile / wrongbook_ctx */
const ALL_ABLATIONS = ['rerank', 'profile', 'wrongbook_ctx'];

/**
 * 跑消融评测：在 baseline 及各消融配置下，对评测集逐题执行检索→组 Prompt→LLM 回答→评判，
 * 统计命中率/引用率/质量分/超纲识别率/延迟。画像与错题缓存只加载一次复用。
 * @param options 样本上限与消融项
 * @returns 各配置指标与逐题明细
 */
export async function runEval(options: RunEvalOptions = {}): Promise<EvalResult> {
  const all = loadEvalQuestions();
  if (all.length === 0) throw badRequest('评测集为空');
  const limit = Math.max(1, Math.min(options.limit ?? env.evalLimit, all.length));
  const items = all.slice(0, limit);
  const ablations = (options.ablations ?? ALL_ABLATIONS).filter((a) => ALL_ABLATIONS.includes(a));

  const configs: Config[] = [
    { name: 'baseline', rerank: false, profile: false, wrongbook: false },
    ...ablations.map((a) => ({
      name: `+${a}`,
      rerank: a === 'rerank',
      profile: a === 'profile',
      wrongbook: a === 'wrongbook_ctx',
    })),
  ];

  const profile = await getProfile().catch(() => null);
  const wrongbookCache = new Map<string, Awaited<ReturnType<typeof questionRepo.recentForSubject>>>();
  for (const subject of new Set(items.map((i) => i.subject))) {
    wrongbookCache.set(subject, await questionRepo.recentForSubject(subject, 3).catch(() => []));
  }

  const metrics: EvalMetric[] = [];
  const details: Record<string, unknown>[] = [];

  for (const config of configs) {
    const started = Date.now();
    let hits = 0;
    let citationsOk = 0;
    let qualitySum = 0;
    let outScopeOk = 0;
    let outScopeCount = 0;
    let errors = 0;

    const rows = await mapLimit(items, 2, async (item) => {
      try {
        const retrieval = await retrieve(item.subject, item.query, {
          rerank: config.rerank,
          topK: env.rag.topKFinal,
          rewrite: false,
        });
        const assembled = assemblePrompt({
          subject: item.subject,
          chunks: retrieval.chunks,
          wrongbook: config.wrongbook ? wrongbookCache.get(item.subject) ?? [] : [],
          profile: config.profile ? profile : null,
          switches: { profileInject: config.profile, wrongbookInject: config.wrongbook },
        });
        const { content: answer } = await complete(
          [
            { role: 'system', content: assembled.system },
            { role: 'user', content: item.query },
          ],
          { temperature: 0, maxTokens: 700 },
        );
        const sources = [...new Set(retrieval.chunks.map((c) => c.sourceName))];
        const judged = await judgeAnswer(item, answer, sources);
        const hit = judged.hit || retrievalHit(item, retrieval.chunks);
        return {
          item,
          answer,
          chunks: retrieval.chunks.map((c) => c.sourceName),
          hit,
          citation: containsCitation(answer, sources),
          judged,
          rerank: retrieval.rerankApplied,
        };
      } catch (err) {
        errors += 1;
        logger.warn(
          { event: 'eval.item_failed', config: config.name, id: item.id, err: (err as Error).message },
          '[eval] item failed',
        );
        return {
          item,
          answer: '',
          chunks: [],
          hit: false,
          citation: false,
          judged: { score: 0, hit: false, out_of_scope_ok: false, reason: `执行失败：${(err as Error).message}` },
          rerank: false,
        };
      }
    });

    for (const row of rows) {
      if (row.hit) hits += 1;
      if (row.citation) citationsOk += 1;
      qualitySum += row.judged.score;
      if (row.item.kind === 'out_of_scope') {
        outScopeCount += 1;
        if (row.judged.out_of_scope_ok) outScopeOk += 1;
      }
      details.push({
        config: config.name,
        id: row.item.id,
        subject: row.item.subject,
        query: row.item.query,
        hit: row.hit,
        citation: row.citation,
        score: row.judged.score,
        outOfScopeOk: row.judged.out_of_scope_ok,
        reason: row.judged.reason,
        chunks: row.chunks,
        answer: truncate(row.answer, 800),
      });
    }

    metrics.push({
      config: config.name,
      hitRate: rows.length > 0 ? hits / rows.length : 0,
      citationRate: rows.length > 0 ? citationsOk / rows.length : 0,
      avgQuality: rows.length > 0 ? qualitySum / rows.length : 0,
      outOfScopeRate: outScopeCount > 0 ? outScopeOk / outScopeCount : 1,
      avgLatencyMs: Math.round((Date.now() - started) / Math.max(1, rows.length)),
      count: rows.length,
      errors,
    });
    logger.info({ event: 'eval.config_done', config: config.name, ms: Date.now() - started }, '[eval] config finished');
  }

  return {
    total: all.length,
    limit,
    ablations,
    metrics,
    generatedAt: new Date().toISOString(),
    details,
  };
}
