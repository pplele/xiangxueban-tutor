/** 检索探针：检查典型问题的 top-k 命中是否合理 */
import { pool } from '../apps/server/src/db/pool';
import { retrieve } from '../apps/server/src/services/rag';

const CASES: { subject: 'math' | 'english'; q: string }[] = [
  { subject: 'math', q: '洛必达法则求极限的使用条件是什么' },
  { subject: 'math', q: '二重积分用极坐标怎么计算' },
  { subject: 'math', q: '一阶线性微分方程的通解公式' },
  { subject: 'english', q: '虚拟语气中与过去事实相反的 if 从句怎么用' },
  { subject: 'english', q: '非谓语动词作状语有什么区别' },
  { subject: 'english', q: '应用文写作中书信的开头结尾模板' },
];

async function main(): Promise<void> {
  for (const c of CASES) {
    const t0 = Date.now();
    const r = await retrieve(c.subject, c.q, { topK: 4 });
    console.log(`\n【${c.subject}】${c.q}  (${Date.now() - t0}ms, rerank=${r.rerankApplied}${r.degraded ? `/${r.degraded}` : ''})`);
    r.chunks.slice(0, 4).forEach((x, i) => {
      console.log(`  ${i + 1}. [${x.score.toFixed(3)}] ${x.sourceName} · ${(x.kpCodes ?? []).join(',')} | ${x.content.slice(0, 50).replace(/\n/g, ' ')}`);
    });
  }
}

void main()
  .catch((e) => console.error('ERR', e instanceof Error ? e.message : e))
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
