import { many, one, query } from '../db/pool';
import type { ChatMessageDto, ChatSessionDto, Citation } from '@tutor/shared';

/** chat_sessions 表原始行结构 */
export interface SessionRow {
  id: string;
  subject: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

/** chat_messages 表原始行结构；citations 为 jsonb 引用数组 */
export interface MessageRow {
  id: string | number;
  session_id: string;
  role: string;
  content: string;
  citations: Citation[] | null;
  created_at: Date;
}

/**
 * 将 chat_sessions 表原始行映射为前端 ChatSessionDto（时间转 ISO 字符串）。
 * @param row chat_sessions 表查询结果行
 * @returns 前端会话 DTO
 */
function mapSession(row: SessionRow): ChatSessionDto {
  return {
    id: row.id,
    subject: row.subject,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * 将 chat_messages 表原始行映射为前端 ChatMessageDto（id 转数字、时间转 ISO、引用兜底 null）。
 * @param row chat_messages 表查询结果行
 * @returns 前端消息 DTO
 */
function mapMessage(row: MessageRow): ChatMessageDto {
  return {
    id: Number(row.id),
    role: row.role as ChatMessageDto['role'],
    content: row.content,
    citations: Array.isArray(row.citations) ? row.citations : null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * 向 chat_sessions 表插入一条新会话。
 * @param subject 科目
 * @param title 可选标题
 * @returns 新建会话 DTO
 */
export async function createSession(subject: string, title?: string): Promise<ChatSessionDto> {
  const row = await one<SessionRow>(
    `INSERT INTO chat_sessions (subject, title) VALUES ($1, $2) RETURNING *`,
    [subject, title ?? null],
  );
  return mapSession(row!);
}

/**
 * 从 chat_sessions 表按 id 读取一个会话。
 * @param id 会话 id
 * @returns 会话 DTO，不存在返回 null
 */
export async function getSession(id: string): Promise<ChatSessionDto | null> {
  const row = await one<SessionRow>(`SELECT * FROM chat_sessions WHERE id = $1`, [id]);
  return row ? mapSession(row) : null;
}

/**
 * 从 chat_sessions 表读取会话列表，按更新时间倒序；subject 为空则不限科目。
 * @param subject 可选，科目
 * @param limit 最多返回条数，默认 50
 * @returns 会话 DTO 列表
 */
export async function listSessions(subject?: string, limit = 50): Promise<ChatSessionDto[]> {
  const rows = await many<SessionRow>(
    `SELECT * FROM chat_sessions
      WHERE ($1::text IS NULL OR subject = $1)
      ORDER BY updated_at DESC LIMIT $2`,
    [subject ?? null, limit],
  );
  return rows.map(mapSession);
}

/**
 * 更新 chat_sessions.updated_at（有标题则仅首设、用 COALESCE 不覆盖已有标题）。
 * @param id 会话 id
 * @param title 可选标题
 */
export async function touchSession(id: string, title?: string): Promise<void> {
  if (title) {
    await query(`UPDATE chat_sessions SET updated_at = now(), title = COALESCE(title, $2) WHERE id = $1`, [id, title]);
  } else {
    await query(`UPDATE chat_sessions SET updated_at = now() WHERE id = $1`, [id]);
  }
}

/**
 * 从 chat_messages 表读取会话最后若干条消息：子查询取最新 limit 条再按 id 升序返回。
 * @param sessionId 会话 id
 * @param limit 最多返回条数，默认 200
 * @returns 按时间正序排列的消息 DTO
 */
export async function listMessages(sessionId: string, limit = 200): Promise<ChatMessageDto[]> {
  const rows = await many<MessageRow>(
    `SELECT * FROM (SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id ASC`,
    [sessionId, limit],
  );
  return rows.map(mapMessage);
}

/**
 * 从 chat_messages 表读取会话最近若干条消息（用于构造对话上下文），正序返回。
 * @param sessionId 会话 id
 * @param limit 最多返回条数，默认 20
 * @returns 按时间正序排列的消息 DTO
 */
export async function recentMessages(sessionId: string, limit = 20): Promise<ChatMessageDto[]> {
  const rows = await many<MessageRow>(
    `SELECT * FROM (SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id ASC`,
    [sessionId, limit],
  );
  return rows.map(mapMessage);
}

/**
 * 向 chat_messages 表插入一条消息；citations 以 jsonb 存储，为空则存 null。
 * @param sessionId 会话 id
 * @param role 角色：user/assistant/tool
 * @param content 消息内容
 * @param citations 可选引用列表
 * @returns 新建消息 DTO
 */
export async function insertMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  citations?: Citation[] | null,
): Promise<ChatMessageDto> {
  const row = await one<MessageRow>(
    `INSERT INTO chat_messages (session_id, role, content, citations)
     VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
    [sessionId, role, content, citations ? JSON.stringify(citations) : null],
  );
  return mapMessage(row!);
}
