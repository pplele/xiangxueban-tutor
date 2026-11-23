import { env, describeEnv } from './config/env';
import { buildApp } from './app';
import { logger } from './lib/logger';
import { closePool } from './db/pool';
import { startVariantQueue, stopVariantQueue } from './services/queue';
import { applyStoredSettings } from './services/settings';
import { cleanupExpired } from './repos/auth';

/**
 * 服务启动主流程：构建应用 → 应用库内配置 → 启动队列 → 定时清理 → 监听端口。
 * 同时注册 SIGTERM/SIGINT 优雅停机与 unhandledRejection 兜底日志。
 */
async function main(): Promise<void> {
  const app = await buildApp();

  // 库里存过 API 配置就用库里的，覆盖 .env 默认值
  await applyStoredSettings();

  await startVariantQueue().catch((err) => {
    logger.error({ err: (err as Error).message }, '[startup] variant queue failed to start');
  });

  const cleanup = setInterval(() => {
    cleanupExpired().catch(() => undefined);
  }, 6 * 3600 * 1000);
  cleanup.unref();

  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    logger.info({ port: env.port, env: describeEnv() }, 'tutor-system 服务已启动');
    logger.info(`健康检查: http://localhost:${env.port}/health  就绪检查: http://localhost:${env.port}/ready`);
  } catch (err) {
    logger.error({ err }, '[startup] listen failed');
    process.exit(1);
  }

  let shuttingDown = false;
  /**
   * 优雅停机：最多等 10 秒处理在途请求，超时强制退出，最终关闭连接池并退出进程。
   * @param signal 触发停机的信号名（SIGTERM/SIGINT），仅用于日志
   */
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, '[shutdown] 开始优雅停机，等待在途请求（最多 10 秒）');
    const forceTimer = setTimeout(() => {
      logger.error('[shutdown] 超时，强制退出');
      process.exit(1);
    }, 11_000);
    forceTimer.unref();
    try {
      await Promise.race([
        (async () => {
          await app.close();
          await stopVariantQueue();
        })(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      await closePool();
    } catch (err) {
      logger.error({ err: (err as Error).message }, '[shutdown] error');
    } finally {
      clearTimeout(forceTimer);
      logger.info('[shutdown] 已停止');
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, '[process] unhandled rejection');
  });
}

void main().catch((err) => {
  logger.error({ err: (err as Error).message, stack: (err as Error).stack }, '[startup] fatal');
  process.exit(1);
});
