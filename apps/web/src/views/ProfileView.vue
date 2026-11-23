<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { UserProfile } from '@tutor/shared';
import { errorMessage, get, patch, post } from '@/api/client';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';

const LEVELS = [
  { key: 'weak', label: '弱', desc: '不及格' },
  { key: 'medium', label: '中', desc: '100 分左右' },
  { key: 'strong', label: '强', desc: '120 分以上' },
] as const;
type SelfLevel = (typeof LEVELS)[number]['key'];

const SUBJECTS = [
  { key: 'math', name: '高等数学', teacher: '宋浩老师', initial: '宋', tone: 'math' },
  { key: 'english', name: '大学英语', teacher: '刘晓艳老师', initial: '艳', tone: 'english' },
] as const;
type SubjectKey = (typeof SUBJECTS)[number]['key'];

/** 来自 /vocab 单词测试记录的词汇概况（英语评价的数据源） */
interface VocabSnapshot {
  rounds: number;
  latestRoundNo: number;
  latestAt: string;
  words: number;
  green: number;
  yellow: number;
  red: number;
  greenPct: number;
  yellowPct: number;
  redPct: number;
  greenTrend: number;
  recent: { roundNo: number; green: number; yellow: number; red: number }[];
}

const loading = ref(true);
const saving = ref(false);
const refreshing = ref(false);
const error = ref('');
const notice = ref('');
const profile = ref<UserProfile | null>(null);
const vocab = ref<VocabSnapshot | null>(null);
/** 英语错题按《库课·大学英语》笔记章节的分布（错题数据到位后自动出现） */
const englishChapters = ref<{ chapter: string; count: number }[]>([]);

const targetScore = ref<number>(120);
const selfLevel = ref<SelfLevel>('medium');
const targetText = ref('');
const weakKpText = ref('');

/**
 * 计算画像完整度：目标分、自评水平、薄弱考点、考试记录、词汇记录各占 20%。
 * @returns 0~100 的完整度整数百分比
 */
const completeness = computed(() => {
  let n = 0;
  if (targetScore.value > 0) n += 1;
  if (selfLevel.value) n += 1;
  if (weakKpText.value.trim()) n += 1;
  if (profile.value?.examEvents?.length) n += 1;
  if (vocab.value) n += 1;
  return Math.round((n / 5) * 100);
});

/** 是否有任一科的评价可展示（数学靠考试、英语靠考试或单词记录） */
const hasAnyNarrative = computed(() =>
  Boolean(profile.value?.narratives?.math || profile.value?.narratives?.english),
);

/** 考试记录列表的只读别名，画像未加载时回退为空数组。 */
const examEvents = computed(() => profile.value?.examEvents ?? []);

/**
 * 从全部考试记录中筛选指定科目的记录。
 * @param subject 科目标识（math / english）
 * @returns 该科目的考试记录数组
 */
function eventsOf(subject: SubjectKey) {
  return examEvents.value.filter((e) => e.subject === subject);
}

/**
 * 取指定科目最近一次考试的得分。
 * @param subject 科目标识
 * @returns 最近一次得分；该科无考试记录时为 null
 */
function lastScore(subject: SubjectKey) {
  const list = eventsOf(subject);
  return list.length ? list[list.length - 1].score : null;
}

/**
 * 计算指定科目最近一次考试相对首次考试的分数变化（保留一位小数）。
 * @param subject 科目标识
 * @returns 成绩变化值；不足两次记录时为 null
 */
function trend(subject: SubjectKey) {
  const list = eventsOf(subject);
  if (list.length < 2) return null;
  return Math.round((list[list.length - 1].score - list[0].score) * 10) / 10;
}

/**
 * 汇总全部考试记录中的失分知识点，按出现次数降序取前 12 个，形成高频失分榜。
 * @returns [知识点, 失分次数] 二元组数组
 */
