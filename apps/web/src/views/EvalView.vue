<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ExamPaper, ExamPaperSummary, UserProfile } from '@tutor/shared';
import { errorMessage, get, post } from '@/api/client';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';

const router = useRouter();

// 前端只开放英语、数学；专业科目（cs）保留在后端 subject 枚举里，界面暂不渲染。
const SUBJECTS = [
  {
    key: 'math',
    name: '高等数学',
    teacher: '宋浩老师',
    initial: '宋',
    spec: '单选 12 题 × 5 分 · 填空 4 题 × 4 分 · 计算 6 题 74 分',
    meta: '满分 150 分 · 120 分钟 · 闭卷',
  },
  {
    key: 'english',
    name: '大学英语',
    teacher: '刘晓艳老师',
    initial: '艳',
    spec: '湖南专升本大学英语标准卷型',
    meta: '满分 150 分 · 120 分钟 · 闭卷',
  },
] as const;
type SubjectKey = (typeof SUBJECTS)[number]['key'];

interface PoolStats {
  questions: { total: number; unused: number };
  variants: { total: number; unused: number };
}

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
const error = ref('');
const notice = ref('');
const generating = ref('');
const papers = ref<ExamPaperSummary[]>([]);
const profile = ref<UserProfile | null>(null);
const vocab = ref<VocabSnapshot | null>(null);
const pools = ref<Record<string, PoolStats>>({});
const narrativeSubject = ref<SubjectKey>('math');
const reloadKey = ref(0);

/** 已交卷的试卷列表，按交卷时间倒序排列。 */
const submitted = computed(() =>
  papers.value
    .filter((p) => Boolean(p.submittedAt))
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt))),
);

/**
 * 把科目 key 转成中文显示名，未知 key 原样返回。
 * @param key 科目标识
 * @returns 科目中文名
 */
function subjectName(key: string) {
  return SUBJECTS.find((s) => s.key === key)?.name ?? key;
}

/**
 * 统计某科目的参考次数与最近一次试卷。
 * @param key 科目标识
 * @returns 含参考次数与最近试卷的对象
 */
function statsFor(key: string) {
  return {
    count: submitted.value.filter((p) => p.subject === key).length,
    last: submitted.value.find((p) => p.subject === key),
  };
}

/**
 * 按考试事件 ID 从用户画像中查找对应记录。
 * @param id 考试事件 ID
 * @returns 匹配的考试事件，或 undefined
 */
function eventFor(id: string) {
  return profile.value?.examEvents?.find((e) => e.id === id);
}

/**
 * 把时间格式化为 YYYY-MM-DD HH:mm，用于试卷列表展示。
 * @param value 时间字符串，可为空
 * @returns 格式化后的时间；入参为空时返回空串
 */
function formatDate(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 取某科目的老师画像点评。
 * @param key 科目标识
 * @returns 该科目的评价数据，或 undefined
 */
function narrativeFor(key: SubjectKey) {
  return profile.value?.narratives?.[key];
}

// 默认标签要落在真正有评价的科目上（例如只有英语词汇评价、数学还没考试）
/**
 * 决定「老师画像」默认展示哪个科目：优先当前选中科，其次英语、数学中真正有评价的科目。
 */
const activeNarrative = computed<SubjectKey>(() => {
  if (narrativeFor(narrativeSubject.value)) return narrativeSubject.value;
  if (narrativeFor('english')) return 'english';
  if (narrativeFor('math')) return 'math';
  return narrativeSubject.value;
});

/**
 * 页面数据加载，组件挂载后调用。
 * 并行拉取试卷列表、用户画像与词汇概况；英语评价缺失时尝试按词汇记录补生成，随后逐科拉取题池统计（均不阻塞主流程）。
 */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [examData, profileData, vocabData] = await Promise.all([
      get<{ items: ExamPaperSummary[] }>('/exams?limit=200'),
      get<UserProfile>('/profile'),
      get<VocabSnapshot>('/profile/vocab-snapshot').catch(() => null),
    ]);
    papers.value = examData.items ?? [];
    profile.value = profileData;
    vocab.value = vocabData;
    // 有单词记录、英语还没有评价时，按词汇记录生成一次
    // 点评生成失败不影响评测页主体数据，不进入整页错误态
    if (vocabData && vocabData.rounds > 0 && !profileData.narratives?.english) {
      try {
        profile.value = await post<UserProfile>('/profile/refresh', { subjects: ['english'] });
      } catch {
        /* 保留已有画像，页面继续可用 */
      }
    }
    const nextPools: Record<string, PoolStats> = {};
    for (const s of SUBJECTS) {
      try {
        nextPools[s.key] = await get<PoolStats>(`/exams/pool?subject=${s.key}`);
      } catch {
        // 题池统计失败不阻塞评测页
      }
    }
    pools.value = nextPools;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
    reloadKey.value += 1;
  }
}

