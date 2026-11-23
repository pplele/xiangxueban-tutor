import { env } from '../config/env';
import { AppError, badRequest, embeddingUnavailable, llmUnavailable } from '../lib/errors';
import { logger } from '../lib/logger';
import { sleep } from '../lib/text';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: LlmRole;
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionOptions {
  tools?: LlmToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  jsonMode?: boolean;
  /** 内部使用：指定模型通道 */
  modelOverride?: string;
  baseUrlOverride?: string;
  apiKeyOverride?: string;
}

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: LlmToolCall[] }
  | { type: 'done'; finishReason: string | null; usage?: Record<string, number> };

interface Channel {
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
}

interface LlmHttpError extends Error {
  status?: number;
  retryable?: boolean;
}

/**
 * 根据覆盖参数与环境变量生成模型通道列表（主通道 + 可选备援通道）。
 * @param options 补全选项，可指定 baseUrl/apiKey/model 覆盖默认通道
 * @returns 按顺序排列的可用通道数组
 */
function channels(options: CompletionOptions): Channel[] {
  if (options.baseUrlOverride) {
    return [
      {
        baseUrl: options.baseUrlOverride.replace(/\/+$/, ''),
        apiKey: options.apiKeyOverride ?? env.llm.apiKey,
        model: options.modelOverride ?? env.llm.model,
        label: 'override',
      },
    ];
  }
  const primary: Channel = {
    baseUrl: env.llm.baseUrl,
    apiKey: env.llm.apiKey,
    model: env.llm.model,
    label: 'primary',
  };
  if (env.llm.fallbackBaseUrl) {
    return [
      primary,
      {
        baseUrl: env.llm.fallbackBaseUrl,
        apiKey: env.llm.fallbackApiKey || env.llm.apiKey,
        model: env.llm.fallbackModel || env.llm.model,
        label: 'fallback',
      },
    ];
  }
  return [primary];
}

/**
 * 判断上游错误是否值得重试或切换备援通道。
 * @param err 捕获到的异常，读取其 status/retryable 字段
 * @returns 可重试（含网络错误、5xx、429、408 及 key 失效类 401/402/403）返回 true
 */
function isRetryable(err: unknown): boolean {
  const e = err as LlmHttpError;
  if (typeof e?.status === 'number') {
    // 5xx/429/408 是临时故障；401/402/403 是 key 失效、欠费、无权限——
    // 原地重试没意义，但切到备援通道往往能救回来（曾因 DeepSeek 402 欠费整批标注失败）
    return (
      e.status >= 500 ||
      e.status === 429 ||
      e.status === 408 ||
      e.status === 401 ||
      e.status === 402 ||
      e.status === 403
    );
  }
  // 网络错误 / DNS / 连接重置
  return true;
}

/**
 * 把内部超时信号与外部取消信号合并为一个 AbortSignal。
 * @param timeoutMs 超时毫秒数
 * @param outer 外部传入的取消信号（如客户端断连）
 * @returns 任一信号触发即取消的合并信号
 */
function combineSignals(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!outer) return timeout;
  return AbortSignal.any([timeout, outer]);
}

/**
 * 向指定 URL 发起带鉴权的 JSON POST 请求（副作用：发网络请求）。
 * @param url 完整请求地址
 * @param apiKey Bearer 令牌
 * @param body 请求体对象
 * @param signal 取消/超时信号
 * @returns 响应正常时返回 Response；网络或 HTTP 错误时抛出带 status/retryable 的 LlmHttpError
 */
async function postJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    const aborted = e.name === 'AbortError' || e.name === 'TimeoutError';
    const error: LlmHttpError = new Error(
      aborted ? '模型服务响应超时' : `模型服务连接失败：${e.message}`,
    );
    error.retryable = true;
    if (!aborted) logger.warn({ err: e.message, url: safeUrl(url) }, '[llm] network error');
    throw error;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn(
      { status: res.status, url: safeUrl(url), body: text.slice(0, 300) },
      '[llm] upstream error',
    );
    const error: LlmHttpError = new Error(`模型服务返回 ${res.status}`);
    error.status = res.status;
    error.retryable = res.status >= 500 || res.status === 429;
    throw error;
  }
  return res;
}

/**
 * 脱敏 URL：去掉查询串与片段，仅保留 origin + pathname，避免日志泄露密钥。
 * @param url 原始 URL 字符串
 * @returns 脱敏后的 URL，解析失败时原样返回
 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * 依次在候选通道上执行 fn，遇到可重试错误自动切换备援通道。
 * @param options 补全选项，用于生成通道列表
 * @param fn 针对单个通道执行的具体请求逻辑
 * @returns 首个成功通道的执行结果
 * @throws 全部通道失败时抛出 llmUnavailable（模型服务暂不可用）
 */
