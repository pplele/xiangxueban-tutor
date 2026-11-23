<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE, errorMessage, get, getAccessToken, getUsername } from '@/api/client';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';

/** 单节课：文件标识、名称与大小（MB） */
interface Lesson {
  file: string;
  name: string;
  sizeMb: number;
}
/** 课程单元：单元序号、标题与下的课程列表 */
interface Unit {
  unit: number;
  title: string;
  lessons: Lesson[];
}

const loading = ref(true);
const error = ref('');
const units = ref<Unit[]>([]);
const openUnit = ref(1);
const activeFile = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);

/** 播放进度记录：位置、总时长与更新时间戳 */
interface Prog {
  pos: number;
  dur: number;
  updatedAt: number;
}
/** 播放进度：{ file: Prog }，本地按用户隔离；看到 95% 算完成 */
const progress = ref<Record<string, Prog>>({});

/** 当前用户的进度 localStorage key，按用户名隔离 */
function progressKey(): string {
  return `vocab:course:${getUsername() || 'anon'}`;
}

/** 从 localStorage 读取进度表，解析失败回退为空对象 */
function readProgress(): Record<string, Prog> {
  try {
    return JSON.parse(localStorage.getItem(progressKey()) || '{}');
  } catch {
    return {};
  }
}

/** 合并写入进度表到 localStorage：合并磁盘已有记录，避免覆盖其它标签页的新进度 */
function writeProgress() {
  try {
    // 合并写：同时开了两个标签页时，不要把另一页刚记的进度覆盖掉
    const disk = readProgress();
    localStorage.setItem(progressKey(), JSON.stringify({ ...disk, ...progress.value }));
  } catch {
    /* 存不进去不影响播放 */
  }
}

/** 把所有单元课程拍平成一维列表，并附带所属单元标题与序号 */
const flatLessons = computed(() => units.value.flatMap((u) => u.lessons.map((l) => ({ ...l, unitTitle: u.title, unit: u.unit }))));
/** 当前课程在拍平列表中的下标 */
const activeIndex = computed(() => flatLessons.value.findIndex((l) => l.file === activeFile.value));
/** 当前课程对象 */
const activeLesson = computed(() => flatLessons.value[activeIndex.value] ?? null);
/** 上一节课（存在时） */
const prevLesson = computed(() => (activeIndex.value > 0 ? flatLessons.value[activeIndex.value - 1] : null));
/** 下一节课（存在时） */
const nextLesson = computed(() =>
  activeIndex.value >= 0 && activeIndex.value < flatLessons.value.length - 1 ? flatLessons.value[activeIndex.value + 1] : null,
);

/** 该课是否看完：播放比例达到 95% */
function isDone(file: string): boolean {
  const p = progress.value[file];
  return Boolean(p && p.dur > 0 && p.pos / p.dur >= 0.95);
}

/** 该课是否为当前播放课 */
function isCurrent(file: string): boolean {
  return file === activeFile.value;
}

/** 统计课程列表中已看完的节数 */
function doneCount(list: Lesson[]): number {
  return list.filter((l) => isDone(l.file)).length;
}

/** 全部课程中已看完的总节数 */
const totalDone = computed(() => doneCount(flatLessons.value));

/** video 标签带不了 Authorization 头，token 走 query（后端 /vocab/course/stream 手动校验） */
/** 当前课程的视频流地址：query 携带 file 与 token（video 标签无法带 Authorization 头） */
const streamUrl = computed(() =>
  activeFile.value
    ? `${API_BASE}/vocab/course/stream?file=${encodeURIComponent(activeFile.value)}&token=${encodeURIComponent(getAccessToken() || '')}`
    : '',
);

/** 切换课程：先刷出上一课进度，再切换到目标文件 */
function selectLesson(file: string) {
  flushProgress();
  activeFile.value = file;
}

/** 展开指定单元 */
function selectUnit(unit: number) {
  openUnit.value = unit;
}

