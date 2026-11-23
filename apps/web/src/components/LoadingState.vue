<script setup lang="ts">
/** 加载占位：text 提示文案（默认「加载中…」），inline 是否行内显示（默认块级） */
withDefaults(defineProps<{ text?: string; inline?: boolean }>(), { text: '加载中…', inline: false });
</script>

<template>
  <div v-if="!inline" class="loading-block">
    <span class="spinner" />
    <span>{{ text }}</span>
  </div>
  <span v-else class="inline-loading"><span class="spinner" /> {{ text }}</span>
</template>

<style scoped>
.inline-loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}
</style>