/**
 * 直接走模拟卷组卷接口，组完把卷号写入 localStorage 并跳到模拟卷页作答。
 * @param subject 要开考的科目
 */
async function startExam(subject: SubjectKey) {
  notice.value = '';
  generating.value = subject;
  try {
    const pool = pools.value[subject];
    if (pool && pool.questions.unused === 0) {
      notice.value = `${subjectName(subject)}题库尚未导入，组卷接口已就绪，导入题目后即可开考。`;
      return;
    }
    const paper = await post<ExamPaper>('/exams/generate', { subject, mode: 'mock' });
    localStorage.setItem('tutor.currentExamId', paper.id);
    await router.push('/exam');
  } catch (err) {
    notice.value = errorMessage(err);
    void load();
  } finally {
    generating.value = '';
  }
}

/**
 * 打开已有试卷：把卷号写入 localStorage 后跳到模拟卷页。
 * @param id 试卷 ID
 */
function openPaper(id: string) {
  localStorage.setItem('tutor.currentExamId', id);
  void router.push('/exam');
}

onMounted(load);
</script>

<template>
  <div class="page page-wide eval-page" :key="reloadKey">
    <header class="page-header">
      <div>
        <div class="eyebrow">科目考试评测中心 · 闭卷模拟</div>
        <h1 class="page-title">科目考试评测</h1>
        <p class="page-desc">
          按湖南专升本标准试卷闭卷作答。每次交卷都会自动记分、记录失分知识点，并同步更新学习画像。
        </p>
      </div>
    </header>

    <div v-if="notice" class="banner-warn">{{ notice }}</div>
    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" @retry="load" />

    <template v-else>
      <section class="card subjects-card">
        <div class="section-head">
          <h3>选择考试科目</h3>
          <span class="small muted">专业科目接口已预留，暂不开放</span>
        </div>
        <div class="subject-grid">
          <article v-for="s in SUBJECTS" :key="s.key" class="subject-card" :class="`subject-${s.key}`">
            <div class="subject-top">
              <span class="subject-initial">{{ s.initial }}</span>
              <div>
                <h4>{{ s.name }}</h4>
                <span class="small muted">{{ s.teacher }}</span>
              </div>
            </div>
            <p class="subject-spec">{{ s.spec }}</p>
            <p class="subject-meta small muted">{{ s.meta }}</p>
            <div class="subject-stats small">
              <template v-if="statsFor(s.key).count">
                已考 {{ statsFor(s.key).count }} 次 · 最近
                <b :class="(statsFor(s.key).last?.totalScore ?? 0) >= 90 ? 'score-good' : 'score-low'">
                  {{ statsFor(s.key).last?.totalScore ?? 0 }} 分
                </b>
              </template>
              <span v-else class="muted">还没有考试记录</span>
              <span v-if="pools[s.key]" class="muted"> · 可用题 {{ pools[s.key].questions.unused }}</span>
              <span v-if="pools[s.key] && pools[s.key].questions.unused === 0" class="pending-badge">题库待导入</span>
            </div>
            <button
              type="button"
              class="btn primary start-btn"
              :disabled="Boolean(generating) || (pools[s.key] && pools[s.key].questions.unused === 0)"
              @click="startExam(s.key)"
            >
              {{ generating === s.key ? '组卷中…' : pools[s.key] && pools[s.key].questions.unused === 0 ? '题库待导入，接口已就绪' : '开始闭卷考试' }}
            </button>
          </article>
        </div>
      </section>

      <section v-if="submitted.length" class="card records-card">
        <div class="section-head">
          <h3>考试记录</h3>
          <span class="small muted">共 {{ submitted.length }} 次</span>
        </div>
        <div class="record-table">
          <div class="record-row record-head">
            <span>考试时间</span><span>科目</span><span>得分</span><span>失分知识点</span><span>操作</span>
          </div>
          <div v-for="p in submitted" :key="p.id" class="record-row">
            <span class="mono small">{{ formatDate(p.submittedAt) }}</span>
            <span>{{ subjectName(p.subject) }}</span>
            <span class="mono score-cell">
              <b :class="(p.totalScore ?? 0) >= 90 ? 'score-good' : 'score-low'">{{ p.totalScore ?? 0 }}</b>
              <span class="muted"> / {{ p.maxScore }}</span>
            </span>
            <span class="small muted kp-cell">
              {{ (eventFor(p.id)?.lostKps ?? []).slice(0, 5).join('、') || '—' }}
            </span>
            <span><button type="button" class="btn ghost tiny" @click="openPaper(p.id)">查看试卷</button></span>
          </div>
        </div>
      </section>

      <section v-if="narrativeFor('math') || narrativeFor('english')" class="card narrative-card">
        <div class="section-head">
          <h3>老师画像</h3>
          <router-link to="/profile" class="small link">设置目标分与自评 →</router-link>
        </div>
        <div class="tabs">
          <button
            v-for="s in SUBJECTS.filter((x) => narrativeFor(x.key))"
            :key="s.key"
            type="button"
            class="tab"
            :class="{ active: activeNarrative === s.key }"
            @click="narrativeSubject = s.key"
          >
            {{ s.teacher }}
          </button>
        </div>
        <!-- 英语：来自 /vocab 单词测试记录的词汇概况 -->
        <div v-if="activeNarrative === 'english' && vocab" class="vocab-box">
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
          <div class="small muted vocab-meta">共 {{ vocab.rounds }} 轮 · {{ vocab.words }} 词</div>
        </div>
        <div v-if="narrativeFor(activeNarrative)" class="narrative-body">
          <div class="narrative-block">
            <h4 class="narrative-title good">优点 · 长处</h4>
            <ul>
              <li v-for="(x, i) in narrativeFor(activeNarrative)!.strengths" :key="i">{{ x }}</li>
            </ul>
          </div>
          <div class="narrative-block">
            <h4 class="narrative-title bad">缺点 · 短处</h4>
            <ul>
              <li v-for="(x, i) in narrativeFor(activeNarrative)!.weaknesses" :key="i">{{ x }}</li>
            </ul>
          </div>
          <div class="narrative-advice">
            <h4 class="narrative-title">老师建议</h4>
            <p>{{ narrativeFor(activeNarrative)!.advice }}</p>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.eval-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
