import crypto from 'node:crypto';

/**
 * 计算字符串的 SHA-256 十六进制摘要。
 * @param input 原始字符串
 * @returns 64 位十六进制摘要
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 生成与源数据一致的判重指纹：sha256: + 归一化内容摘要的前 32 位。
 * @param text 原始文本
 * @returns 指纹字符串
 */
export function fingerprint(text: string): string {
  return `sha256:${sha256Hex(normalizeForFingerprint(text)).slice(0, 32)}`;
}

/**
 * 指纹归一化：去除所有空白、中英文标点与 $，并转小写，避免格式差异导致重复判定失败。
 * @param text 原始文本
 * @returns 归一化后的文本
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[，。；：！？、,.;:!?（）()【】[\]“”"'‘’]/g, '')
    .replace(/\$/g, '')
    .toLowerCase()
    .trim();
}

/**
 * 生成随机令牌（base64url 编码）。
 * @param bytes 随机字节数，默认 48
 * @returns 令牌字符串
 */
export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * 时序安全地比较两个字符串（长度不等时也执行一次比较以减少时序泄露）。
 * @param a 字符串 A
 * @param b 字符串 B
 * @returns 内容相等返回 true
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // 仍执行比较以减少时序差异
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 生成 UUID v4 字符串。
 * @returns 标准 UUID
 */
export function uuid(): string {
  return crypto.randomUUID();
}
