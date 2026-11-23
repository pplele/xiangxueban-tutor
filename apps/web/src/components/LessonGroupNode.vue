<script setup lang="ts">
// 递归目录节点组件：课程 → 类别 → 模块 → 章节 → 视频
/** 视频条目：文件标识、名称与大小（MB） */
interface Video { file: string; name: string; sizeMb: number }
/** 目录分组：名称、路径、子分组、视频列表与条目计数 */
interface Group { name: string; path: string; children: Group[]; videos: Video[]; count: number }

/** props：node 当前节点、depth 层级、activeFile 当前播放文件、openMap 展开状态、isDone/fmtSize 工具回调 */
const props = defineProps<{
  node: Group;
  depth: number;
  activeFile: string;
  openMap: Record<string, boolean>;
  isDone: (f: string) => boolean;
  fmtSize: (m: number) => string;
}>();
/** emits：toggle 展开/折叠某分组，select 选中某视频文件 */
const emit = defineEmits<{
  toggle: [path: string];
  select: [file: string];
}>();

/** 该分组是否展开：openMap 中未显式记为 false 即视为展开 */
function isOpen(): boolean {
  return props.openMap[props.node.path] !== false;
}
</script>

<template>
  <div class="tree-node" :style="{ '--depth': depth }">
    <button class="group-head" type="button" @click="emit('toggle', node.path)">
      <span class="chev" :class="{ open: isOpen() }">▸</span>
      <span class="group-name" :title="node.name">{{ node.name }}</span>
      <span class="group-count">{{ node.count }}</span>
    </button>
    <div v-if="isOpen()" class="group-body">
      <button
        v-for="v in node.videos" :key="v.file"
        class="lesson"
        :class="{ cur: v.file === activeFile, done: isDone(v.file) }"
        type="button"
        @click="emit('select', v.file)"
      >
        <span class="lesson-check">{{ isDone(v.file) ? '✓' : '' }}</span>
        <span class="lesson-name" :title="v.name">{{ v.name }}</span>
        <span class="lesson-size">{{ fmtSize(v.sizeMb) }}</span>
      </button>
      <LessonGroupNode
        v-for="child in node.children" :key="child.path"
        :node="child" :depth="depth + 1" :active-file="activeFile"
        :open-map="openMap" :is-done="isDone" :fmt-size="fmtSize"
        @toggle="(p: string) => emit('toggle', p)"
        @select="(f: string) => emit('select', f)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-node { margin-left: calc(var(--depth) * 12px); }
.group-head { width: 100%; display: flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 7px 6px; border-radius: 7px; cursor: pointer; color: var(--ink); text-align: left; font-family: var(--sans); }
.group-head:hover { background: var(--panel-soft); }
.chev { font-size: 11px; color: var(--muted); transition: transform .15s ease; display: inline-block; }
.chev.open { transform: rotate(90deg); }
.group-name { flex: 1; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-count { font-size: 10.5px; color: var(--muted); background: var(--bg-deep); padding: 1px 6px; border-radius: 10px; }
.group-body { padding-left: 6px; }
.lesson { width: 100%; display: flex; align-items: center; gap: 7px; border: 0; background: transparent; padding: 6px 8px; border-radius: 7px; cursor: pointer; text-align: left; color: var(--ink-2); font-family: var(--sans); }
.lesson:hover { background: var(--panel-soft); }
.lesson.cur { background: var(--accent-soft); color: var(--accent-dark); font-weight: 600; }
.lesson.done { color: var(--muted); }
.lesson-check { width: 13px; flex: none; font-size: 11px; color: var(--accent); text-align: center; }
.lesson-name { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lesson-size { font-size: 10.5px; color: var(--muted); flex: none; }
</style>
