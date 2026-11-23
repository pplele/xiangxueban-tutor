<script setup lang="ts">
/**
 * 打印/导出 PDF 的通用外壳。
 * 用 Teleport 把打印内容挂到 body 末尾，配合 @media print 只显示 .print-paper，
 * 从而在浏览器「打印 → 另存为 PDF」时得到干净的文档（中文 + KaTeX 公式都能正常渲染）。
 * 使用方通过默认 slot 传入打印内容；variant 决定纸张的排版预设。
 */
import NavIcon from './NavIcon.vue';

withDefaults(
  defineProps<{
    open: boolean;
    /** compact=错题本密集排版；exam=标准试卷排版 */
    variant?: 'compact' | 'exam';
    title?: string;
  }>(),
  { variant: 'compact', title: '打印' },
);

/** emits：close 关闭打印外壳 */
const emit = defineEmits<{ close: [] }>();

/** 调起浏览器打印窗口（配合 @media print 输出干净 PDF） */
function doPrint() {
  window.print();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="print-overlay">
      <div class="print-toolbar no-print">
        <div class="pt-info">
          <strong>{{ title }}</strong>
          <span class="pt-hint">在打印窗口中选择「另存为 PDF」即可保存文件</span>
        </div>
        <div class="pt-actions">
          <button class="btn btn-sm" type="button" @click="emit('close')">关闭</button>
          <button class="btn btn-sm btn-primary" type="button" @click="doPrint">
            <NavIcon name="print" :size="15" /> 打印 / 另存为 PDF
          </button>
        </div>
      </div>
      <div class="print-scroll">
        <div class="print-paper" :class="'paper-' + variant">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.print-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  background: #4a4f4c;
}
.print-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.pt-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pt-info strong {
  font-size: 14px;
  color: var(--ink);
}
.pt-hint {
  font-size: 12px;
  color: var(--muted);
}
.pt-actions {
  display: flex;
  gap: 8px;
}
.print-scroll {
  flex: 1;
  overflow: auto;
  padding: 24px 0 60px;
}
.print-paper {
  width: 210mm;
  min-height: 297mm;
  margin: 0 auto;
  padding: 18mm 16mm;
  background: #fff;
  color: #111;
  box-shadow: 0 8px 30px rgb(0 0 0 / 35%);
  font-family: var(--sans);
}
</style>

<!-- 打印样式必须非 scoped：要选中应用根节点 #app（Teleport 的打印容器在它之外） -->
<style>
@media print {
  @page {
    size: A4 portrait;
    margin: 16mm 15mm;
  }
  html,
  body {
    background: #fff !important;
  }
  /* 应用根节点整块隐藏；打印内容 Teleport 在 #app 之外，单独显示 */
  #app {
    display: none !important;
  }
  .print-overlay {
    position: static !important;
    display: block !important;
    background: #fff !important;
  }
  .print-toolbar.no-print {
    display: none !important;
  }
  .print-scroll {
    overflow: visible !important;
    padding: 0 !important;
  }
  .print-paper {
    width: auto !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    box-shadow: none !important;
  }
}
</style>
