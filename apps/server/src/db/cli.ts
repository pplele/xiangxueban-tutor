import { closePool, pool } from './pool';
import { migrateDown, migrateUp, migrationStatus } from './migrate';

/**
 * 迁移命令行入口：根据 argv[2] 分派 up/down/status，结束时关闭连接池。
 */
async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  try {
    if (cmd === 'up') {
      await migrateUp();
    } else if (cmd === 'down') {
      await migrateDown();
    } else if (cmd === 'status') {
      const rows = await migrationStatus();
      if (rows.length === 0) console.log('（尚无已应用的迁移）');
      for (const row of rows) console.log(`${row.version}  ${row.appliedAt}`);
    } else {
      console.error('用法: tsx src/db/cli.ts [up|down|status]');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[migrate] 失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await closePool();
    await pool.end().catch(() => undefined);
  }
}

void main();
