<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { API_BASE, errorMessage, get, getAccessToken, getUsername } from '@/api/client';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import LessonGroupNode from '@/components/LessonGroupNode.vue';

interface Video {
  file: string;
  name: string;
  sizeMb: number;
}
interface Group {
  name: string;
  path: string;
  children: Group[];
  videos: Video[];
  count: number;
}
interface Course {
  id: string;
  name: string;
  stage: number;
  subject: string;
  tagline: string;
  tone: string;
  count: number;
  totalMb: number;
  groups: Group[];
}

const loading = ref(true);
const error = ref('');
const courses = ref<Course[]>([]);
const activeCourse = ref('');
const activeFile = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);
const openNodes = ref<Record<string, boolean>>({});
const keyword = ref('');

/** 播放进度：{ file: { pos, dur, updatedAt } }，按用户本地隔离；看到 95% 算完成 */
interface Prog { pos: number; dur: number; updatedAt: number }
const progress = ref<Record<string, Prog>>({});

/**
 * 生成当前用户专属的播放进度本地存储键，未登录时用 anon 兜底。
 * @returns localStorage 键名
 */
function progressKey(): string {
  return `listen:course:${getUsername() || 'anon'}`;
}
/**
 * 从 localStorage 读取播放进度表，数据损坏时返回空对象。
 * @returns 视频文件到「播放位置 / 时长 / 更新时间」的映射
 */
function readProgress(): Record<string, Prog> {
  try { return JSON.parse(localStorage.getItem(progressKey()) || '{}'); } catch { return {}; }
}
/** 把内存中的播放进度合并写回 localStorage（保留其他用户的记录），失败不影响播放。 */
function writeProgress() {
  try {
    const disk = readProgress();
    localStorage.setItem(progressKey(), JSON.stringify({ ...disk, ...progress.value }));
  } catch { /* 存不进去不影响播放 */ }
}

/** 当前选中的课程对象。 */
const course = computed(() => courses.value.find((c) => c.id === activeCourse.value) ?? null);

