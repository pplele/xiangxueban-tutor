const RAW_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8849/api';

/**
 * 局域网访问时（手机扫码打开 http://192.168.x.x:5173），配置里写死的 localhost 后端
 * 会指向手机自己；此时降级为同源相对路径 /api，由 vite 代理转发到后端，免 CORS。
 * 开发服务器与生产静态部署（同源挂 /api）都适用。
 * @returns 归一化后的 API 根地址；局域网访问时降级为同源相对路径 /api
 */
function resolveApiBase(): string {
  const base = String(RAW_BASE).replace(/\/+$/, '');
  try {
    const u = new URL(base);
    const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (isLocal && typeof location !== 'undefined' && location.hostname !== u.hostname) {
      return '/api';
    }
  } catch {
    /* 非绝对地址（本来就是相对路径），原样使用 */
  }
  return base;
}

export const API_BASE = resolveApiBase();

const ACCESS_KEY = 'tutor.accessToken';
const REFRESH_KEY = 'tutor.refreshToken';
const USER_KEY = 'tutor.username';

/** 后端错误响应体映射成的结构化错误参数 */
export interface ApiErrorShape {
  code: string;
  message: string;
  status?: number;
  details?: Record<string, string>;
  offline?: boolean;
}

/** 统一应用错误：携带业务 code、HTTP status 与离线标记 */
export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, string>;
  offline: boolean;

  /** @param shape 错误参数（含 message、code、status、details 等） */
  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.name = 'ApiError';
    this.code = shape.code;
    this.status = shape.status ?? 0;
    this.details = shape.details;
    this.offline = Boolean(shape.offline);
  }
}

/** 从 localStorage 读取访问令牌；未登录返回 null。@returns 访问令牌或 null */
export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_KEY);
}
/** 从 localStorage 读取刷新令牌；未登录返回 null。@returns 刷新令牌或 null */
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}
/** 读取用户名；未设置时回退为「学生」。@returns 用户名 */
export function getUsername(): string {
  return localStorage.getItem(USER_KEY) || '学生';
}

/**
 * 将令牌（及可选用户名）写入 localStorage，完成登录态持久化。
 * @param accessToken 访问令牌
 * @param refreshToken 刷新令牌
 * @param username 用户名，传入才覆盖
 */
export function setAuth(accessToken: string, refreshToken: string, username?: string): void {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
  if (username) localStorage.setItem(USER_KEY, username);
}

