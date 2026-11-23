/**
 * 评测 CLI：检索命中率 + 回答质量，对比 4 组消融配置。
 * 用法：npm run eval -- --limit 20
 *      npm run eval -- --limit 50 --ablation rerank,profile,wrongbook_ctx
 */
import fs from 'node:fs';
import path from 'node:path';
import { runEval } from '../apps/server/src/services/eval';
import { pool } from '../apps/server/src/db/pool';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
  }
  return undefined;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const limitRaw = arg('limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const ablationRaw = arg('ablation');
  const ablations = ablationRaw ? ablationRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  console.log(`开始评测：limit=${limit ?? '默认'} ablations=${ablations ? ablations.join(',') : '全部'}`);
  const started = Date.now();
  const result = await runEval({ limit, ablations });

  console.log('\n===== 消融实验对比（共 ' + result.limit + ' 题 / 全集 ' + result.total + ' 题）=====');
  const header = ['配置', '检索命中率', '引用率', '回答质量', '超纲识别', '平均耗时', '错误数'];
  const rows = result.metrics.map((m) => [
    m.config,
    pct(m.hitRate),
    pct(m.citationRate),
    m.avgQuality.toFixed(3),
    pct(m.outOfScopeRate),
    `${m.avgLatencyMs}ms`,
    String(m.errors ?? 0),
  ]);
  const widths = header.map((h, i) => Math.max(h.length * 2, ...rows.map((r) => (r[i] ?? '').length)));
  const render = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i], ' ')).join('  ');
  console.log(render(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(render(row));
  console.log(`\n总耗时：${((Date.now() - started) / 1000).toFixed(1)}s`);

  const outDir = path.resolve(process.cwd(), 'eval/results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`完整结果已保存：${outFile}`);
}

void main()
  .catch((err) => {
    console.error('[eval] 失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
