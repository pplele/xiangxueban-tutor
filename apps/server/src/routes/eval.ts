import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validate';
import { runEval } from '../services/eval';

const querySchema = z.object({
  ablation: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** 合法的消融实验开关集合：rerank=重排序、profile=画像、wrongbook_ctx=错题上下文 */
const VALID = new Set(['rerank', 'profile', 'wrongbook_ctx']);

/**
 * 评测路由注册：运行消融评测
 */
export async function evalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /eval/run - 运行评测：ablation 可指定要关闭的开关（逗号分隔/none 表示全关，缺省则全开），limit 限制样本数；鉴权：需登录
   */
  app.get('/eval/run', async (request) => {
    const query = parseInput(querySchema, request.query);
    let ablations: string[] | undefined;
    if (query.ablation !== undefined) {
      const raw = Array.isArray(query.ablation) ? query.ablation.join(',') : query.ablation;
      ablations =
        raw.trim() === '' || raw.trim() === 'none'
          ? []
          : raw
              .split(',')
              .map((x) => x.trim())
              .filter((x) => VALID.has(x));
    } else {
      ablations = [...VALID];
    }
    request.log.info({ event: 'eval.start', ablations, limit: query.limit }, '[eval] run requested');
    return runEval({ limit: query.limit, ablations });
  });
}
