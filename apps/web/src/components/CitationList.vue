<script setup lang="ts">
import { computed } from 'vue';
import type { Citation } from '@tutor/shared';
import MathText from './MathText.vue';

/** props：citations 为回答引用的出处片段列表（可为空） */
const props = defineProps<{ citations?: Citation[] | null }>();
/** 引用列表，空值回退为空数组 */
const list = computed(() => props.citations ?? []);
/** 按出处名称分组，返回 [出处, 该出处片段数组] 的有序列表 */
const grouped = computed(() => {
  const map = new Map<string, Citation[]>();
  for (const c of list.value) {
    const key = c.sourceName || '未知出处';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  return [...map.entries()];
});
</script>

<template>
  <details v-if="list.length > 0" class="citations">
    <summary>
      <span class="cite-icon">引</span>
      参考出处 <span class="cite-count">{{ grouped.length }} 处 / {{ list.length }} 条</span>
    </summary>
    <div class="cite-body">
      <div v-for="[source, items] in grouped" :key="source" class="cite-group">
        <div class="cite-source">
          <span class="tag tag-mono">{{ source }}</span>
          <span class="small muted">{{ items.length }} 个片段</span>
        </div>
        <div v-for="(item, idx) in items" :key="idx" class="cite-item">
          <MathText :text="item.content" class="cite-rich" />
          <div class="cite-meta small muted">
            <span v-if="item.chapter">章节：{{ item.chapter }}</span>
            <span v-if="item.kpCodes?.length">考点：{{ item.kpCodes.join('、') }}</span>
            <span v-if="typeof item.score === 'number'">相关度：{{ item.score.toFixed(3) }}</span>
          </div>
        </div>
      </div>
    </div>
  </details>
</template>

<style scoped>
.citations {
  margin-top: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  overflow: hidden;
}
summary {
  cursor: pointer;
  padding: 9px 13px;
  font-size: 12.5px;
  color: var(--ink-2);
  display: flex;
  align-items: center;
  gap: 8px;
  user-select: none;
  list-style: none;
}
summary::-webkit-details-marker {
  display: none;
}
summary::after {
  content: "▾";
  margin-left: auto;
  color: var(--muted);
  transition: transform 0.2s ease;
}
.citations[open] summary::after {
  transform: rotate(180deg);
}
.cite-icon {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-family: var(--serif);
  font-size: 11px;
  font-weight: 700;
}
.cite-count {
  color: var(--muted);
  font-size: 11.5px;
}
.cite-body {
  border-top: 1px solid var(--line);
  padding: 4px 13px 12px;
  max-height: 360px;
  overflow-y: auto;
}
.cite-group {
  padding-top: 10px;
}
.cite-source {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.cite-item {
  border-left: 2px solid var(--line-strong);
  padding: 2px 0 2px 10px;
  margin: 7px 0;
}
.cite-rich {
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.7;
  max-height: 150px;
  overflow-y: auto;
  padding-right: 4px;
}
.cite-item .cite-rich p {
  margin: 0 0 4px;
}
.cite-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
}
</style>
