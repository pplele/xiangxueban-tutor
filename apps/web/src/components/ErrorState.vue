<script setup lang="ts">
/** 通用错误占位：message 错误文案，retryable 是否显示重试按钮（默认显示） */
defineProps<{ message?: string; retryable?: boolean }>();
/** 点击重试按钮时触发 */
defineEmits<{ (e: 'retry'): void }>();
</script>

<template>
  <div class="error-state fade-up">
    <div class="error-mark">!</div>
    <h4>出了点问题</h4>
    <p>{{ message || '请稍后重试' }}</p>
    <button v-if="retryable !== false" class="btn btn-sm" type="button" @click="$emit('retry')">重试</button>
  </div>
</template>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 42px 20px;
  text-align: center;
}
.error-mark {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--danger-soft);
  color: var(--danger);
  font-family: var(--serif);
  font-size: 20px;
  font-weight: 700;
}
.error-state h4 {
  font-size: 16px;
}
.error-state p {
  margin: 0 0 6px;
  color: var(--muted);
  font-size: 13px;
  max-width: 460px;
}
</style>
