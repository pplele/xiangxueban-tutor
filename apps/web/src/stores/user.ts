import { defineStore } from 'pinia';
import { API_BASE, get, errorMessage, getAccessToken } from '@/api/client';
import { useAuthStore } from './auth';

/** 头像：内置 emoji（value+bg）或上传图片（file+mime） */
export type Avatar =
  | { type: 'emoji'; value: string; bg: string }
  | { type: 'image'; file: string; mime: string };

/** GET /prefs 返回的用户展示偏好（昵称、头像与预设头像列表） */
interface PrefsResponse {
  nickname: string;
  avatar: Avatar | null;
  presets: { type: 'emoji'; value: string; bg: string }[];
}

/**
 * 用户展示偏好：昵称与头像。
 * 单账号系统，全局共享；登录成功后 load() 一次，设置页改完 refresh()。
 */
export const useUserStore = defineStore('user', {
  /** 初始 state：昵称、头像、预设头像与是否已加载 */
  state: () => ({
    nickname: '',
    avatar: null as Avatar | null,
    presets: [] as PrefsResponse['presets'],
    loaded: false,
  }),
  getters: {
    /** 侧边栏/账号卡展示名：自定义昵称优先，否则用登录账号名 */
    displayName(): string {
      const auth = useAuthStore();
      return this.nickname.trim() || auth.username || '学生';
    },
    /** 头像第一个字：昵称优先，否则账号名 */
    initial(): string {
      return this.displayName.slice(0, 1) || '学';
    },
    /** 头像图片地址：<img> 带不了 Authorization 头，token 走 query */
    avatarUrl(): string {
      if (this.avatar?.type !== 'image') return '';
      const token = getAccessToken() ?? '';
      return `${API_BASE}/prefs/avatar?token=${encodeURIComponent(token)}`;
    },
  },
  actions: {
    /**
     * 加载用户偏好：GET /prefs 拉取昵称/头像/预设，失败时静默回退到默认值。
     * @param force 是否忽略缓存强制刷新
     */
    async load(force = false) {
      if (this.loaded && !force) return;
      try {
        const data = await get<PrefsResponse>('/prefs');
        this.nickname = data.nickname ?? '';
        this.avatar = data.avatar ?? null;
        this.presets = data.presets ?? [];
        this.loaded = true;
      } catch (err) {
        // 偏好加载失败不影响主流程：昵称退回账号名、头像退回首字母
        this.nickname = '';
        this.avatar = null;
        this.loaded = true;
        void errorMessage(err);
      }
    },
    /**
     * 设置页改完后本地立即更新昵称/头像并标记已加载。
     * @param nickname 新昵称
     * @param avatar 新头像（emoji 或图片）
     */
    setLocal(nickname: string, avatar: Avatar | null) {
      this.nickname = nickname;
      this.avatar = avatar;
      this.loaded = true;
    },
  },
});
