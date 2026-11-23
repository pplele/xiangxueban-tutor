<script setup lang="ts">
import { computed } from 'vue';
import { renderRich } from '@/lib/rich';

/** props：text 为待渲染的 Markdown/公式文本，class 为透传到根元素的样式类 */
const props = defineProps<{ text?: string | null; class?: string }>();
/** 用 renderRich 把文本安全渲染成 HTML，供 v-html 输出 */
const html = computed(() => renderRich(props.text ?? ''));
</script>

<template>
  <div class="rich" :class="$props.class" v-html="html"></div>
</template>
