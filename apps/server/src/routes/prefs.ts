import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { unauthorized } from '../lib/errors';
import { parseInput } from '../lib/validate';
import {
  avatarFile,
  getPrefs,
  hasAvatarImage,
  presetAvatars,
  resetAvatar,
  setEmojiAvatar,
  setImageAvatar,
  setNickname,
} from '../services/prefs';

const nicknameSchema = z.object({ nickname: z.string().max(24) });
const emojiSchema = z.object({
  emoji: z.string().min(1).max(8),
  bg: z.string().max(7).optional(),
});
const imageSchema = z.object({ dataUrl: z.string().max(2_200_000) });

/**
 * 偏好设置路由注册：昵称与头像读写、头像图片流
 */
export async function prefsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /prefs - 读昵称与头像偏好 + 内置头像候选；鉴权：需登录 */
  app.get('/prefs', async () => ({ ...(await getPrefs()), presets: presetAvatars() }));

  /** PUT /prefs/nickname - 设置昵称（空字符串恢复用账号名）；鉴权：需登录 */
  app.put('/prefs/nickname', async (request) => {
    const { nickname } = parseInput(nicknameSchema, request.body);
    await setNickname(nickname);
    return getPrefs();
  });

  /** PUT /prefs/avatar/emoji - 选内置 emoji 头像（可带背景色 bg）；鉴权：需登录 */
  app.put('/prefs/avatar/emoji', async (request) => {
    const { emoji, bg } = parseInput(emojiSchema, request.body);
    await setEmojiAvatar(emoji, bg);
    return getPrefs();
  });

  /** PUT /prefs/avatar/image - 上传图片头像（dataURL），落盘后更新偏好；鉴权：需登录 */
  app.put('/prefs/avatar/image', async (request) => {
    const { dataUrl } = parseInput(imageSchema, request.body);
    await setImageAvatar(dataUrl);
    return getPrefs();
  });

  /** DELETE /prefs/avatar - 恢复默认头像（删除已上传图片）；鉴权：需登录 */
  app.delete('/prefs/avatar', async () => {
    await resetAvatar();
    return getPrefs();
  });

  /**
   * GET /prefs/avatar - 头像图片流：<img> 带不了 Authorization 头，token 走 query。
   * 与二维码 / 视频流一致：白名单 + 路由内手动校验 JWT。鉴权：路由标记 auth:false，处理器内校验 access token
   */
  app.get('/prefs/avatar', { config: { auth: false } }, async (request, reply) => {
    const { token } = request.query as { token?: string };
    try {
      const payload = app.jwt.verify(String(token ?? '')) as { sub?: string; typ?: string };
      if (!payload.sub || payload.typ !== 'access') throw new Error('wrong token type');
    } catch {
      throw unauthorized('登录已过期，请刷新页面');
    }
    if (!hasAvatarImage()) return reply.status(404).send();
    const prefs = await getPrefs();
    const mime =
      prefs.avatar?.type === 'image' ? prefs.avatar.mime : 'application/octet-stream';
    return reply
      .header('content-type', mime)
      .header('cache-control', 'no-store')
      .send(fs.createReadStream(avatarFile()));
  });
}