/** 清除本地登录态，并派发 tutor:logout 事件通知各组件同步登出 */
export function clearAuth(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new CustomEvent('tutor:logout'));
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * 用刷新令牌换取新令牌；并发调用共享同一 Promise，避免重复刷新。
 * @returns 是否换得新令牌（HTTP 失败会清除登录态，纯网络失败仅返回 false）
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearAuth();
        return false;
      }
      const data = await res.json();
      setAuth(data.accessToken, data.refreshToken, data.user?.username);
      return true;
    } catch {
      // 网络失败不清除登录态，提示离线
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

/** request 可选配置：是否带令牌、是否重试 5xx、单请求超时毫秒数 */
export interface RequestOptions {
  auth?: boolean;
  retry5xx?: boolean;
  timeoutMs?: number;
}

/**
 * 等待指定毫秒后 resolve，用于 5xx 的指数退避重试。
 * @param ms 等待毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 将失败的 HTTP 响应解析为统一 ApiError：优先读后端 error 体，再按状态码兜底。
 * @param res 失败的响应
 * @returns 结构化错误对象
 */
async function parseErrorResponse(res: Response): Promise<ApiError> {
  try {
    const data = await res.json();
    if (data?.error) {
      return new ApiError({
        code: data.error.code || `HTTP_${res.status}`,
        message: data.error.message || `请求失败（${res.status}）`,
        status: res.status,
        details: data.error.details,
      });
    }
  } catch {
    /* ignore */
  }
  if (res.status >= 500) {
    return new ApiError({ code: 'SERVER_ERROR', message: '服务器开小差了，请稍后重试', status: res.status });
  }
  return new ApiError({ code: `HTTP_${res.status}`, message: `请求失败（${res.status}）`, status: res.status });
}

/**
 * 执行一次底层 fetch：按需附加 Authorization 头，网络异常统一转成离线 ApiError。
 * @param path 相对 API_BASE 的请求路径
 * @param init fetch 初始化参数
 * @param auth 是否附带访问令牌
 * @returns 原始响应
 */
async function doFetch(path: string, init: RequestInit, auth: boolean): Promise<Response> {
  const headers = new Headers(init.headers || {});
  if (auth) {
    const token = getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError({
      code: 'OFFLINE',
      message: '网络连接失败，请检查网络或确认后端服务已启动（默认 http://localhost:8849）',
      offline: true,
    });
  }
}

/**
 * 通用请求入口：附加令牌、401 自动刷新重试、5xx 指数退避最多重试 3 次。
 * @param path 请求路径（拼接到 API_BASE 后）
 * @param init fetch 初始化参数
 * @param options 重试与鉴权配置
 * @returns 解析后的 JSON 数据；204 返回 null
 */
export async function request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  const auth = options.auth !== false;
  const retry5xx = options.retry5xx !== false;

  for (let attempt = 0; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await doFetch(path, init, auth);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw err;
    }

    if (res.status === 401 && auth) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        res = await doFetch(path, init, auth);
      } else {
        clearAuth();
        throw new ApiError({ code: 'UNAUTHORIZED', message: '登录已过期，请重新登录', status: 401 });
      }
    }

    if (res.ok) {
      if (res.status === 204) return null as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    }

    const error = await parseErrorResponse(res);
    const shouldRetry = retry5xx && res.status >= 500 && attempt < 3;
    if (shouldRetry) {
      await sleep(300 * Math.pow(2, attempt));
      continue;
    }
    throw error;
  }

  throw new ApiError({ code: 'UNKNOWN', message: '请求失败，请稍后重试' });
}

/** 发起 GET 请求：@param path 请求路径 @param options 可选配置 @returns 解析后的 JSON */
export function get<T>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { method: 'GET' }, options);
}

/**
 * 发起 POST 请求，body 自动 JSON 序列化（Content-Type: application/json）。
 * @param path 请求路径
 * @param body 请求体，undefined 时不发送
 * @param options 可选配置
 * @returns 解析后的 JSON
 */
export function post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options,
  );
}

/**
 * 发起 PUT 请求：以 JSON 提交完整资源。
 * @param path 请求路径
 * @param body 请求体
 * @param options 可选配置
 * @returns 解析后的 JSON
 */
export function put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
  return request<T>(
    path,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    options,
  );
}

/** 发起 PATCH 请求：以 JSON 提交局部更新。@param path 请求路径 @param body 请求体 @param options 可选配置 @returns 解析后的 JSON */
export function patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {  return request<T>(
    path,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    options,
  );
}

/** 发起 DELETE 请求；默认返回 null。@param path 请求路径 @param options 可选配置 @returns 解析后的数据 */
export function del<T = null>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, { method: 'DELETE' }, options);
}

/** 登录接口返回：访问/刷新令牌、有效期与用户信息 */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  user: { username: string };
}

/**
 * 调用 POST /auth/login 登录（无需令牌、不重试 5xx），成功后持久化登录态。
 * @param username 用户名
 * @param password 密码
 * @returns 登录响应（含令牌）
 */
export async function login(username: string, password: string): Promise<LoginResponse> {
  const data = await post<LoginResponse>('/auth/login', { username, password }, { auth: false, retry5xx: false });
  setAuth(data.accessToken, data.refreshToken, data.user.username);
  return data;
}

/** 调用 POST /auth/logout 通知后端失效令牌（忽略失败），随后清除本地登录态 */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  try {
    if (refreshToken) await post('/auth/logout', { refreshToken });
  } catch {
    /* 忽略退出失败 */
  }
  clearAuth();
}

/**
 * 从任意异常中提取可展示给用户的中文错误文案。
 * @param err 捕获的异常
 * @returns 错误文案
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.offline) return err.message;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return '发生未知错误';
}
