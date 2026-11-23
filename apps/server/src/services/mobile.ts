import QRCode from 'qrcode';
import { getAll } from '../repos/settings';
import { lanAddresses } from './miniprogram';

/** 前端开发服务器端口（vite.config.ts 固定 5173）；以后换端口改这一处或存设置即可 */
const FRONT_PORT_KEY = 'mobile.frontPort';
const DEFAULT_FRONT_PORT = 5173;

export interface MobileAccess {
  /** 手机扫码后打开的地址 */
  url: string;
  /** 二维码 PNG（data URL），每次实时生成、永不过期 */
  qrDataUrl: string;
  /** 本机全部可用局域网地址，地址变化时前端提示 */
  lanIps: string[];
  frontPort: number;
}

/**
 * 手机网页版入口地址 + 二维码。
 * 与微信开发者工具的「预览码」不同：二维码内容由本机局域网 IP 拼出来，
 * 只要电脑 IP 不变，扫出来一直有效，无需重新生成。
 * @param targetPath 打开的页面路径：默认 /m/snap（拍题），考试答题卡传 /m/exam/<id>
 * @returns 入口地址、实时生成的二维码 dataURL、全部局域网地址与前端端口
 */
export async function mobileAccess(targetPath = '/m/snap'): Promise<MobileAccess> {
  const stored = await getAll();
  const port = Number(stored[FRONT_PORT_KEY]) || DEFAULT_FRONT_PORT;
  const ips = lanAddresses();
  const ip = ips[0] ?? '';
  const safePath = /^\/[\w\-/:%.]*$/.test(targetPath) ? targetPath : '/m/snap';
  const url = ip ? `http://${ip}:${port}${safePath}` : '';

  let qrDataUrl = '';
  if (url) {
    qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 480,
      color: { dark: '#172522', light: '#ffffff' },
    });
  }
  return { url, qrDataUrl, lanIps: ips, frontPort: port };
}
