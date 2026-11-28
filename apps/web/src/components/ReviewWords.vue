<script setup lang="ts">
/**
 * 复习单词：把大词表拆成小块，复用「灰 → 绿 → 黄 → 红」记忆法。
 * 两大区域：教材单词（10 单元）/ 题目单词（词法 8 类，句法暂未开放）。
 * 词条来自照片 OCR 识别：识别后全部初始为灰色，进入某块后做第一次选择。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { get, post, del, errorMessage } from '@/api/client';
import { compressImage } from '@/lib/upload';
import {
  TEXTBOOK_UNITS, MORPHOLOGY_GROUPS, SYNTAX_GROUPS,
  type ReviewStatus, type ReviewGroup,
} from '@tutor/shared';

type View = 'home' | 'group';
type Area = 'textbook' | 'question';
type Part = 'morphology' | 'syntax';
type Filter = 'all' | 'gray' | 'green' | 'yellow' | 'red' | 'phrase';

interface ReviewWord {
  id: number;
  groupKey: string;
  term: string;
  meaning: string;
  kind: 'word' | 'phrase';
  status: ReviewStatus;
  builtin: boolean;
}
interface GroupStat {
  key: string; total: number; gray: number; green: number; yellow: number; red: number;
}
interface OcrItem { term: string; meaning: string; kind: 'word' | 'phrase' }

const area = ref<Area>('textbook');
const part = ref<Part>('morphology');
const view = ref<View>('home');
const current = ref<ReviewGroup | null>(null);

const stats = ref<GroupStat[]>([]);
const words = ref<ReviewWord[]>([]);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const filter = ref<Filter>('all');
const showMeaning = ref(false);
const speakingId = ref<number | null>(null);

/** 区域网格当前显示的小块 */
const groups = computed<ReviewGroup[]>(() => {
  if (area.value === 'textbook') return TEXTBOOK_UNITS;
  return part.value === 'syntax' ? SYNTAX_GROUPS : MORPHOLOGY_GROUPS;
});

function statOf(key: string): GroupStat {
  return stats.value.find((s) => s.key === key) ?? { key, total: 0, gray: 0, green: 0, yellow: 0, red: 0 };
}

/** 单个小块的掌握进度（已选 = 绿黄红） */
function progress(s: GroupStat): number {
  if (!s.total) return 0;
  return Math.round(((s.green + s.yellow + s.red) / s.total) * 100);
}

// ---------- 数据加载 ----------
async function loadStats() {
  try {
    const res = await get<{ groups: GroupStat[] }>('/vocab/review/groups');
    stats.value = res.groups;
  } catch (err) { error.value = errorMessage(err); }
}

async function openGroup(g: ReviewGroup) {
  if (g.disabled) return;
  current.value = g;
  view.value = 'group';
  filter.value = 'all';
  await loadWords();
}

async function loadWords() {
  if (!current.value) return;
  loading.value = true; error.value = '';
  try {
    const res = await get<{ words: ReviewWord[] }>(`/vocab/review/words?group=${encodeURIComponent(current.value.key)}`);
    words.value = res.words;
  } catch (err) { error.value = errorMessage(err); }
  finally { loading.value = false; }
}

function goHome() {
  view.value = 'home';
  current.value = null;
  notice.value = '';
  loadStats();
}

const filtered = computed(() => {
  if (filter.value === 'all') return words.value;
  if (filter.value === 'phrase') return words.value.filter((w) => w.kind === 'phrase');
  return words.value.filter((w) => w.status === filter.value);
});

const counts = computed(() => ({
  total: words.value.length,
  gray: words.value.filter((w) => w.status === 'gray').length,
  green: words.value.filter((w) => w.status === 'green').length,
  yellow: words.value.filter((w) => w.status === 'yellow').length,
  red: words.value.filter((w) => w.status === 'red').length,
  phrase: words.value.filter((w) => w.kind === 'phrase').length,
}));

// ---------- 四色记忆法：单击循环 灰→绿→黄→红→灰 ----------
const CYCLE: ReviewStatus[] = ['gray', 'green', 'yellow', 'red'];
/** 防抖：连续点同一个词时合并请求，避免一秒发多次 */
const pending = new Map<number, ReviewStatus>();
let flushTimer: number | null = null;

