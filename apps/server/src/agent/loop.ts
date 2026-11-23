import type { Citation } from '@tutor/shared';
import type { LlmMessage, LlmToolCall } from './llm';
import { streamChat } from './llm';
import { executeTool, getToolSchemas } from './tools';
import { sha256Hex } from '../lib/crypto';
import { logger } from '../lib/logger';
import { truncate } from '../lib/text';

export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'done'; summary?: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'done'; content: string; citations: Citation[] };

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunAgentOptions {
  systemPrompt: string;
  history: HistoryMessage[];
  question: string;
  subject: string;
  sessionId: string;
  initialCitations: Citation[];
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}

const MAX_TURNS = 5;

/**
 * 生成引文去重键：出处名 + 内容 sha256 的前 16 位。
 * @param c 引文对象
 * @returns 用于判重的字符串键
 */
function citationKey(c: Citation): string {
  return `${c.sourceName}::${sha256Hex(c.content).slice(0, 16)}`;
}

/**
 * 按「出处名 + 内容指纹」对引文去重，跳过无出处项，保留首次出现者。
 * @param list 待去重的引文数组
 * @returns 去重后的引文数组
 */
export function dedupeCitations(list: Citation[]): Citation[] {
  const map = new Map<string, Citation>();
  for (const c of list) {
    if (!c || !c.sourceName) continue;
    const key = citationKey(c);
    if (!map.has(key)) map.set(key, c);
  }
  return [...map.values()];
}

/**
 * 手写 Agent Loop：
 * 最多 5 轮「模型 → 工具 → 模型」，工具结果以自然语言追加为 tool 消息。
 * 超过 5 轮则再请求一次无工具补全，强制收敛并输出已有内容。
 */
export async function runAgent(options: RunAgentOptions): Promise<{ content: string; citations: Citation[] }> {
  const messages: LlmMessage[] = [
    { role: 'system', content: options.systemPrompt },
    ...options.history.map((h) => ({ role: h.role, content: h.content }) as LlmMessage),
    { role: 'user', content: options.question },
  ];

  const citations = dedupeCitations(options.initialCitations);
  let fullText = '';
  let finished = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let turnText = '';
    let toolCalls: LlmToolCall[] = [];

    const stream = streamChat(messages, {
      tools: getToolSchemas(),
      temperature: 0.4,
      signal: options.signal,
    });

    for await (const event of stream) {
      if (event.type === 'text') {
        turnText += event.text;
        fullText += event.text;
        options.emit({ type: 'token', text: event.text });
      } else if (event.type === 'tool_calls') {
        toolCalls = event.calls;
      }
    }

    if (toolCalls.length === 0) {
      finished = true;
      break;
    }

    messages.push({
      role: 'assistant',
      content: turnText || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function.name;
      options.emit({ type: 'tool', name, status: 'running' });
      const { result, error } = await executeTool(name, call.function.arguments, { subject: options.subject, sessionId: options.sessionId });
      if (result?.citations && result.citations.length > 0) {
        const merged = dedupeCitations([...citations, ...result.citations]);
        citations.length = 0;
        citations.push(...merged);
        options.emit({ type: 'citations', citations: merged });
      }
      const content = result?.text
        ? result.text
        : `（工具 ${name} 执行失败：${error ?? '未知错误'}。请如实告诉学生该功能暂时不可用，不要编造结果。）`;
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content,
      });
      options.emit({ type: 'tool', name, status: 'done', summary: truncate(result?.text ?? error ?? '', 120) });
      logger.info({ event: 'agent.tool', tool: name, ok: Boolean(result) }, '[agent] tool step');
    }
  }

  if (!finished) {
    // 强制收敛：不带工具再请求一次，只输出文字
    let finalText = '';
    const stream = streamChat(messages, { temperature: 0.4, signal: options.signal });
    for await (const event of stream) {
      if (event.type === 'text') {
        finalText += event.text;
        fullText += event.text;
        options.emit({ type: 'token', text: event.text });
      }
    }
    if (!fullText.trim()) {
      fullText = '抱歉，本轮查询步骤过多，已经达到工具调用上限。请把问题再具体描述一下，我会继续帮你分析。';
      options.emit({ type: 'token', text: fullText });
    }
    logger.warn({ event: 'agent.max_turns', turns: MAX_TURNS }, '[agent] forced final answer');
  }

  const finalCitations = dedupeCitations(citations);
  options.emit({ type: 'citations', citations: finalCitations });
  return { content: fullText.trim(), citations: finalCitations };
}
