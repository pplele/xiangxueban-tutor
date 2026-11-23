<script setup lang="ts">
import { computed } from 'vue';
import { useUserStore } from '@/stores/user';

/** 统一头像：emoji / 上传图片 / 首字母兜底。size 传数字像素。 */
/** props：size 头像边长像素（默认 34），头像内容来自 user store */
const props = withDefaults(defineProps<{ size?: number }>(), { size: 34 });
const user = useUserStore();

/** 头像容器行内样式：按 size 设置宽高与字号（大尺寸字更小） */
const boxStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  fontSize: `${Math.round(props.size * (props.size >= 50 ? 0.44 : 0.5))}px`,
}));
/** emoji 头像的背景色行内样式；图片头像返回空对象 */
const emojiStyle = computed(() => {
  const a = user.avatar;
  return a?.type === 'emoji' ? { background: a.bg } : {};
});
</script>

<template>
  <div class="ua" :class="{ 'ua-image': user.avatar?.type === 'image' }" :style="[boxStyle, emojiStyle]">
    <img v-if="user.avatar?.type === 'image' && user.avatarUrl" :src="user.avatarUrl" alt="头像" />
    <span v-else-if="user.avatar?.type === 'emoji'">{{ user.avatar.value }}</span>
    <span v-else>{{ user.initial }}</span>
  </div>
</template>

<style scoped>
.ua {
  border-radius: 50%;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  overflow: hidden;
  font-family: var(--serif);
  line-height: 1;
  user-select: none;
}
.ua-image {
  background: var(--accent-soft);
}
.ua img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