async function flush() {
  flushTimer = null;
  const batch = [...pending.entries()];
  pending.clear();
  let failed = false;
  for (const [wordId, status] of batch) {
    try { await post('/vocab/review/mark', { wordId: Number(wordId), status }); }
    catch (err) { error.value = errorMessage(err); failed = true; }
  }
  // 失败时保留本地已点的颜色，不回滚，避免用户白点；下次操作会再尝试同步
  if (!failed) await loadStats();
}

function onClick(w: ReviewWord) {
  const i = CYCLE.indexOf(w.status);
  w.status = CYCLE[(i + 1) % CYCLE.length];
  pending.set(w.id, w.status);
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flush, 260);
}

/** 一键把当前筛选出来的词设为某个状态（例如「剩下的全标遗忘」） */
async function markVisible(status: ReviewStatus) {
  const targets = filtered.value.filter((w) => w.status !== status);
  if (!targets.length) return;
  if (flushTimer) { window.clearTimeout(flushTimer); flushTimer = null; }
  pending.clear();
  for (const w of targets) { w.status = status; pending.set(w.id, status); }
  await flush();
  notice.value = `已把 ${targets.length} 个词标为${STATUS_LABEL[status]}`;
  setTimeout(() => { notice.value = ''; }, 2600);
}

const STATUS_LABEL: Record<ReviewStatus, string> = {
  gray: '灰色（未选）', green: '熟悉', yellow: '模糊', red: '遗忘',
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'gray', label: '灰色未选' },
  { key: 'green', label: '熟悉' },
  { key: 'yellow', label: '模糊' },
  { key: 'red', label: '遗忘' },
  { key: 'phrase', label: '短语搭配' },
];

// ---------- 重置 ----------
async function resetGroup() {
  if (!current.value) return;
  if (!window.confirm(`把「${current.value.label}」的掌握状态全部重置为灰色？词条本身不会删除。`)) return;
  try {
    await post('/vocab/review/reset', { group: current.value.key });
    await loadWords(); await loadStats();
    notice.value = '已重置为全灰，可以重新做一轮选择';
    setTimeout(() => { notice.value = ''; }, 2600);
  } catch (err) { error.value = errorMessage(err); }
}

// ---------- 照片 OCR 导入 ----------
const fileInput = ref<HTMLInputElement | null>(null);
const ocrBusy = ref(false);
const ocrItems = ref<OcrItem[]>([]);
const ocrShow = ref(false);
const importing = ref(false);

function pickPhoto() { fileInput.value?.click(); }

async function onPhoto(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  ocrBusy.value = true; error.value = ''; notice.value = '';
  try {
    const image = await compressImage(file, 2.6 * 1024 * 1024, 2200);
    const res = await post<{ items: OcrItem[] }>('/vocab/review/ocr', { image });
    ocrItems.value = res.items;
    ocrShow.value = true;
    notice.value = `识别出 ${res.items.length} 条，请核对后再导入`;
  } catch (err) { error.value = errorMessage(err); }
  finally { ocrBusy.value = false; }
}

function removeOcrItem(i: number) { ocrItems.value.splice(i, 1); }

async function confirmImport() {
  if (!current.value || !ocrItems.value.length) return;
  importing.value = true; error.value = '';
  try {
    const res = await post<{ inserted: number }>('/vocab/review/import', {
      group: current.value.key,
      items: ocrItems.value.filter((x) => x.term.trim()),
    });
    ocrShow.value = false;
    ocrItems.value = [];
    await loadWords(); await loadStats();
    notice.value = `导入成功，新增 ${res.inserted} 条（重复的已跳过），全部为灰色`;
    setTimeout(() => { notice.value = ''; }, 3200);
  } catch (err) { error.value = errorMessage(err); }
  finally { importing.value = false; }
}

// ---------- 手动补一条 ----------
const manualTerm = ref('');
const manualMeaning = ref('');
async function addManual() {
  const term = manualTerm.value.trim();
  if (!term || !current.value) return;
  try {
    await post('/vocab/review/import', {
      group: current.value.key,
      items: [{ term, meaning: manualMeaning.value.trim(), kind: /\s/.test(term) ? 'phrase' : 'word' }],
    });
    manualTerm.value = ''; manualMeaning.value = '';
    await loadWords(); await loadStats();
  } catch (err) { error.value = errorMessage(err); }
}

// ---------- 删除个人词条 ----------
async function removeWord(w: ReviewWord) {
  if (w.builtin) return;
  if (!window.confirm(`删除「${w.term}」？`)) return;
  try {
    await del(`/vocab/review/words/${w.id}`);
    await loadWords(); await loadStats();
  } catch (err) { error.value = errorMessage(err); }
}

