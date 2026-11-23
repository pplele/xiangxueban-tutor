import { env } from '../config/env';
import { badRequest } from '../lib/errors';
import { logger } from '../lib/logger';
import * as repo from '../repos/settings';

/**
 * 可在「个人主页」里改的配置项。
 * 直接读写 env 对象：llm.ts / embedding 在调用时才取值，改完立刻生效，不用重启。
 */
interface Field {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  hint?: string;
  read: () => string;
  write: (v: string) => void;
}

/** 配置分组：展示信息 + 可测通道 + 字段列表 */
interface Group {
  key: string;
  title: string;
  desc: string;
  testTarget?: ChannelKey;
  fields: Field[];
}

/** 可测试的通道：主模型/备援/视觉/向量/重排序 */
type ChannelKey = 'llm' | 'fallback' | 'vision' | 'embedding' | 'rerank';

/** 去掉地址末尾的斜杠 */
const strip = (v: string) => v.replace(/\/+$/, '');

/** 可在个人主页编辑的通道配置分组定义 */
const GROUPS: Group[] = [
  {
    key: 'llm',
    title: '主模型（答疑 / 组卷 / 变式）',
    desc: '日常对话与题目生成走这个通道；报 429 或余额不足时会自动切到备援通道。',
    testTarget: 'llm',
    fields: [
      {
        key: 'llm.baseUrl',
        label: '接口地址',
        placeholder: 'https://api.deepseek.com/v1',
        read: () => env.llm.baseUrl,
        write: (v) => {
          env.llm.baseUrl = strip(v);
        },
      },
      {
        key: 'llm.apiKey',
        label: 'API Key',
        secret: true,
        placeholder: 'sk-...（留空表示不修改）',
        read: () => env.llm.apiKey,
        write: (v) => {
          env.llm.apiKey = v;
        },
      },
      {
        key: 'llm.model',
        label: '模型名',
        placeholder: 'deepseek-chat',
        read: () => env.llm.model,
        write: (v) => {
          env.llm.model = v;
        },
      },
    ],
  },
  {
    key: 'fallback',
    title: '备援模型（可选）',
    desc: '主通道限流 / 欠费时自动接管。留空则只用主通道。',
    testTarget: 'fallback',
    fields: [
      {
        key: 'llm.fallbackBaseUrl',
        label: '接口地址',
        placeholder: 'https://open.bigmodel.cn/api/paas/v4',
        read: () => env.llm.fallbackBaseUrl,
        write: (v) => {
          env.llm.fallbackBaseUrl = strip(v);
        },
      },
      {
        key: 'llm.fallbackApiKey',
        label: 'API Key',
        secret: true,
        placeholder: '留空表示不修改',
        read: () => env.llm.fallbackApiKey,
        write: (v) => {
          env.llm.fallbackApiKey = v;
        },
      },
      {
        key: 'llm.fallbackModel',
        label: '模型名',
        placeholder: 'glm-4-flash',
        read: () => env.llm.fallbackModel,
        write: (v) => {
          env.llm.fallbackModel = v;
        },
      },
    ],
  },
  {
    key: 'vision',
    title: '视觉模型（小程序拍题识题）',
    desc: '手机拍照上传后由这个模型把题干转成文字。留空则复用主通道的地址与 Key。',
    testTarget: 'vision',
    fields: [
      {
        key: 'vision.baseUrl',
        label: '接口地址',
        placeholder: 'https://open.bigmodel.cn/api/paas/v4',
        read: () => env.vision.baseUrl,
        write: (v) => {
          env.vision.baseUrl = strip(v);
        },
      },
      {
        key: 'vision.apiKey',
        label: 'API Key',
        secret: true,
        placeholder: '留空表示不修改',
        read: () => env.vision.apiKey,
        write: (v) => {
          env.vision.apiKey = v;
        },
      },
      {
        key: 'vision.model',
        label: '模型名',
        placeholder: 'glm-4v-plus',
        read: () => env.vision.model,
        write: (v) => {
          env.vision.model = v;
        },
      },
    ],
  },
  {
    key: 'embedding',
    title: '向量模型（知识库检索）',
    desc: '换了模型或维度后需要重新 ingest 知识库，否则检索会对不上。',
    testTarget: 'embedding',
    fields: [
      {
        key: 'embedding.baseUrl',
        label: '接口地址',
        placeholder: 'https://api.siliconflow.cn/v1',
        read: () => env.embedding.baseUrl,
        write: (v) => {
          env.embedding.baseUrl = strip(v);
        },
      },
      {
        key: 'embedding.apiKey',
        label: 'API Key',
        secret: true,
        placeholder: '留空表示不修改',
        read: () => env.embedding.apiKey,
        write: (v) => {
          env.embedding.apiKey = v;
        },
      },
      {
        key: 'embedding.model',
        label: '模型名（维度需为 1024）',
        placeholder: 'BAAI/bge-m3',
        read: () => env.embedding.model,
        write: (v) => {
          env.embedding.model = v;
        },
      },
    ],
  },
];

/** 所有配置字段的扁平列表（便于按 key 查改） */
const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

/** Key 只回显掩码，绝不把明文送到前端 */
function mask(v: string): string {
  if (!v) return '';
  if (v.length <= 10) return '••••••';
  return `${v.slice(0, 3)}••••${v.slice(-4)}`;
}

/** 面向前端的配置视图：按分组返回字段值（明文/掩码） */
export interface SettingsView {
  groups: {
    key: string;
    title: string;
    desc: string;
    testTarget?: ChannelKey;
    fields: { key: string; label: string; placeholder?: string; secret: boolean; hint?: string; value: string; masked: string; hasValue: boolean }[];
  }[];
}