async function runWithChannels<T>(options: CompletionOptions, fn: (ch: Channel) => Promise<T>): Promise<T> {
  const list = channels(options);
  let lastErr: unknown;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    try {
      return await fn(ch);
    } catch (err) {
      lastErr = err;
      const canFallback = i < list.length - 1 && isRetryable(err);
      if (canFallback) {
        logger.warn({ channel: ch.label, reason: (err as Error).message }, '[llm] 切换备援通道');
        continue;
      }
      break;
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : 'unknown';
  throw llmUnavailable(`模型服务暂不可用，请稍后重试（${reason}）`);
}

/**
 * 按 OpenAI 兼容格式组装 chat/completions 请求体。
 * @param ch 当前使用的通道（提供模型名）
 * @param messages 对话消息列表
 * @param options 补全选项（工具、温度、maxTokens、jsonMode 等）
 * @param stream 是否流式
 * @returns 请求体对象
 */
function buildBody(ch: Channel, messages: LlmMessage[], options: CompletionOptions, stream: boolean) {
  const body: Record<string, unknown> = {
    model: ch.model,
    messages,
    temperature: options.temperature ?? 0.3,
    stream,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }
  if (options.jsonMode) body.response_format = { type: 'json_object' };
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

/**
 * 非流式对话补全：一次性返回文本、工具调用与用量（副作用：发网络请求，失败自动切备援通道）。
 * @param messages 对话消息列表
 * @param options 补全选项（工具、温度、maxTokens、信号等）
 * @returns 回复文本、工具调用数组与可选的 usage 用量信息
 */
export async function complete(
  messages: LlmMessage[],
  options: CompletionOptions = {},
): Promise<{ content: string; toolCalls: LlmToolCall[]; usage?: Record<string, number> }> {
  const started = Date.now();
  return runWithChannels(options, async (ch) => {
    const signal = combineSignals(env.llm.timeoutMs, options.signal);
    const res = await postJson(
      `${ch.baseUrl}/chat/completions`,
      ch.apiKey,
      buildBody(ch, messages, options, false),
      signal,
    );
    const data = (await res.json()) as any;
    if (data?.error) throw llmUnavailable(String(data.error.message ?? '模型返回错误'));
    const message = data?.choices?.[0]?.message;
    if (!message) throw llmUnavailable('模型返回内容为空，请稍后重试');
    const toolCalls: LlmToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' },
        }))
      : [];
    logger.debug({ ms: Date.now() - started, channel: ch.label }, '[llm] complete');
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      usage: data?.usage,
    };
  });
}

/**
 * 流式补全：逐块产出文本增量与最终的 tool_calls（副作用：发网络请求、读数据流）。
 * @param messages 对话消息列表
 * @param options 补全选项（工具、温度、信号等）
 * @returns 异步生成器，依次产出 text / tool_calls / done 事件
 */
export async function* streamChat(
  messages: LlmMessage[],
  options: CompletionOptions = {},
): AsyncGenerator<LlmStreamEvent> {
  const response = await runWithChannels(options, async (ch) => {
    const signal = combineSignals(env.llm.timeoutMs, options.signal);
    return postJson(
      `${ch.baseUrl}/chat/completions`,
      ch.apiKey,
      buildBody(ch, messages, options, true),
      signal,
    );
  });

  const reader = response.body?.getReader();
  if (!reader) throw llmUnavailable('模型服务未返回数据流，请稍后重试');
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finishReason: string | null = null;
  let usage: Record<string, number> | undefined;
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!rawLine.startsWith('data:')) continue;
        const payload = rawLine.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json?.error) throw llmUnavailable(String(json.error.message ?? '模型返回错误'));
        if (json?.usage) usage = json.usage;
        const choice = json?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text', text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const key = typeof tc.index === 'number' ? tc.index : toolAcc.size;
            const cur = toolAcc.get(key) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(key, cur);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (toolAcc.size > 0) {
    const calls: LlmToolCall[] = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, v]) => ({
        id: v.id || `call_${i}`,
        type: 'function' as const,
        function: { name: v.name, arguments: v.args || '{}' },
      }))
      .filter((c) => c.function.name);
    if (calls.length > 0) yield { type: 'tool_calls', calls };
  }
  yield { type: 'done', finishReason, usage };
}

// ---------------- Embedding ----------------

/**
 * 把数值数组序列化为 PostgreSQL vector 字面量（如 [0.1,0.2]），非有限值记为 0。
 * @param v 向量数值数组
 * @returns vector 列可接受的字符串字面量
 */