/** 把课程树摊平成视频列表，供「上一节/下一节」用 */
function flatten(nodes: Group[]): Video[] {
  const out: Video[] = [];
  const walk = (list: Group[]) => {
    for (const n of list) {
      out.push(...n.videos);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
/** 当前课程摊平后的视频列表。 */
const flatVideos = computed(() => (course.value ? flatten(course.value.groups) : []));
/** 当前视频在摊平列表中的下标，未找到时为 -1。 */
const activeIndex = computed(() => flatVideos.value.findIndex((v) => v.file === activeFile.value));
/** 当前正在播放的视频对象。 */
const activeVideo = computed(() => flatVideos.value[activeIndex.value] ?? null);
/** 上一个视频；已是第一个时为 null。 */
const prevVideo = computed(() => (activeIndex.value > 0 ? flatVideos.value[activeIndex.value - 1] : null));
/** 下一个视频；已是最后一个时为 null。 */
const nextVideo = computed(() => (activeIndex.value >= 0 && activeIndex.value < flatVideos.value.length - 1 ? flatVideos.value[activeIndex.value + 1] : null));

/**
 * 判断某视频是否已完成：观看进度达到 95% 即视为完成。
 * @param file 视频文件标识
 * @returns 是否已完成
 */
function isDone(file: string): boolean {
  const p = progress.value[file];
  return Boolean(p && p.dur > 0 && p.pos / p.dur >= 0.95);
}
/**
 * 递归统计课程树中已完成的视频数。
 * @param nodes 课程分组节点列表
 * @returns 已完成视频数
 */
function countDone(nodes: Group[]): number {
  let n = 0;
  const walk = (list: Group[]) => { for (const x of list) { n += x.videos.filter((v) => isDone(v.file)).length; walk(x.children); } };
  walk(nodes);
  return n;
}
/** 当前课程已完成的视频数。 */
const totalDone = computed(() => (course.value ? countDone(course.value.groups) : 0));

/** 每门课的完成数 / 百分比，供三阶段卡展示 */
function courseDone(c: Course): number {
  return countDone(c.groups);
}
/**
 * 计算某门课的完成百分比。
 * @param c 课程对象
 * @returns 0~100 的百分比整数
 */
function coursePct(c: Course): number {
  return c.count ? Math.round((courseDone(c) / c.count) * 100) : 0;
}
/**
 * 判定某门课在卡片上的状态：无内容 / 已完成 / 学习中 / 未开始。
 * @param c 课程对象
 * @returns 状态标识
 */
function courseState(c: Course): 'done' | 'doing' | 'todo' | 'empty' {
  if (!c.count) return 'empty';
  if (courseDone(c) >= c.count) return 'done';
  if (courseDone(c) > 0) return 'doing';
  return 'todo';
}

/** 全流程总进度 */
const overall = computed(() => {
  const total = courses.value.reduce((s, c) => s + c.count, 0);
  const done = courses.value.reduce((s, c) => s + courseDone(c), 0);
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
});
/** 全部课程的总体积（MB）。 */
const totalSize = computed(() => courses.value.reduce((s, c) => s + c.totalMb, 0));

/**
 * 判断课程树节点的展开状态；有搜索关键词时强制展开，便于看到匹配结果。
 * @param path 节点路径
 * @returns 是否展开
 */
function isOpen(path: string): boolean {
  if (keyword.value.trim()) return true;
  return openNodes.value[path] !== false;
}
/**
 * 切换课程树节点的展开/收起状态，点击分组标题时触发。
 * @param path 节点路径
 */
function toggleNode(path: string) { openNodes.value[path] = !isOpen(path); }

/**
 * 按关键词在课程树中模糊匹配视频名（不区分大小写）。
 * @param nodes 课程分组节点列表
 * @returns 匹配的视频列表；关键词为空时返回空数组
 */
function matchedVideos(nodes: Group[]): Video[] {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return [];
  return flatten(nodes).filter((v) => v.name.toLowerCase().includes(q));
}

/**
 * 拼接带 token 的视频流地址，供 <video> 直接播放。
 * @returns 当前视频的流 URL；未选视频时为空串
 */
const streamUrl = computed(() =>
  activeFile.value
    ? `${API_BASE}/lessons/stream?file=${encodeURIComponent(activeFile.value)}&token=${encodeURIComponent(getAccessToken() || '')}`
    : '',
);

/**
 * 选择要播放的视频，点击视频项或上一节/下一节时触发。
 * 切换前先 flushProgress 把当前播放位置落盘。
 * @param file 目标视频文件标识
 */
function selectVideo(file: string) {
  flushProgress();
  activeFile.value = file;
}
/**
 * 切换课程，点击课程卡片时触发。
 * 先落盘当前进度，再按本地记录续播该课程最近看过的视频，没有记录则从第一节开始。
 * @param id 目标课程 ID
 */
function selectCourse(id: string) {
  if (id === activeCourse.value) return;
  flushProgress();
  activeCourse.value = id;
  activeFile.value = '';
  keyword.value = '';
  const c = courses.value.find((x) => x.id === id);
  if (!c) return;
  const list = flatten(c.groups);
  let lastFile = ''; let lastAt = 0;
  for (const [file, p] of Object.entries(progress.value)) {
    if (list.some((v) => v.file === file) && p.updatedAt > lastAt) { lastAt = p.updatedAt; lastFile = file; }
  }
  const start = list.find((v) => v.file === lastFile) ?? list[0];
  if (start) activeFile.value = start.file;
}

let lastSave = 0;
/**
 * <video> timeupdate 事件：周期性记录播放进度。
 * 每 3 秒最多落盘一次（看到 95% 时立即记录），进度合并写入 localStorage 以便下次续播。
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
/** 立即把当前播放位置写入进度表并落盘；切换视频、切换课程或页面卸载前调用。 */
function flushProgress() {
  const v = videoEl.value;
  if (!v || !activeFile.value || !Number.isFinite(v.currentTime) || !v.duration) return;
  progress.value[activeFile.value] = { pos: v.currentTime, dur: v.duration, updatedAt: Date.now() };
  writeProgress();
}
/**
 * <video> loadedmetadata 事件：元数据加载完成后跳回上次观看位置（距首尾 15 秒内不跳，避免卡在片头片尾）。
 */
function onLoadedMetadata() {
  const v = videoEl.value;
  const rec = progress.value[activeFile.value];
  if (v && rec && rec.pos > 15 && rec.pos < rec.dur - 15) v.currentTime = rec.pos;
}
/** 上一节按钮处理器：切到摊平列表中的前一个视频。 */
function goPrev() { if (prevVideo.value) selectVideo(prevVideo.value.file); }
/** 下一节按钮处理器：切到摊平列表中的后一个视频。 */
function goNext() { if (nextVideo.value) selectVideo(nextVideo.value.file); }
/**
 * 把秒数格式化为 m:ss，用于播放器时间显示。
 * @param sec 秒数
 * @returns 时间文本
 */
function fmtPos(sec: number): string {
  const m = Math.floor(sec / 60); const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
/**
 * 把体积（MB）格式化为易读文案，超过 1024MB 显示为 G。
 * @param mb 体积，单位 MB
 * @returns 体积文案
 */
function fmtSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`;
}
/**
 * 把阶段序号转成展示标签，90 以上视为拓展阶段。
 * @param n 阶段序号
 * @returns 阶段标签
 */
function stageLabel(n: number): string {
  return n < 90 ? `第 ${n} 阶段` : '拓展';
}

/**
 * 页面数据加载，组件挂载后调用。
 * 调用 GET /lessons/courses 拉取课程树并读取本地进度；默认续播最近看过的那门课及其视频，没看过则选第一个有内容的课程。
 */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await get<{ courses: Course[] }>('/lessons/courses');
    courses.value = res.courses;
    progress.value = readProgress();
    let lastFile = ''; let lastAt = 0;
    for (const [file, p] of Object.entries(progress.value)) {
      if (p.updatedAt > lastAt) { lastAt = p.updatedAt; lastFile = file; }
    }
    // 默认续播「最近看过的那一课」所属课程，没看过就选第一阶段
    const owner = res.courses.find((c) => flatten(c.groups).some((v) => v.file === lastFile));
    const startCourse = owner ?? res.courses.find((c) => c.count > 0) ?? res.courses[0];
    if (startCourse) {
      activeCourse.value = startCourse.id;
      const list = flatten(startCourse.groups);
      const start = list.find((v) => v.file === lastFile) ?? list[0];
      if (start) activeFile.value = start.file;
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}
/** 页面关闭/刷新前把当前播放进度落盘，避免丢失续播位置。 */
function onBeforeUnload() { flushProgress(); }
/** 组件挂载：加载课程数据，并注册 beforeunload 监听用于离开前保存进度。 */
onMounted(() => { load(); window.addEventListener('beforeunload', onBeforeUnload); });
/** 组件卸载：落盘当前进度并移除 beforeunload 监听。 */
onBeforeUnmount(() => { flushProgress(); window.removeEventListener('beforeunload', onBeforeUnload); });
</script>

<template>
  <div class="listen-page">
    <header class="page-head">
      <div>
        <div class="eyebrow">三阶段 · 系统备考</div>
        <h1>全套学习流程</h1>
        <p class="sub">数学打底 → 英语攻坚 → 词汇收口，按顺序跟着视频走完一轮</p>
      </div>
      <div v-if="!loading && overall.total" class="head-stat">
        <span class="stat-num">{{ overall.done }}</span><span class="stat-sep">/</span><span class="stat-den">{{ overall.total }}</span>
        <span class="stat-label">节已看完</span>
      </div>
    </header>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error && !courses.length" :message="error" @retry="load" />

    <template v-else>
      <!-- 全流程总进度 -->
      <div v-if="overall.total" class="overall-card card">
        <div class="overall-left">
          <span class="overall-title">整体进度</span>
          <span class="overall-detail">{{ courses.length }} 门课 · {{ overall.total }} 节 · 约 {{ fmtSize(totalSize) }}</span>
        </div>
        <div class="overall-right">
          <div class="overall-track"><span :style="{ width: overall.pct + '%' }" /></div>
          <b class="overall-pct">{{ overall.pct }}%</b>
        </div>
      </div>

      <!-- 三阶段流程卡 -->
      <div v-if="courses.length" class="stage-flow">
        <button
          v-for="(c, i) in courses" :key="c.id"
          class="stage-card card"
          :class="[`tone-${c.tone}`, { active: c.id === activeCourse, 'is-empty': !c.count }]"
          type="button"
          @click="selectCourse(c.id)"
        >
          <span v-if="i < courses.length - 1" class="flow-arrow" aria-hidden="true">→</span>
          <div class="stage-top">
            <span class="stage-no">{{ c.stage < 90 ? String(c.stage).padStart(2, '0') : '＋' }}</span>
            <span class="stage-subject">{{ c.subject }}</span>
            <span class="stage-state" :class="courseState(c)">
              {{ courseState(c) === 'done' ? '已完成' : courseState(c) === 'doing' ? '学习中' : courseState(c) === 'empty' ? '整理中' : '未开始' }}
            </span>
          </div>
          <div class="stage-name">{{ c.name }}</div>
          <p class="stage-tagline">{{ c.tagline || '按目录顺序跟着视频学完即可' }}</p>
          <div class="stage-meta">
            <span>{{ c.count }} 节课时</span>
            <span v-if="c.totalMb">约 {{ fmtSize(c.totalMb) }}</span>
          </div>
          <div class="stage-progress">
            <div class="stage-bar"><span :style="{ width: coursePct(c) + '%' }" /></div>
            <span class="stage-pct">{{ courseDone(c) }} / {{ c.count }}</span>
          </div>
          <span class="stage-cta">{{ c.id === activeCourse ? '正在学习' : '进入学习' }} <span aria-hidden="true">↗</span></span>
        </button>
      </div>

      <!-- 无视频（还在下载）时的空态 -->
      <div v-if="course && !course.count" class="card empty-course">
        <div class="empty-icon"><span>▶</span></div>
        <h3>{{ course.name }}正在整理中</h3>
        <p class="muted">课程视频还在下载，稍后再来看看。已下载的课时会自动出现在这里。</p>
      </div>

      <div v-else-if="course" class="listen-layout">
        <!-- 左：多级目录 -->
        <aside class="course-side card">
          <div class="side-head">
            <b>{{ course.name }} · 课程目录</b>
            <span class="side-progress">{{ totalDone }} / {{ flatVideos.length }}</span>
          </div>
          <div class="search-box">
            <span class="search-ico">⌕</span>
            <input v-model="keyword" type="search" placeholder="搜课时名称…" aria-label="搜索课时" />
          </div>

          <div v-if="keyword.trim()" class="search-results">
            <p v-if="!matchedVideos(course.groups).length" class="no-result">没有匹配的课时</p>
            <button
              v-for="v in matchedVideos(course.groups)" :key="v.file"
              class="search-item" :class="{ cur: v.file === activeFile, done: isDone(v.file) }"
              type="button" @click="selectVideo(v.file)"
            >{{ isDone(v.file) ? '✓ ' : '' }}{{ v.name }}</button>
          </div>

          <div v-else class="tree">
            <LessonGroupNode
              v-for="g in course.groups" :key="g.path"
              :node="g" :depth="0"
              :active-file="activeFile"
              :open-map="openNodes"
              :is-done="isDone"
              :fmt-size="fmtSize"
              @toggle="toggleNode"
              @select="selectVideo"
            />
          </div>

          <div v-if="flatVideos.length" class="side-foot">
            <div class="overall-bar"><span :style="{ width: (totalDone / flatVideos.length * 100) + '%' }" /></div>
            <span class="muted small">完成 {{ Math.round(totalDone / flatVideos.length * 100) }}%</span>
          </div>
        </aside>

        <!-- 右：播放器 -->
        <section class="course-main card">
          <template v-if="activeVideo">
            <div class="player-head">
              <div class="player-title">
                <span class="player-course">{{ stageLabel(course.stage) }} · {{ course.name }}</span>
                <b>{{ activeVideo.name }}</b>
                <span v-if="isDone(activeVideo.file)" class="done-chip">已看完</span>
                <span v-else-if="progress[activeVideo.file]?.pos > 60" class="resume-chip">
                  上次看到 {{ fmtPos(progress[activeVideo.file].pos) }}
                </span>
              </div>
              <div class="player-nav">
                <button class="btn btn-sm" type="button" :disabled="!prevVideo" @click="goPrev">上一节</button>
                <span class="nav-pos">{{ activeIndex + 1 }} / {{ flatVideos.length }}</span>
                <button class="btn btn-sm" type="button" :disabled="!nextVideo" @click="goNext">下一节</button>
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
              <span class="tip-dot" />支持拖动进度条与倍速；关掉页面再回来，会从上次的位置接着播。
            </p>
          </template>
          <div v-else class="player-placeholder">
            <div class="ph-play">▶</div>
            <p>从左侧目录选择一节开始学习</p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.listen-page { max-width: 1240px; margin: 0 auto; }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 16px; }
.eyebrow { font-size: 11.5px; letter-spacing: .12em; color: var(--accent); font-weight: 600; margin-bottom: 4px; }
.page-head h1 { font-size: 23px; letter-spacing: .02em; }
.sub { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.head-stat { display: flex; align-items: baseline; gap: 3px; color: var(--ink); white-space: nowrap; }
.stat-num { font-size: 26px; font-weight: 700; color: var(--accent); line-height: 1; }
.stat-sep, .stat-den { font-size: 15px; color: var(--muted); }
.stat-label { margin-left: 6px; font-size: 12px; color: var(--muted); }

/* 整体进度条 */
.overall-card { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 18px; margin-bottom: 14px; flex-wrap: wrap; }
.overall-left { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.overall-title { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.overall-detail { font-size: 12px; color: var(--muted); }
.overall-right { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 180px; max-width: 420px; }
.overall-track { flex: 1; height: 7px; background: var(--bg-deep); border-radius: 6px; overflow: hidden; }
.overall-track span { display: block; height: 100%; background: var(--accent); border-radius: 6px; transition: width .35s ease; }
.overall-pct { font-size: 14px; color: var(--accent-dark); min-width: 38px; text-align: right; }

/* 三阶段流程卡 */
.stage-flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-bottom: 18px; }
@media (max-width: 920px) { .stage-flow { grid-template-columns: 1fr; gap: 14px; } }
.stage-card {
  position: relative; text-align: left; cursor: pointer; padding: 16px 16px 14px;
  border: 1px solid var(--line); border-radius: 14px; background: var(--panel);
  transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
  display: flex; flex-direction: column; min-height: 208px; font-family: var(--sans);
}
.stage-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.stage-card.active { border-color: var(--tone-main); box-shadow: 0 0 0 2px var(--tone-soft), var(--shadow); }
.flow-arrow {
  position: absolute; right: -18px; top: 50%; transform: translateY(-50%);
  font-size: 17px; color: var(--line-strong); z-index: 2; pointer-events: none;
}
@media (max-width: 920px) { .flow-arrow { display: none; } }
.tone-math { --tone-main: var(--blue); --tone-soft: var(--blue-soft); }
.tone-english { --tone-main: var(--terra); --tone-soft: var(--terra-soft); }
.tone-word { --tone-main: var(--accent); --tone-soft: var(--accent-soft); }
.tone-extra { --tone-main: var(--amber); --tone-soft: var(--amber-soft); }
.stage-top { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; }
.stage-no { font-size: 12px; font-weight: 700; color: var(--tone-main); background: var(--tone-soft); padding: 2px 8px; border-radius: 7px; letter-spacing: .04em; }
.stage-subject { font-size: 11.5px; color: var(--muted); }
.stage-state { margin-left: auto; font-size: 10.5px; padding: 2px 7px; border-radius: 20px; background: var(--bg-deep); color: var(--muted); }
.stage-state.done { background: var(--accent-soft); color: var(--accent-dark); }
.stage-state.doing { background: var(--amber-soft); color: var(--amber); }
.stage-state.empty { background: var(--amber-soft); color: var(--amber); }
.stage-card.active .stage-state.todo { background: var(--tone-soft); color: var(--tone-main); }
.stage-name { font-size: 17px; font-weight: 700; color: var(--ink); line-height: 1.3; }
.stage-tagline { margin: 6px 0 12px; font-size: 12px; color: var(--muted); line-height: 1.55; flex: 1; }
.stage-meta { display: flex; gap: 12px; font-size: 11.5px; color: var(--ink-2); margin-bottom: 9px; }
.stage-meta span { display: inline-flex; align-items: center; gap: 4px; }
.stage-progress { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.stage-bar { flex: 1; height: 5px; background: var(--bg-deep); border-radius: 4px; overflow: hidden; }
.stage-bar span { display: block; height: 100%; background: var(--tone-main); border-radius: 4px; transition: width .3s ease; }
.stage-pct { font-size: 11px; color: var(--muted); white-space: nowrap; }
.stage-cta { font-size: 11.5px; font-weight: 600; color: var(--tone-main); }
.stage-card.is-empty { opacity: .78; }
.stage-card.is-empty .stage-name { color: var(--ink-2); }

.empty-course { text-align: center; padding: 60px 20px; }
.empty-icon { width: 62px; height: 62px; margin: 0 auto 16px; border-radius: 18px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
.empty-icon span { font-size: 22px; margin-left: 3px; }
.empty-course h3 { font-size: 17px; margin-bottom: 6px; }
.empty-course p { margin: 0; font-size: 13px; }

.listen-layout { display: grid; grid-template-columns: 320px minmax(0,1fr); gap: 16px; align-items: start; }
@media (max-width: 920px) { .listen-layout { grid-template-columns: 1fr; } }

.course-side { padding: 10px 12px; max-height: calc(100vh - 190px); overflow-y: auto; }
.side-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 6px 10px; border-bottom: 1px solid var(--line); font-size: 13.5px; }
.side-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-progress { font-size: 12px; color: var(--muted); flex: none; }
.search-box { position: relative; margin: 10px 4px; }
.search-box .search-ico { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 17px; line-height: 1; }
.search-box input { width: 100%; padding: 7px 10px 7px 28px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); color: var(--ink); font-size: 12.5px; outline: none; font-family: var(--sans); }
.search-box input:focus { border-color: var(--accent); }
.search-results { padding: 4px; }
.search-item { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 8px 10px; border-radius: 7px; font-size: 12.5px; color: var(--ink-2); cursor: pointer; font-family: var(--sans); }
.search-item:hover { background: var(--panel-soft); }
.search-item.cur { background: var(--accent-soft); color: var(--accent-dark); font-weight: 600; }
.search-item.done { color: var(--muted); }
.no-result { text-align: center; color: var(--muted); font-size: 12px; padding: 14px 0; }

.tree { padding: 4px 0; }
.side-foot { display: flex; align-items: center; gap: 8px; padding: 10px 6px 4px; margin-top: 6px; border-top: 1px solid var(--line); }
.overall-bar { flex: 1; height: 5px; background: var(--bg-deep); border-radius: 4px; overflow: hidden; }
.overall-bar span { display: block; height: 100%; background: var(--accent); border-radius: 4px; transition: width .3s ease; }

.course-main { padding: 16px; }
.player-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.player-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.player-course { font-size: 11.5px; color: var(--muted); background: var(--bg-deep); padding: 2px 8px; border-radius: 20px; }
.player-title b { font-size: 15px; overflow-wrap: anywhere; }
.done-chip { font-size: 11px; padding: 2px 8px; border-radius: 20px; background: var(--accent-soft); color: var(--accent-dark); }
.resume-chip { font-size: 11px; padding: 2px 8px; border-radius: 20px; background: var(--amber-soft); color: var(--amber); }
.player-nav { display: flex; align-items: center; gap: 6px; }
.nav-pos { font-size: 11.5px; color: var(--muted); padding: 0 2px; white-space: nowrap; }
.player { width: 100%; aspect-ratio: 16 / 9; background: #101a18; border-radius: 10px; display: block; }
.player-tip { margin: 10px 2px 0; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.tip-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex: none; }
.player-placeholder { min-height: 380px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--muted); gap: 12px; }
.ph-play { width: 60px; height: 60px; border-radius: 50%; display: grid; place-items: center; background: var(--bg-deep); color: var(--ink-2); font-size: 20px; padding-left: 4px; }
.player-placeholder p { margin: 0; font-size: 13px; }
</style>