/**
 * 构造配置视图：密钥字段只回掩码与是否有值，不回明文。
 * @returns 分组配置视图
 */
export function getSettingsView(): SettingsView {
  return {
    groups: GROUPS.map((g) => ({
      key: g.key,
      title: g.title,
      desc: g.desc,
      testTarget: g.testTarget,
      fields: g.fields.map((f) => {
        const raw = f.read();
        return {
          key: f.key,
          label: f.label,
          placeholder: f.placeholder,
          secret: Boolean(f.secret),
          hint: f.hint,
          value: f.secret ? '' : raw,
          masked: f.secret ? mask(raw) : '',
          hasValue: Boolean(raw),
        };
      }),
    })),
  };
}

/**
 * 保存配置：只处理已知 key，密钥留空/仍是掩码视为不修改，baseUrl 校验协议；
 * 写库后调用各字段 write 直接改 env 对象，立即生效无需重启。
 * @param values 待保存的 key-value
 * @returns 最新配置视图
 */
export async function saveSettings(values: Record<string, string>): Promise<SettingsView> {
  const updates: Record<string, string> = {};
  const applied: string[] = [];
  for (const f of ALL_FIELDS) {
    if (!(f.key in values)) continue;
    const v = String(values[f.key] ?? '').trim();
    if (f.secret && (v === '' || v.includes('••'))) continue;
    if (f.key.endsWith('baseUrl') && v !== '' && !/^https?:\/\//i.test(v)) {
      throw badRequest(`${f.label}必须以 http:// 或 https:// 开头`);
    }
    if (v === f.read()) continue;
    updates[f.key] = v;
    applied.push(f.key);
  }
  if (applied.length === 0) return getSettingsView();
  await repo.setMany(updates);
  for (const key of applied) {
    const f = ALL_FIELDS.find((x) => x.key === key)!;
    f.write(updates[key]);
  }
  logger.info({ applied }, '[settings] 已更新运行期配置');
  return getSettingsView();
}

/**
 * 启动时把库中配置盖到 env 上；表不存在或读失败只告警，沿用 .env 不影响启动。
 */
export async function applyStoredSettings(): Promise<void> {
  try {
    const rows = await repo.getAll();
    let n = 0;
    for (const [key, value] of Object.entries(rows)) {
      const f = ALL_FIELDS.find((x) => x.key === key);
      if (!f) continue;
      f.write(value);
      n += 1;
    }
    if (n > 0) logger.info({ count: n }, '[settings] 已应用库中配置');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[settings] 读取库中配置失败，沿用 .env');
  }
}

/** 按通道键取出 baseUrl/apiKey/model，备援通道缺省回落到主通道 */
function channelOf(target: ChannelKey): { baseUrl: string; apiKey: string; model: string } {
  switch (target) {
    case 'llm':
      return { baseUrl: env.llm.baseUrl, apiKey: env.llm.apiKey, model: env.llm.model };
    case 'fallback':
      return {
        baseUrl: env.llm.fallbackBaseUrl,
        apiKey: env.llm.fallbackApiKey || env.llm.apiKey,
        model: env.llm.fallbackModel || env.llm.model,
      };
    case 'vision':
      return { baseUrl: env.vision.baseUrl, apiKey: env.vision.apiKey, model: env.vision.model };
    case 'embedding':
      return { baseUrl: env.embedding.baseUrl, apiKey: env.embedding.apiKey, model: env.embedding.model };
    case 'rerank':
      return { baseUrl: env.rerank.baseUrl, apiKey: env.rerank.apiKey, model: env.rerank.model };
  }
}

/** 连通性探测结果：是否成功、HTTP 状态、说明信息 */
export interface TestResult {
  ok: boolean;
  status: number;
  message: string;
}

/**
 * 连通性探测：优先 GET /models；不支持（404/405）时，向量通道退化为一次最小 embedding 探针，
 * 其余通道提示手动验证。缺 baseUrl/apiKey 直接返回失败。
 * @param target 通道键
 * @returns 探测结果
 */
export async function testChannel(target: ChannelKey): Promise<TestResult> {
  const ch = channelOf(target);
  if (!ch.baseUrl) return { ok: false, status: 0, message: '还没配置接口地址' };
  if (!ch.apiKey) return { ok: false, status: 0, message: '还没配置 API Key' };

  const headers = { authorization: `Bearer ${ch.apiKey}`, 'content-type': 'application/json' };
  const timeout = AbortSignal.timeout(12_000);

  try {
    const res = await fetch(`${ch.baseUrl}/models`, { headers, signal: timeout });
    if (res.ok) return { ok: true, status: res.status, message: '连接正常' };
    if (res.status !== 404 && res.status !== 405) {
      const text = (await res.text()).slice(0, 160);
      return { ok: false, status: res.status, message: `${res.status} ${text || res.statusText}` };
    }
  } catch (err) {
    return { ok: false, status: 0, message: `连不上：${(err as Error).message}` };
  }

  // /models 不存在：向量通道发一次 1 条文本的 embedding 探针，其余提示手动验证
  if (target === 'embedding') {
    try {
      const res = await fetch(`${ch.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: ch.model, input: ['ping'] }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return { ok: true, status: res.status, message: '向量接口正常' };
      const text = (await res.text()).slice(0, 160);
      return { ok: false, status: res.status, message: `${res.status} ${text || res.statusText}` };
    } catch (err) {
      return { ok: false, status: 0, message: `连不上：${(err as Error).message}` };
    }
  }
  return { ok: false, status: 404, message: '该服务未开放 /models 探测，请直接发一条答疑消息验证' };
}
