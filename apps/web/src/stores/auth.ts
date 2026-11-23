import { defineStore } from 'pinia';
import {
  clearAuth,
  getAccessToken,
  getUsername,
  login as apiLogin,
  logout as apiLogout,
} from '@/api/client';

/** 登录/鉴权状态：由 localStorage 令牌初始化登录态 */
export const useAuthStore = defineStore('auth', {
  /** 初始 state：用户名、是否已登录、加载中与错误信息 */
  state: () => ({
    username: getUsername(),
    authenticated: Boolean(getAccessToken()),
    loading: false,
    error: '',
  }),
  actions: {
    /** 从 localStorage 重新读取用户名与登录态，供登出事件等场景同步 */
    sync() {
      this.username = getUsername();
      this.authenticated = Boolean(getAccessToken());
    },
    /**
     * 登录：调用 apiLogin 后在本地标记已登录，失败时记录错误文案。
     * @param username 用户名
     * @param password 密码
     * @returns 是否登录成功
     */
    async signIn(username: string, password: string) {
      this.loading = true;
      this.error = '';
      try {
        const data = await apiLogin(username.trim(), password);
        this.username = data.user.username;
        this.authenticated = true;
        return true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : '登录失败';
        return false;
      } finally {
        this.loading = false;
      }
    },
    /** 退出登录：调用后端登出并清空本地登录态 */
    async signOut() {
      await apiLogout();
      clearAuth();
      this.authenticated = false;
      this.username = '';
    },
    /** 处理被强制登出（如令牌失效事件）：仅重置本地登录态，不请求后端 */
    handleForcedLogout() {
      this.authenticated = false;
      this.username = '';
    },
  },
});
