<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { del, errorMessage, get, getUsername, patch, post } from '@/api/client';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import NavIcon from '@/components/NavIcon.vue';
import VocabCourse from '@/components/VocabCourse.vue';
import { buildMemoryBody, normalizeMemoryBody, type MemoryDraft } from '@/lib/memory';

type Mark = 'green' | 'yellow' | 'red';
type Zone = 'green' | 'yellow' | 'red' | 'new';

interface BoardWord {
  id: number;
  word: string;
  phonetic: string;
  meaning: string;
  kind: string;
  zone: Zone;
}

interface Round {
  id: string;
  roundNo: number;
  total: number;
  green: number;
  yellow: number;
  red: number;
  startedAt: string;
  finishedAt: string;
}

/** 未提交的选词草稿：切到别的页面（组件卸载）或刷新后要能原样回来 */
interface Draft {
  roundNo: number;
  scope: 'word' | 'all';
  marks: [number, Mark][];
  orderIds: number[];
  startedAt: string;
  savedAt: number;
}

/** 草稿有效期：超过 12 小时认为上一轮的练习已经过期，从头开始 */
const DRAFT_TTL = 12 * 60 * 60 * 1000;

/**
 * 生成当前用户专属的本地草稿键名，未登录时用 anon 兜底。
 * @returns localStorage 中存放草稿的键
 */
function draftKey(): string {
  return `vocab:draft:${getUsername() || 'anon'}`;
}