/** 上次保存进度的时间戳，用于 3 秒节流 */
let lastSave = 0;

/**
 * video timeupdate 回调：把当前播放位置写进进度表（3 秒节流；接近结尾时不节流）。
 */
function onTimeUpdate() {
  const v = videoEl.value;
  if (!v || !activeFile.value || !Number.isFinite(v.currentTime) || !v.duration) return;
  const ratio = v.currentTime / v.duration;
  const now = Date.now();
  if (now - lastSave < 3000 && ratio < 0.95) return;
  lastSave = now;
  progress.value[activeFile.value] = { pos: v.currentTime, dur: v.duration, updatedAt: now };
  writeProgress();
}

/** 立即把当前播放位置刷入进度表（切课/暂停/卸载时调用） */
function flushProgress() {
  const v = videoEl.value;
  if (!v || !activeFile.value || !Number.isFinite(v.currentTime) || !v.duration) return;
  progress.value[activeFile.value] = { pos: v.currentTime, dur: v.duration, updatedAt: Date.now() };
  writeProgress();
}

/**
 * video loadedmetadata 回调：有历史进度且不在开头/结尾附近时从上次位置续播。
 */
function onLoadedMetadata() {
  const v = videoEl.value;
  const rec = progress.value[activeFile.value];
  if (v && rec && rec.pos > 15 && rec.pos < rec.dur - 15) v.currentTime = rec.pos;
}

/** 切换到上一节课 */
function goPrev() {
  if (prevLesson.value) selectLesson(prevLesson.value.file);
}

/** 切换到下一节课 */
function goNext() {
  if (nextLesson.value) selectLesson(nextLesson.value.file);
}

/**
 * 把秒数格式化成 m:ss。
 * @param sec 秒数
 * @returns 形如 3:05 的时间字符串
 */