/* 卡片内容统一内边距，避免文字贴边像被切割 */
.eval-page > .card {
  padding: 22px 24px;
}
.vocab-box {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  padding: 12px 14px;
  margin-bottom: 16px;
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
.subject-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
}
.subject-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-soft);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.subject-math {
  border-top: 3px solid var(--accent);
}
.subject-english {
  border-top: 3px solid #5b8c85;
}
.subject-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.subject-initial {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-family: var(--serif);
  font-size: 18px;
}
.subject-top h4 {
  font-size: 16px;
  margin: 0 0 2px;
}
.subject-spec,
.subject-meta {
  margin: 0;
  line-height: 1.6;
}
.subject-stats {
  margin-top: 2px;
}
.pending-badge {
  margin-left: 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--muted);
}
.start-btn {
  margin-top: auto;
  width: 100%;
}
.score-good {
  color: var(--ok, #2f7d5b);
}
.score-low {
  color: var(--danger, #b14b42);
}
.empty-line {
  padding: 18px 4px;
}
.record-table {
  display: flex;
  flex-direction: column;
}
.record-row {
  display: grid;
  grid-template-columns: 1.1fr 0.7fr 0.7fr 2fr 0.7fr;
  gap: 10px;
  align-items: center;
  padding: 10px 4px;
  border-bottom: 1px dashed var(--line);
  font-size: 13px;
}
.record-head {
  color: var(--muted);
  font-size: 11.5px;
  letter-spacing: 0.04em;
}
.kp-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.tab {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12.5px;
  cursor: pointer;
}
.tab.active {
  background: var(--accent-soft);
  color: var(--accent-dark);
  border-color: var(--accent);
}
.narrative-body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.narrative-advice {
  grid-column: 1 / -1;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
.narrative-title {
  font-size: 13px;
  margin-bottom: 7px;
}
.narrative-title.good {
  color: var(--ok, #2f7d5b);
}
.narrative-title.bad {
  color: var(--danger, #b14b42);
}
.narrative-block ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}
.narrative-advice p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.8;
}
.link {
  color: var(--accent-dark);
  text-decoration: none;
}
@media (max-width: 720px) {
  .record-row {
    grid-template-columns: 1fr 1fr;
  }
  .record-head {
    display: none;
  }
  .narrative-body {
    grid-template-columns: 1fr;
  }
}
</style>
