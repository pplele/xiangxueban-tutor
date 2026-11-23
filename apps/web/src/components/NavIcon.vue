<script setup lang="ts">
/** 图标组件：name 为内置图标名（未匹配时显示圆点兜底），size 为像素尺寸（默认 18） */
defineProps<{ name: string; size?: number }>();
</script>

<template>
  <svg
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'chat'">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.7L3 21l1.8-5.3A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z" />
    </template>
    <template v-else-if="name === 'book'">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      <path d="M8.5 7h7" />
    </template>
    <template v-else-if="name === 'exam'">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h5" />
    </template>
    <template v-else-if="name === 'profile'">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </template>
    <template v-else-if="name === 'eval'">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </template>
    <template v-else-if="name === 'word'">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M8 16.5 10.6 8l2.6 8.5M9 13.8h3.3" />
    </template>
    <template v-else-if="name === 'spark'">
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
      <path d="M19 16.5 19.7 18.3 21.5 19l-1.8.7L19 21.5l-.7-1.8L16.5 19l1.8-.7Z" />
    </template>
    <template v-else-if="name === 'arrow-right'">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'arrow-left'">
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </template>
    <template v-else-if="name === 'send'">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </template>
    <template v-else-if="name === 'logout'">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m4 12.5 5 5L20 6.5" />
    </template>
    <template v-else-if="name === 'x'">
      <path d="M6 6l12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'camera'">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </template>
    <template v-else-if="name === 'scan'">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M4 12h16" />
    </template>
    <template v-else-if="name === 'play'">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="m10.5 9 5 3-5 3Z" />
    </template>
    <template v-else-if="name === 'print'">
      <path d="M7 9V3.5h10V9M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
      <rect x="7" y="14" width="10" height="7" rx="1" />
      <path d="M7 17.5h10" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </template>
    <template v-else-if="name === 'note'">
      <path d="M5 3.5h9.5L19 8v12.5H5Z" />
      <path d="M14 3.5V8h5" />
      <path d="M8 12h8M8 15.5h8M8 19h5" />
    </template>
    <template v-else-if="name === 'edit'">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </template>
    <template v-else-if="name === 'volume'">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
    </template>
    <template v-else>
      <circle cx="12" cy="12" r="9" />
    </template>
  </svg>
</template>
