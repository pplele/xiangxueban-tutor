import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { badRequest, unauthorized } from '../lib/errors';
import { listCourses, resolveLessonFile } from '../services/lessons';

/**
 * 视频课程路由注册：课程树目录 / 视频流
 */
export async function lessonRoutes(app: FastifyInstance) {
  /** GET /lessons/courses - 返回课程树（课程 → 类别 → 模块 → 章节 → 视频）；鉴权：需登录 */
  app.get('/lessons/courses', async () => ({ courses: await listCourses() }));

  /**
   * GET /lessons/stream - 视频流：video 标签带不了 Authorization 头，改用 ?token= 传 JWT，支持 Range 拖动进度条
   * 鉴权：路由标记 auth:false，但在处理器内手动校验 access token
   */
  app.get('/lessons/stream', { config: { auth: false } }, async (request, reply) => {
    const query = request.query as { file?: string; token?: string };
    try {
      const payload = app.jwt.verify(String(query.token ?? '')) as { sub?: string; typ?: string };
      if (!payload.sub || payload.typ !== 'access') throw new Error('wrong token type');
    } catch {
      throw unauthorized('登录已过期，请刷新页面重新进入');
    }

    const abs = resolveLessonFile(String(query.file ?? ''));
    if (!abs) throw badRequest('视频文件不存在');
    const stat = await fsp.stat(abs);

    reply
      .header('content-type', 'video/mp4')
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'no-store');

    const range = request.headers.range;
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size || start > end) {
        return reply
          .status(416)
          .header('content-range', `bytes */${stat.size}`)
          .send();
      }
      return reply
        .status(206)
        .header('content-range', `bytes ${start}-${end}/${stat.size}`)
        .header('content-length', String(end - start + 1))
        .send(fs.createReadStream(abs, { start, end }));
    }
    return reply.header('content-length', String(stat.size)).send(fs.createReadStream(abs));
  });
}