function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(8)) : 0)).join(',')}]`;
}

export { vectorLiteral };

/**
 * 批量生成文本向量（副作用：向向量服务发 /embeddings 请求，按配置分批）。
 * 会校验返回条数与向量维度，不一致时抛 embeddingUnavailable。
 * @param texts 待向量化的文本数组
 * @returns 与输入顺序一一对应的向量数组
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  const batchSize = Math.max(1, env.embedding.batchSize);
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    let res: Response;
    try {
      res = await fetch(`${env.embedding.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.embedding.apiKey}`,
        },
        body: JSON.stringify({
          model: env.embedding.model,
          input: batch,
          // 智谱 embedding-3 需 dimensions 指定输出维度，且不认 encoding_format；
          // bge-m3 等固定维度模型则相反，用开关区分
          ...(env.embedding.sendDim
            ? { dimensions: env.embedding.dim }
            : { encoding_format: 'float' }),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[embedding] network error');
      throw embeddingUnavailable('向量服务连接失败，请检查 EMBEDDING_BASE_URL 配置');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: text.slice(0, 200) }, '[embedding] upstream error');
      throw embeddingUnavailable(`向量服务暂不可用（HTTP ${res.status}），请稍后重试`);
    }
    const data = (await res.json()) as any;
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length !== batch.length) {
      throw embeddingUnavailable('向量服务返回条数与请求不一致');
    }
    for (const row of rows) {
      const vec = row?.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw embeddingUnavailable('向量服务返回格式不正确');
      }
      if (vec.length !== env.embedding.dim) {
        throw embeddingUnavailable(
          `向量维度为 ${vec.length}，数据库要求 ${env.embedding.dim}，请检查 EMBEDDING_MODEL`,
        );
      }
      out.push(vec as number[]);
    }
  }
  return out;
}

/**
 * 生成单条文本的向量，是 embedTexts 的单值便捷封装。
 * @param text 待向量化的文本
 * @returns 对应的向量数组；无结果时返回 undefined
 */
export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}

// ---------------- Rerank ----------------

export interface RerankResult {
  index: number;
  score: number;
}

/**
 * 调用重排服务对候选文档按与查询的相关度重新排序（副作用：发 /rerank 请求）。
 * @param query 查询文本
 * @param documents 候选文档列表
 * @param topN 返回的条数上限（不超过文档数）
 * @returns 按 score 降序排列、索引合法的结果数组；未配置时抛错
 */
export async function rerank(query: string, documents: string[], topN: number): Promise<RerankResult[]> {
  if (!env.rerank.baseUrl || !env.rerank.apiKey) {
    throw new Error('rerank not configured');
  }
  const res = await fetch(`${env.rerank.baseUrl}/rerank`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.rerank.apiKey}`,
    },
    body: JSON.stringify({
      model: env.rerank.model,
      query,
      documents,
      top_n: Math.min(topN, documents.length),
    }),
    signal: AbortSignal.timeout(env.rerank.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rerank HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  const data = (await res.json()) as any;
  const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : [];
  return rows
    .map((r: any) => ({
      index: Number(r.index),
      score: Number(r.relevance_score ?? r.score ?? 0),
    }))
    .filter((r: RerankResult) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length)
    .sort((a: RerankResult, b: RerankResult) => b.score - a.score);
}

/**
 * 视觉模型识图（小程序拍照识题链路）。
 * imageBase64 允许带 data URL 前缀，也允许纯 base64。
 * 与主对话通道解耦：走 env.vision 配置，主模型是纯文本模型时也能识图。
 */
export async function describeImage(
  imageBase64: string,
  prompt: string,
  options: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const raw = imageBase64.replace(/^data:[^;,]+;base64,/, '').trim();
  if (!raw) throw badRequest('图片内容为空');
  const signal = combineSignals(env.vision.timeoutMs, options.signal);
  const body: Record<string, unknown> = {
    model: env.vision.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: raw } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    temperature: options.temperature ?? 0.1,
    max_tokens: options.maxTokens ?? 1600,
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await postJson(`${env.vision.baseUrl}/chat/completions`, env.vision.apiKey, body, signal);
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim()) return content.trim();
      throw new Error('视觉模型返回为空');
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetryable(err)) {
        await sleep(800);
        continue;
      }
      break;
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : 'unknown';
  logger.warn({ event: 'vision_failed', model: env.vision.model, reason }, '[llm] vision failed');
  throw llmUnavailable(`题目识别失败，请重拍或手动输入（${reason}）`);
}