/** 删除当前用户的本地草稿；隐私模式下 localStorage 不可用时静默忽略。 */
function clearDraft() {
  try {
    localStorage.removeItem(draftKey());
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

/**
 * 读取并校验本地草稿；结构损坏或超过 12 小时有效期则清除并返回 null。
 * @returns 有效的草稿对象，或 null
 */
function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (!d || !Array.isArray(d.marks) || !Array.isArray(d.orderIds)) return null;
    if (Date.now() - (d.savedAt ?? 0) > DRAFT_TTL) {
      clearDraft();
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

const tab = ref<'test' | 'history' | 'course' | 'essay' | 'collocation' | 'story'>('test');
const loading = ref(true);
const error = ref('');

const words = ref<BoardWord[]>([]);
const roundNo = ref(1);
const lastRound = ref<Round | null>(null);
const includePhrases = ref(false);

// 本轮标记：点 1 下绿、2 下黄、3 下红；不点 = 保留上一轮原区（首次出现的词算红）
const marks = ref(new Map<number, Mark>());
const startedAt = ref(new Date().toISOString());
const submitting = ref(false);
const result = ref<Round | null>(null);

const order = ref<BoardWord[]>([]);
const popup = ref<{ x: number; y: number; word: BoardWord } | null>(null);
/** 本次进入页面从草稿里恢复的标记数，用于顶部提示 */
const restoredCount = ref(0);

const rounds = ref<Round[]>([]);
const detail = ref<{ round: Round; items: { wordId: number; word: string; meaning: string; zone: string; state: string }[] } | null>(null);

// ---------- 我的作文：英语作文存档 ----------
interface Essay {
  id: string;
  title: string;
  prompt: string;
  genre: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 文体选项：对应库课笔记第七章「写作上（应用文）/ 写作下（提纲·图画·图表）」 */
const GENRES = ['应用文', '提纲作文', '图画作文', '图表作文', '议论文', '其它'];

const essays = ref<Essay[]>([]);
const essayLoading = ref(false);
const essaySaving = ref(false);
const essayError = ref('');
/** 正在修改的作文 id，空串表示新建 */
const editingId = ref('');
/** 列表里展开全文的作文 id */
const expandedId = ref('');
const essayForm = reactive({ title: '', prompt: '', genre: '其它', body: '' });

/**
 * 统计英文单词数（只数连续字母词，忽略标点与中文）。
 * @param text 作文正文
 * @returns 单词数
 */
function wordCount(text: string): number {
  return (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
}

/** 表单里的实时字数 */
const essayWordCount = computed(() => wordCount(essayForm.body));

/**
 * 列表里的正文摘要：压成一行、最多 140 字，查看全文时不用。
 * @param e 作文
 * @returns 摘要文本
 */
function essayExcerpt(e: Essay): string {
  const flat = e.body.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

/** 清空表单并退出编辑态。 */
function resetEssayForm() {
  editingId.value = '';
  essayForm.title = '';
  essayForm.prompt = '';
  essayForm.genre = '其它';
  essayForm.body = '';
}

/** 调用 GET /vocab/essays 拉取当前学生的全部作文。 */
async function loadEssays() {
  essayLoading.value = true;
  essayError.value = '';
  try {
    const res = await get<{ essays: Essay[] }>('/vocab/essays');
    essays.value = res.essays;
  } catch (err) {
    essayError.value = errorMessage(err);
  } finally {
    essayLoading.value = false;
  }
}

/** 切到「我的作文」标签并加载列表。 */
async function openEssay() {
  tab.value = 'essay';
  await loadEssays();
}

/**
 * 把某篇作文载入表单准备修改。
 * @param e 目标作文
 */
function editEssay(e: Essay) {
  editingId.value = e.id;
  essayForm.title = e.title;
  essayForm.prompt = e.prompt;
  essayForm.genre = GENRES.includes(e.genre) ? e.genre : '其它';
  essayForm.body = e.body;
  essayError.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 新建或保存修改：标题与正文必填，成功后清空表单并刷新列表。 */
async function saveEssay() {
  if (essaySaving.value) return;
  const title = essayForm.title.trim();
  const body = essayForm.body.trim();
  if (!title) {
    essayError.value = '先给作文写个标题';
    return;
  }
  if (!body) {
    essayError.value = '作文正文不能为空';
    return;
  }
  essaySaving.value = true;
  essayError.value = '';
  try {
    const payload = {
      title,
      prompt: essayForm.prompt,
      genre: essayForm.genre,
      body,
      tags: [] as string[],
    };
    if (editingId.value) await patch(`/vocab/essays/${editingId.value}`, payload);
    else await post('/vocab/essays', payload);
    resetEssayForm();
    await loadEssays();
  } catch (err) {
    essayError.value = errorMessage(err);
  } finally {
    essaySaving.value = false;
  }
}

/**
 * 删除一篇作文（先确认，删除后若正在编辑它则清空表单）。
 * @param e 目标作文
 */
async function removeEssay(e: Essay) {
  if (!window.confirm(`删除《${e.title}》？此操作不可撤销。`)) return;
  try {
    await del(`/vocab/essays/${e.id}`);
    if (editingId.value === e.id) resetEssayForm();
    await loadEssays();
  } catch (err) {
    essayError.value = errorMessage(err);
  }
}

/** 本轮实际参与测试的词：按「是否连短语一起测」决定是否过滤掉短语。 */
const testWords = computed(() => (includePhrases.value ? words.value : words.value.filter((w) => w.kind === 'word')));
/** 短语条数（考纲 3000 词不含短语，但固定搭配在选择题里高频，单独提示） */
const phraseCount = computed(() => words.value.filter((w) => w.kind === 'phrase').length);
/** 当前已标记（点过）的词数。 */
const markedCount = computed(() => marks.value.size);
/** 当前被标为「熟悉」（绿）的词数。 */
const greenCount = computed(() => [...marks.value.values()].filter((v) => v === 'green').length);
/** 当前被标为「模糊」（黄）的词数。 */
const yellowCount = computed(() => [...marks.value.values()].filter((v) => v === 'yellow').length);
/** 当前被标为「遗忘」（红）的词数。 */
const redCount = computed(() => [...marks.value.values()].filter((v) => v === 'red').length);
/** 不点会保留原区，这里提示有多少词不用管 */
const untouchedCount = computed(() => testWords.value.length - marks.value.size);

const ZONES: { key: Zone; label: string; hint: string }[] = [
  { key: 'green', label: '熟悉区', hint: '上轮点 1 下' },
  { key: 'yellow', label: '模糊区', hint: '上轮点 2 下' },
  { key: 'red', label: '遗忘区', hint: '上轮点 3 下 / 新词' },
  { key: 'new', label: '新词区', hint: '还没测过' },
];

/**
 * 把打乱后的词按所在区域分组并过滤空区域，供页面分区渲染。
 * @returns 含区域元信息与词列表的分组数组
 */
const groups = computed(() =>
  ZONES.map((z) => ({ ...z, items: order.value.filter((w) => w.zone === z.key) })).filter((g) => g.items.length > 0),
);

/** 是否存在上一轮留下的分区结果（用于控制「按区域分组」提示的显示）。 */
const hasZone = computed(() => words.value.some((w) => w.zone !== 'new'));

/**
 * 用 Fisher-Yates 算法打乱数组，返回新数组，不修改入参。
 * @param arr 待打乱的数组
 * @returns 打乱顺序后的新数组
 */
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 按当前测试范围重新打乱词的展示顺序。 */
function rebuildOrder() {
  order.value = shuffle(testWords.value);
}

/** 把当前选词顺手存草稿，切页面/刷新回来不用重选 */
function saveDraft() {
  try {
    const draft: Draft = {
      roundNo: roundNo.value,
      scope: includePhrases.value ? 'all' : 'word',
      marks: [...marks.value.entries()],
      orderIds: order.value.map((w) => w.id),
      startedAt: startedAt.value,
      savedAt: Date.now(),
    };
    localStorage.setItem(draftKey(), JSON.stringify(draft));
  } catch {
    /* 存不进去不影响当前这一轮 */
  }
}

/** 用户点「清空重来」：丢掉草稿，重新打乱 */
function discardDraft() {
  clearDraft();
  marks.value = new Map();
  restoredCount.value = 0;
  startedAt.value = new Date().toISOString();
  rebuildOrder();
}

/** 只重排不丢选词，顺序也要一起存进草稿 */
function reshuffle() {
  rebuildOrder();
  saveDraft();
}

/**
 * 加载词表并初始化本轮测试，组件挂载后调用，提交后进入下一轮也复用本函数。
 * 请求 GET /vocab/board 拉取词表与轮次；若本地草稿属于同一轮且测试范围一致，则恢复标记与顺序，否则清除草稿。
 */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const board = await get<{ words: BoardWord[]; lastRound: Round | null; nextRoundNo: number }>('/vocab/board');
    words.value = board.words;
    lastRound.value = board.lastRound;
    roundNo.value = board.nextRoundNo;
    marks.value = new Map();
    result.value = null;
    restoredCount.value = 0;
    startedAt.value = new Date().toISOString();

    // 同一个用户、同一轮、同一范围（含不含短语）才恢复，避免串到别的轮次
    const draft = readDraft();
    const sameRound = draft && draft.roundNo === board.nextRoundNo;
    if (draft && sameRound) includePhrases.value = draft.scope === 'all';

    rebuildOrder();

    if (draft && sameRound) {
      const byId = new Map(board.words.map((w) => [w.id, w]));
      const keep = draft.marks.filter(([id]) => byId.has(id));
      const restoredOrder = draft.orderIds.map((id) => byId.get(id)).filter((w): w is BoardWord => Boolean(w));
      // 词表有增删时，把没进顺序表的新词补到末尾，保证每个词都能点到
      const seen = new Set(restoredOrder.map((w) => w.id));
      const scopeWords = includePhrases.value ? board.words : board.words.filter((w) => w.kind === 'word');
      for (const w of scopeWords) if (!seen.has(w.id)) restoredOrder.push(w);
      if (restoredOrder.length) order.value = restoredOrder;
      if (keep.length) {
        marks.value = new Map(keep);
        startedAt.value = draft.startedAt || startedAt.value;
      }
      restoredCount.value = keep.length;
      saveDraft(); // 刷新时间戳，延长草稿有效期
    } else {
      clearDraft();
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/**
 * 查询某个词当前被标记的颜色。
 * @param w 目标词
 * @returns 标记值；未标记返回 null
 */
function markOf(w: BoardWord): Mark | null {
  return marks.value.get(w.id) ?? null;
}

/** 单词卡片的颜色类。合并成一次查找，5000 词铺屏时少一半 Map 查询 */
function wordClass(w: BoardWord): string {
  const m = marks.value.get(w.id);
  return m ? 'w-' + m : 'w-gray';
}

/** 单击循环：无标记 → 绿 → 黄 → 红 → 无标记（无标记 = 保留上一轮原区，不用逐个点） */
function onClick(w: BoardWord) {
  if (result.value) return;
  const cur = markOf(w);
  if (cur === null) marks.value.set(w.id, 'green');
  else if (cur === 'green') marks.value.set(w.id, 'yellow');
  else if (cur === 'yellow') marks.value.set(w.id, 'red');
  else marks.value.delete(w.id);
  saveDraft();
}

/** 切换「连短语一起测」：只重排，不动已选（短语是单词的超集，标记仍然有效） */
function onScopeChange(e: Event) {
  includePhrases.value = (e.target as HTMLInputElement).checked;
  rebuildOrder();
  saveDraft();
}

let popupHideTimer: number | null = null;
/** 右键取词后延迟朗读的计时器（避开 Chrome cancel→speak 静音） */
let popupSpeakTimer: number | null = null;

/**
 * 右键单词时在鼠标附近弹出释义浮层，并把坐标限制在视口内防止溢出。
 * @param e 右键鼠标事件，用于取坐标
 * @param w 目标词
 */
function openPopup(e: MouseEvent, w: BoardWord) {
  if (popupHideTimer) window.clearTimeout(popupHideTimer);
  popupHideTimer = null;
  const width = 300;
  const height = 170;
  popup.value = {
    x: Math.min(e.clientX, window.innerWidth - width - 12),
    y: Math.min(e.clientY + 8, window.innerHeight - height - 12),
    word: w,
  };
  // 右击弹出释义的同时把这个词读出来；延迟 60ms 避开浏览器「cancel 后立即 speak 静音」
  if (popupSpeakTimer) window.clearTimeout(popupSpeakTimer);
  popupSpeakTimer = window.setTimeout(() => {
    popupSpeakTimer = null;
    speak(w.word, -1);
  }, 60);
}

/** 立即关闭释义浮层，并清除可能存在的延迟隐藏计时器。 */
function closePopup() {
  if (popupHideTimer) window.clearTimeout(popupHideTimer);
  popupHideTimer = null;
  popup.value = null;
}

/** 鼠标一移开单词就隐藏释义；留一点延迟方便把鼠标移到弹层上继续看 */
function hidePopupSoon() {
  if (popupHideTimer) window.clearTimeout(popupHideTimer);
  popupHideTimer = window.setTimeout(() => {
    popup.value = null;
    popupHideTimer = null;
  }, 180);
}

/** 鼠标移入释义浮层时取消延迟隐藏，避免正在阅读时浮层突然消失。 */
function keepPopup() {
  if (popupHideTimer) window.clearTimeout(popupHideTimer);
  popupHideTimer = null;
}

/**
 * 提交本轮测试处理器，点击「提交本轮」按钮时触发。
 * 调用 POST /vocab/rounds 保存掌握状态；允许全部不点（保留原区），成功后清除草稿并展示结果弹窗。
 */
async function submit() {
  // 允许一个都不点直接提交：此时全部词保留原本区域（后端按上一轮结果回填）
  if (submitting.value) return;
  submitting.value = true;
  error.value = '';
  try {
    const states = [...marks.value.entries()].map(([wordId, state]) => ({ wordId, state }));
    const res = await post<{ round: Round }>('/vocab/rounds', {
      states,
      startedAt: startedAt.value,
      scope: includePhrases.value ? 'all' : 'word',
    });
    result.value = res.round;
    rounds.value = [];
    tab.value = 'test';
    restoredCount.value = 0;
    clearDraft();
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}

/** 进入下一轮：复用 load 重新拉取词板，并重置标记、结果与草稿。 */
async function nextRound() {
  await load();
}

/** 切到「我的记录」标签，并调用 GET /vocab/rounds 拉取历次测试轮次。 */
async function openHistory() {
  tab.value = 'history';
  detail.value = null;
  try {
    const res = await get<{ rounds: Round[] }>('/vocab/rounds');
    rounds.value = res.rounds;
  } catch (err) {
    error.value = errorMessage(err);
  }
}

/**
 * 打开某一轮的明细弹窗，调用 GET /vocab/rounds/:id 获取逐词结果。
 * @param r 要查看的轮次
 */
async function openDetail(r: Round) {
  try {
    detail.value = await get(`/vocab/rounds/${r.id}`);
  } catch (err) {
    error.value = errorMessage(err);
  }
}

/**
 * 把 ISO 时间格式化为 YYYY-MM-DD HH:mm，用于记录列表展示。
 * @param iso 时间字符串
 * @returns 格式化后的时间；无法解析时返回空串
 */
function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 从当前轮明细中按掌握状态筛选词条（熟悉 / 模糊 / 遗忘）。
 * @param state 状态值（green / yellow / red）
 * @returns 该状态下的词条列表
 */
function detailByState(state: string) {
  return (detail.value?.items ?? []).filter((i) => i.state === state);
}


// ---------- 背搭配：模仿不背单词的卡片模式（与单词测试拆开） ----------
interface CollocationCard {
  /** 内置为 vocab_words.id（正数），自建为 -user_collocations.id（负数） */
  id: number;
  word: string;
  meaning: string;
  exampleEn: string;
  exampleZh: string;
  status: string;
  seen: number;
  /** true=自己添加的搭配，可删除 */
  custom: boolean;
}
interface CollocationStats {
  total: number;
  newCount: number;
  learning: number;
  known: number;
  studied: number;
}
type CardFilter = 'all' | 'new' | 'learning' | 'known';

const collCards = ref<CollocationCard[]>([]);
const collStats = ref<CollocationStats | null>(null);
const collLoading = ref(false);
const collError = ref('');
/** 当前卡片下标（在过滤后的队列里） */
const collIndex = ref(0);
/** 是否已翻到背面（看释义/例句/翻译） */
const collFlipped = ref(false);
/** 筛选：全部 / 未学 / 模糊 / 已掌握 */
const collFilter = ref<CardFilter>('all');
/** 是否乱序 */
const collShuffle = ref(false);
/** 打乱用的顺序（卡片 id 数组） */
const collOrder = ref<number[]>([]);
/** 本轮已过卡片数（用于进度展示） */
const collRoundDone = ref(0);
/** 浏览器是否支持语音合成 */
const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
/** 当前正在朗读的卡片 id */
const speakingId = ref<number | null>(null);

// ---------- 背搭配：搜索 + 自建搭配 ----------
/** 搜索词：空格分词，全部命中才算匹配（AND），大小写不敏感 */
const collQuery = ref('');
const collKeywords = computed(() =>
  collQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean),
);
/** 短语、中文释义、英文例句、例句翻译一起搜 */
const collSearchScope = computed<CollocationCard[]>(() => {
  const kws = collKeywords.value;
  if (!kws.length) return collCards.value;
  return collCards.value.filter((c) => {
    const hay = [c.word, c.meaning, c.exampleEn, c.exampleZh].join(' ').toLowerCase();
    return kws.every((k) => hay.includes(k));
  });
});
/** 搜索词一变就回到第一张，避免下标越界看着像空卡片 */
watch(collKeywords, () => {
  collIndex.value = 0;
  collFlipped.value = false;
  collRoundDone.value = 0;
  speakingId.value = null;
});

/** 自建搭配表单 */
const collFormOpen = ref(false);
const collFormSaving = ref(false);
const collFormError = ref('');
const collForm = reactive({ word: '', meaning: '', exampleEn: '', exampleZh: '' });

/** 按搜索 + 筛选 + 乱序得到当前卡片队列 */
const collQueue = computed(() => {
  let list = collSearchScope.value;
  if (collFilter.value !== 'all') list = list.filter((c) => c.status === collFilter.value);
  if (collShuffle.value) {
    const map = new Map(list.map((c) => [c.id, c]));
    list = collOrder.value.map((id) => map.get(id)).filter((c): c is CollocationCard => Boolean(c));
  }
  return list;
});
const collCurrent = computed<CollocationCard | null>(() => collQueue.value[collIndex.value] ?? null);
const collProgressPct = computed(() => {
  if (!collQueue.value.length) return 0;
  return Math.round(((collIndex.value + 1) / collQueue.value.length) * 100);
});

/** 调用 GET /vocab/collocations 拉取卡片与统计。 */
async function loadCollocations(keepIndex = false) {
  collLoading.value = true;
  collError.value = '';
  try {
    const res = await get<{ cards: CollocationCard[]; stats: CollocationStats }>('/vocab/collocations');
    collCards.value = res.cards;
    collStats.value = res.stats;
    if (collOrder.value.length !== res.cards.length) {
      const ids = res.cards.map((c) => c.id);
      collOrder.value = collShuffle.value ? shuffleIds(ids) : ids;
    }
    if (!keepIndex) {
      collIndex.value = 0;
      collFlipped.value = false;
      collRoundDone.value = 0;
    }
  } catch (err) {
    collError.value = errorMessage(err);
  } finally {
    collLoading.value = false;
  }
}

/** Fisher-Yates 洗牌，返回打乱后的 id 数组。 */
function shuffleIds(ids: number[]): number[] {
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 切到「背搭配」标签并首次加载。 */
async function openCollocation() {
  tab.value = 'collocation';
  if (!collCards.value.length) await loadCollocations();
}

/** 清空自建搭配表单 */
function resetCollForm() {
  collForm.word = '';
  collForm.meaning = '';
  collForm.exampleEn = '';
  collForm.exampleZh = '';
  collFormError.value = '';
}

/** 展开/收起自建搭配表单 */
function toggleCollForm() {
  collFormOpen.value = !collFormOpen.value;
  if (!collFormOpen.value) resetCollForm();
}

/** 保存一条自建搭配，成功后自动定位到这张卡片，马上就能背 */
async function saveCustomCollocation() {
  if (collFormSaving.value) return;
  const word = collForm.word.trim();
  if (!word) {
    collFormError.value = '先填搭配短语，比如 make a difference';
    return;
  }
  collFormSaving.value = true;
  collFormError.value = '';
  try {
    const card = await post<CollocationCard>('/vocab/collocations', {
      word,
      meaning: collForm.meaning.trim(),
      exampleEn: collForm.exampleEn.trim(),
      exampleZh: collForm.exampleZh.trim(),
    });
    resetCollForm();
    collFormOpen.value = false;
    await loadCollocations();
    // 用新短语当搜索词，列表里只会剩这一张，不用在 1000+ 条里找
    collQuery.value = card.word;
    collIndex.value = 0;
    collFlipped.value = false;
    collRoundDone.value = 0;
  } catch (err) {
    collFormError.value = errorMessage(err);
  } finally {
    collFormSaving.value = false;
  }
}

/** 删除当前自建搭配（内置搭配没有删除按钮） */
async function removeCustomCollocation() {
  const cur = collCurrent.value;
  if (!cur?.custom) return;
  if (!window.confirm(`删除自建搭配「${cur.word}」？这张卡会从背搭配里移除。`)) return;
  try {
    // 自建卡片 id 存的是负数，取绝对值才是数据库 id
    await del(`/vocab/collocations/${-cur.id}`);
    await loadCollocations();
  } catch (err) {
    collError.value = errorMessage(err);
  }
}

/** 切换筛选：重置到第一张并翻回正面。 */
function setCollFilter(f: CardFilter) {
  collFilter.value = f;
  collIndex.value = 0;
  collFlipped.value = false;
  collRoundDone.value = 0;
}

/** 切换乱序：开则打乱，关则恢复词表原序。 */
function reshuffleColl() {
  collShuffle.value = !collShuffle.value;
  collOrder.value = collShuffle.value
    ? shuffleIds(collCards.value.map((c) => c.id))
    : collCards.value.map((c) => c.id);
  collIndex.value = 0;
  collFlipped.value = false;
  collRoundDone.value = 0;
}

/** 翻卡：点击卡片正面显示背面，再点翻回。 */
function flipCard() {
  if (collCurrent.value) collFlipped.value = !collFlipped.value;
}

/** 用浏览器语音合成朗读英文（不背单词式点喇叭听发音）。 */
function speak(text: string, id: number) {
  if (!ttsSupported || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.85;
  u.pitch = 1;
  speakingId.value = id;
  u.onend = () => { speakingId.value = null; };
  u.onerror = () => { speakingId.value = null; };
  window.speechSynthesis.speak(u);
}

/** 标记当前卡片掌握状态，保存进度并自动进入下一张。 */
async function markCollocation(status: 'new' | 'learning' | 'known') {
  const cur = collCurrent.value;
  if (!cur) return;
  try {
    await post('/vocab/collocations/progress', { wordId: cur.id, status });
  } catch (err) {
    collError.value = errorMessage(err);
    return;
  }
  // 本地即时更新状态，无需整表重载
  const target = collCards.value.find((c) => c.id === cur.id);
  if (target) { target.status = status; target.seen += 1; }
  if (collStats.value) {
    if (status === 'known') { collStats.value.known += 1; collStats.value.learning = Math.max(0, collStats.value.learning - (cur.status === 'learning' ? 1 : 0)); }
    else if (status === 'learning') { collStats.value.learning += 1; }
    collStats.value.newCount = Math.max(0, collStats.value.newCount - (cur.status === 'new' ? 1 : 0));
    collStats.value.studied += 1;
  }
  collRoundDone.value += 1;
  collFlipped.value = false;
  // 若当前筛选下这张已不符合条件（如筛「未学」却标了认识），队列会缩短，注意下标
  if (collIndex.value >= collQueue.value.length - 1) collIndex.value = 0;
  else collIndex.value += 1;
}

/** 前进/后退一张（不写进度）。 */
function collStep(delta: number) {
  const len = collQueue.value.length;
  if (!len) return;
  collIndex.value = (collIndex.value + delta + len) % len;
  collFlipped.value = false;
  speakingId.value = null;
  if (ttsSupported) window.speechSynthesis.cancel();
}

/** 重置全部搭配学习进度（二次确认后执行）。 */
async function resetCollProgress() {
  if (!window.confirm('确定清空所有固定搭配的学习进度吗？此操作不可撤销。')) return;
  try {
    await post('/vocab/collocations/reset', {});
    await loadCollocations();
  } catch (err) {
    collError.value = errorMessage(err);
  }
}

// ---------- 单词趣味记忆：故事 / 谚语 / 近似词 + 每日复习打卡 ----------
type MemoryMode = 'story' | 'proverb' | 'similar';
interface WordStory {
  id: string;
  title: string;
  body: string;
  mode: MemoryMode;
  builtin: boolean;
  storyDate: string;
  createdAt: string;
  updatedAt: string;
  checkinCount: number;
  lastCheckin: string | null;
  checkedToday: boolean;
}
interface StoryStats {
  totalStories: number;
  totalCheckins: number;
  activeDays: number;
  streak: number;
  todayChecked: number;
  todayTotal: number;
}

/** 三种记忆模式的展示文案 */
interface MemoryModeMeta {
  key: MemoryMode;
  label: string;
  icon: string;
  desc: string;
  /** 新增表单里的格式引导（决定翻转/朗读能不能用上） */
  hint: string;
  /** 正文框占位示例 */
  placeholder: string;
  /** 一键填入的规范模板 */
  template: string;
}

const MEMORY_MODES: MemoryModeMeta[] = [
  {
    key: 'story',
    label: '故事',
    icon: '📖',
    desc: '把生词编进情节里，读一遍故事就记住一群词',
    hint: '用 **单词**（释义） 标出生词，## 写标题、**整行** 分幕；翻转会藏起括号里的中文',
    placeholder: '## 《我的新故事》\n**第一幕：房租与房东**\n把生词串进情节里，如 **suburb**（郊区）租了一间房…',
    template: [
      '## 《我的新故事》',
      '**第一幕：开场**',
      '在城市 **suburb**（郊区）租了一间 **private**（私人的）房间，房东很 **reasonable**（讲道理的）。',
      '**第二幕：转折**',
      '他每天背的词 **increase**（增加），娱乐时间 **decrease**（减少）。',
    ].join('\n'),
  },
  {
    key: 'proverb',
    label: '谚语',
    icon: '💡',
    desc: '经典英文谚语，用词库里的词，翻转自测词义',
    hint: '## 写英文原句，**单词**（释义） 标出词库词；「译：」「记：」开头的中文行翻转时会一起藏起来',
    placeholder: '## Practice makes perfect.\n**practice**（n. 练习） · **perfect**（adj. 完美的）\n译：熟能生巧。\n记：写作里可直接引用…',
    template: [
      '## Practice makes perfect.',
      '**practice**（n. 练习） · **perfect**（adj. 完美的）',
      '译：熟能生巧。',
      '记：想说"多练就会好"时用这句最地道；**practice** 是名词，动词写 **practise**。',
    ].join('\n'),
  },
  {
    key: 'similar',
    label: '近似',
    icon: '🔍',
    desc: '拼写/词义易混词分组，一看就分清（含同根词串记）',
    hint: '## 写易混词组，每个 **单词**（释义） 单独一行讲区别；「辨：」开头的中文行翻转时会一起藏起来',
    placeholder: '## peculiar / particular\n**peculiar**（adj. 独特的）—— 侧重"与众不同"。\n**particular**（adj. 讲究的）—— 侧重"某一个"。\n辨：be **particular** about 对……讲究。',
    template: [
      '## peculiar / particular',
      '**peculiar**（adj. 独特的；古怪的）—— 侧重"与众不同"，常带点怪。',
      '**particular**（adj. 特别的；讲究的）—— 侧重"某一个 / 挑剔"。',
      '辨：be **particular** about 对……讲究；**peculiar** to 为……特有。',
    ].join('\n'),
  },
];

/** 当前模式的展示与表单配置 */
const currentModeMeta = computed(() => MEMORY_MODES.find((m) => m.key === memoryMode.value) ?? MEMORY_MODES[0]);

const memoryMode = ref<MemoryMode>('story');
const storyList = ref<WordStory[]>([]);
const storyStats = ref<StoryStats | null>(null);
const storyLoading = ref(false);
const storyError = ref('');
const storyFormOpen = ref(false);
const editingStoryId = ref('');
const expandedStoryId = ref('');
const storyForm = reactive({ title: '', body: '', storyDate: '' });
const storySaving = ref(false);

// ---------- 标准填入：字段化输入，一键生成规范正文（谚语 / 近似） ----------
/** 标准填入的字段值；词条至少留一行 */
const draft = reactive<MemoryDraft>({
  headline: '',
  translation: '',
  note: '',
  pairs: [{ word: '', gloss: '' }],
});
/** 效果预览是否处于翻转（藏译文）状态 */
const previewHide = ref(false);

/** 新增一个词条输入行 */
function addDraftPair() {
  draft.pairs.push({ word: '', gloss: '' });
}

/** 删掉第 i 个词条行（至少保留一行） */
function removeDraftPair(i: number) {
  if (draft.pairs.length <= 1) return;
  draft.pairs.splice(i, 1);
}

/** 清空标准填入的所有字段 */
function resetDraft() {
  draft.headline = '';
  draft.translation = '';
  draft.note = '';
  draft.pairs.splice(0, draft.pairs.length, { word: '', gloss: '' });
}

/**
 * 把已有正文回填到标准填入面板，方便用字段方式改老记录。
 * 解析 ## 标题、译：、辨/记：、**词**（释义），解析不到就保持空白。
 * @param body 已有正文
 */
function fillDraftFromBody(body: string) {
  const pairs: { word: string; gloss: string }[] = [];
  let headline = '';
  let translation = '';
  let note = '';

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('## ')) {
      if (!headline) headline = line.slice(3).trim();
      continue;
    }
    const trans = line.match(/^译[：:]\s*(.*)$/);
    if (trans) {
      translation = trans[1].trim();
      continue;
    }
    const noteMatch = line.match(/^(辨|记)[：:]\s*(.*)$/);
    if (noteMatch) {
      note = noteMatch[2].trim();
      continue;
    }
    const pairRe = /\*\*([^*]+)\*\*（([^）]*)）/g;
    let m = pairRe.exec(line);
    while (m) {
      if (!pairs.some((p) => p.word === m![1])) pairs.push({ word: m[1], gloss: m[2] });
      m = pairRe.exec(line);
    }
  }

  draft.headline = headline;
  draft.translation = translation;
  draft.note = note;
  draft.pairs.splice(0, draft.pairs.length, ...(pairs.length ? pairs : [{ word: '', gloss: '' }]));
}

/** 预览用正文：按模式跑一遍规范化，所见即所存 */
const previewBody = computed(() => normalizeMemoryBody(storyForm.body, memoryMode.value));
/** 预览里的可朗读词数 */
const previewWordCount = computed(() => storyWordCount(previewBody.value));

/**
 * 把标准填入的字段拼成正文并写进正文框。
 * 缺关键字段时直接提示，避免存进一条"读不出、翻不动"的记录。
 */
function applyDraft() {
  const { body, error } = buildMemoryBody(memoryMode.value, draft);
  if (error || !body) {
    storyError.value = error ?? '生成失败，请检查填写内容';
    return;
  }
  const current = storyForm.body.trim();
  if (current && current !== body && !window.confirm('正文已有内容，生成会覆盖，继续吗？')) return;
  storyForm.body = body;
  if (!storyForm.title.trim()) storyForm.title = draft.headline.trim();
  storyError.value = '';
}
/** 已翻转（隐藏中文译文）的记录 id 集合 */
const flippedStories = ref<Record<string, boolean>>({});

// ---------- 记忆搜索：当前模式实时过滤 + 可勾选跨全部模式 ----------
const storyQuery = ref('');
const searchAllModes = ref(false);
const allModeStories = ref<WordStory[]>([]);
const allModesLoading = ref(false);

/** 搜索词：空格分词，全部命中才算匹配（AND），大小写不敏感 */
const storyKeywords = computed(() =>
  storyQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean),
);

/** 搜索范围：真正在搜索且勾了「含其他模式」才用三模式合并缓存，否则保持当前模式列表 */
const storyScope = computed<WordStory[]>(() =>
  searchAllModes.value && storyKeywords.value.length ? allModeStories.value : storyList.value,
);

/** 标题 + 正文一起搜：英文单词、中文释义、标题、谚语原句都能命中 */
const filteredStories = computed<WordStory[]>(() => {
  const kws = storyKeywords.value;
  const list = storyScope.value;
  if (!kws.length) return list;
  return list.filter((s) => {
    const hay = `${s.title}\n${s.body}`.toLowerCase();
    return kws.every((k) => hay.includes(k));
  });
});

/** 并发拉取三种模式（复用已有列表接口，顺带触发内置素材灌入，保证搜得到） */
async function loadAllModesForSearch() {
  if (allModesLoading.value || allModeStories.value.length) return;
  allModesLoading.value = true;
  try {
    const res = await Promise.all(
      MEMORY_MODES.map((m) =>
        get<{ stories: WordStory[]; stats: StoryStats }>(`/vocab/stories?mode=${m.key}`),
      ),
    );
    allModeStories.value = res.flatMap((r) => r.stories);
  } catch (err) {
    storyError.value = errorMessage(err);
  } finally {
    allModesLoading.value = false;
  }
}

/** 模式 key → 中文名 */
function modeLabel(mode: MemoryMode): string {
  return MEMORY_MODES.find((m) => m.key === mode)?.label ?? mode;
}

/** 标题命中词高亮：按原文切片后逐段转义，不破坏 HTML 实体也不引入注入 */
function highlightTitle(title: string): string {
  const kws = storyKeywords.value;
  if (!kws.length) return escapeStoryHtml(title);
  const pattern = new RegExp(
    `(${kws.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  let out = '';
  let last = 0;
  for (const m of title.matchAll(pattern)) {
    const i = m.index ?? 0;
    out += escapeStoryHtml(title.slice(last, i));
    out += `<mark class="story-hl">${escapeStoryHtml(m[0])}</mark>`;
    last = i + m[0].length;
  }
  return out + escapeStoryHtml(title.slice(last));
}

/** 取正文里第一个命中行做摘要，不展开也能知道词出现在哪句话 */
function matchSnippet(s: WordStory): string {
  const kws = storyKeywords.value;
  if (!kws.length) return '';
  const line = s.body
    .split('\n')
    .find((l) => kws.some((k) => l.toLowerCase().includes(k)) && !l.trim().startsWith('## '));
  if (!line) return '';
  return line.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim().slice(0, 110);
}

/** 从跨模式结果跳到所属模式并展开该条，回到正常列表即可打卡/编辑 */
async function gotoStoryMode(s: WordStory) {
  searchAllModes.value = false;
  storyQuery.value = '';
  if (memoryMode.value !== s.mode) await switchMemoryMode(s.mode);
  expandedStoryId.value = s.id;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 搜索时按需加载全模式数据，并自动展开第一条命中
watch([storyQuery, searchAllModes], async () => {
  if (searchAllModes.value && storyKeywords.value.length && !allModeStories.value.length) {
    await loadAllModesForSearch();
  }
  if (storyKeywords.value.length && filteredStories.value.length) {
    expandedStoryId.value = filteredStories.value[0].id;
  }
});

/** 本地日期 YYYY-MM-DD，用作新建故事默认日期 */
function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 切到「单词趣味记忆」标签并首次加载。 */
async function openStory() {
  tab.value = 'story';
  if (!storyList.value.length) await loadStories();
}

/** 切换记忆模式（故事/谚语/近似），重新拉取该模式数据。 */
async function switchMemoryMode(mode: MemoryMode) {
  if (memoryMode.value === mode) return;
  memoryMode.value = mode;
  resetStoryForm();
  flippedStories.value = {};
  expandedStoryId.value = '';
  storyList.value = [];
  await loadStories();
  // 切模式会触发该模式内置素材灌入，跨模式搜索缓存随之刷新，避免漏条目
  if (searchAllModes.value && storyKeywords.value.length) {
    allModeStories.value = [];
    await loadAllModesForSearch();
  }
}

/** 调用 GET /vocab/stories?mode= 拉取当前模式记录与复习统计。 */
async function loadStories() {
  storyLoading.value = true;
  storyError.value = '';
  const firstLoad = storyList.value.length === 0;
  try {
    const res = await get<{ stories: WordStory[]; stats: StoryStats }>(`/vocab/stories?mode=${memoryMode.value}`);
    storyList.value = res.stories;
    storyStats.value = res.stats;
    // 首次进入某模式时默认展开第一条，避免用户以为「没有内容」
    if (firstLoad && res.stories.length) expandedStoryId.value = res.stories[0].id;
  } catch (err) {
    storyError.value = errorMessage(err);
  } finally {
    storyLoading.value = false;
  }
}

/** 统计一篇故事里用 ** ** 标出的生词数。 */
function storyWordCount(body: string): number {
  return (body.match(/\*\*[^*]+\*\*/g) ?? []).length;
}

/** HTML 转义，v-html 渲染故事前先过一遍，防注入。 */
function escapeStoryHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 行内渲染：**词**（释义）→ 译文 span（翻转时直接渲染成 is-hidden，HTML 层面生效，不依赖父级 class）；
 * **词** → 可点击朗读的生词。
 * @param line 单行文本
 * @param hideGloss 是否隐藏中文译文
 */
function renderStoryInline(line: string, hideGloss: boolean): string {
  let h = line.replace(
    /\*\*([^*]+)\*\*（([^）]*)）/g,
    (_m, word: string, gloss: string) =>
      `<strong class="st-word" title="点击朗读">${word}</strong>` +
      `<span class="st-gloss${hideGloss ? ' is-hidden' : ''}">（${gloss}）</span>`,
  );
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong class="st-word" title="点击朗读">$1</strong>');
  return h;
}

/**
 * 把故事 markdown 渲染成安全 HTML。
 * 支持：## 标题、**整行** 作幕名、行内 **词**（释义）。
 * 标题与生词都带点击朗读；hideGloss 为真时译文直接渲染为隐藏态。
 * @param body 正文
 * @param hideGloss 是否藏起中文译文
 */
function renderStory(body: string, hideGloss = false): string {
  return body
    .split('\n')
    .map((raw) => {
      const line = escapeStoryHtml(raw).trim();
      if (!line) return '';
      if (line.startsWith('## ')) {
        return `<h3 class="st-title" title="点击朗读整句">${renderStoryInline(line.slice(3), hideGloss)}</h3>`;
      }
      // 「译：」「辨：」「记：」等整行中文说明，翻转时和括号释义一起藏起来（谚语/近似必备）
      if (/^(译|辨|记|例)[：:]/.test(line)) {
        return `<p class="st-p st-cn"><span class="st-gloss${hideGloss ? ' is-hidden' : ''}">${renderStoryInline(line, hideGloss)}</span></p>`;
      }
      if (/^\*\*[^*]+\*\*$/.test(line)) return `<div class="st-act">${renderStoryInline(line, hideGloss)}</div>`;
      return `<p class="st-p">${renderStoryInline(line, hideGloss)}</p>`;
    })
    .join('');
}

/** 翻转/复原某条记录的中文译文；藏译文时自动展开正文，保证点一下就能看到效果。 */
function toggleStoryFlip(id: string) {
  flippedStories.value[id] = !flippedStories.value[id];
  if (flippedStories.value[id]) expandedStoryId.value = id;
}
function isStoryFlipped(id: string): boolean {
  return Boolean(flippedStories.value[id]);
}

/** 朗读任意英文文本：先剥掉中文、全角标点等非 ASCII 字符，再按美音读。 */
function speakEn(raw: string) {
  if (!ttsSupported) return;
  const text = raw.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.85;
  u.pitch = 1;
  window.speechSynthesis.speak(u);
}

/**
 * 故事/谚语正文点击委托：点生词读单词，点标题（谚语原句）读整句。
 * 用事件委托是因为正文由 v-html 渲染，无法直接绑 click。
 */
function onStoryClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const wordEl = target.closest('.st-word');
  if (wordEl?.textContent) {
    speakEn(wordEl.textContent);
    return;
  }
  const titleEl = target.closest('.st-title');
  if (titleEl?.textContent) speakEn(titleEl.textContent);
}

/** 展开/收起一篇故事正文。 */
function toggleStoryExpand(id: string) {
  expandedStoryId.value = expandedStoryId.value === id ? '' : id;
}

/** 清空故事表单并退出编辑态。 */
function resetStoryForm() {
  editingStoryId.value = '';
  storyForm.title = '';
  storyForm.body = '';
  storyForm.storyDate = todayISO();
  storyFormOpen.value = false;
  previewHide.value = false;
  resetDraft();
}

/** 打开/收起写故事表单（收起时重置日期）。 */
function toggleStoryForm() {
  if (storyFormOpen.value) {
    resetStoryForm();
  } else {
    editingStoryId.value = '';
    storyForm.title = '';
    storyForm.body = '';
    storyForm.storyDate = todayISO();
    storyFormOpen.value = true;
    storyError.value = '';
    previewHide.value = false;
    resetDraft();
  }
}

/** 把某篇故事载入表单准备修改。 */
function editStory(s: WordStory) {
  editingStoryId.value = s.id;
  storyForm.title = s.title;
  storyForm.body = s.body;
  storyForm.storyDate = s.storyDate;
  storyFormOpen.value = true;
  storyError.value = '';
  previewHide.value = false;
  // 已有正文回填到标准填入面板，改的时候仍可用字段方式
  fillDraftFromBody(s.body);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * 按当前模式一键填入规范模板。
 * 模板里带 `**词**（释义）` 与 ## 标题，保证这条新增记录也能翻转藏译文、点词朗读、打卡。
 * 已有正文时先确认再覆盖，避免误删正在写的内容。
 */
function insertMemoryTemplate() {
  const tpl = currentModeMeta.value.template;
  if (storyForm.body.trim() && !window.confirm('正文已有内容，填入模板会覆盖，继续吗？')) return;
  storyForm.body = tpl;
  if (!storyForm.title.trim()) storyForm.title = `我的${currentModeMeta.value.label} · ${todayISO()}`;
  storyError.value = '';
}

/** 新建或保存一条记忆（按当前模式存），保存后重新拉取该模式列表。 */
async function saveStory() {
  if (storySaving.value) return;
  const title = storyForm.title.trim();
  const rawBody = storyForm.body.trim();
  if (!title) {
    storyError.value = '先给这条记忆写个标题';
    return;
  }
  if (!rawBody) {
    storyError.value = '正文不能为空';
    return;
  }
  // 保存前统一规范化：`trust信任，truth相信` 也会被收成 **trust**（信任） · **truth**（相信）
  const body = normalizeMemoryBody(rawBody, memoryMode.value);
  if (memoryMode.value !== 'story' && storyWordCount(body) === 0) {
    storyError.value =
      '正文里没识别到可朗读的单词。用上面的「标准填入」填英文词 + 中文释义，或按 **trust**（信任） 的格式写。';
    return;
  }
  storySaving.value = true;
  storyError.value = '';
  try {
    const payload = { title, body, storyDate: storyForm.storyDate || todayISO(), mode: memoryMode.value };
    if (editingStoryId.value) await patch(`/vocab/stories/${editingStoryId.value}`, payload);
    else await post('/vocab/stories', payload);
    resetStoryForm();
    allModeStories.value = []; // 新增后让跨模式缓存失效
    await loadStories();
  } catch (err) {
    storyError.value = errorMessage(err);
  } finally {
    storySaving.value = false;
  }
}

/** 删除一篇故事（含其打卡记录）。 */
async function removeStory(s: WordStory) {
  if (!window.confirm(`删除《${s.title}》？这条记录的打卡记录也会一起删掉，不可撤销。`)) return;
  try {
    await del(`/vocab/stories/${s.id}`);
    if (editingStoryId.value === s.id) resetStoryForm();
    allModeStories.value = []; // 删除后让跨模式缓存失效
    await loadStories();
  } catch (err) {
    storyError.value = errorMessage(err);
  }
}

/** 给某篇故事打卡 / 撤销今日打卡（Power of two: 服务端幂等）。 */
async function toggleCheckin(s: WordStory) {
  try {
    if (s.checkedToday) await del(`/vocab/stories/${s.id}/checkin`);
    else await post(`/vocab/stories/${s.id}/checkin`, {});
    await loadStories();
  } catch (err) {
    storyError.value = errorMessage(err);
  }
}

/** 一键给当前模式全部记录打卡（今天复习完一整轮）。 */
async function checkinAllStories() {
  try {
    await post('/vocab/stories/checkin-all', { mode: memoryMode.value });
    await loadStories();
  } catch (err) {
    storyError.value = errorMessage(err);
  }
}

/** 组件挂载：加载词表，并注册全局点击/滚动监听用于关闭释义浮层。 */
onMounted(() => {
  load();
  window.addEventListener('click', closePopup);
  window.addEventListener('scroll', closePopup, true);
});

/** 组件卸载：移除全局监听并关闭释义浮层，避免事件泄漏。 */
onBeforeUnmount(() => {
  window.removeEventListener('click', closePopup);
  window.removeEventListener('scroll', closePopup, true);
  if (popupSpeakTimer) window.clearTimeout(popupSpeakTimer);
  closePopup();
});
</script>

<template>
  <div class="page page-wide vocab-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">英语 · 词汇查漏补缺</div>
        <h1 class="page-title">单词本 · 一轮一轮过</h1>
        <p class="page-desc">
          单击 = 熟悉（绿），连点两下 = 模糊（黄），连点三下 = 遗忘（红）；不点的词保留原区，不用逐个重新点。右键任意单词看释义，鼠标移开即隐藏。
        </p>
      </div>
      <div class="vocab-tabs">
        <button class="tab" :class="{ on: tab === 'test' }" type="button" @click="tab = 'test'">开始测试</button>
        <button class="tab" :class="{ on: tab === 'history' }" type="button" @click="openHistory">我的记录</button>
        <button class="tab" :class="{ on: tab === 'course' }" type="button" @click="tab = 'course'">学单词</button>
        <button class="tab" :class="{ on: tab === 'essay' }" type="button" @click="openEssay">我的作文</button>
        <button class="tab tab-highlight" :class="{ on: tab === 'collocation' }" type="button" @click="openCollocation">背搭配</button>
        <button class="tab tab-highlight" :class="{ on: tab === 'story' }" type="button" @click="openStory">单词趣味记忆</button>
      </div>
    </header>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error && !words.length" :message="error" @retry="load" />

    <template v-else>
      <!-- ========== 测试 ========== -->
      <section v-if="tab === 'test'">
        <div class="vocab-bar">
          <span class="round-chip">第 {{ roundNo }} 轮</span>
          <span class="bar-item">已标记 <b>{{ markedCount }}</b> / {{ testWords.length }}</span>
          <span class="bar-item legend">
            <i class="dot gray" />未点 {{ untouchedCount }}（留原区）
            <i class="dot green" />绿 {{ greenCount }}
            <i class="dot yellow" />黄 {{ yellowCount }}
            <i class="dot red" />红 {{ redCount }}
          </span>
          <label class="bar-item switch">
            <input :checked="includePhrases" type="checkbox" @change="onScopeChange" />
            连短语一起测<span v-if="phraseCount" class="switch-count">+{{ phraseCount }}</span>
          </label>
          <div class="spacer" />
          <button class="btn btn-sm" type="button" @click="reshuffle">重新打乱</button>
          <button
            class="btn btn-sm btn-primary"
            type="button"
            :disabled="submitting"
            title="没点的词保留原区，只有点过变色的词会调整区域"
            @click="submit"
          >
            {{ submitting ? '提交中…' : '提交本轮' }}
          </button>
        </div>

        <div v-if="error" class="banner banner-error">{{ error }}</div>

        <div v-if="restoredCount" class="banner banner-info">
          已恢复上次没提交的 {{ restoredCount }} 个选择（第 {{ roundNo }} 轮），接着点就行。
          <button class="link-btn banner-link" type="button" @click="discardDraft">清空重来</button>
        </div>

        <p v-if="hasZone" class="zone-note">
          按上一轮结果分成了 {{ groups.length }} 个区域。点 1 下 = 熟悉（绿）、2 下 = 模糊（黄）、3 下 = 遗忘（红）；
          <b>没点的词保留在原本区域</b>，提交后只把变色的词调整位置，不用逐个重新点。
        </p>

        <div v-for="g in groups" :key="g.key" class="zone" :class="'zone-' + g.key">
          <div class="zone-head">
            <span class="zone-badge" :class="'z-' + g.key">
              <span class="zone-badge-dot" />
              {{ g.label }}
            </span>
            <span class="zone-hint">{{ g.hint }}</span>
            <span class="zone-count">{{ g.items.length }} 个</span>
          </div>
          <div class="word-grid">
            <button
              v-for="w in g.items"
              :key="w.id"
              class="word"
              :class="wordClass(w)"
              type="button"
            @click="onClick(w)"
            @contextmenu.prevent="openPopup($event, w)"
            @mouseleave="hidePopupSoon"
          >
              {{ w.word }}
            </button>
          </div>
        </div>
      </section>

      <!-- ========== 我的记录 ========== -->
      <section v-else-if="tab === 'history'" class="card card-pad">
        <h2 class="block-title">历次测试</h2>
        <p v-if="!rounds.length" class="muted-note">还没有记录，先去做一轮测试。</p>
        <table v-else class="data-table">
          <thead>
            <tr><th>轮次</th><th>时间</th><th>总词数</th><th>熟悉</th><th>模糊</th><th>遗忘</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rounds" :key="r.id">
              <td>第 {{ r.roundNo }} 轮</td>
              <td>{{ fmt(r.finishedAt) }}</td>
              <td>{{ r.total }}</td>
              <td class="c-green">{{ r.green }}</td>
              <td class="c-amber">{{ r.yellow }}</td>
              <td class="c-red">{{ r.red }}</td>
              <td><button class="link-btn" type="button" @click="openDetail(r)">明细</button></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- ========== 学单词：刘晓燕单词课 ========== -->
      <section v-else-if="tab === 'course'">
        <VocabCourse />
      </section>


      <!-- ========== 我的作文：写好的英语作文存档 ========== -->
      <section v-else-if="tab === 'essay'" class="essay-layout">
        <div class="card card-pad">
          <div class="block-head">
            <h2 class="block-title">{{ editingId ? '修改作文' : '存入一篇作文' }}</h2>
            <span class="muted-note">写好的英语作文放这里，随时回来改</span>
          </div>
          <div v-if="essayError" class="banner banner-error">{{ essayError }}</div>
          <div class="essay-field">
            <label>标题</label>
            <input
              v-model="essayForm.title"
              class="input"
              maxlength="200"
              placeholder="如：2026 模拟卷 · 应用文（建议信）"
            />
          </div>
          <div class="essay-row">
            <div class="essay-field">
              <label>文体</label>
              <select v-model="essayForm.genre" class="input">
                <option v-for="g in GENRES" :key="g" :value="g">{{ g }}</option>
              </select>
            </div>
            <div class="essay-field essay-field-grow">
              <label>题目要求（可选）</label>
              <input
                v-model="essayForm.prompt"
                class="input"
                maxlength="4000"
                placeholder="把作文题的中文要求或英文 Directions 贴进来"
              />
            </div>
          </div>
          <div class="essay-field">
            <label>正文 <span class="muted-note">· {{ essayWordCount }} 词</span></label>
            <textarea
              v-model="essayForm.body"
              class="textarea essay-textarea"
              rows="12"
              placeholder="把你写好的英文作文整篇粘贴到这里…"
            />
          </div>
          <div class="essay-form-foot">
            <button v-if="editingId" class="btn btn-sm" type="button" @click="resetEssayForm">取消修改</button>
            <div class="spacer" />
            <button class="btn btn-sm btn-primary" type="button" :disabled="essaySaving" @click="saveEssay">
              {{ essaySaving ? '保存中…' : editingId ? '保存修改' : '存入作文' }}
            </button>
          </div>
        </div>

        <div class="card card-pad">
          <div class="block-head">
            <h2 class="block-title">已存作文（{{ essays.length }}）</h2>
          </div>
          <p v-if="essayLoading" class="muted-note">加载中…</p>
          <p v-else-if="!essays.length" class="muted-note">
            还没有存过作文。左边写一篇，或者把写好的整篇粘进去。
          </p>
          <div v-for="e in essays" :key="e.id" class="essay-item">
            <div class="essay-item-head">
              <div>
                <b>{{ e.title }}</b>
                <span class="essay-meta">{{ e.genre }} · {{ wordCount(e.body) }} 词 · {{ fmt(e.updatedAt) }}</span>
              </div>
              <div class="essay-actions">
                <button class="link-btn" type="button" @click="expandedId = expandedId === e.id ? '' : e.id">
                  {{ expandedId === e.id ? '收起' : '全文' }}
                </button>
                <button class="link-btn" type="button" @click="editEssay(e)">编辑</button>
                <button class="link-btn essay-del" type="button" @click="removeEssay(e)">删除</button>
              </div>
            </div>
            <p v-if="e.prompt" class="essay-prompt">题目：{{ e.prompt }}</p>
            <p class="essay-body" :class="{ 'essay-body-full': expandedId === e.id }">
              {{ expandedId === e.id ? e.body : essayExcerpt(e) }}
            </p>
          </div>
        </div>
      </section>

      <!-- ========== 背搭配：不背单词式卡片 ========== -->
      <section v-else-if="tab === 'collocation'" class="coll-wrap">
        <div class="coll-head">
          <div>
            <h2 class="block-title">背搭配 · 一个个过</h2>
            <p class="coll-sub">单词和短语分开背。点卡片翻面看释义、例句和翻译，点喇叭听发音；底部标记「认识 / 模糊 / 不认识」自动进入下一张。</p>
          </div>
          <div class="coll-head-actions">
            <button class="btn btn-sm btn-primary" type="button" @click="toggleCollForm">
              {{ collFormOpen ? '收起表单' : '＋ 添加搭配' }}
            </button>
            <button class="btn btn-sm" type="button" @click="resetCollProgress">重置进度</button>
          </div>
        </div>

        <!-- 自建搭配：把自己记不住的短语也加进来一起背 -->
        <div v-if="collFormOpen" class="card card-pad coll-custom-form">
          <div class="block-head">
            <h2 class="block-title">添加一条自己的搭配</h2>
            <span class="muted-note">短语必填，释义和例句选填；加完就能翻卡、听发音、记掌握状态</span>
          </div>
          <div v-if="collFormError" class="banner banner-error">{{ collFormError }}</div>
          <div class="essay-field">
            <label>搭配短语 <span class="muted-note">· 必填，如 make a difference</span></label>
            <input v-model="collForm.word" class="input" maxlength="120" placeholder="如：make a difference" />
          </div>
          <div class="essay-field">
            <label>中文释义 <span class="muted-note">· 选填</span></label>
            <input v-model="collForm.meaning" class="input" maxlength="300" placeholder="如：产生影响，起作用" />
          </div>
          <div class="essay-field">
            <label>英文例句 <span class="muted-note">· 选填，写了就能在卡片背面听整句发音</span></label>
            <input v-model="collForm.exampleEn" class="input" maxlength="1000" placeholder="如：Small actions can make a difference." />
          </div>
          <div class="essay-field">
            <label>例句翻译 <span class="muted-note">· 选填</span></label>
            <input v-model="collForm.exampleZh" class="input" maxlength="1000" placeholder="如：小小的行动也能带来改变。" />
          </div>
          <div class="essay-form-foot">
            <button class="btn btn-sm" type="button" @click="toggleCollForm">取消</button>
            <div class="spacer" />
            <button class="btn btn-sm btn-primary" type="button" :disabled="collFormSaving" @click="saveCustomCollocation">
              {{ collFormSaving ? '保存中…' : '加入背搭配' }}
            </button>
          </div>
        </div>

        <div v-if="collLoading" class="card card-pad muted">正在加载搭配卡片…</div>
        <ErrorState v-else-if="collError" :message="collError" @retry="loadCollocations()" />
        <template v-else>
          <!-- 统计条 -->
          <div v-if="collStats" class="coll-stats coll-stats-5">
            <div class="coll-stat"><span class="coll-stat-num">{{ collStats.total }}</span><span class="coll-stat-label">总搭配</span></div>
            <div class="coll-stat"><span class="coll-stat-num coll-c-green">{{ collStats.known }}</span><span class="coll-stat-label">已认识</span></div>
            <div class="coll-stat"><span class="coll-stat-num coll-c-yellow">{{ collStats.learning }}</span><span class="coll-stat-label">模糊</span></div>
            <div class="coll-stat"><span class="coll-stat-num coll-c-red">{{ collStats.newCount }}</span><span class="coll-stat-label">未学</span></div>
            <div class="coll-stat"><span class="coll-stat-num">{{ collCards.filter((c) => c.custom).length }}</span><span class="coll-stat-label">自建</span></div>
          </div>

          <!-- 搜索：短语 / 释义 / 例句一起找 -->
          <div class="coll-search">
            <input
              v-model="collQuery"
              class="input"
              type="search"
              maxlength="200"
              placeholder="搜搭配：如 make a difference / 产生影响 / 多个词用空格隔开"
            />
            <button v-if="collQuery" class="btn btn-sm" type="button" @click="collQuery = ''">清除</button>
            <span v-if="collKeywords.length" class="muted-note">
              找到 {{ collSearchScope.length }} / {{ collCards.length }} 条
            </span>
          </div>

          <!-- 筛选与工具 -->
          <div class="coll-toolbar">
            <div class="coll-filters">
              <button v-for="f in ([['all','全部'],['new','未学'],['learning','模糊'],['known','已认识']] as [CardFilter,string][])" :key="f[0]"
                class="coll-chip" :class="{ on: collFilter === f[0] }" type="button" @click="setCollFilter(f[0])">{{ f[1] }}</button>
            </div>
            <button class="btn btn-sm" :class="{ 'btn-primary': collShuffle }" type="button" @click="reshuffleColl">🔀 乱序</button>
          </div>

          <!-- 卡片 -->
          <div v-if="collCurrent" class="coll-card-wrap">
            <div class="coll-counter">{{ collIndex + 1 }} / {{ collQueue.length }} · 本轮已过 {{ collRoundDone }} 张</div>
            <div class="coll-progress"><div class="coll-progress-fill" :style="{ width: collProgressPct + '%' }"></div></div>

            <div class="coll-card" :class="{ flipped: collFlipped }" @click="flipCard">
              <!-- 正面：短语 + 发音 -->
              <div class="coll-face coll-front">
                <span class="coll-badge" :class="{ 'coll-badge-custom': collCurrent.custom }">
                  {{ collCurrent.custom ? '自建搭配' : '固定搭配' }}
                </span>
                <div class="coll-word">{{ collCurrent.word }}</div>
                <button v-if="ttsSupported" class="coll-speak" type="button" :class="{ speaking: speakingId === collCurrent.id }"
                  title="朗读短语" @click.stop="speak(collCurrent.word, collCurrent.id)">
                  <NavIcon name="volume" :size="20" /> {{ speakingId === collCurrent.id ? '朗读中…' : '听发音' }}
                </button>
                <div class="coll-tap-hint">点击卡片翻面看释义和例句</div>
              </div>
              <!-- 背面：释义 + 例句 + 翻译 + 发音 -->
              <div class="coll-face coll-back">
                <div class="coll-back-word">{{ collCurrent.word }}</div>
                <div class="coll-meaning">{{ collCurrent.meaning }}</div>
                <div v-if="collCurrent.exampleEn" class="coll-example">
                  <div class="coll-example-line">
                    <span class="coll-eg-text">{{ collCurrent.exampleEn }}</span>
                    <button v-if="ttsSupported" class="coll-speak-sm" type="button" title="朗读例句"
                      @click.stop="speak(collCurrent.exampleEn, collCurrent.id)"><NavIcon name="volume" :size="16" /></button>
                  </div>
                  <div class="coll-eg-zh">{{ collCurrent.exampleZh }}</div>
                </div>
                <div v-else class="coll-example coll-eg-pending">例句生成中…</div>
                <div class="coll-tap-hint">点击翻回正面</div>
              </div>
            </div>

            <!-- 上一张/下一张；自建搭配可就地删除 -->
            <div class="coll-nav">
              <button class="btn btn-sm" type="button" @click="collStep(-1)">← 上一张</button>
              <button v-if="collCurrent.custom" class="link-btn coll-del" type="button" @click="removeCustomCollocation">删除这条</button>
              <button class="btn btn-sm" type="button" @click="collStep(1)">下一张 →</button>
            </div>

            <!-- 三档掌握标记 -->
            <div class="coll-actions">
              <button class="coll-mark coll-mark-red" type="button" @click="markCollocation('new')">不认识</button>
              <button class="coll-mark coll-mark-yellow" type="button" @click="markCollocation('learning')">模糊</button>
              <button class="coll-mark coll-mark-green" type="button" @click="markCollocation('known')">认识</button>
            </div>
          </div>

          <div v-else class="card card-pad muted coll-empty">
            <template v-if="collKeywords.length">
              没有找到匹配「{{ collQuery.trim() }}」的搭配。换几个词试试，或点「清除」看全部。
            </template>
            <template v-else>
              这个筛选下暂时没有搭配了。切换到「全部」继续，或重置进度重新开始。
            </template>
          </div>
        </template>
      </section>

      <!-- ========== 单词趣味记忆：故事 / 谚语 / 近似 ========== -->
      <section v-else-if="tab === 'story'" class="story-wrap">
        <div class="coll-head">
          <div>
            <h2 class="block-title">单词趣味记忆 · 换个方式记住单词</h2>
            <p class="coll-sub">同一种记忆法：把词放进故事、谚语、易混词里，比孤立背单词记得牢。点「翻转」藏起中文自测,看完打卡。</p>
          </div>
          <button class="btn btn-sm btn-primary" type="button" @click="toggleStoryForm">
            {{ storyFormOpen ? '收起表单' : `＋ 新增一条${currentModeMeta.label}` }}
          </button>
        </div>

        <!-- 三种模式切换 -->
        <div class="memory-mode-tabs">
          <button
            v-for="m in MEMORY_MODES"
            :key="m.key"
            class="memory-mode-tab"
            :class="{ on: memoryMode === m.key }"
            type="button"
            @click="switchMemoryMode(m.key)"
          >
            <span class="memory-mode-icon">{{ m.icon }}</span>
            <span class="memory-mode-name">{{ m.label }}</span>
          </button>
        </div>
        <p class="memory-mode-desc">{{ currentModeMeta.desc }}</p>
        <p class="memory-mode-tip">
          💡 点单词或谚语句子可听读音；点「翻转·藏译文」会把中文遮住自测（自动展开正文），再点一次恢复。
        </p>

        <!-- 搜索：默认搜当前模式，勾选后跨三种模式一起找 -->
        <div class="story-search">
          <div class="story-search-box">
            <span class="story-search-icon">🔍</span>
            <input
              v-model="storyQuery"
              class="input story-search-input"
              type="text"
              :placeholder="`在${searchAllModes ? '全部模式' : currentModeMeta.label}里搜单词、中文释义或标题（空格分隔多个词）`"
            />
            <button v-if="storyQuery" class="story-search-clear" type="button" aria-label="清空搜索" @click="storyQuery = ''">✕</button>
          </div>
          <label class="story-search-all">
            <input v-model="searchAllModes" type="checkbox" />
            含其他模式
          </label>
          <span v-if="allModesLoading" class="muted-note">正在汇总全部模式…</span>
          <span v-else-if="storyKeywords.length" class="story-search-count">
            找到 <b>{{ filteredStories.length }}</b> 条 / 共 {{ storyScope.length }} 条
          </span>
        </div>

        <!-- 复习统计 -->
        <div v-if="storyStats" class="coll-stats">
          <div class="coll-stat"><span class="coll-stat-num">{{ storyStats.totalStories }}</span><span class="coll-stat-label">总条数</span></div>
          <div class="coll-stat"><span class="coll-stat-num coll-c-green">{{ storyStats.streak }}</span><span class="coll-stat-label">连续打卡（天）</span></div>
          <div class="coll-stat"><span class="coll-stat-num">{{ storyStats.totalCheckins }}</span><span class="coll-stat-label">累计打卡</span></div>
          <div class="coll-stat"><span class="coll-stat-num coll-c-yellow">{{ storyStats.todayChecked }}/{{ storyStats.todayTotal }}</span><span class="coll-stat-label">今日复习</span></div>
        </div>

        <!-- 新增/修改表单：文案、占位、模板随当前模式变化 -->
        <div v-if="storyFormOpen" class="card card-pad story-form">
          <div class="block-head">
            <h2 class="block-title">
              {{ editingStoryId ? '修改' : '新增' }}{{ currentModeMeta.label }}
              <span class="story-form-mode">{{ currentModeMeta.icon }} {{ currentModeMeta.label }}模式</span>
            </h2>
            <span class="muted-note">{{ currentModeMeta.hint }}</span>
          </div>
          <div v-if="storyError" class="banner banner-error">{{ storyError }}</div>
          <div class="essay-field">
            <label>标题</label>
            <input v-model="storyForm.title" class="input" maxlength="200" :placeholder="`给这条${currentModeMeta.label}起个标题`" />
          </div>
          <div class="essay-field">
            <label>记录日期</label>
            <input v-model="storyForm.storyDate" class="input" type="date" />
          </div>
          <!-- 标准填入：谚语 / 近似 用字段填，生成的正文必定可朗读、可翻转 -->
          <div v-if="memoryMode !== 'story'" class="std-fill">
            <div class="std-fill-head">
              <b>标准填入</b>
              <span>一格一格填就行，不用记格式；生成的正文一定能点词朗读、翻转藏译文</span>
            </div>

            <div class="essay-field">
              <label>{{ memoryMode === 'proverb' ? '英文原句' : '词组标题' }}</label>
              <input
                v-model="draft.headline"
                class="input"
                maxlength="200"
                :placeholder="memoryMode === 'proverb' ? '如：No pain, no gain.' : '如：trust / truth'"
              />
            </div>

            <div v-if="memoryMode === 'proverb'" class="essay-field">
              <label>中文译文 <span class="muted-note">· 选填</span></label>
              <input v-model="draft.translation" class="input" maxlength="300" placeholder="如：不劳无获。" />
            </div>

            <div class="essay-field">
              <label>单词 + 释义 <span class="muted-note">· 一个词一行，英文在前、中文释义在后</span></label>
              <div class="std-pair-list">
                <div v-for="(p, i) in draft.pairs" :key="i" class="std-pair-row">
                  <input v-model="p.word" class="input" maxlength="60" placeholder="英文，如 trust" />
                  <input v-model="p.gloss" class="input" maxlength="120" placeholder="中文，如 v./n. 信任" />
                  <button
                    class="std-pair-del"
                    type="button"
                    title="删掉这个词"
                    :disabled="draft.pairs.length <= 1"
                    @click="removeDraftPair(i)"
                  >
                    ×
                  </button>
                </div>
              </div>
              <button class="story-tpl-btn" type="button" @click="addDraftPair">＋ 再加一个词</button>
            </div>

            <div class="essay-field">
              <label>{{ memoryMode === 'proverb' ? '记忆点' : '辨析说明' }} <span class="muted-note">· 选填</span></label>
              <textarea
                v-model="draft.note"
                class="textarea"
                rows="2"
                :placeholder="
                  memoryMode === 'proverb'
                    ? '如：写作开头句；反义句是 No sweet without sweat.'
                    : '如：trust 是「信任」，truth 是「真相」；tell the truth 说实话'
                "
              />
            </div>

            <div class="std-fill-foot">
              <span class="muted-note">填完点右边 → 自动生成规范正文，填进下面的正文框</span>
              <button class="btn btn-sm btn-primary" type="button" @click="applyDraft">⚡ 生成标准正文</button>
            </div>
          </div>

          <div class="essay-field">
            <label>
              正文 <span class="muted-note">· 生成后会填在这里，也能直接改</span>
              <button class="story-tpl-btn" type="button" @click="insertMemoryTemplate">📋 填入{{ currentModeMeta.label }}模板</button>
            </label>
            <textarea
              v-model="storyForm.body"
              class="textarea essay-textarea"
              rows="14"
              :placeholder="currentModeMeta.placeholder"
            />
            <p class="story-form-note">
              按 <b>**单词**（中文释义）</b> 写，这条记录才能：点单词听读音、翻转藏起中文自测、按模式单独打卡统计。
              <template v-if="memoryMode !== 'story'">直接写 <b>trust信任</b> 也行，保存时会自动补成标准格式。</template>
            </p>
          </div>

          <!-- 效果预览：所见即所存 -->
          <div class="std-preview">
            <div class="std-preview-head">
              <b>效果预览</b>
              <span class="muted-note">{{ previewWordCount }} 个可朗读词 · 点绿色词听读音</span>
              <button class="btn btn-sm" :class="{ 'btn-primary': previewHide }" type="button" @click="previewHide = !previewHide">
                {{ previewHide ? '👁 显示译文' : '🙈 试翻转' }}
              </button>
            </div>
            <p v-if="!previewBody.trim()" class="muted-note">正文还是空的。上面填完点「生成标准正文」，这里会实时出效果。</p>
            <div v-else class="story-body" @click="onStoryClick" v-html="renderStory(previewBody, previewHide)" />
          </div>
          <div class="essay-form-foot">
            <button v-if="editingStoryId" class="btn btn-sm" type="button" @click="resetStoryForm">取消修改</button>
            <div class="spacer" />
            <button class="btn btn-sm btn-primary" type="button" :disabled="storySaving" @click="saveStory">
              {{ storySaving ? '保存中…' : editingStoryId ? '保存修改' : `存入${currentModeMeta.label}` }}
            </button>
          </div>
        </div>

        <!-- 一键打卡：搜索状态下隐藏，避免把整个模式误打卡 -->
        <div v-if="storyList.length && !storyKeywords.length" class="story-toolbar">
          <span class="muted-note">共 {{ storyList.length }} 条 · 今日已复习 {{ storyStats?.todayChecked ?? 0 }} 条</span>
          <button class="btn btn-sm" type="button" :disabled="storyStats?.todayChecked === storyStats?.todayTotal" @click="checkinAllStories">
            📌 全部打卡（今天全复习完了）
          </button>
        </div>

        <p v-if="storyLoading" class="muted-note">加载中…</p>
        <ErrorState v-else-if="storyError && !storyList.length" :message="storyError" @retry="loadStories" />
        <p v-else-if="allModesLoading" class="muted-note">正在汇总三种模式的内容…</p>
        <p v-else-if="storyKeywords.length && !filteredStories.length" class="muted-note">
          没有找到匹配「{{ storyQuery.trim() }}」的记录。可以少输几个字，或勾选「含其他模式」再找找。
        </p>
        <p v-else-if="!storyScope.length" class="muted-note">
          {{ searchAllModes ? '三种模式暂时都还没有内容。' : `这个模式还没有内容。点右上角「＋ 新增一条${currentModeMeta.label}」自己存一条，或点「填入模板」按格式写。` }}
        </p>

        <!-- 列表（已按搜索过滤）：每条可翻转、打卡；自建的可编辑删除 -->
        <div v-else class="story-list">
          <article v-for="s in filteredStories" :key="s.id" class="card card-pad story-card">
            <header class="story-card-head">
              <div class="story-card-title">
                <b v-html="highlightTitle(s.title)"></b>
                <span v-if="s.builtin" class="story-builtin-badge">内置</span>
                <span v-if="searchAllModes" class="story-scope-badge">{{ modeLabel(s.mode) }}</span>
                <span class="story-meta">{{ s.storyDate }} · {{ storyWordCount(s.body) }} 个生词 · 已打卡 {{ s.checkinCount }} 天</span>
                <p v-if="matchSnippet(s)" class="story-snippet">↳ {{ matchSnippet(s) }}</p>
              </div>
              <div class="story-actions">
                <button v-if="searchAllModes" class="link-btn" type="button" @click="gotoStoryMode(s)">前往该模式</button>
                <button class="btn btn-sm" :class="{ 'btn-primary': isStoryFlipped(s.id) }" type="button" @click="toggleStoryFlip(s.id)">
                  {{ isStoryFlipped(s.id) ? '👁 显示译文' : '🙈 翻转·藏译文' }}
                </button>
                <button class="link-btn" type="button" @click="toggleStoryExpand(s.id)">
                  {{ expandedStoryId === s.id ? '收起' : '展开' }}
                </button>
                <template v-if="!s.builtin && !searchAllModes">
                  <button class="link-btn" type="button" @click="editStory(s)">编辑</button>
                  <button class="link-btn essay-del" type="button" @click="removeStory(s)">删除</button>
                </template>
              </div>
            </header>
            <div
              v-show="expandedStoryId === s.id"
              class="story-body"
              @click="onStoryClick"
              v-html="renderStory(s.body, isStoryFlipped(s.id))"
            />
            <footer v-if="!searchAllModes" class="story-card-foot">
              <span v-if="s.lastCheckin" class="muted-note">最近打卡 {{ s.lastCheckin }}</span>
              <span v-else class="muted-note">还没打过卡</span>
              <button class="btn btn-sm" :class="s.checkedToday ? 'btn-primary' : ''" type="button" @click="toggleCheckin(s)">
                {{ s.checkedToday ? '✓ 今日已打卡（点此撤销）' : '📌 今日打卡' }}
              </button>
            </footer>
            <p v-else class="story-cross-hint">位于「{{ modeLabel(s.mode) }}」模式 · 点「前往该模式」回去后可打卡、编辑</p>
          </article>
        </div>
      </section>
    </template>

    <!-- 提交结果 -->
    <div v-if="result" class="modal-backdrop" @click.self="result = null">
      <div class="modal result-modal">
        <header class="modal-head">
          <div>
            <div class="eyebrow">第 {{ result.roundNo }} 轮完成</div>
            <h2>本轮结果</h2>
          </div>
          <button class="icon-btn" type="button" aria-label="关闭" @click="result = null">
            <NavIcon name="x" :size="18" />
          </button>
        </header>
        <div class="modal-body">
          <div class="result-grid">
            <div class="result-cell green"><b>{{ result.green }}</b><span>熟悉</span></div>
            <div class="result-cell yellow"><b>{{ result.yellow }}</b><span>模糊</span></div>
            <div class="result-cell red"><b>{{ result.red }}</b><span>遗忘</span></div>
          </div>
          <p class="muted-note">共 {{ result.total }} 个词 · {{ fmt(result.finishedAt) }}</p>
          <p class="muted-note">下一轮会按这三个结果分成三个区域重新开始，单词颜色重新从灰色算。</p>
        </div>
        <div class="modal-foot">
          <button class="btn" type="button" @click="result = null">留在这里</button>
          <button class="btn btn-primary" type="button" @click="nextRound">进入第 {{ result.roundNo + 1 }} 轮</button>
        </div>
      </div>
    </div>

    <!-- 单轮明细 -->
    <div v-if="detail" class="modal-backdrop" @click.self="detail = null">
      <div class="modal detail-modal">
        <header class="modal-head">
          <div>
            <div class="eyebrow">第 {{ detail.round.roundNo }} 轮 · {{ fmt(detail.round.finishedAt) }}</div>
            <h2>词表明细</h2>
          </div>
          <button class="icon-btn" type="button" aria-label="关闭" @click="detail = null">
            <NavIcon name="x" :size="18" />
          </button>
        </header>
        <div class="modal-body">
          <div v-for="s in ['green', 'yellow', 'red']" :key="s" class="detail-block">
            <div class="detail-head" :class="'z-' + s">
              {{ s === 'green' ? '熟悉' : s === 'yellow' ? '模糊' : '遗忘' }}
              （{{ detailByState(s).length }}）
            </div>
            <div class="detail-words">
              <span v-for="i in detailByState(s)" :key="i.wordId" class="detail-word">{{ i.word }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 右键释义 -->
    <div
      v-if="popup"
      class="word-pop"
      :style="{ left: popup.x + 'px', top: popup.y + 'px' }"
      @click.stop
      @mouseenter="keepPopup"
      @mouseleave="closePopup"
    >
      <div class="pop-word">{{ popup.word.word }}</div>
      <div v-if="popup.word.phonetic" class="pop-phonetic">{{ popup.word.phonetic }}</div>
      <div class="pop-meaning">{{ popup.word.meaning || '（无释义）' }}</div>
    </div>
  </div>
</template>

<style scoped>

/* ---------- 背搭配：不背单词式卡片 ---------- */
.tab-highlight { color: var(--brand, #2f7d5d); font-weight: 600; }
.coll-wrap { display: flex; flex-direction: column; gap: 16px; }
.coll-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.coll-sub { margin: 6px 0 0; font-size: 13px; color: var(--muted, #6b7280); line-height: 1.6; max-width: 720px; }
.coll-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.coll-stats-5 { grid-template-columns: repeat(5, 1fr); }
@media (max-width: 720px) { .coll-stats-5 { grid-template-columns: repeat(2, 1fr); } }
.coll-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.coll-custom-form { display: flex; flex-direction: column; gap: 2px; }
.coll-search { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.coll-search .input { flex: 1 1 320px; min-width: 0; }
.coll-search .muted-note { font-size: 12.5px; }
.coll-badge-custom { color: #b45309; background: color-mix(in srgb, #f59e0b 16%, transparent); }
.coll-del { color: #dc2626; }
.coll-del:hover { text-decoration: underline; }
.coll-stat { background: var(--panel, #fff); border: 1px solid var(--line, #e5e7eb); border-radius: 12px; padding: 12px 16px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.coll-stat-num { font-size: 22px; font-weight: 600; line-height: 1.2; }
.coll-stat-label { font-size: 12px; color: var(--muted, #6b7280); }
.coll-c-green { color: #16a34a; }
.coll-c-yellow { color: #d97706; }
.coll-c-red { color: #dc2626; }
.coll-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.coll-filters { display: flex; gap: 8px; flex-wrap: wrap; }
.coll-chip { padding: 6px 14px; border: 1px solid var(--line, #e5e7eb); border-radius: 999px; background: var(--panel, #fff); color: var(--muted, #6b7280); font-size: 13px; cursor: pointer; }
.coll-chip.on { background: var(--brand, #2f7d5d); color: #fff; border-color: var(--brand, #2f7d5d); }
.coll-card-wrap { max-width: 640px; width: 100%; margin: 0 auto; }
.coll-counter { text-align: center; font-size: 13px; color: var(--muted, #6b7280); margin-bottom: 6px; }
.coll-progress { height: 6px; background: var(--line, #e5e7eb); border-radius: 999px; overflow: hidden; margin-bottom: 18px; }
.coll-progress-fill { height: 100%; background: var(--brand, #2f7d5d); border-radius: 999px; transition: width .25s; }
.coll-card { position: relative; height: 360px; cursor: pointer; perspective: 1000px; }
.coll-face { position: absolute; inset: 0; backface-visibility: hidden; -webkit-backface-visibility: hidden; overflow-y: auto; background: var(--panel, #fff); border: 1px solid var(--line, #e5e7eb); border-radius: 16px; box-shadow: var(--shadow-lift, 0 8px 24px rgba(0,0,0,.08)); padding: 28px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 16px; }
.coll-front { z-index: 2; }
.coll-card.flipped .coll-front { transform: rotateY(180deg); }
.coll-card.flipped .coll-back { transform: rotateY(0); }
.coll-back { transform: rotateY(180deg); z-index: 2; }
.coll-badge { font-size: 12px; color: var(--brand, #2f7d5d); background: color-mix(in srgb, var(--brand, #2f7d5d) 12%, transparent); padding: 4px 10px; border-radius: 999px; }
.coll-word { font-size: 30px; font-weight: 600; line-height: 1.3; word-break: break-word; }
.coll-back-word { font-size: 20px; font-weight: 600; color: var(--brand, #2f7d5d); }
.coll-meaning { font-size: 18px; line-height: 1.5; }
.coll-speak { display: inline-flex; align-items: center; gap: 8px; padding: 8px 18px; border: 1px solid var(--brand, #2f7d5d); color: var(--brand, #2f7d5d); background: transparent; border-radius: 999px; font-size: 14px; cursor: pointer; }
.coll-speak.speaking { opacity: .6; }
.coll-speak-sm { border: none; background: transparent; color: var(--brand, #2f7d5d); cursor: pointer; padding: 4px; }
.coll-tap-hint { position: absolute; bottom: 18px; font-size: 12px; color: var(--muted, #9ca3af); }
.coll-example { width: 100%; background: var(--soft, #f8faf9); border-radius: 10px; padding: 14px 16px; text-align: left; }
.coll-example-line { display: flex; align-items: flex-start; gap: 8px; }
.coll-eg-text { flex: 1; font-size: 15px; line-height: 1.6; }
.coll-eg-zh { margin-top: 6px; font-size: 13px; color: var(--muted, #6b7280); line-height: 1.6; }
.coll-eg-pending { text-align: center; color: var(--muted, #9ca3af); font-size: 13px; }
.coll-nav { display: flex; justify-content: space-between; margin: 16px 0; }
.coll-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.coll-mark { padding: 14px 0; border: 1px solid var(--line, #e5e7eb); border-radius: 12px; background: var(--panel, #fff); font-size: 15px; font-weight: 600; cursor: pointer; }
.coll-mark-red { color: #dc2626; border-color: #fecaca; }
.coll-mark-yellow { color: #d97706; border-color: #fde68a; }
.coll-mark-green { color: #16a34a; border-color: #bbf7d0; }
.coll-mark:hover { filter: brightness(.97); }
.coll-empty { text-align: center; }
@media (max-width: 640px) {
  .coll-stats { grid-template-columns: repeat(2, 1fr); }
  .coll-word { font-size: 24px; }
}

/* 弹层基础样式：错题本里是 scoped 的，这个页面得自己带一份 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(23, 37, 34, 0.5);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
  z-index: 80;
  padding: 20px;
}
.modal {
  width: min(680px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow-lift);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 22px 14px;
  border-bottom: 1px solid var(--line);
}
.modal-head h2 {
  font-size: 21px;
}
.modal-body {
  padding: 16px 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 13px 22px 18px;
  border-top: 1px solid var(--line);
}
.icon-btn {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}
.icon-btn:hover {
  background: var(--panel-soft);
  color: var(--ink);
}
.vocab-page {
  padding-bottom: 40px;
}
.vocab-tabs {
  display: flex;
  gap: 6px;
  background: var(--panel-soft);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 4px;
}
.tab {
  border: 0;
  background: transparent;
  color: var(--ink-2);
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 7px;
  cursor: pointer;
}
.tab.on {
  background: var(--panel);
  color: var(--accent);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(27, 41, 38, 0.08);
}
.vocab-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 14px;
  box-shadow: var(--shadow);
}
.round-chip {
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-weight: 600;
  font-size: 12.5px;
  padding: 3px 10px;
  border-radius: 999px;
}
.bar-item {
  font-size: 12.5px;
  color: var(--ink-2);
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend .dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
  margin-left: 6px;
}
.dot.gray {
  background: #e6e2d8;
}
.dot.yellow {
  background: #f3d27a;
}
.dot.green {
  background: #9ed3b3;
}
.dot.red {
  background: #e8a49a;
}
.switch {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.switch-count {
  font-size: 11.5px;
  color: var(--ink-soft, #8a8478);
  background: #f0ece0;
  border-radius: 9px;
  padding: 1px 6px;
  line-height: 1.4;
}
.spacer {
  flex: 1;
}
.zone-note,
.muted-note {
  color: var(--muted);
  font-size: 12.5px;
  margin: 12px 2px;
}
.zone {
  --zone-tint: transparent;
  --zone-edge: var(--line-strong);
  --zone-accent: var(--ink-2);
  margin-top: 18px;
  padding: 14px 16px 16px;
  border: 1px solid var(--zone-edge);
  border-left: 4px solid var(--zone-accent);
  border-radius: 12px;
  background: var(--zone-tint);
}
.zone-green {
  --zone-tint: #f3faf5;
  --zone-edge: #cfe7d8;
  --zone-accent: #3f9c68;
}
.zone-yellow {
  --zone-tint: #fdf9ec;
  --zone-edge: #ecd9a8;
  --zone-accent: #d1a02e;
}
.zone-red {
  --zone-tint: #fdf3f1;
  --zone-edge: #efcfc9;
  --zone-accent: #cf5949;
}
.zone-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 13px;
}
.zone-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px 5px 10px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 13px;
  background: var(--panel);
  border: 1px solid var(--zone-edge);
  color: var(--zone-accent);
}
.zone-badge-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--zone-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--zone-accent) 16%, transparent);
}
.zone-badge.z-green { color: #2f7d52; border-color: #cfe7d8; }
.zone-badge.z-yellow { color: #9a7016; border-color: #ecd9a8; }
.zone-badge.z-red { color: #b8453a; border-color: #efcfc9; }
.zone-badge.z-new { color: var(--ink-2); }
/* 明细弹窗标题沿用同名颜色类 */
.z-green { color: #2f7d52; }
.z-yellow { color: #9a7016; }
.z-red { color: #b8453a; }
.z-new { color: var(--ink-2); }
.zone-hint {
  font-size: 12px;
  color: var(--muted);
}
.zone-count {
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
  color: var(--zone-accent);
  background: var(--panel);
  border: 1px solid var(--zone-edge);
  padding: 3px 10px;
  border-radius: 999px;
}
.word-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.word {
  border: 1px solid var(--line-strong);
  background: var(--panel);
  color: var(--ink);
  font-size: 13.5px;
  line-height: 1.2;
  padding: 7px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-family: var(--sans);
  box-shadow: 0 1px 2px rgb(27 41 38 / 4%);
  transition: background 0.12s, border-color 0.12s, transform 0.08s;
  user-select: none;
}
.word:hover {
  transform: translateY(-1px);
  border-color: var(--ink-2);
}
.w-gray {
  background: var(--panel);
  border-color: var(--line-strong);
  color: #55605b;
}
.w-yellow {
  background: #fdf1cc;
  border-color: #e8c46a;
  color: #6b4d0d;
}
.w-green {
  background: #dff2e6;
  border-color: #8cc6a4;
  color: #1e5a3c;
}
.w-red {
  background: #fdeae6;
  border-color: #e39a8d;
  color: #a33d31;
}
.result-modal,
.detail-modal {
  width: min(560px, 92vw);
}
.result-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.result-cell {
  border-radius: 12px;
  padding: 14px;
  text-align: center;
}
.result-cell b {
  display: block;
  font-size: 26px;
  font-weight: 700;
}
.result-cell span {
  font-size: 12.5px;
}
.result-cell.green {
  background: #dff2e6;
  color: #1e5a3c;
}
.result-cell.yellow {
  background: #fdf1cc;
  color: #6b4d0d;
}
.result-cell.red {
  background: #f8e3df;
  color: #8f2f27;
}
.detail-block {
  margin-bottom: 14px;
}
.detail-head {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 6px;
}
.detail-words {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
}
.detail-word {
  font-size: 12.5px;
  background: var(--panel-soft);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 8px;
}
.word-pop {
  position: fixed;
  z-index: 60;
  width: 288px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  box-shadow: var(--shadow-lift);
  padding: 12px 14px;
}
.pop-word {
  font-family: var(--serif);
  font-size: 17px;
  font-weight: 600;
}
.pop-phonetic {
  color: var(--muted);
  font-size: 12.5px;
  margin-top: 2px;
}
.pop-meaning {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-2);
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.block-title {
  font-size: 15px;
  font-weight: 600;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th,
.data-table td {
  text-align: left;
  padding: 9px 8px;
  border-bottom: 1px solid var(--line);
}
.data-table th {
  color: var(--muted);
  font-weight: 500;
  font-size: 12px;
}
.c-green {
  color: #2f7d52;
  font-weight: 600;
}
.c-amber {
  color: #a9761b;
  font-weight: 600;
}
.c-red {
  color: #a83c33;
  font-weight: 600;
}
.link-btn {
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
  cursor: pointer;
  padding: 0;
}
.banner-link {
  margin-left: 8px;
  text-decoration: underline;
}

/* ---------- 我的作文 ---------- */
.essay-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1000px) {
  .essay-layout {
    grid-template-columns: 1fr;
  }
}
.essay-field {
  margin-bottom: 12px;
}
.essay-field > label {
  display: block;
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 6px;
}
.essay-row {
  display: flex;
  gap: 12px;
}
.essay-field-grow {
  flex: 1;
  min-width: 0;
}
.essay-textarea {
  width: 100%;
  min-height: 260px;
  font-family: var(--serif);
  line-height: 1.75;
  resize: vertical;
}
.essay-form-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.essay-item {
  border-top: 1px solid var(--line);
  padding: 12px 0;
}
.essay-item-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.essay-meta {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}
.essay-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.essay-del {
  color: #a83c33;
}
.essay-prompt {
  font-size: 12.5px;
  color: var(--muted);
  margin: 8px 0 0;
}
.essay-body {
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink-2);
  white-space: pre-wrap;
  margin: 8px 0 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.essay-body-full {
  display: block;
  overflow: visible;
  -webkit-line-clamp: unset;
}

/* ---------- 单词趣味记忆：故事 / 谚语 / 近似 + 每日复习打卡 ---------- */
.story-wrap { display: flex; flex-direction: column; gap: 16px; }
.memory-mode-tabs { display: flex; gap: 10px; flex-wrap: wrap; }
.memory-mode-tab { display: flex; align-items: center; gap: 8px; padding: 10px 20px; border: 1px solid var(--line, #e5e7eb); border-radius: 12px; background: var(--panel, #fff); color: var(--muted, #6b7280); font-size: 15px; font-weight: 600; cursor: pointer; transition: all .2s; }
.memory-mode-tab:hover { border-color: var(--brand, #2f7d5d); }
.memory-mode-tab.on { background: var(--brand, #2f7d5d); color: #fff; border-color: var(--brand, #2f7d5d); box-shadow: var(--shadow-lift, 0 4px 14px rgba(0,0,0,.1)); }
.memory-mode-icon { font-size: 18px; }
.memory-mode-desc { margin: -6px 0 0; font-size: 13px; color: var(--muted, #6b7280); }
.memory-mode-tip {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--muted, #6b7280);
  background: color-mix(in srgb, var(--brand, #2f7d5d) 6%, transparent);
  border-radius: 8px;
  padding: 6px 10px;
}
/* 新增表单：模式徽章、模板按钮、格式说明 */
.story-form-mode {
  display: inline-block;
  margin-left: 10px;
  padding: 2px 9px;
  font-size: 12px;
  font-weight: 500;
  color: var(--brand, #2f7d5d);
  background: color-mix(in srgb, var(--brand, #2f7d5d) 10%, transparent);
  border-radius: 999px;
  vertical-align: middle;
}
.story-tpl-btn {
  margin-left: 10px;
  border: 1px solid color-mix(in srgb, var(--brand, #2f7d5d) 40%, transparent);
  background: transparent;
  color: var(--brand, #2f7d5d);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 12px;
  cursor: pointer;
}
.story-tpl-btn:hover { background: color-mix(in srgb, var(--brand, #2f7d5d) 10%, transparent); }
.story-form-note {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--muted, #6b7280);
  background: color-mix(in srgb, var(--brand, #2f7d5d) 5%, transparent);
  border-radius: 8px;
  padding: 8px 12px;
}
.story-form-note b { color: var(--brand, #2f7d5d); }

/* ---------- 标准填入：字段化输入 + 效果预览 ---------- */
.std-fill {
  margin: 6px 0 16px;
  padding: 14px 16px 12px;
  border: 1px solid color-mix(in srgb, var(--brand, #2f7d5d) 22%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--brand, #2f7d5d) 4%, transparent);
}
.std-fill-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.std-fill-head b { font-size: 14px; color: var(--brand, #2f7d5d); }
.std-fill-head span { font-size: 12px; color: var(--muted, #6b7280); }
.std-pair-list { display: flex; flex-direction: column; gap: 8px; }
.std-pair-row { display: flex; align-items: center; gap: 8px; }
.std-pair-row .input { flex: 1; min-width: 0; }
.std-pair-row .input:first-child { flex: 0 0 38%; }
.std-pair-del {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  line-height: 1;
  border-radius: 8px;
  border: 1px solid var(--line, #e5e7eb);
  background: transparent;
  color: var(--muted, #6b7280);
  font-size: 16px;
  cursor: pointer;
}
.std-pair-del:hover:not(:disabled) {
  border-color: #e5b4b4;
  color: #c0392b;
  background: #fdf2f2;
}
.std-pair-del:disabled { opacity: 0.35; cursor: not-allowed; }
.std-fill-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed color-mix(in srgb, var(--brand, #2f7d5d) 20%, transparent);
}
.std-preview {
  margin-top: 14px;
  padding: 12px 16px 14px;
  border: 1px dashed color-mix(in srgb, var(--brand, #2f7d5d) 32%, transparent);
  border-radius: 12px;
  background: var(--surface, #fff);
}
.std-preview-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.std-preview-head b { font-size: 13px; color: var(--brand, #2f7d5d); }
.std-preview-head .btn { margin-left: auto; }
.std-preview .story-body { padding: 4px 0 0; }

/* 记忆搜索：输入框、跨模式开关、命中高亮与摘要 */
.story-search {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.story-search-box {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 320px;
  max-width: 560px;
}
.story-search-icon {
  position: absolute;
  left: 12px;
  font-size: 14px;
  pointer-events: none;
  opacity: .6;
}
.story-search-box .story-search-input { padding-left: 34px; padding-right: 34px; }
.story-search-clear {
  position: absolute;
  right: 8px;
  border: none;
  background: transparent;
  color: var(--muted, #6b7280);
  font-size: 14px;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
}
.story-search-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--muted, #6b7280);
  cursor: pointer;
  white-space: nowrap;
}
.story-search-all input { accent-color: var(--brand, #2f7d5d); }
.story-search-count { font-size: 13px; color: var(--muted, #6b7280); }
.story-search-count b { color: var(--brand, #2f7d5d); }
.story-hl {
  background: rgba(245, 197, 24, .38);
  color: inherit;
  border-radius: 3px;
  padding: 0 2px;
}
.story-snippet {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted, #6b7280);
  background: color-mix(in srgb, var(--brand, #2f7d5d) 5%, transparent);
  border-left: 2px solid color-mix(in srgb, var(--brand, #2f7d5d) 35%, transparent);
  padding: 5px 10px;
  border-radius: 0 6px 6px 0;
}
.story-scope-badge {
  display: inline-block;
  padding: 1px 8px;
  font-size: 11.5px;
  color: var(--brand, #2f7d5d);
  border: 1px solid color-mix(in srgb, var(--brand, #2f7d5d) 35%, transparent);
  border-radius: 999px;
}
.story-cross-hint { margin: 10px 0 0; font-size: 12.5px; color: var(--muted, #6b7280); }
.story-builtin-badge { display: inline-block; font-size: 11px; color: var(--brand, #2f7d5d); background: color-mix(in srgb, var(--brand, #2f7d5d) 12%, transparent); border-radius: 6px; padding: 2px 8px; margin-left: 8px; vertical-align: middle; }
.story-form .banner { margin-bottom: 12px; }
.story-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.story-list { display: flex; flex-direction: column; gap: 16px; }
.story-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.story-card-title b { font-size: 16px; }
.story-meta { display: block; font-size: 12px; color: var(--muted, #6b7280); margin-top: 4px; }
.story-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.story-card-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--line, #e5e7eb); margin-top: 14px; padding-top: 12px; }

/* 正文排版：## 标题 / 幕名 / 段落 */
.story-body {
  margin-top: 14px;
  line-height: 1.9;
  font-size: 15px;
  color: var(--text, #1f2937);
}
.story-body :deep(.st-title) {
  font-size: 18px;
  font-weight: 700;
  margin: 4px 0 14px;
  color: var(--brand, #2f7d5d);
  cursor: pointer;
}
.story-body :deep(.st-title:hover) { text-decoration: underline dotted; }
.story-body :deep(.st-act) {
  font-size: 15px;
  font-weight: 700;
  color: var(--brand, #2f7d5d);
  background: color-mix(in srgb, var(--brand, #2f7d5d) 8%, transparent);
  border-left: 3px solid var(--brand, #2f7d5d);
  padding: 6px 12px;
  margin: 16px 0 8px;
  border-radius: 0 8px 8px 0;
}
.story-body :deep(.st-p) { margin: 8px 0; }
.story-body :deep(.st-word) {
  color: var(--brand, #2f7d5d);
  font-weight: 700;
  border-bottom: 1px dashed color-mix(in srgb, var(--brand, #2f7d5d) 45%, transparent);
  padding: 0 1px;
  cursor: pointer;
  transition: background .15s;
}
.story-body :deep(.st-word:hover) {
  background: color-mix(in srgb, var(--brand, #2f7d5d) 12%, transparent);
  border-radius: 4px;
}
/* 中文译文：翻转时用遮罩藏起来，保留占位不塌行 */
.story-body :deep(.st-gloss) {
  color: var(--muted, #6b7280);
  transition: color .2s, background .2s;
  border-radius: 4px;
  padding: 0 2px;
}
.story-body :deep(.st-gloss.is-hidden) {
  color: transparent;
  background: color-mix(in srgb, var(--muted, #6b7280) 26%, transparent);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--muted, #6b7280) 45%, transparent);
  user-select: none;
}
</style>
