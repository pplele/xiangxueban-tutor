import { env } from '../config/env';
import { logger } from '../lib/logger';
import { sleep } from '../lib/text';
import * as jobsRepo from '../repos/jobs';
import { generateVariantSet } from './variant';

/** 变式生成队列的模块级状态：是否已启动、是否停止、在跑的 worker 集合 */
let started = false;
let stopped = true;
const workers = new Set<Promise<void>>();

/**
 * 单个 worker 主循环：不断领取任务并调用 LLM 生成变式，成功后标记完成、失败则记录原因。
 * 无任务时休眠 800ms 再试；claim 失败只记日志不中断。
 */
async function workerLoop(workerId: number): Promise<void> {
  while (!stopped) {
    let job: jobsRepo.JobRow | null = null;
    try {
      job = await jobsRepo.claimNext();
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[queue] claim failed');
    }
    if (!job) {
      await sleep(800);
      continue;
    }
    try {
      logger.info({ event: 'variant.start', questionId: job.question_id, workerId }, '[queue] generating variants');
      const result = await generateVariantSet(job.question_id);
      await jobsRepo.markDone(job.question_id);
      logger.info(
        { event: 'variant.done', questionId: job.question_id, setId: result.setId, count: result.items.length },
        '[queue] variants ready',
      );
    } catch (err) {
      const message = (err as Error).message || '未知错误';
      await jobsRepo.markFailed(job.question_id, message).catch(() => undefined);
      logger.error(
        { event: 'variant.failed', questionId: job.question_id, err: message },
        '[queue] variant generation failed',
      );
    }
  }
}

/**
 * 启动变式生成队列：先把遗留的 running 任务重置回队列，再按并发数拉起多个 worker。
 * 重复调用无副作用。
 */
export async function startVariantQueue(): Promise<void> {
  if (started) return;
  started = true;
  stopped = false;
  const reset = await jobsRepo.resetStaleRunning().catch(() => 0);
  if (reset > 0) logger.warn({ count: reset }, '[queue] reset stale running jobs');
  for (let i = 0; i < env.variantConcurrency; i++) {
    const p = workerLoop(i + 1)
      .catch((err) => logger.error({ err: (err as Error).message }, '[queue] worker crashed'))
      .finally(() => workers.delete(p));
    workers.add(p);
  }
  logger.info({ concurrency: env.variantConcurrency }, '[queue] variant queue started');
}

/** 停止变式生成队列：置停止标志，最多等待 10 秒让在跑的 worker 收尾。 */
export async function stopVariantQueue(): Promise<void> {
  stopped = true;
  await Promise.race([Promise.allSettled([...workers]), sleep(10_000)]);
  started = false;
  logger.info('[queue] variant queue stopped');
}

/**
 * 将一道题入队生成变式（幂等：已在队列/已完成的不会重复入队）。
 * @param questionId 错题 id
 * @returns 是否新入队及任务行
 */
export async function enqueueVariant(questionId: string): Promise<{ enqueued: boolean; job: Awaited<ReturnType<typeof jobsRepo.enqueue>>['job'] }> {
  const result = await jobsRepo.enqueue(questionId);
  if (result.enqueued) {
    logger.info({ event: 'variant.enqueued', questionId }, '[queue] job enqueued');
  }
  return result;
}

/**
 * 批量入队：逐题调用 enqueueVariant，汇总每题的入队结果。
 * @param questionIds 错题 id 列表
 * @returns 每题及其是否入队
 */
export async function enqueueMany(questionIds: string[]): Promise<{ questionId: string; enqueued: boolean }[]> {
  const out: { questionId: string; enqueued: boolean }[] = [];
  for (const id of questionIds) {
    const result = await enqueueVariant(id);
    out.push({ questionId: id, enqueued: result.enqueued });
  }
  return out;
}
