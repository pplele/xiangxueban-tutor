import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { badRequest } from '../lib/errors';
import * as settingsRepo from '../repos/settings';

/** 昵称 / 头像偏好设置：单账号系统，存 app_settings 键值，头像图片落盘。 */

/** 昵称与头像在 app_settings 表中的键 */
const KEY_NICKNAME = 'profile.nickname';
const KEY_AVATAR = 'profile.avatar';

/** 内置头像：emoji + 背景色，用户可快速选，不必上传图片 */
export interface EmojiAvatar {
  type: 'emoji';
  value: string;
  bg: string;
}

/** 上传图片头像：file 为落盘文件名，mime 用于响应头 */
export interface ImageAvatar {
  type: 'image';
  file: string;
  mime: string;
}

/** 头像类型：内置 emoji 或上传图片 */
export type Avatar = EmojiAvatar | ImageAvatar;

export interface Prefs {
  /** 展示昵称，未设置时为空字符串 */
  nickname: string;
  avatar: Avatar | null;
}

/** 头像图片落盘目录（与 exam-uploads 同一套定位逻辑，gitignore 已排除 data/） */
function avatarDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'data/avatar'),
    path.resolve(process.cwd(), '../data/avatar'),
    path.resolve(process.cwd(), '../../data/avatar'),
    path.resolve(__dirname, '../../../data/avatar'),
  ];
  const base = candidates.find((p) => fs.existsSync(path.dirname(p))) ?? candidates[0];
  return base;
}

/** 头像文件绝对路径（供路由输出流） */
export function avatarFile(): string {
  return path.join(avatarDir(), 'avatar.img');
}

/** 内置 emoji 候选与默认背景色 */
const DEFAULT_EMOJIS = ['🦊', '🐼', '🐯', '🐨', '🦁', '🐙', '🌙', '⭐', '📚', '🎓', '💡', '🚀'];
const DEFAULT_BG = '#e3f0ea';

/**
 * 读昵称与头像偏好；头像 JSON 解析失败时降级为 null，不影响主流程。
 * @returns 昵称与头像偏好
 */
export async function getPrefs(): Promise<Prefs> {
  const all = await settingsRepo.getAll();
  let avatar: Avatar | null = null;
  const raw = all[KEY_AVATAR];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Avatar;
      if (parsed && (parsed.type === 'emoji' || parsed.type === 'image')) avatar = parsed;
    } catch {
      /* 坏数据当没有头像 */
    }
  }
  return { nickname: all[KEY_NICKNAME] ?? '', avatar };
}

/**
 * 供设置页展示的内置头像候选。
 * @returns emoji 头像列表
 */
export function presetAvatars(): EmojiAvatar[] {
  return DEFAULT_EMOJIS.map((value) => ({ type: 'emoji', value, bg: DEFAULT_BG }));
}

/**
 * 保存昵称（空字符串 = 恢复用登录账号名）。
 * @param nickname 新昵称
 */
export async function setNickname(nickname: string): Promise<void> {
  const clean = nickname.trim().slice(0, 24);
  await settingsRepo.setMany({ [KEY_NICKNAME]: clean });
}

/**
 * 选定内置 emoji 头像，并删除旧的图片头像文件。
 * @param value emoji 字符
 * @param bg 背景色（#RRGGBB，非法则用默认色）
 */
export async function setEmojiAvatar(value: string, bg?: string): Promise<void> {
  const emoji = value.trim().slice(0, 8);
  if (!emoji) throw badRequest('头像不能为空');
  const color = /^#[0-9a-fA-F]{6}$/.test(bg ?? '') ? bg! : DEFAULT_BG;
  const avatar: EmojiAvatar = { type: 'emoji', value: emoji, bg: color };
  await settingsRepo.setMany({ [KEY_AVATAR]: JSON.stringify(avatar) });
  // emoji 头像不再需要旧的图片文件
  await removeImageFile();
}

/**
 * 上传图片头像（dataURL），校验格式与大小（≤1.5MB）后落盘并记录元数据。
 * @param dataUrl 图片 data URL
 */
export async function setImageAvatar(dataUrl: string): Promise<void> {
  const m = /^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!m) throw badRequest('只支持 PNG / JPG / WEBP 图片');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) throw badRequest('图片内容为空');
  if (buf.length > 1.5 * 1024 * 1024) throw badRequest('图片超过 1.5MB，请压缩后再上传');

  await fsp.mkdir(avatarDir(), { recursive: true });
  await fsp.writeFile(avatarFile(), buf);

  const mime = `image/${m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()}`;
  const avatar: ImageAvatar = { type: 'image', file: path.basename(avatarFile()), mime };
  await settingsRepo.setMany({ [KEY_AVATAR]: JSON.stringify(avatar) });
}

/** 删除已上传的头像图片文件（忽略不存在） */
async function removeImageFile(): Promise<void> {
  try {
    await fsp.unlink(avatarFile());
  } catch {
    /* 本来就没有文件 */
  }
}

/** 恢复默认头像（首字母），删除元数据与图片文件 */
export async function resetAvatar(): Promise<void> {
  await settingsRepo.setMany({ [KEY_AVATAR]: '' });
  await removeImageFile();
}

/** 当前头像图片是否存在（供接口决定是否读盘） */
export function hasAvatarImage(): boolean {
  return fs.existsSync(avatarFile());
}
