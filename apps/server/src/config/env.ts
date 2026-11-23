import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../../../.env'),
];
for (const file of envCandidates) {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file });
    break;
  }
}

/**
 * 读取字符串环境变量，缺失或空串时返回 fallback（默认空串）。
 * @param key 环境变量名
 * @param fallback 缺省值
 * @returns 环境变量值或缺省值
 */
function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  return fallback ?? '';
}

/**
 * 读取可选环境变量并去除首尾空白，缺失时返回空串。
 * @param key 环境变量名
 * @returns 修剪后的值或空串
 */
function optional(key: string): string {
  return (process.env[key] ?? '').trim();
}

/**
 * 读取数值环境变量，缺失或非法时返回 fallback。
 * @param key 环境变量名
 * @param fallback 缺省数值
 * @returns 解析出的有限数值或缺省值
 */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 读取布尔环境变量：1/true/yes/on 视为 true，其余非空值视为 false。
 * @param key 环境变量名
 * @param fallback 缺省布尔值
 * @returns 解析出的布尔值或缺省值
 */
function bool(key: string, fallback: boolean): boolean {
  const raw = (process.env[key] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/** 服务启动必须配置的环境变量清单，缺失任意一个将直接退出进程 */
const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'AUTH_USERNAME',
  'AUTH_PASSWORD',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_MODEL',
] as const;

const missing = REQUIRED.filter((k) => !optional(k));
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error('\n[配置错误] 缺少以下必填环境变量，服务已停止：\n' + missing.map((k) => `  - ${k}`).join('\n'));
  // eslint-disable-next-line no-console
  console.error('\n请复制 .env.example 为 .env 并补齐配置。\n');
  process.exit(1);
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 8849),
  databaseUrl: str('DATABASE_URL'),

  jwtSecret: str('JWT_SECRET'),
  jwtExpiresIn: str('JWT_EXPIRES_IN', '2h'),
  refreshTokenTtlDays: num('REFRESH_TOKEN_TTL_DAYS', 14),
  authUsername: str('AUTH_USERNAME'),
  authPassword: str('AUTH_PASSWORD'),

  llm: {
    baseUrl: str('LLM_BASE_URL').replace(/\/+$/, ''),
    apiKey: str('LLM_API_KEY'),
    model: str('LLM_MODEL', 'deepseek-chat'),
    fallbackBaseUrl: optional('LLM_FALLBACK_BASE_URL').replace(/\/+$/, ''),
    fallbackApiKey: optional('LLM_FALLBACK_API_KEY'),
    fallbackModel: optional('LLM_FALLBACK_MODEL'),
    timeoutMs: num('LLM_TIMEOUT_MS', 120_000),
  },

  // 拍照识题用的视觉模型（小程序拍题链路）。默认复用主通道的地址与 key
  vision: {
    baseUrl: str('VISION_BASE_URL', str('LLM_BASE_URL')).replace(/\/+$/, ''),
    apiKey: str('VISION_API_KEY', str('LLM_API_KEY')),
    model: str('VISION_MODEL', 'glm-4v-plus'),
    timeoutMs: num('VISION_TIMEOUT_MS', 90_000),
  },

  embedding: {
    baseUrl: str('EMBEDDING_BASE_URL').replace(/\/+$/, ''),
    apiKey: str('EMBEDDING_API_KEY'),
    model: str('EMBEDDING_MODEL', 'BAAI/bge-m3'),
    dim: num('EMBEDDING_DIM', 1024),
    batchSize: num('EMBEDDING_BATCH_SIZE', 16),
    // 智谱 embedding-3 原生 2048 维，需显式传 dimensions 才能压到 1024；
    // bge-m3 等固定维度模型不支持该参数，故用开关控制
    sendDim: bool('EMBEDDING_SEND_DIM', false),
  },

  rerank: {
    enabled: bool('RERANK', true),
    baseUrl: optional('RERANK_BASE_URL').replace(/\/+$/, ''),
    apiKey: optional('RERANK_API_KEY'),
    model: optional('RERANK_MODEL') || 'BAAI/bge-reranker-v2-m3',
    timeoutMs: num('RERANK_TIMEOUT_MS', 20_000),
  },

  rag: {
    topKVector: num('RAG_TOP_K_VECTOR', 20),
    topKKeyword: num('RAG_TOP_K_KEYWORD', 20),
    topKFinal: num('RAG_TOP_K_FINAL', 6),
    rrfK: num('RAG_RRF_K', 60),
  },

  switches: {
    rerank: bool('RERANK', true),
    profileInject: bool('PROFILE_INJECT', true),
    wrongbookInject: bool('WRONGBOOK_INJECT', true),
  },

  corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  variantConcurrency: Math.max(1, num('VARIANT_CONCURRENCY', 2)),
  evalLimit: num('EVAL_LIMIT', 20),
  logLevel: str('LOG_LEVEL', 'info'),
};

if (env.embedding.dim !== 1024) {
  // 数据库向量列固定为 1024，提前提示避免运行期报错
  // eslint-disable-next-line no-console
  console.warn(`[配置警告] EMBEDDING_DIM=${env.embedding.dim}，但数据库 vector 列固定为 1024。请改为 1024 或修改迁移。`);
}

/**
 * 生成用于启动日志的环境摘要（端口、LLM、Embedding、Rerank 配置）。
 * @returns 单行摘要字符串
 */
export function describeEnv(): string {
  return [
    `PORT=${env.port}`,
    `LLM=${env.llm.baseUrl} (${env.llm.model})`,
    `EMBEDDING=${env.embedding.baseUrl} (${env.embedding.model})`,
    `RERANK=${env.rerank.enabled && env.rerank.baseUrl ? env.rerank.model : 'disabled'}`,
  ].join(' ');
}
