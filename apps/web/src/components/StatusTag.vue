<script setup lang="ts">
import { computed } from 'vue';

/** props：status 为状态/判定码（用于取色与默认文案），label 为自定义展示文案 */
const props = defineProps<{ status?: string | null; label?: string }>();

/** 状态码到标签配色类（tag-amber/blue/green/red）的映射 */
const TONE: Record<string, string> = {
  待变式: 'tag-amber',
  待复习: 'tag-blue',
  已生成变式: 'tag-green',
  queued: 'tag-amber',
  running: 'tag-blue',
  done: 'tag-green',
  failed: 'tag-red',
  correct: 'tag-green',
  partial: 'tag-amber',
  wrong: 'tag-red',
  self_pass: 'tag-green',
  self_partial: 'tag-amber',
  self_fail: 'tag-red',
};

/** 状态码到中文默认文案的映射 */
const LABEL: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  failed: '失败',
  correct: '正确',
  partial: '部分正确',
  wrong: '错误',
  self_pass: '已掌握',
  self_partial: '部分掌握',
  self_fail: '未掌握',
};

/** 当前状态的配色类 */
const tone = computed(() => TONE[props.status ?? ''] ?? '');
/** 展示文案：优先自定义 label，其次状态码默认文案，再回退状态码本身，最后「未知」 */
const text = computed(() => props.label ?? LABEL[props.status ?? ''] ?? props.status ?? '未知');
</script>

<template>
  <span class="tag" :class="tone">
    <span class="status-dot" />{{ text }}
  </span>
</template>