function fmtPos(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 加载课程目录 GET /vocab/course/list 与本地进度，并定位到最近观看或第一课 */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await get<{ units: Unit[] }>('/vocab/course/list');
    units.value = res.units;
    progress.value = readProgress();

    // 默认续播「最近看的那一课」，没看过就从 Unit 1 第一课开始
    let lastFile = '';
    let lastAt = 0;
    for (const [file, p] of Object.entries(progress.value)) {
      if (p.updatedAt > lastAt) {
        lastAt = p.updatedAt;
        lastFile = file;
      }
    }
    const start = flatLessons.value.find((l) => l.file === lastFile) ?? flatLessons.value[0];
    if (start) {
      activeFile.value = start.file;
      openUnit.value = start.unit;
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/** 页面关闭前刷出进度，避免丢失最后几秒 */
function onBeforeUnload() {
  flushProgress();
}

/** 挂载后加载数据并监听 beforeunload 保存进度 */
onMounted(() => {
  load();
  window.addEventListener('beforeunload', onBeforeUnload);
});

/** 卸载前刷出进度并移除 beforeunload 监听 */
onBeforeUnmount(() => {
  flushProgress();
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <div>
    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error && !units.length" :message="error" @retry="load" />

    <div v-else class="course-layout">
      <!-- 左：目录 -->
      <aside class="course-side card">
        <div class="side-head">
          <b>课程目录</b>
          <span class="side-progress">{{ totalDone }} / {{ flatLessons.length }} 已看完</span>
        </div>
        <div class="unit-list">
          <div v-for="u in units" :key="u.unit" class="unit">
            <button class="unit-head" :class="{ open: openUnit === u.unit }" type="button" @click="selectUnit(u.unit)">
              <span class="unit-title">{{ u.title }}</span>
              <span class="unit-count" :class="{ all: doneCount(u.lessons) === u.lessons.length }">
                {{ doneCount(u.lessons) }}/{{ u.lessons.length }}
              </span>
            </button>
            <ul v-if="openUnit === u.unit" class="lesson-list">
              <li v-for="l in u.lessons" :key="l.file">
                <button
                  class="lesson"
                  :class="{ cur: isCurrent(l.file), done: isDone(l.file) }"
                  type="button"
                  @click="selectLesson(l.file)"
                >
                  <span class="lesson-check">{{ isDone(l.file) ? '✓' : '' }}</span>
                  <span class="lesson-name">{{ l.name }}</span>
                  <span class="lesson-size">{{ l.sizeMb }}M</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
      </aside>

      <!-- 右：播放器 -->
      <section class="course-main card">
        <template v-if="activeLesson">
          <div class="player-head">
            <div class="player-title">
              <span class="player-unit">{{ activeLesson.unitTitle }}</span>
              <b>{{ activeLesson.name }}</b>
              <span v-if="isDone(activeLesson.file)" class="done-chip">已看完</span>
              <span
                v-else-if="progress[activeLesson.file]?.pos > 60"
                class="resume-chip"
              >上次看到 {{ fmtPos(progress[activeLesson.file].pos) }}</span>
            </div>
            <div class="player-nav">
              <button class="btn btn-sm" type="button" :disabled="!prevLesson" @click="goPrev">上一课</button>
              <button class="btn btn-sm" type="button" :disabled="!nextLesson" @click="goNext">下一课</button>
            </div>
          </div>
          <video
            :key="activeFile"
            ref="videoEl"
            class="player"
            :src="streamUrl"
            controls
            playsinline
            preload="metadata"
            @timeupdate="onTimeUpdate"
            @loadedmetadata="onLoadedMetadata"
            @pause="flushProgress"
          />
          <p class="player-tip">
            拖动进度条、倍速都支持；关掉页面再回来，会从上次的位置接着播。
          </p>
        </template>
        <p v-else class="muted-note">请从左侧目录选择一课开始。</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.course-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}
@media (max-width: 900px) {
  .course-layout {
    grid-template-columns: 1fr;
  }
}
.course-side {
  padding: 10px 12px;
  max-height: calc(100vh - 140px);
  overflow-y: auto;
}
.side-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 6px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 13.5px;
}
.side-progress {
  font-size: 12px;
  color: var(--muted);
}
.unit {
  margin-top: 6px;
}
.unit-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 0;
  background: transparent;
  padding: 9px 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13.5px;
  color: var(--ink);
}
.unit-head:hover {
  background: var(--panel-soft);
}
.unit-head.open {
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-weight: 600;
}
.unit-count {
  font-size: 11.5px;
  color: var(--muted);
}
.unit-count.all {
  color: #2f7d52;
  font-weight: 600;
}
.lesson-list {
  list-style: none;
  margin: 2px 0 6px;
  padding: 0 0 0 6px;
  border-left: 2px solid var(--line);
}
.lesson {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  padding: 6px 8px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--ink-2);
  text-align: left;
}
.lesson:hover {
  background: var(--panel-soft);
}
.lesson.cur {
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-weight: 600;
}
.lesson.done .lesson-name {
  color: var(--muted);
}
.lesson-check {
  width: 14px;
  flex: none;
  color: #2f7d52;
  font-size: 12px;
  font-weight: 700;
}
.lesson-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lesson-size {
  flex: none;
  font-size: 11px;
  color: var(--muted);
}
.course-main {
  padding: 14px 16px 12px;
}
.player-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.player-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14.5px;
}
.player-unit {
  background: var(--panel-soft);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--ink-2);
  padding: 2px 9px;
}
.done-chip {
  background: #dff2e6;
  color: #1e5a3c;
  border-radius: 999px;
  font-size: 11.5px;
  padding: 2px 9px;
}
.resume-chip {
  background: #fdf1cc;
  color: #6b4d0d;
  border-radius: 999px;
  font-size: 11.5px;
  padding: 2px 9px;
}
.player-nav {
  display: flex;
  gap: 8px;
}
.player {
  width: 100%;
  max-height: calc(100vh - 260px);
  min-height: 320px;
  background: #101418;
  border-radius: 12px;
  display: block;
}
.player-tip {
  margin-top: 10px;
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