const lostKpRanking = computed(() => {
  const map = new Map<string, number>();
  for (const e of examEvents.value) {
    for (const kp of e.lostKps ?? []) map.set(kp, (map.get(kp) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
});

/**
 * 把后端返回的用户画像写入本地状态，并回填目标分、自评水平、目标院校与薄弱考点等表单项。
 * @param data 后端返回的用户画像
 */
function hydrate(data: UserProfile) {
  profile.value = data;
  const labels = data.labels ?? {};
  targetScore.value = Number(labels.target_score ?? 120);
  selfLevel.value = (['weak', 'medium', 'strong'].includes(String(labels.self_level))
    ? labels.self_level
    : 'medium') as SelfLevel;
  targetText.value = String(labels.target ?? '');
  weakKpText.value = Array.isArray(labels.weak_kp) ? labels.weak_kp.join('、') : '';
}

/**
 * 页面初始化加载，组件挂载后由 onMounted 调用，也用于错误态重试。
 * 并行请求用户画像与词汇概况；若已有词汇测试记录但英语评价缺失，会额外请求一次按词汇记录生成的英语点评（失败不影响主数据）。
 */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [data, vocabData, chapterStats] = await Promise.all([
      get<UserProfile>('/profile'),
      get<VocabSnapshot>('/profile/vocab-snapshot').catch(() => null),
      get<{ chapters: { chapter: string; count: number }[] }>('/questions/stats?subject=english').catch(() => null),
    ]);
    hydrate(data);
    vocab.value = vocabData;
    englishChapters.value = chapterStats?.chapters ?? [];
    // 有单词测试记录、但英语还没生成评价时，自动按词汇记录生成一次（不等英语考试）
    // 点评是锦上添花：生成失败不能把已经拿到的画像数据整页替换成错误态
    if (vocabData && vocabData.rounds > 0 && !data.narratives?.english) {
      try {
        hydrate(await post<UserProfile>('/profile/refresh', { subjects: ['english'] }));
      } catch {
        /* 保留主数据，用户可点「按考试记录重新生成」再试 */
      }
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/**
 * 保存目标设置处理器，点击「保存并更新画像」按钮时触发。
 * 先 PATCH /profile 持久化目标分、自评水平、院校与薄弱考点，再调用 refresh(false) 让老师重算画像。
 */
async function save() {
  saving.value = true;
  notice.value = '';
  error.value = '';
  try {
    const data = await patch<UserProfile>('/profile', {
      labels: {
        target_score: targetScore.value,
        self_level: selfLevel.value,
        target: targetText.value.trim(),
        weak_kp: weakKpText.value
          .split(/[,，、\s]+/)
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 30),
      },
    });
    hydrate(data);
    notice.value = '已保存，正在让老师根据考试与单词记录更新画像…';
    await refresh(false);
    notice.value = '已保存，老师画像已更新。';
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}

/**
 * 重新生成老师画像处理器，点击「按考试记录重新生成」按钮或保存后自动调用。
 * 调用 POST /profile/refresh 让老师按考试分数、失分知识点与单词记录重算两科评价。
 * @param showNotice 完成后是否显示成功提示，默认 true
 */
async function refresh(showNotice = true) {
  refreshing.value = true;
  try {
    const data = await post<UserProfile>('/profile/refresh', { subjects: ['math', 'english'] });
    hydrate(data);
    if (showNotice) notice.value = '画像已根据考试分数、失分知识点与单词记录重新生成。';
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    refreshing.value = false;
  }
}

/**
 * 把时间字符串格式化为 YYYY-MM-DD，用于考试日期与画像更新时间的展示。
 * @param value ISO 时间字符串，可为空
 * @returns 格式化后的日期；入参为空时返回空串
 */
function formatDate(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

onMounted(load);
</script>

<template>
  <div class="page page-wide profile-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">学习画像 · 由考试成绩驱动</div>
        <h1 class="page-title">学习画像</h1>
        <p class="page-desc">
          先填目标分和当前水平。之后数学按闭卷考试的分数与失分知识点画像；英语结合单词测试记录、错题分布与考试失分考点（按《库课·大学英语》笔记章节），由宋浩老师和刘晓艳老师给出点评。
        </p>
      </div>
      <div class="completeness" :title="`画像完整度 ${completeness}%`">
        <svg viewBox="0 0 44 44" width="44" height="44">
          <circle cx="22" cy="22" r="18" class="ring-bg" />
          <circle
            cx="22"
            cy="22"
            r="18"
            class="ring-fg"
            :stroke-dasharray="`${(completeness / 100) * 113} 113`"
          />
        </svg>
        <span class="small muted">{{ completeness }}%</span>
      </div>
    </header>

    <div v-if="notice" class="banner-warn">{{ notice }}</div>
    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" @retry="load" />

    <template v-else>
      <section class="card setup-card">
        <div class="section-head">
          <h3>先告诉我你的目标</h3>
          <span class="small muted">这两项会直接影响老师的点评口径</span>
        </div>
        <div class="setup-grid">
          <div class="field">
            <label for="target-score">目标分数（每科满分 150）</label>
            <div class="score-input">
              <input id="target-score" v-model.number="targetScore" type="number" min="0" max="150" step="5" />
              <span class="small muted">/ 150</span>
            </div>
            <p class="hint">例如 120，老师会按差距给出提分安排。</p>
          </div>
          <div class="field">
            <label>你现在觉得自己是</label>
            <div class="level-group">
              <button
                v-for="lv in LEVELS"
                :key="lv.key"
                type="button"
                class="level-btn"
                :class="{ active: selfLevel === lv.key }"
                @click="selfLevel = lv.key"
              >
                <b>{{ lv.label }}</b>
                <span class="small muted">{{ lv.desc }}</span>
              </button>
            </div>
          </div>
          <div class="field">
            <label for="target-text">目标院校（可选）</label>
            <input id="target-text" v-model="targetText" type="text" placeholder="例如：长沙理工" />
          </div>
          <div class="field">
            <label for="weak-kp">已知薄弱考点（可选）</label>
            <input id="weak-kp" v-model="weakKpText" type="text" placeholder="例如：1.6, 2.3, E1.9" />
          </div>
        </div>
        <div class="setup-actions">
          <button type="button" class="btn primary" :disabled="saving || refreshing" @click="save">
            {{ saving || refreshing ? '生成画像中…' : '保存并更新画像' }}
          </button>
          <button type="button" class="btn ghost" :disabled="refreshing" @click="refresh()">
            {{ refreshing ? '重新生成中…' : '按考试记录重新生成' }}
          </button>
        </div>
      </section>

      <section v-if="examEvents.length" class="card stats-card">
        <div class="section-head">
          <h3>考试表现</h3>
          <span class="small muted">共 {{ examEvents.length }} 次交卷记录</span>
        </div>
        <div class="stat-grid">
          <div v-for="s in SUBJECTS" :key="s.key" class="stat-card">
            <span class="small muted">{{ s.name }} · {{ s.teacher }}</span>
            <div class="stat-score">
              <b>{{ lastScore(s.key) ?? '—' }}</b>
              <span class="small muted">/ 150</span>
            </div>
            <div class="small">
              已考 {{ eventsOf(s.key).length }} 次
              <span v-if="trend(s.key) !== null" :class="trend(s.key)! >= 0 ? 'trend-up' : 'trend-down'">
                · 较首次 {{ trend(s.key)! >= 0 ? '+' : '' }}{{ trend(s.key) }} 分
              </span>
            </div>
          </div>
        </div>
        <div v-if="examEvents.length" class="recent-list">
          <div v-for="e in [...examEvents].reverse().slice(0, 6)" :key="e.id" class="recent-row">
            <span class="mono small">{{ formatDate(e.date) }}</span>
            <span class="small">{{ e.subject === 'math' ? '高等数学' : e.subject === 'english' ? '大学英语' : e.subject }}</span>
            <span class="mono small">{{ e.score }}/{{ e.maxScore }}</span>
            <span class="small muted kp-cell">{{ (e.lostKps ?? []).slice(0, 6).join('、') || '无失分考点' }}</span>
          </div>
        </div>
      </section>

      <section v-if="englishChapters.length" class="card kp-card">
        <div class="section-head">
          <h3>英语错题分布</h3>
          <span class="small muted">按《库课·大学英语》笔记章节</span>
        </div>
        <div class="kp-list">
          <div v-for="c in englishChapters" :key="c.chapter" class="kp-item">
            <span class="small">{{ c.chapter }}</span>
            <span class="small muted">{{ c.count }} 题</span>
          </div>
        </div>
      </section>

      <section v-if="lostKpRanking.length" class="card kp-card">
        <div class="section-head"><h3>高频失分知识点</h3><span class="small muted">来自全部考试记录</span></div>
        <div class="kp-list">
          <div v-for="([kp, n], i) in lostKpRanking" :key="kp" class="kp-item">
            <span class="kp-rank mono">{{ i + 1 }}</span>
            <span>{{ kp }}</span>
            <span class="small muted">失分 {{ n }} 次</span>
          </div>
        </div>
      </section>

      <section v-if="hasAnyNarrative" class="card narratives-card">
        <div class="section-head">
          <h3>老师画像</h3>
          <span class="small muted">英语 · 刘晓艳 ｜ 数学 · 宋浩</span>
        </div>
        <div class="narrative-grid">
          <article
            v-for="s in SUBJECTS"
            :key="s.key"
            v-show="s.key === 'english' ? Boolean(profile?.narratives?.english) : Boolean(profile?.narratives?.math)"
            class="narrative-card"
            :class="`tone-${s.tone}`"
          >
            <div class="narrative-head">
              <span class="teacher-initial">{{ s.initial }}</span>
              <div>
                <h4>{{ s.teacher }}</h4>
                <span class="small muted">{{ s.name }}</span>
              </div>
            </div>

            <!-- 英语：来自 /vocab 单词测试记录的词汇概况 -->
            <div v-if="s.key === 'english' && vocab" class="vocab-box">
              <div class="vocab-box-title">
                词汇记录 · 第 {{ vocab.latestRoundNo }} 轮
                <span class="small muted">{{ formatDate(vocab.latestAt) }}</span>
              </div>
              <div class="vocab-bar">
                <span class="vlab green">认识 {{ vocab.green }}</span>
                <span class="vlab yellow">模糊 {{ vocab.yellow }}</span>
                <span class="vlab red">遗忘 {{ vocab.red }}</span>
              </div>
              <div class="vocab-track">
                <i class="seg green" :style="{ width: vocab.greenPct + '%' }" />
                <i class="seg yellow" :style="{ width: vocab.yellowPct + '%' }" />
                <i class="seg red" :style="{ width: vocab.redPct + '%' }" />
              </div>
              <div class="small muted vocab-meta">
                共 {{ vocab.rounds }} 轮测试 · {{ vocab.words }} 词 ·
                熟悉词较首轮
                <b :class="vocab.greenTrend >= 0 ? 'trend-up' : 'trend-down'">
                  {{ vocab.greenTrend >= 0 ? '+' : '' }}{{ vocab.greenTrend }}
                </b>
              </div>
            </div>

            <template v-if="profile?.narratives?.[s.key]">
              <h5 class="nlabel good">优点 · 长处</h5>
              <ul>
                <li v-for="(x, i) in profile.narratives[s.key].strengths" :key="i">{{ x }}</li>
              </ul>
              <h5 class="nlabel bad">缺点 · 短处</h5>
              <ul>
                <li v-for="(x, i) in profile.narratives[s.key].weaknesses" :key="i">{{ x }}</li>
              </ul>
              <h5 class="nlabel">老师建议</h5>
              <p class="advice">{{ profile.narratives[s.key].advice }}</p>
              <p class="small muted generated">更新于 {{ formatDate(profile.narratives[s.key].generatedAt) }}</p>
            </template>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.profile-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
/* 卡片内容统一内边距，避免文字贴边像被切割 */
.profile-page > .card {
  padding: 22px 24px;
}
.vocab-box {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  padding: 12px 14px;
  margin-bottom: 6px;
}
.vocab-box-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 9px;
}
.vocab-bar {
  display: flex;
  gap: 14px;
  font-size: 12px;
  margin-bottom: 7px;
}
.vlab.green { color: #2f7d5b; }
.vlab.yellow { color: #a67c00; }
.vlab.red { color: #b14b42; }
.vocab-track {
  display: flex;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--line);
}
.vocab-track .seg { display: block; height: 100%; }
.vocab-track .seg.green { background: #4a9d78; }
.vocab-track .seg.yellow { background: #d0a329; }
.vocab-track .seg.red { background: #c25a50; }
.vocab-meta { margin-top: 8px; }
.vocab-meta b { font-family: var(--mono); }
.completeness {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.ring-bg {
  fill: none;
  stroke: var(--line);
  stroke-width: 4;
}
.ring-fg {
  fill: none;
  stroke: var(--accent);
  stroke-width: 4;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: 22px 22px;
}
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.section-head h3 {
  font-size: 16px;
}
.setup-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 20px;
}
.field label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 7px;
}
.field input[type='text'],
.field input[type='number'] {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--ink);
  padding: 9px 11px;
  font-size: 13px;
  font-family: var(--sans);
}
.hint {
  margin: 5px 0 0;
}
.score-input {
  display: flex;
  align-items: center;
  gap: 8px;
}
.score-input input {
  max-width: 130px;
}
.level-group {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.level-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel-soft);
  color: var(--ink);
  padding: 9px 6px;
  cursor: pointer;
}
.level-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-dark);
}
.level-btn b {
  font-size: 14px;
}
.setup-actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
  flex-wrap: wrap;
}
.empty-line {
  padding: 16px 2px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.stat-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  padding: 14px 16px;
}
.stat-score {
  margin: 8px 0 4px;
}
.stat-score b {
  font-size: 30px;
  font-family: var(--mono);
}
.trend-up {
  color: var(--ok, #2f7d5b);
}
.trend-down {
  color: var(--danger, #b14b42);
}
.recent-list {
  margin-top: 14px;
  border-top: 1px solid var(--line);
}
.recent-row {
  display: grid;
  grid-template-columns: 0.9fr 0.8fr 0.7fr 2.4fr;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px dashed var(--line);
  font-size: 12.5px;
}
.kp-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kp-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}
.kp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}
.kp-rank {
  color: var(--accent-dark);
  font-weight: 700;
}
.kp-item .small {
  margin-left: auto;
}
.narrative-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.narrative-card {
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--panel-soft);
  padding: 16px;
}
.narrative-card.tone-math {
  border-top: 3px solid var(--accent);
}
.narrative-card.tone-english {
  border-top: 3px solid #5b8c85;
}
.narrative-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.narrative-head h4 {
  margin: 0 0 2px;
  font-size: 15px;
}
.teacher-initial {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-family: var(--serif);
}
.nlabel {
  font-size: 12px;
  margin: 12px 0 5px;
}
.nlabel.good {
  color: var(--ok, #2f7d5b);
}
.nlabel.bad {
  color: var(--danger, #b14b42);
}
.narrative-card ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.75;
}
.advice {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
}
.generated {
  margin: 10px 0 0;
}
@media (max-width: 860px) {
  .setup-grid,
  .narrative-grid {
    grid-template-columns: 1fr;
  }
  .recent-row {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
