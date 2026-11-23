import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { badRequest } from '../lib/errors';

/**
 * 小程序工程目录（随启动方式不同 cwd 会变，多候选逐个试）。
 * @returns apps/miniprogram 的绝对路径
 */
export function miniprogramDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'apps/miniprogram'),
    path.resolve(process.cwd(), '../miniprogram'),
    path.resolve(__dirname, '../../../miniprogram'),
    path.resolve(__dirname, '../../../../apps/miniprogram'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 apps/miniprogram');
  return found;
}

/** 小程序端连接配置文件 config.js 的路径 */
function configPath(): string {
  return path.join(miniprogramDir(), 'utils/config.js');
}

/**
 * 从 config.js 中读取 BASE_URL；文件缺失或格式不符返回空串。
 * @returns 当前配置的后端地址
 */
export function readMiniBaseUrl(): string {
  try {
    const src = fs.readFileSync(configPath(), 'utf8');
    return /BASE_URL:\s*'([^']*)'/.exec(src)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * 只改 config.js 里 BASE_URL 那一行，其余内容原样保留；校验地址格式。
 * @param baseUrl 新的后端地址（形如 http://192.168.1.10:8849）
 */
export async function writeMiniBaseUrl(baseUrl: string): Promise<void> {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s'"]+$/i.test(url)) throw badRequest('地址要形如 http://192.168.1.10:8849');
  const file = configPath();
  const src = await fsp.readFile(file, 'utf8');
  if (!/BASE_URL:\s*'[^']*'/.test(src)) throw badRequest('config.js 里没找到 BASE_URL 字段');
  await fsp.writeFile(file, src.replace(/BASE_URL:\s*'[^']*'/, `BASE_URL: '${url}'`), 'utf8');
}

/**
 * 本机可用于手机访问的局域网 IPv4。
 * Windows 上会混进 WSL / Hyper-V / VMware 等虚拟网卡，这些地址手机连不到，
 * 必须按「网卡名 + 网段」加权，把真实 Wi-Fi / 有线地址排到前面。
 * @returns 按可用优先级排序去重后的 IPv4 列表
 */
export function lanAddresses(): string[] {
  const VIRTUAL = /(vEthernet|VMware|VirtualBox|WSL|Docker|Hyper-V|Loopback|Tailscale|ZeroTier|VPN|TAP|Bluetooth)/i;
  const items: { address: string; score: number }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      let score = 0;
      if (!VIRTUAL.test(name)) score += 4;
      if (item.address.startsWith('192.168.')) score += 3;
      else if (item.address.startsWith('10.')) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(item.address)) score += 1;
      items.push({ address: item.address, score });
    }
  }
  items.sort((a, b) => b.score - a.score);
  return [...new Set(items.map((i) => i.address))];
}

/** 小程序预览二维码图片路径（apps/miniprogram/preview-qr.png） */
export function qrFile(): string {
  return path.join(miniprogramDir(), 'preview-qr.png');
}

/** 小程序连接概览：baseUrl、局域网 IP、建议地址、二维码状态、appid */
export interface MiniOverview {
  baseUrl: string;
  lanIps: string[];
  /** 建议值：本机首个私网 IP + 服务端口 */
  suggested: string;
  qr: { exists: boolean; updatedAt: string | null; sizeKb: number };
  appid: string;
}

/**
 * 汇总小程序连接信息：读取 config.js、列出局域网 IP、检查二维码文件、读取 appid。
 * @param port 服务端口，用于拼建议地址
 * @returns 小程序连接概览
 */
export function miniOverview(port: number): MiniOverview {
  let appid = '';
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(miniprogramDir(), 'project.config.json'), 'utf8')) as { appid?: string };
    appid = conf.appid ?? '';
  } catch {
    /* 没读到就不显示 */
  }
  const ips = lanAddresses();
  let qr = { exists: false, updatedAt: null as string | null, sizeKb: 0 };
  try {
    const st = fs.statSync(qrFile());
    qr = { exists: true, updatedAt: st.mtime.toISOString(), sizeKb: Math.round(st.size / 1024) };
  } catch {
    /* 还没上传过 */
  }
  return {
    baseUrl: readMiniBaseUrl(),
    lanIps: ips,
    suggested: ips[0] ? `http://${ips[0]}:${port}` : '',
    qr,
    appid,
  };
}

/**
 * 接收前端上传的二维码截图（dataURL），校验格式（PNG/JPG/WEBP）与大小（≤1.5MB）后，
 * 覆盖 apps/miniprogram/preview-qr.png。
 * @param dataUrl 图片的 data URL
 */
export async function saveQrImage(dataUrl: string): Promise<void> {
  const m = /^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!m) throw badRequest('只支持 PNG / JPG / WEBP 图片');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) throw badRequest('图片内容为空');
  if (buf.length > 1.5 * 1024 * 1024) throw badRequest('图片超过 1.5MB，请压缩后再上传');
  await fsp.writeFile(qrFile(), buf);
}
