import type { Citation } from '@tutor/shared';
import { API_BASE, ApiError, clearAuth, getAccessToken, refreshAccessToken } from './client';

/** 聊天 SSE 事件联合类型：start/token/tool/citations/done/error */
export type ChatStreamEvent =
  | { type: 'start'; sessionId: string; timestamp?: string }
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'done'; summary?: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'done'; messageId?: number; citations?: Citation[]; timestamp?: string }
  | { type: 'error'; code: string; message: string };

/** streamAsk 的入参：会话、提问内容、可选题目上下文与事件回调 */
export interface StreamAskOptions {
  sessionId: string;
  content: string;
  /** 做题页小窗：把当前题目上下文注入服务端 Prompt */
  questionId?: string;
  variantId?: number | null;
  studentAnswer?: string;
  signal?: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

/**
 * 向 POST /chat/ask 发起流式提问请求：按需附加令牌，网络异常转成离线 ApiError。
 * @param options 提问参数（含题目上下文、AbortSignal 等）
 * @param auth 是否附带访问令牌
 * @returns 原始响应（body 为 SSE 流）
 */
async function doFetch(options: StreamAskOptions, auth: boolean): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  try {
    return await fetch(`${API_BASE}/chat/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: options.sessionId,
        content: options.content,
        ...(options.questionId ? { questionId: options.questionId } : {}),
        ...(options.variantId ? { variantId: options.variantId } : {}),
        ...(options.studentAnswer ? { studentAnswer: options.studentAnswer } : {}),
      }),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError({
      code: 'OFFLINE',
      message: '网络连接失败，请检查网络或确认后端服务已启动',
      offline: true,
    });
  }
}

/**
 * 通过 fetch + ReadableStream 消费 POST /chat/ask 的 SSE 流（POST 无法用 EventSource）。
 * 处理 401 刷新重试、按 \n\n 分块，逐条回调 onEvent。
 * @param options 提问参数与事件回调
 */
export async function streamAsk(options: StreamAskOptions): Promise<void> {
  let res = await doFetch(options, true);
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await doFetch(options, true);
    } else {
      clearAuth();
      throw new ApiError({ code: 'UNAUTHORIZED', message: '登录已过期，请重新登录', status: 401 });
    }
  }

  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    let code = `HTTP_${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) {
        message = data.error.message;
        code = data.error.code;
      }
    } catch {
      /* ignore */
    }
    throw new ApiError({ code, message, status: res.status });
  }

  if (!res.body) throw new ApiError({ code: 'NO_STREAM', message: '服务未返回数据流' });

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleBlock(block, options.onEvent);
      }
    }
    // 兼容最后没有空行的情况
    if (buffer.trim()) handleBlock(buffer, options.onEvent);
  } finally {
    reader.releaseLock();
  }
}

/**
 * 解析单个 SSE 块中的 data 行，拼成 JSON 后回调；忽略心跳与脏数据。
 * @param block 以 \n\n 分隔出的单个事件块
 * @param onEvent 事件回调
 */
function handleBlock(block: string, onEvent: (e: ChatStreamEvent) => void): void {
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n');
  try {
    const event = JSON.parse(payload) as ChatStreamEvent;
    if (event && typeof event.type === 'string') onEvent(event);
  } catch {
    // 忽略无法解析的心跳或脏数据
  }
}
