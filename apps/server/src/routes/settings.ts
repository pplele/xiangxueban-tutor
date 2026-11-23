import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { env } from '../config/env';
import { unauthorized } from '../lib/errors';
import { parseInput } from '../lib/validate';
import { getSettingsView, saveSettings, testChannel } from '../services/settings';
import { miniOverview, qrFile, readMiniBaseUrl, saveQrImage, writeMiniBaseUrl } from '../services/miniprogram';
import { mobileAccess } from '../services/mobile';

const saveSchema = z.object({
  values: z.record(z.string().max(60), z.string().max(600)),
});

const testSchema = z.object({
  target: z.enum(['llm', 'fallback', 'vision', 'embedding', 'rerank']),
});

const baseUrlSchema = z.object({ baseUrl: z.string().max(200) });
const qrSchema = z.object({ dataUrl: z.string().max(2_200_000) });

/**
 * 设置路由注册：系统配置读写/连通性测试、手机访问地址、小程序连接信息与二维码
 */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /settings - 读取系统配置（密钥只回掩码）；鉴权：需登录 */
  app.get('/settings', async () => getSettingsView());

  /** PUT /settings - 保存配置：写库并立即生效；鉴权：需登录 */
  app.put('/settings', async (request) => {
    const { values } = parseInput(saveSchema, request.body);
    return saveSettings(values);
  });

  /** POST /settings/test - 单通道（llm/fallback/vision/embedding/rerank）连通性测试；鉴权：需登录 */
  app.post('/settings/test', async (request) => testChannel(parseInput(testSchema, request.body).target));

  // ========== 手机网页版：局域网地址 + 实时生成的永久二维码 ==========
  /**
   * GET /settings/mobile - 返回手机网页版访问地址与二维码；path 查询参数指定打开页面（默认 /m/snap 拍题，考试答题卡传 /m/exam/<id>）；鉴权：需登录
   */
  app.get('/settings/mobile', async (request) => {
    const query = request.query as Record<string, unknown>;
    const p = typeof query.path === 'string' ? query.path : '/m/snap';
    return mobileAccess(p);
  });

  // ========== 小程序：连接信息与预览二维码 ==========

  /** GET /settings/miniprogram - 返回小程序连接信息、baseUrl 与预览二维码状态；鉴权：需登录 */
  app.get('/settings/miniprogram', async () => miniOverview(env.port));

  /** PUT /settings/miniprogram/base-url - 设置小程序连接的后端 baseUrl；鉴权：需登录 */
  app.put('/settings/miniprogram/base-url', async (request) => {
    const { baseUrl } = parseInput(baseUrlSchema, request.body);
    await writeMiniBaseUrl(baseUrl);
    return { baseUrl: readMiniBaseUrl() };
  });

  /** POST /settings/miniprogram/qr - 保存上传的小程序预览二维码图片（dataURL），返回二维码状态；鉴权：需登录 */
  app.post('/settings/miniprogram/qr', async (request) => {
    const { dataUrl } = parseInput(qrSchema, request.body);
    await saveQrImage(dataUrl);
    return miniOverview(env.port).qr;
  });

  /**
   * GET /settings/miniprogram/qr - 二维码图片流：<img> 带不了 Authorization 头，token 走 query
   * 鉴权：路由标记 auth:false，但在处理器内手动校验 access token
   */
  app.get('/settings/miniprogram/qr', { config: { auth: false } }, async (request, reply) => {
    const { token } = request.query as { token?: string };
    try {
      const payload = app.jwt.verify(String(token ?? '')) as { sub?: string; typ?: string };
      if (!payload.sub || payload.typ !== 'access') throw new Error('wrong token type');
    } catch {
      throw unauthorized('登录已过期，请刷新页面');
    }
    const file = qrFile();
    if (!fs.existsSync(file)) return reply.status(404).send();
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'no-store')
      .send(fs.createReadStream(file));
  });
}
