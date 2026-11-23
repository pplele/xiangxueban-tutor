import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { enqueueMany } from '../services/queue';
import * as jobsRepo from '../repos/jobs';

/**
 * 变式路由注册：批量生成变式 / 查询生成进度
 */
export async function variantRoutes(app: FastifyInstance): Promise<void> {
  /** POST /variants/generate - 接收题目 id 列表，去重后入队生成变式，返回入队结果与队列统计；鉴权：需登录 */
  app.post('/variants/generate', async (request) => {
    const body = parseInput(
      z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(100) }),
      request.body,
    );
    const unique = [...new Set(body.ids)];
    const results = await enqueueMany(unique);
    const progress = await jobsRepo.progress();
    return {
      results,
      queued: results.filter((r) => r.enqueued).length,
      counts: progress.counts,
    };
  });

  /** GET /variants/progress - 查询变式生成队列的进度与计数；鉴权：需登录 */
  app.get('/variants/progress', async () => {
    return jobsRepo.progress();
  });
}