// ---------- 朗读 ----------
const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;
function speak(text: string, id: number) {
  if (!ttsSupported || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US'; u.rate = 0.85;
  speakingId.value = id;
  u.onend = () => { speakingId.value = null; };
  u.onerror = () => { speakingId.value = null; };
  window.speechSynthesis.speak(u);
}

onMounted(loadStats);
onBeforeUnmount(() => { if (flushTimer) window.clearTimeout(flushTimer); window.speechSynthesis?.cancel(); });
</script>

<template>
  <section class="review">
    <!-- ========== 首页：两大区域 + 小块网格 ========== -->
    <template v-if="view === 'home'">
      <div class="rv-area-tabs">
        <button class="rv-area-tab" :class="{ on: area === 'textbook' }" type="button" @click="area = 'textbook'">
          教材单词 <span class="rv-area-sub">10 个单元</span>
        </button>
        <button class="rv-area-tab" :class="{ on: area === 'question' }" type="button" @click="area = 'question'">
          题目单词 <span class="rv-area-sub">词法 / 句法</span>
        </button>
      </div>

      <!-- 题目单词再分词法 / 句法 -->
      <div v-if="area === 'question'" class="rv-part-tabs">
        <button class="rv-part-tab" :class="{ on: part === 'morphology' }" type="button" @click="part = 'morphology'">词法</button>
        <button class="rv-part-tab" :class="{ on: part === 'syntax' }" type="button" @click="part = 'syntax'">句法</button>
      </div>

      <div v-if="area === 'question' && part === 'syntax'" class="rv-coming">
        <div class="rv-coming-icon">§</div>
        <h3>句法部分还没开放</h3>
        <p>这部分我还没学到，等学完再往里加词条。现在先把词法的八类过一遍。</p>
      </div>

      <div v-else class="rv-grid">
        <button
          v-for="g in groups" :key="g.key"
          class="rv-card" :class="{ disabled: g.disabled }" type="button"
          :disabled="g.disabled" @click="openGroup(g)"
        >
          <div class="rv-card-top">
            <span class="rv-card-label">{{ g.label }}</span>
            <span class="rv-card-count">{{ statOf(g.key).total }} 词</span>
          </div>
          <div class="rv-card-bar"><div class="rv-card-bar-fill" :style="{ width: progress(statOf(g.key)) + '%' }" /></div>
          <div class="rv-card-dots">
            <span class="rv-dot rv-dot-green" />{{ statOf(g.key).green }}
            <span class="rv-dot rv-dot-yellow" />{{ statOf(g.key).yellow }}
            <span class="rv-dot rv-dot-red" />{{ statOf(g.key).red }}
            <span class="rv-card-gray">灰 {{ statOf(g.key).gray }}</span>
          </div>
          <div class="rv-card-foot">{{ statOf(g.key).total ? `已选 ${progress(statOf(g.key))}%` : '暂无词条 · 可上传照片' }} <span aria-hidden="true">→</span></div>
        </button>
      </div>

      <p class="rv-tip">教材词表由照片识别后内置；你也可以进入任意一块，用「上传照片」继续往里加词。同一块内重复的词会自动跳过。</p>
    </template>

    <!-- ========== 词墙：某一个小块 ========== -->
    <template v-else-if="current">
      <div class="rv-back-wrap">
        <button class="rv-back" type="button" @click="goHome">← 返回{{ area === 'textbook' ? '教材单词' : '题目词法' }}</button>
        <span class="rv-current-title">{{ current.label }}</span>
      </div>

      <div class="rv-stats">
        <div class="rv-stat"><b>{{ counts.total }}</b><span>总词条</span></div>
        <div class="rv-stat rv-s-gray"><b>{{ counts.gray }}</b><span>灰色未选</span></div>
        <div class="rv-stat rv-s-green"><b>{{ counts.green }}</b><span>熟悉</span></div>
        <div class="rv-stat rv-s-yellow"><b>{{ counts.yellow }}</b><span>模糊</span></div>
        <div class="rv-stat rv-s-red"><b>{{ counts.red }}</b><span>遗忘</span></div>
      </div>

      <div class="rv-toolbar">
        <div class="rv-filters">
          <button v-for="f in FILTERS" :key="f.key" class="rv-chip" :class="{ on: filter === f.key }" type="button" @click="filter = f.key">
            {{ f.label }}<span v-if="f.key !== 'all' && f.key !== 'phrase'" class="rv-chip-n">{{ counts[f.key as 'gray'|'green'|'yellow'|'red'] }}</span>
            <span v-else-if="f.key === 'phrase'" class="rv-chip-n">{{ counts.phrase }}</span>
          </button>
        </div>
        <div class="rv-actions">
          <button class="rv-btn" type="button" :disabled="ocrBusy" @click="pickPhoto">📷 {{ ocrBusy ? '识别中…' : '上传照片导入' }}</button>
          <button class="rv-btn" :class="{ on: showMeaning }" type="button" @click="showMeaning = !showMeaning">{{ showMeaning ? '隐藏释义' : '显示释义' }}</button>
          <button class="rv-btn" type="button" @click="resetGroup">重置本组</button>
        </div>
        <input ref="fileInput" class="rv-file" type="file" accept="image/*" @change="onPhoto" />
      </div>

      <div class="rv-bulk">
        <span>把当前列表里的词一键标为：</span>
        <button type="button" class="rv-bulk-b rv-bulk-green" @click="markVisible('green')">全熟悉</button>
        <button type="button" class="rv-bulk-b rv-bulk-yellow" @click="markVisible('yellow')">全模糊</button>
        <button type="button" class="rv-bulk-b rv-bulk-red" @click="markVisible('red')">全遗忘</button>
        <button type="button" class="rv-bulk-b" @click="markVisible('gray')">全回灰</button>
      </div>

      <div v-if="notice" class="rv-notice">{{ notice }}</div>
      <div v-if="error" class="rv-error">{{ error }}</div>

      <div v-if="loading" class="rv-empty">加载中…</div>
      <div v-else-if="!words.length" class="rv-empty">
        <p>这一块还没有词条。</p>
        <p class="rv-empty-sub">点上面的「上传照片导入」，把手写单词表拍进来，识别后会自动全部呈现灰色。</p>
      </div>
      <div v-else-if="!filtered.length" class="rv-empty">这个筛选下没有词条，换个筛选看看。</div>

      <div v-else class="rv-wall">
        <div
          v-for="w in filtered" :key="w.id"
          class="rv-word" :class="['rv-' + w.status, { phrase: w.kind === 'phrase' }]"
          :title="showMeaning ? w.meaning : '单击切换掌握状态；点喇叭朗读'"
          @click="onClick(w)"
        >
          <span class="rv-word-term">{{ w.term }}</span>
          <span v-if="w.kind === 'phrase'" class="rv-word-kind">短语</span>
          <span v-if="showMeaning && w.meaning" class="rv-word-meaning">{{ w.meaning }}</span>
          <button class="rv-word-speak" type="button" title="朗读" @click.stop="speak(w.term, w.id)">🔊</button>
          <button v-if="!w.builtin" class="rv-word-del" type="button" title="删除" @click.stop="removeWord(w)">×</button>
        </div>
      </div>

      <!-- 手动补一条（OCR 漏识别时用） -->
      <div class="rv-manual">
        <input v-model="manualTerm" class="input" placeholder="补一个词/短语，如 at the cost of" @keydown.enter="addManual" />
        <input v-model="manualMeaning" class="input" placeholder="中文释义（可空）" @keydown.enter="addManual" />
        <button class="rv-btn" type="button" @click="addManual">添加</button>
      </div>

      <!-- OCR 识别结果确认弹层 -->
      <div v-if="ocrShow" class="rv-modal-mask" @click.self="ocrShow = false">
        <div class="rv-modal">
          <h3>核对识别结果</h3>
          <p class="rv-modal-sub">共 {{ ocrItems.length }} 条。手写体可能认错，可以直接改文字、删掉多余行；确认后导入全部为灰色。</p>
          <div class="rv-ocr-list">
            <div v-for="(it, i) in ocrItems" :key="i" class="rv-ocr-row">
              <input v-model="it.term" class="input" placeholder="英文词条" />
              <input v-model="it.meaning" class="input" placeholder="中文释义" />
              <button class="rv-ocr-kind" type="button" @click="it.kind = it.kind === 'phrase' ? 'word' : 'phrase'">{{ it.kind === 'phrase' ? '短语' : '单词' }}</button>
              <button class="rv-ocr-del" type="button" @click="removeOcrItem(i)">×</button>
            </div>
          </div>
          <div class="rv-modal-foot">
            <button class="rv-btn" type="button" @click="ocrShow = false">取消</button>
            <button class="rv-btn rv-btn-primary" type="button" :disabled="importing" @click="confirmImport">{{ importing ? '导入中…' : `确认导入 ${ocrItems.length} 条` }}</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.review { padding: 4px 0 10px; }
.rv-head { margin-bottom: 18px; }
.eyebrow { font-size: 12px; letter-spacing: .12em; color: var(--terra, #b45f3b); font-weight: 600; }
.rv-title { font-family: var(--serif); font-size: 26px; margin: 4px 0 8px; color: var(--ink); }
.rv-desc { font-size: 13.5px; color: var(--ink-2); line-height: 1.7; max-width: 760px; margin: 0; }

.rv-area-tabs { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
.rv-area-tab {
  padding: 12px 20px; border: 1px solid var(--line-strong); border-radius: 10px;
  background: var(--panel); color: var(--ink-2); font-family: var(--sans); font-size: 15px;
  font-weight: 600; cursor: pointer; transition: all .16s ease;
}
.rv-area-tab:hover { border-color: var(--accent); }
.rv-area-tab.on { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: var(--shadow-lift); }
.rv-area-sub { display: block; font-size: 11.5px; font-weight: 400; opacity: .75; margin-top: 3px; }

.rv-part-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.rv-part-tab {
  padding: 7px 20px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--panel-soft); color: var(--ink-2); font-size: 13px; cursor: pointer;
}
.rv-part-tab.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); font-weight: 600; }

.rv-coming {
  text-align: center; padding: 54px 20px; border: 1px dashed var(--line-strong);
  border-radius: 14px; background: var(--panel-soft); color: var(--ink-2);
}
.rv-coming-icon { font-size: 40px; color: var(--line-strong); margin-bottom: 8px; }
.rv-coming h3 { font-family: var(--serif); font-size: 19px; margin: 0 0 8px; color: var(--ink); }
.rv-coming p { font-size: 13px; margin: 0; }

.rv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.rv-card {
  text-align: left; padding: 15px 16px 13px; border: 1px solid var(--line);
  border-radius: 12px; background: var(--panel); cursor: pointer; font-family: var(--sans);
  transition: border-color .16s ease, box-shadow .16s ease, transform .1s ease;
}
.rv-card:hover { border-color: var(--accent); box-shadow: var(--shadow-lift); transform: translateY(-2px); }
.rv-card.disabled { opacity: .5; cursor: not-allowed; }
.rv-card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rv-card-label { font-family: var(--serif); font-size: 17px; font-weight: 600; color: var(--ink); }
.rv-card-count { font-size: 12px; color: var(--muted); white-space: nowrap; }
.rv-card-bar { height: 5px; border-radius: 999px; background: var(--bg-deep); margin: 12px 0 9px; overflow: hidden; }
.rv-card-bar-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width .3s; }
.rv-card-dots { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-2); }
.rv-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 6px; }
.rv-dot:first-child { margin-left: 0; }
.rv-dot-green { background: #8cc6a4; } .rv-dot-yellow { background: #e8c46a; } .rv-dot-red { background: #e39a8d; }
.rv-card-gray { margin-left: auto; color: var(--muted); }
.rv-card-foot { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; }

.rv-tip { margin: 16px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.7; }

/* 词墙 */
.rv-back-wrap { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
.rv-back { padding: 7px 14px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); color: var(--ink-2); font-size: 13px; cursor: pointer; font-family: var(--sans); }
.rv-back:hover { border-color: var(--accent); color: var(--accent); }
.rv-current-title { font-family: var(--serif); font-size: 20px; color: var(--ink); font-weight: 600; }

.rv-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 16px; }
.rv-stat { padding: 12px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); text-align: center; }
.rv-stat b { display: block; font-size: 21px; color: var(--ink); font-family: var(--mono); }
.rv-stat span { font-size: 11.5px; color: var(--muted); }
.rv-s-gray b { color: #7d8782; } .rv-s-green b { color: #1e5a3c; } .rv-s-yellow b { color: #a9761b; } .rv-s-red b { color: #a83c33; }

.rv-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.rv-filters { display: flex; gap: 6px; flex-wrap: wrap; }
.rv-chip { padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--ink-2); font-size: 12.5px; cursor: pointer; font-family: var(--sans); }
.rv-chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.rv-chip-n { margin-left: 6px; opacity: .7; font-family: var(--mono); font-size: 11px; }
.rv-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.rv-btn { padding: 7px 13px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); color: var(--ink-2); font-size: 12.5px; cursor: pointer; font-family: var(--sans); white-space: nowrap; }
.rv-btn:hover { border-color: var(--accent); color: var(--accent); }
.rv-btn.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.rv-btn:disabled { opacity: .55; cursor: not-allowed; }
.rv-btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.rv-btn-primary:hover { color: #fff; opacity: .9; }
.rv-file { display: none; }

.rv-bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.rv-bulk-b { padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-soft); color: var(--ink-2); cursor: pointer; font-size: 12px; }
.rv-bulk-green:hover { border-color: #8cc6a4; color: #1e5a3c; }
.rv-bulk-yellow:hover { border-color: #e8c46a; color: #a9761b; }
.rv-bulk-red:hover { border-color: #e39a8d; color: #a83c33; }

.rv-notice, .rv-error { padding: 9px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
.rv-notice { background: var(--accent-soft); color: var(--accent-dark); }
.rv-error { background: var(--danger-soft); color: var(--danger); }
.rv-empty { padding: 46px 20px; text-align: center; color: var(--muted); font-size: 14px; border: 1px dashed var(--line-strong); border-radius: 12px; }
.rv-empty-sub { font-size: 12.5px; margin-top: 6px; }

.rv-wall { display: flex; flex-wrap: wrap; gap: 7px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-soft); }
.rv-word {
  position: relative; display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border: 1px solid var(--line-strong); border-radius: 8px;
  background: var(--panel); color: #55605b; font-size: 13.5px; line-height: 1.3;
  cursor: pointer; user-select: none; font-family: var(--sans);
  transition: background .12s, border-color .12s, transform .08s;
}
.rv-word:hover { transform: translateY(-1px); border-color: var(--ink-2); }
.rv-word.phrase { border-style: dashed; }
.rv-word-term { font-weight: 500; }
.rv-word-kind { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--blue-soft); color: var(--blue); }
.rv-word-meaning { color: var(--muted); font-size: 11.5px; margin-left: 2px; }
.rv-word-speak, .rv-word-del { border: none; background: transparent; cursor: pointer; font-size: 11px; padding: 0 2px; opacity: .45; line-height: 1; }
.rv-word-speak:hover, .rv-word-del:hover { opacity: 1; }
.rv-word-del { font-size: 15px; }
.rv-gray { background: var(--panel); border-color: var(--line-strong); color: #55605b; }
.rv-green { background: #dff2e6; border-color: #8cc6a4; color: #1e5a3c; }
.rv-yellow { background: #fdf1cc; border-color: #e8c46a; color: #6b4d0d; }
.rv-red { background: #fdeae6; border-color: #e39a8d; color: #a33d31; }

.rv-manual { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.rv-manual .input { flex: 1; min-width: 160px; }

/* OCR 确认弹层 */
.rv-modal-mask { position: fixed; inset: 0; background: rgba(20, 30, 28, .48); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 16px; }
.rv-modal { width: min(720px, 96vw); max-height: 86vh; display: flex; flex-direction: column; background: var(--panel); border-radius: 14px; padding: 22px; box-shadow: var(--shadow-lift); }
.rv-modal h3 { font-family: var(--serif); font-size: 19px; margin: 0 0 6px; color: var(--ink); }
.rv-modal-sub { font-size: 12.5px; color: var(--muted); margin: 0 0 14px; line-height: 1.6; }
.rv-ocr-list { overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 6px; }
.rv-ocr-row { display: grid; grid-template-columns: 1.2fr 1fr 62px 28px; gap: 6px; align-items: center; }
.rv-ocr-row .input { font-size: 13px; padding: 7px 9px; }
.rv-ocr-kind { padding: 6px 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-soft); color: var(--blue); font-size: 11.5px; cursor: pointer; }
.rv-ocr-del { border: none; background: transparent; color: var(--danger); font-size: 19px; cursor: pointer; }
.rv-modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }

@media (max-width: 640px) {
  .rv-stats { grid-template-columns: repeat(3, 1fr); }
  .rv-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .rv-card { padding: 12px; }
  .rv-wall { padding: 11px; gap: 6px; }
  .rv-word { font-size: 12.5px; padding: 6px 9px; }
  .rv-ocr-row { grid-template-columns: 1fr 1fr 54px 24px; }
  .rv-toolbar { align-items: stretch; }
  .rv-actions { width: 100%; }
}
</style>
