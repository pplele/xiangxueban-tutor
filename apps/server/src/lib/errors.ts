export interface ErrorDetails {
  [field: string]: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: ErrorDetails;

  /**
   * 创建带 HTTP 状态码、业务错误码与可选字段详情的应用异常。
   * @param statusCode HTTP 状态码
   * @param code 业务错误码
   * @param message 错误描述
   * @param details 可选的字段级错误详情
   */
  constructor(statusCode: number, code: string, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/** 构造 400 BAD_REQUEST 错误 */
export const badRequest = (message: string, details?: ErrorDetails) =>
  new AppError(400, 'BAD_REQUEST', message, details);

/** 构造 400 VALIDATION_ERROR 错误，可带字段级详情 */
export const validationError = (message = '请求参数不合法', details?: ErrorDetails) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);

/** 构造 401 UNAUTHORIZED 错误 */
export const unauthorized = (message = '未登录或登录已过期') =>
  new AppError(401, 'UNAUTHORIZED', message);

/** 构造 403 FORBIDDEN 错误 */
export const forbidden = (message = '没有权限执行该操作') => new AppError(403, 'FORBIDDEN', message);

/** 构造 404 NOT_FOUND 错误 */
export const notFound = (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message);

/** 构造 409 CONFLICT 错误（资源重复/冲突） */
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

/** 构造 429 RATE_LIMITED 错误 */
export const rateLimited = (message = '请求过于频繁，请稍后再试') =>
  new AppError(429, 'RATE_LIMITED', message);

/** 构造 502 LLM_UNAVAILABLE 错误（模型服务不可用） */
export const llmUnavailable = (message = '模型服务暂不可用，请稍后重试') =>
  new AppError(502, 'LLM_UNAVAILABLE', message);

/** 构造 502 EMBEDDING_UNAVAILABLE 错误（向量服务不可用） */
export const embeddingUnavailable = (message = '向量服务暂不可用，请稍后重试') =>
  new AppError(502, 'EMBEDDING_UNAVAILABLE', message);
