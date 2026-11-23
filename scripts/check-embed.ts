/**
 * 向量服务冒烟测试：验证 EMBEDDING_* / RERANK_* 配置可用、维度正确、语义合理。
 * 用法：npx tsx scripts/check-embed.ts
 */
import { embedTexts, rerank } from '../apps/server/src/agent/llm';
import { env } from '../apps/server/src/config/env';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main(): Promise<void> {
  console.log(`[config] baseUrl=${env.embedding.baseUrl} model=${env.embedding.model} dim=${env.embedding.dim} sendDim=${env.embedding.sendDim}`);
  const texts = [
    '定积分的换元积分法：设 x=φ(t)，则 dx=φ′(t)dt，积分限随之改变',
    '不定积分的第一类换元法（凑微分法）',
    '英语虚拟语气中 if 引导的与现在事实相反的从句用过去式',
  ];
  const vecs = await embedTexts(texts);
  console.log(`[embed] 返回 ${vecs.length} 条，维度=${vecs.map((v) => v.length).join('/')}`);
  console.log(`[semantic] 数学-数学 相似度=${cosine(vecs[0], vecs[1]).toFixed(4)}  数学-英语 相似度=${cosine(vecs[0], vecs[2]).toFixed(4)}`);

  const docs = texts.slice();
  const rs = await rerank('定积分换元法怎么换积分限', docs, 3);
  console.log(`[rerank] ${rs.map((r) => `#${r.index}:${r.score.toFixed(4)}`).join(' ')}`);
}

void main().catch((err) => {
  console.error('[check-embed] 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
