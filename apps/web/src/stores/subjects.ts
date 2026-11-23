import { defineStore } from 'pinia';
import type { SubjectWithChapters } from '@tutor/shared';
import { get, errorMessage } from '@/api/client';

/** 科目与章节目录缓存：GET /subjects 拉取一次后复用 */
export const useSubjectsStore = defineStore('subjects', {
  /** 初始 state：科目列表、加载中、错误与是否已加载 */
  state: () => ({
    items: [] as SubjectWithChapters[],
    loading: false,
    error: '',
    loaded: false,
  }),
  actions: {
    /**
     * 确保科目目录已加载：已加载时直接返回，force=true 时强制重新拉取 GET /subjects。
     * @param force 是否忽略缓存强制刷新
     * @returns 科目（含章节）列表
     */
    async ensure(force = false) {
      if (this.loaded && !force) return this.items;
      this.loading = true;
      this.error = '';
      try {
        const data = await get<{ subjects: SubjectWithChapters[] }>('/subjects');
        this.items = data.subjects;
        this.loaded = true;
        return this.items;
      } catch (err) {
        this.error = errorMessage(err);
        return this.items;
      } finally {
        this.loading = false;
      }
    },
    /**
     * 按科目代码取科目名称，找不到时回退为代码本身。
     * @param code 科目代码
     * @returns 科目名称
     */
    nameOf(code: string): string {
      return this.items.find((s) => s.code === code)?.name ?? code;
    },
    /**
     * 按科目代码取章节列表，找不到时返回空数组。
     * @param code 科目代码
     * @returns 章节列表
     */
    chaptersOf(code: string) {
      return this.items.find((s) => s.code === code)?.chapters ?? [];
    },
  },
});
