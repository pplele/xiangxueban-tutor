<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { QuestionCard, QuestionDetail, SubjectCode, VariantProgress } from '@tutor/shared';
import { SUBJECTS, SUBJECT_NAME } from '@tutor/shared';
import { errorMessage, get, patch, post } from '@/api/client';
import { useSubjectsStore } from '@/stores/subjects';
import { bodyPreview, plainPreview, cleanOption } from '@/lib/rich';
import { copyText, importPromptFor } from '@/lib/importPrompt';
import MathText from '@/components/MathText.vue';
import StatusTag from '@/components/StatusTag.vue';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import NavIcon from '@/components/NavIcon.vue';
import PrintSheet from '@/components/PrintSheet.vue';
import WrongbookPrint from '@/components/WrongbookPrint.vue';

const router = useRouter();
const subjectsStore = useSubjectsStore();

const subject = ref<SubjectCode>('math');
const chapter = ref('');
const status = ref('');
const searchInput = ref('');
const search = ref('');
const page = ref(1);
const pageSize = 20;

const items = ref<QuestionCard[]>([]);
const total = ref(0);
const loadingList = ref(true);
const listError = ref('');
const stats = ref<{ chapters: { chapter: string; count: number }[]; statuses: { status: string; count: number }[] }>({
  chapters: [],
  statuses: [],
});

const selectedId = ref('');
const detail = ref<QuestionDetail | null>(null);
const loadingDetail = ref(false);
const detailError = ref('');
const noteDraft = ref('');
const noteEditing = ref(false);
const noteState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');

const importOpen = ref(false);
const importText = ref('');
const importForce = ref(false);
const importing = ref(false);
const importResult = ref<any>(null);
const importError = ref('');
// 整理提示词：学生多半是在别的 AI 会话里问的题，先把这段复制过去
const promptOpen = ref(false);
const promptCopied = ref(false);
let promptTimer: number | null = null;

const progress = ref<VariantProgress | null>(null);
const progressError = ref('');
let pollTimer: number | null = null;

const statusOptions = ['待复习', '待变式', '已生成变式'];
/** 列表总页数，至少为 1。 */
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
/** 当前科目的章节列表（来自科目 store）。 */
const chapters = computed(() => subjectsStore.chaptersOf(subject.value));
/**
 * 从统计数据中取指定状态的题目数量。
 * @param s 状态名
 * @returns 该状态的题目数；无数据时为 0
 */
const statusCount = (s: string) => stats.value.statuses.find((x) => x.status === s)?.count ?? 0;
/** 当前科目的题目总数（各状态数量之和）。 */
const subjectTotal = computed(() => stats.value.statuses.reduce((sum, s) => sum + s.count, 0));
/** 变式生成中（排队 + 运行中）的任务数。 */
const activeJobs = computed(() => (progress.value ? progress.value.counts.queued + progress.value.counts.running : 0));
/** 变式生成任务总数（含排队、运行、完成、失败）。 */
const jobTotal = computed(() => {
  if (!progress.value) return 0;
  const c = progress.value.counts;
  return c.queued + c.running + c.done + c.failed;
});
/** 变式生成任务的完成百分比（完成与失败均计入已完成）。 */
const jobPercent = computed(() => {
  if (!progress.value || jobTotal.value === 0) return 0;
  const c = progress.value.counts;
  return Math.round(((c.done + c.failed) / jobTotal.value) * 100);
});

let searchTimer: number | null = null;
/**
 * 监听搜索框输入：用 320ms 防抖后才写入 search 并重新加载列表，避免逐字请求。
 */
watch(searchInput, (value) => {
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    search.value = value.trim();
    page.value = 1;
    void loadQuestions();
  }, 320);
});

/**
 * 监听科目切换：重置章节、状态、搜索、分页与选中项，再重新加载该科数据。
 */
watch(subject, () => {
  chapter.value = '';
  status.value = '';
  searchInput.value = '';
  search.value = '';
  page.value = 1;
  selectedId.value = '';
  detail.value = null;
  void loadAll();
});

/** 并行刷新统计与题目列表，用于科目切换或初始化。 */
async function loadAll() {
  await Promise.all([loadStats(), loadQuestions()]);
}

/** 调用 GET /questions/stats 加载当前科目的章节/状态统计，失败不影响主流程。 */
async function loadStats() {
  try {
    stats.value = await get(`/questions/stats?subject=${subject.value}`);
  } catch {
    /* 统计失败不影响主流程 */
  }
}

/**
 * 按当前科目、章节、状态、搜索词与页码调用 GET /questions 加载题目列表。
 * 列表为空时清空选中项；当前选中题不在新列表中时自动选中第一条。
 */
async function loadQuestions() {
  loadingList.value = true;
  listError.value = '';
  try {
    const params = new URLSearchParams({
      subject: subject.value,
      page: String(page.value),
      pageSize: String(pageSize),
    });
    if (chapter.value) params.set('chapter', chapter.value);
    if (status.value) params.set('status', status.value);
    if (search.value) params.set('search', search.value);
    const data = await get<{ items: QuestionCard[]; total: number }>(`/questions?${params.toString()}`);
    items.value = data.items;
    total.value = data.total;
    if (data.items.length === 0) {
      selectedId.value = '';
      detail.value = null;
    } else if (!data.items.some((q) => q.id === selectedId.value)) {
      await selectQuestion(data.items[0].id);
    }
  } catch (err) {
    listError.value = errorMessage(err);
  } finally {
    loadingList.value = false;
  }
}

// ---------- 打印 / 导出 PDF ----------
const printOpen = ref(false);
const printLoading = ref(false);
const printItems = ref<QuestionCard[]>([]);
const printError = ref('');
/** 把当前筛选条件拼成打印范围说明文案。 */
const printScopeLabel = computed(() => {
  const parts: string[] = [];
  if (chapter.value) parts.push(chapter.value);
  if (status.value) parts.push(status.value);
  if (search.value) parts.push(`搜索“${search.value}”`);
  return parts.join(' · ') || '全部错题';
});

/** 按当前筛选条件分页拉取全部题目（/questions pageSize 上限 200），仅用于打印 */
async function openPrint() {
  printOpen.value = true;
  printError.value = '';
  printItems.value = [];
  printLoading.value = true;
  try {
    const base = new URLSearchParams({
      subject: subject.value,
      pageSize: '200',
    });
    if (chapter.value) base.set('chapter', chapter.value);
    if (status.value) base.set('status', status.value);
    if (search.value) base.set('search', search.value);

    const all: QuestionCard[] = [];
    let pageNo = 1;
    let totalCount = 0;
    do {
      const params = new URLSearchParams(base);
      params.set('page', String(pageNo));
      const data = await get<{ items: QuestionCard[]; total: number }>(`/questions?${params.toString()}`);
      all.push(...data.items);
      totalCount = data.total;
      pageNo += 1;
    } while (all.length < totalCount && pageNo <= 100);

    printItems.value = all;
  } catch (err) {
    printError.value = errorMessage(err);
  } finally {
    printLoading.value = false;
  }
}

/**
 * 选中题目并加载详情，点击列表项时触发；已选中同一题则直接返回。
 * 调用 GET /questions/:id，同时初始化备注草稿与保存状态。
 * @param id 题目 ID
 */
async function selectQuestion(id: string) {
  if (selectedId.value === id && detail.value) return;
  selectedId.value = id;
  loadingDetail.value = true;
  detailError.value = '';
  try {
    const data = await get<QuestionDetail>(`/questions/${id}`);
    detail.value = data;
    noteDraft.value = data.note ?? '';
    noteEditing.value = false;
    noteState.value = 'idle';
  } catch (err) {
    detailError.value = errorMessage(err);
    detail.value = null;
  } finally {
    loadingDetail.value = false;
  }
}

/**
 * 选择/取消章节筛选，点击章节标签时触发。
 * @param name 章节名；再次点击同一章节则取消筛选
 */
function chooseChapter(name: string) {
  chapter.value = chapter.value === name ? '' : name;
  page.value = 1;
  void loadQuestions();
}

/**
 * 选择/取消状态筛选，点击状态标签时触发。
 * @param value 状态名；再次点击同一状态则取消筛选
 */
function chooseStatus(value: string) {
  status.value = status.value === value ? '' : value;
  page.value = 1;
  void loadQuestions();
}

/**
 * 翻页按钮处理器，按增量切换页码并重新加载列表。
 * @param delta 页码增量（+1 / -1）
 */
function changePage(delta: number) {
  const next = page.value + delta;
  if (next < 1 || next > totalPages.value) return;
  page.value = next;
  void loadQuestions();
}

/** 进入备注编辑态：从已保存的备注重新填充草稿，避免残留脏数据。 */
function startEditNote() {
  // 取消编辑会留下脏 draft，进编辑态时从已保存的备注重新取
  noteDraft.value = detail.value?.note ?? '';
  noteEditing.value = true;
}

/** 取消备注编辑：丢弃草稿改动并还原为已保存的备注。 */
function cancelEditNote() {
  noteDraft.value = detail.value?.note ?? '';
  noteEditing.value = false;
}

/**
 * 保存错题备注处理器，点击备注区「保存」时触发。
 * 调用 PATCH /questions/:id/note 持久化，显示 2 秒「已保存」提示后回到 idle 状态。
 */
async function saveNote() {
  if (!detail.value) return;
  noteState.value = 'saving';
  try {
    await patch(`/questions/${detail.value.id}/note`, { note: noteDraft.value });
    detail.value.note = noteDraft.value;
    noteEditing.value = false;
    noteState.value = 'saved';
    window.setTimeout(() => {
      if (noteState.value === 'saved') noteState.value = 'idle';
    }, 2000);
  } catch (err) {
    noteState.value = 'error';
    detailError.value = errorMessage(err);
  }
}

/**
 * 生成变式题处理器，点击「生成变式」时触发。
 * 调用 POST /variants/generate 入队，随后刷新进度并启动轮询直到任务结束。
 */
async function generateVariants() {
  if (!detail.value) return;
  try {
    await post('/variants/generate', { ids: [detail.value.id] });
    await loadProgress();
    startPolling();
  } catch (err) {
    detailError.value = errorMessage(err);
  }
}

/** 打开「导入错题」弹窗并清空上次导入结果与错误提示。 */
function openImport() {
  importOpen.value = true;
  importResult.value = null;
  importError.value = '';
}

/** 关闭「导入错题」弹窗；导入进行中时忽略点击，避免中断。 */
function closeImport() {
  if (importing.value) return;
  importOpen.value = false;
}

/** 当前科目对应的整理提示词：数学重公式、英语重原文照抄、计算机重代码，切科目即换 */
const importPrompt = computed(() => importPromptFor(subject.value));

/** 导入弹窗里的示例占位文本，跟着科目变，避免英语科目还看到数学例子 */
const importPlaceholder = computed(() => {
  if (subject.value === 'english') {
    return '把 AI 整理好的内容整段粘到这里。示例：\n### 错题1：定语从句关系代词\n**原文**：The book ___ I bought yesterday is very interesting.\n**题目**：The book ___ I bought yesterday is very interesting.\n**选项**：A. which B. who C. whom D. what\n**答案**：A\n**解析**：先行词是物，从句缺宾语，用 which / that。\n**考点**：E1.9';
  }
  if (subject.value === 'cs') {
    return '把 AI 整理好的内容整段粘到这里。示例：\n### 错题1：二叉树的遍历\n**题目**：已知中序与先序序列，求后序序列。\n**选项**：A. … B. … C. … D. …\n**答案**：B\n**考点**：C2.3';
  }
  return '把 AI 整理好的内容整段粘到这里。示例：\n### 错题1：罗尔定理验证\n**题目**：…\n**解析**：…\n**考点**：3.1';
});

/** 复制整理提示词：剪贴板 API 在非 https 下不可用，copyText 里已带兜底 */
async function copyImportPrompt() {
  const ok = await copyText(importPrompt.value);
  if (!ok) {
    importError.value = '复制失败，请点「查看全文」后手动全选复制';
    return;
  }
  promptCopied.value = true;
  if (promptTimer) window.clearTimeout(promptTimer);
  promptTimer = window.setTimeout(() => {
    promptCopied.value = false;
  }, 2400);
}

/** 当前科目的中文简称，用作导入弹窗标题等处的标签。 */
const subjectLabel = computed(
  () => SUBJECTS.find((s) => s.code === subject.value)?.shortName ?? '当前科目',
);

/**
 * 提交错题导入处理器，点击「开始导入」时触发。
 * 调用 POST /questions/import 导入 JSON/Markdown 内容，刷新列表、统计与进度；有入队任务时启动轮询，并自动选中首道导入题。
 */
async function submitImport() {
  if (!importText.value.trim()) {
    importError.value = '请粘贴 JSON 或 Markdown 错题内容';
    return;
  }
  importing.value = true;
  importError.value = '';
  importResult.value = null;
  try {
    const data = await post<any>('/questions/import', {
      content: importText.value,
      subject: subject.value,
      force: importForce.value,
    });
    importResult.value = data;
    importText.value = '';
    await Promise.all([loadQuestions(), loadStats()]);
    await loadProgress();
    if (data.enqueuedCount > 0) startPolling();
    if (data.imported?.length > 0) await selectQuestion(data.imported[0].id);
  } catch (err) {
    importError.value = errorMessage(err);
  } finally {
    importing.value = false;
  }
}

/** 调用 GET /variants/progress 刷新变式生成进度（排队/运行/完成/失败数）。 */
async function loadProgress() {
  try {
    progress.value = await get<VariantProgress>('/variants/progress');
    progressError.value = '';
  } catch (err) {
    progressError.value = errorMessage(err);
  }
}

/**
 * 启动变式生成进度轮询：每 2.5 秒刷新一次进度，任务全部结束后停止轮询并刷新列表与详情。
 * 已有轮询在跑时不重复启动。
 */
function startPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(async () => {
    await loadProgress();
    if (!activeJobs.value) {
      stopPolling();
      await Promise.all([loadQuestions(), loadStats()]);
      if (detail.value) await selectQuestion(detail.value.id);
    }
  }, 2500);
}

/** 停止变式生成进度轮询并清除定时器。 */
function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 跳转到练习页作答：默认练原题，传入变式 ID 则练对应变式。
 * @param id 变式题 ID，可选
 */
function practice(id?: number) {
  if (!detail.value) return;
  const q = id ? `?variantId=${id}` : '';
  router.push(`/practice/${detail.value.id}${q}`);
}

/**
 * 把时间格式化为「M月D日 HH:mm」，用于列表时间展示。
 * @param value 时间字符串，可为空
 * @returns 格式化后的时间；入参为空时返回空串
 */
function formatTime(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/**
 * 把作答结果状态值转成中文标签。
 * @param v 状态值
 * @returns 中文标签；未知值原样返回
 */
function verdictText(v?: string | null) {
  return (
    { correct: '正确', wrong: '错误', self_pass: '已掌握', self_partial: '部分掌握', self_fail: '未掌握' }[
      v ?? ''
    ] ?? v ?? ''
  );
}

/**
 * 按变式难度返回对应的标签样式类（L1 绿 / L2 蓝 / L3 及以上赭）。
 * @param level 难度级别
 * @returns 样式类名
 */
function levelTone(level: string) {
  return level === 'L1' ? 'tag-green' : level === 'L2' ? 'tag-blue' : 'tag-terra';
}

/**
 * 汇总导入失败的原因文案，用于结果弹窗提示。
 * @returns 以「；」连接的失败原因；无失败时为空串
 */
function errorReasons(): string {
  const errors = importResult.value?.errors;
  if (!Array.isArray(errors)) return '';
  return errors.map((e: { reason?: string }) => e.reason ?? '').filter(Boolean).join('；');
}

/**
 * 组件挂载：先确保科目数据就绪，再加载列表、统计与生成进度；有未完成任务时启动轮询。
 */
onMounted(async () => {
  await subjectsStore.ensure();
  await loadAll();
  await loadProgress();
  if (activeJobs.value) startPolling();
});

/** 组件卸载：停止进度轮询并清除搜索防抖计时器。 */
onBeforeUnmount(() => {
  stopPolling();
  if (searchTimer) window.clearTimeout(searchTimer);
});
</script>

<template>
  <div class="page page-wide wb-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">错题闭环 · L1 / L2 / L5</div>
        <h1 class="page-title">错题本</h1>
        <p class="page-desc">错题入库后自动生成分级变式；状态、备注与作答历史都保留在题卡上。</p>
      </div>
      <div class="header-actions">
        <div class="subject-tabs">
          <button
            v-for="s in SUBJECTS"
            :key="s.code"
            type="button"
            class="subject-tab"
            :class="{ active: s.code === subject }"
            @click="subject = s.code"
          >
            {{ s.shortName }}
          </button>
        </div>
        <button class="btn" type="button" :disabled="!total" @click="openPrint">
          <NavIcon name="print" :size="16" /> 打印 / 导出 PDF
        </button>
        <button class="btn btn-primary" type="button" @click="openImport">
          <NavIcon name="plus" :size="16" /> 导入错题
        </button>
      </div>
    </header>

    <div v-if="activeJobs > 0" class="card progress-card">
      <div class="progress-head">
        <div class="progress-title">
          <span class="spinner" />
          <span>变式生成队列</span>
          <span class="small muted">排队 {{ progress?.counts.queued ?? 0 }} · 生成中 {{ progress?.counts.running ?? 0 }}</span>
        </div>
        <span class="small muted">{{ jobPercent }}%</span>
      </div>
      <div class="progress-track"><div class="progress-fill" :style="{ width: `${jobPercent}%` }" /></div>
    </div>
    <div v-else-if="progress && progress.counts.failed > 0" class="banner banner-warn progress-warn">
      有 {{ progress.counts.failed }} 个变式任务失败（通常是模型服务暂不可用），可在题卡中重新生成。
    </div>

    <div class="wb-grid">
      <aside class="card chapter-panel">
        <div class="panel-head">
          <h3>章节</h3>
          <span class="small muted">{{ subjectTotal }} 题</span>
        </div>
        <button type="button" class="chapter-item" :class="{ active: chapter === '' }" @click="chapter = ''; page = 1; loadQuestions()">
          <span>全部章节</span>
          <span class="chapter-count">{{ subjectTotal }}</span>
        </button>
        <button
          v-for="c in chapters"
          :key="c.name"
          type="button"
          class="chapter-item"
          :class="{ active: chapter === c.name }"
          @click="chooseChapter(c.name)"
        >
          <span class="ellipsis">{{ c.name }}</span>
          <span class="chapter-count">{{ stats.chapters.find((x) => x.chapter === c.name)?.count ?? 0 }}</span>
        </button>
        <div v-if="chapters.length === 0" class="small muted panel-empty">暂无章节数据</div>
      </aside>

      <section class="card list-panel">
        <div class="list-tools">
          <label class="search-box">
            <NavIcon name="search" :size="15" />
            <input v-model="searchInput" class="search-input" type="search" placeholder="搜索题干…" />
          </label>
          <div class="status-filter">
            <button
              v-for="s in statusOptions"
              :key="s"
              type="button"
              class="filter-chip"
              :class="{ active: status === s }"
              @click="chooseStatus(s)"
            >
              {{ s }} <span class="filter-count">{{ statusCount(s) }}</span>
            </button>
          </div>
        </div>

        <div class="list-scroll">
          <LoadingState v-if="loadingList" text="加载错题…" />
          <ErrorState v-else-if="listError" :message="listError" @retry="loadAll" />
          <div v-else-if="items.length === 0" class="empty-state">
            <h4>这里还没有错题</h4>
            <p>粘贴 JSON 或 Markdown 错题集导入，或让答疑老师把错题记下来。</p>
            <button class="btn btn-sm" type="button" @click="openImport">导入第一道错题</button>
          </div>
          <template v-else>
            <button
              v-for="q in items"
              :key="q.id"
              type="button"
              class="question-item"
              :class="{ active: q.id === selectedId }"
              @click="selectQuestion(q.id)"
            >
              <div class="qi-top">
                <span class="tag tag-mono">{{ q.id }}</span>
                <StatusTag :status="q.status" />
              </div>
              <div class="qi-stem">{{ bodyPreview(q.textBody, 88) }}</div>
              <div class="qi-meta">
                <span class="tag">{{ q.questionType }}</span>
                <span v-for="kp in q.kpCodes.slice(0, 2)" :key="kp" class="tag tag-mono">考点 {{ kp }}</span>
                <span v-if="q.variantCount" class="small muted">{{ q.variantCount }} 变式</span>
                <span v-if="q.attemptCount" class="small muted">{{ q.attemptCount }} 次作答</span>
              </div>
            </button>
          </template>
        </div>

        <div v-if="total > pageSize" class="pager">
          <button class="btn btn-sm btn-ghost" :disabled="page <= 1" @click="changePage(-1)">上一页</button>
          <span class="small muted">{{ page }} / {{ totalPages }}</span>
          <button class="btn btn-sm btn-ghost" :disabled="page >= totalPages" @click="changePage(1)">下一页</button>
        </div>
      </section>

      <section class="card detail-panel">
        <LoadingState v-if="loadingDetail" text="加载题卡详情…" />
        <ErrorState v-else-if="detailError && !detail" :message="detailError" @retry="selectedId && selectQuestion(selectedId)" />
        <div v-else-if="!detail" class="empty-state">
          <h4>选择一道错题</h4>
          <p>左侧点击题卡，查看题干、变式、备注与作答记录。</p>
        </div>

        <template v-else>
          <div class="detail-head">
            <div>
              <div class="detail-kicker">
                <span class="tag tag-mono">{{ detail.id }}</span>
                <StatusTag :status="detail.status" />
                <span class="tag">{{ detail.questionType }}</span>
              </div>
              <!-- 标题是题干截断，本身带 $...$：直接插值是整行 LaTeX 源码，必须降级 -->
              <h2>{{ plainPreview(detail.title || detail.textBody, 56) }}</h2>
              <div class="detail-sub">
                <span>{{ detail.chapter }}</span>
                <span v-if="detail.kpCodes.length">· 考点 {{ detail.kpCodes.join('、') }}</span>
                <span class="muted">· {{ formatTime(detail.createdAt) }}</span>
              </div>
            </div>
            <div class="detail-actions">
              <button class="btn btn-sm" type="button" @click="generateVariants">
                <NavIcon name="spark" :size="15" /> 生成变式
              </button>
              <button class="btn btn-sm btn-primary" type="button" @click="practice()">去练习</button>
            </div>
          </div>

          <div class="detail-scroll">
            <div v-if="detailError" class="banner banner-error">{{ detailError }}</div>

            <div class="stem-block">
              <MathText :text="detail.textBody" />
              <div v-if="detail.options && detail.options.length" class="option-list">
                <div v-for="(opt, idx) in detail.options" :key="idx" class="option-row">
                  <span class="option-letter">{{ String.fromCharCode(65 + idx) }}</span>
                  <MathText :text="cleanOption(opt)" />
                </div>
              </div>
            </div>

            <details v-if="detail.answer || detail.solution" class="answer-block">
              <summary>查看标准答案与解析</summary>
              <div class="answer-body">
                <div v-if="detail.answer" class="answer-line">
                  <span class="answer-label">答案</span>
                  <MathText :text="detail.answer" />
                </div>
                <div v-if="detail.solution" class="solution-line">
                  <span class="answer-label">解析</span>
                  <MathText :text="detail.solution" />
                </div>
              </div>
            </details>

            <div class="note-block">
              <div class="section-title">
                <h3>我的备注 / 错因</h3>
                <span class="small muted">
                  <template v-if="noteState === 'saving'">保存中…</template>
                  <template v-else-if="noteState === 'saved'">已保存</template>
                  <template v-else-if="noteState === 'error'">保存失败</template>
                  <template v-else>逐字保留</template>
                </span>
              </div>
              <!-- 备注里常有 $\frac{...}$，默认渲染成公式，点「编辑备注」才看源码 -->
              <div v-if="!noteEditing" class="note-view" @click="startEditNote">
                <MathText v-if="detail.note" :text="detail.note" />
                <span v-else class="note-placeholder">点此写下当时的错误想法、口诀或提醒…</span>
              </div>
              <textarea
                v-else
                v-model="noteDraft"
                class="textarea"
                rows="3"
                placeholder="写下当时的错误想法、口诀或提醒…公式用 $...$ 包起来，如 $\frac{1}{x}$"
              />
              <div class="note-actions">
                <template v-if="noteEditing">
                  <button class="btn btn-sm btn-ghost" type="button" @click="cancelEditNote">取消</button>
                  <button class="btn btn-sm" type="button" :disabled="noteState === 'saving'" @click="saveNote">
                    保存备注
                  </button>
                </template>
                <button v-else class="btn btn-sm" type="button" @click="startEditNote">编辑备注</button>
              </div>
            </div>

            <div class="variants-block">
              <div class="section-title">
                <h3>变式题</h3>
                <span class="small muted">{{ detail.variants.length }} 道 · {{ detail.variantSets.length }} 套</span>
              </div>
              <div v-if="detail.variantSets.length === 0" class="empty-inline">
                还没有变式。点击右上角「生成变式」，后台队列会产出 L1 同类换数、L2 改问法、L5 概念辨析。
              </div>
              <div v-for="set in detail.variantSets" :key="set.setId" class="variant-set">
                <div class="variant-set-head">
                  <span class="set-badge">{{ set.setId }}</span>
                  <span class="small muted">{{ formatTime(set.createdAt) }}</span>
                </div>
                <div v-for="v in set.items" :key="v.id" class="variant-card">
                  <div class="variant-top">
                    <span class="tag" :class="levelTone(v.level)">{{ v.level }}</span>
                    <span v-if="v.targetTrap" class="small muted ellipsis">埋坑：{{ plainPreview(v.targetTrap, 72) }}</span>
                    <button class="btn btn-sm btn-ghost variant-do" type="button" @click="practice(v.id)">做这道</button>
                  </div>
                  <div class="variant-stem">
                    <MathText :text="v.stem" class="variant-stem-rich" />
                  </div>
                </div>
              </div>
            </div>

            <div class="attempts-block">
              <div class="section-title">
                <h3>作答记录</h3>
                <span class="small muted">{{ detail.attempts.length }} 次</span>
              </div>
              <div v-if="detail.attempts.length === 0" class="empty-inline">还没有作答记录。</div>
              <div v-for="a in detail.attempts" :key="a.id" class="attempt-row">
                <StatusTag :status="a.verdict" />
                <span class="attempt-answer ellipsis">{{ a.answer || '（空）' }}</span>
                <span class="small muted">{{ a.source === 'exam' ? '模拟卷' : '练习' }}</span>
                <span class="small muted attempt-time">{{ formatTime(a.at) }}</span>
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>

    <div v-if="importOpen" class="modal-backdrop" @click.self="closeImport">
      <div class="modal">
        <header class="modal-head">
          <div>
            <div class="eyebrow">导入 · 自动判格式</div>
            <h2>粘贴错题内容</h2>
          </div>
          <button class="icon-btn" type="button" aria-label="关闭" @click="closeImport">
            <NavIcon name="x" :size="18" />
          </button>
        </header>

        <div class="modal-body">
          <div class="banner banner-info">
            支持 JSON（单题、数组、`{questions:[...]}`）与 Markdown（「### 错题 001」+「**题目**/**解析**/**备注」{{ subject === 'english' ? '，阅读/完形题可加「**原文**」' : '' }}）。
            系统按题干指纹自动判重。
          </div>

          <!-- 学生手里的错题散在别的 AI 会话里，先给一段能让对方输出对格式的提示词 -->
          <div class="prompt-card">
            <div class="prompt-head">
              <div class="prompt-title">
                <span class="step-dot">1</span>
                复制{{ subjectLabel }}提示词，发给你问题用的 AI
              </div>
              <div class="prompt-actions">
                <button class="btn btn-sm btn-primary" type="button" @click="copyImportPrompt">
                  {{ promptCopied ? '已复制 ✓' : '复制提示词' }}
                </button>
                <button class="btn btn-sm" type="button" @click="promptOpen = !promptOpen">
                  {{ promptOpen ? '收起全文' : '查看全文' }}
                </button>
              </div>
            </div>
            <p class="prompt-hint">
              提示词里带了字段格式、{{ subject === 'english' ? '英文书写规范（原文照抄、不用公式）' : subject === 'cs' ? '代码书写规范' : '数学公式规范' }}和{{ subjectLabel }}考点编码表，AI 照它整理的内容可以直接粘进下面的框。
              每次整理完 AI 会在结尾打一条「已整理断点」标记，下次再发它就只统计标记之后的新题，不会重复；
              粘贴时标记那行一起粘也没关系，系统会自动忽略。
            </p>
            <pre v-if="promptOpen" class="prompt-text">{{ importPrompt }}</pre>
          </div>

          <div class="step-line">
            <span class="step-dot">2</span>
            把 AI 整理好的结果粘到下面，点「导入」写入<strong>{{ subjectLabel }}</strong>错题本
          </div>

          <textarea
            v-model="importText"
            class="textarea import-textarea"
            rows="12"
            :placeholder="importPlaceholder"
          />

          <label class="checkbox-row">
            <input v-model="importForce" type="checkbox" />
            强制覆盖同指纹的已有题卡
          </label>

          <div v-if="importError" class="banner banner-error">{{ importError }}</div>

          <div v-if="importResult" class="import-result">
            <div class="import-stats">
              <span class="tag tag-green">新建 {{ importResult.imported?.length ?? 0 }}</span>
              <span class="tag tag-blue">跳过重复 {{ importResult.skipped?.length ?? 0 }}</span>
              <span v-if="importResult.enqueuedCount" class="tag tag-amber">入队变式 {{ importResult.enqueuedCount }}</span>
              <span v-if="importResult.errors?.length" class="tag tag-red">失败 {{ importResult.errors.length }}</span>
            </div>
            <div v-if="importResult.imported?.length" class="small">
              已导入：
              <span v-for="x in importResult.imported" :key="x.id" class="tag tag-mono">{{ x.id }}</span>
            </div>
            <div v-if="importResult.skipped?.length" class="small muted">
              跳过：
              <div v-for="x in importResult.skipped" :key="x.id" class="import-skip">
                {{ x.id }} · {{ x.reason }}
              </div>
            </div>
            <div v-if="importResult.warnings?.length" class="small muted">提示：{{ importResult.warnings.join('；') }}</div>
            <div v-if="importResult.errors?.length" class="small" style="color: var(--danger)">
              {{ errorReasons() }}
            </div>
          </div>
        </div>

        <footer class="modal-foot">
          <button class="btn" type="button" :disabled="importing" @click="closeImport">关闭</button>
          <button class="btn btn-primary" type="button" :disabled="importing" @click="submitImport">
            <span v-if="importing" class="spinner spinner-light" />
            {{ importing ? '导入中…' : '导入' }}
          </button>
        </footer>
      </div>
    </div>

    <PrintSheet :open="printOpen" variant="compact" :title="`错题本 · ${SUBJECT_NAME[subject] || ''}`" @close="printOpen = false">
      <div v-if="printLoading" class="print-loading">正在整理题目…</div>
      <div v-else-if="printError" class="banner banner-error">{{ printError }}</div>
      <WrongbookPrint
        v-else-if="printItems.length"
        :items="printItems"
        :subject-label="SUBJECT_NAME[subject] || ''"
        :scope-label="printScopeLabel"
      />
      <div v-else class="print-loading">当前筛选没有题目</div>
    </PrintSheet>
  </div>
</template>

<style scoped>
.wb-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.subject-tabs {
  display: inline-flex;
  padding: 4px;
  background: var(--panel-soft);
  border: 1px solid var(--line);
  border-radius: 10px;
  gap: 2px;
}
.subject-tab {
  border: 0;
  background: transparent;
  padding: 6px 13px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--ink-2);
  cursor: pointer;
}
.subject-tab.active {
  background: var(--panel);
  color: var(--accent-dark);
  font-weight: 600;
  box-shadow: 0 2px 6px rgba(27, 41, 38, 0.08);
}

.progress-card {
  padding: 12px 16px;
}
.progress-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.progress-title {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  font-weight: 500;
}
.progress-track {
  height: 5px;
  border-radius: 99px;
  background: var(--bg-deep);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), #3f9c80);
  border-radius: 99px;
  transition: width 0.4s ease;
}
.progress-warn {
  align-items: center;
}

.wb-grid {
  display: grid;
  grid-template-columns: 196px 330px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  flex: 1;
  min-height: 0;
}

.chapter-panel {
  padding: 14px 10px;
  position: sticky;
  top: 20px;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 2px 8px 10px;
}
.panel-head h3 {
  font-size: 15px;
}
.chapter-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  background: transparent;
  padding: 8px 9px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--ink-2);
  cursor: pointer;
  text-align: left;
  transition: 0.16s ease;
}
.chapter-item:hover {
  background: var(--panel-soft);
  color: var(--accent-dark);
}
.chapter-item.active {
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-weight: 600;
}
.chapter-count {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  background: rgba(27, 41, 38, 0.05);
  padding: 1px 6px;
  border-radius: 99px;
}
.panel-empty {
  padding: 10px;
}

.list-panel {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 190px);
  overflow: hidden;
  position: sticky;
  top: 20px;
}
.list-tools {
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: #fffefb;
  color: var(--muted);
}
.search-input {
  flex: 1;
  border: 0;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: var(--ink);
}
.status-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.filter-chip {
  border: 1px solid var(--line);
  background: var(--panel-soft);
  color: var(--ink-2);
  border-radius: 99px;
  font-size: 11px;
  padding: 3px 9px;
  cursor: pointer;
  transition: 0.16s ease;
}
.filter-chip.active {
  background: var(--ink);
  border-color: var(--ink);
  color: #f4efe4;
}
.filter-count {
  opacity: 0.65;
  font-family: var(--mono);
  margin-left: 2px;
}

.list-scroll {
  overflow-y: auto;
  flex: 1;
  padding: 8px;
}
.question-item {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 10px;
  padding: 11px 12px;
  cursor: pointer;
  transition: 0.16s ease;
  margin-bottom: 3px;
}
.question-item:hover {
  background: var(--panel-soft);
}
.question-item.active {
  background: var(--panel);
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}
.qi-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.qi-stem {
  font-family: var(--serif);
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--ink);
  margin-bottom: 7px;
}
.qi-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}
.pager {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
}

.detail-panel {
  padding: 0;
  max-height: calc(100vh - 190px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.detail-head {
  padding: 18px 22px 15px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
  background: linear-gradient(180deg, var(--panel), var(--panel-soft));
}
.detail-kicker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.detail-head h2 {
  font-size: 19px;
  line-height: 1.5;
}
.detail-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.detail-actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: none;
}
.detail-scroll {
  overflow-y: auto;
  padding: 20px 22px 26px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.stem-block {
  font-size: 15px;
}
.option-list {
  margin-top: 13px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.option-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-soft);
  font-size: 13.5px;
}
.option-letter {
  width: 22px;
  height: 22px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  font-family: var(--serif);
  font-size: 11px;
  color: var(--ink-2);
  background: var(--panel);
}

.answer-block {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
  overflow: hidden;
}
.answer-block summary {
  cursor: pointer;
  padding: 11px 14px;
  font-size: 13px;
  color: var(--ink-2);
  font-weight: 500;
  list-style: none;
}
.answer-block summary::-webkit-details-marker {
  display: none;
}
.answer-block summary::before {
  content: "＋";
  margin-right: 8px;
  color: var(--accent);
}
.answer-block[open] summary::before {
  content: "－";
}
.answer-body {
  border-top: 1px solid var(--line);
  padding: 13px 15px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--panel);
}
.answer-line,
.solution-line {
  display: flex;
  gap: 10px;
}
.answer-label {
  flex: none;
  font-family: var(--serif);
  font-size: 12px;
  color: var(--terra);
  border: 1px solid #ecd4c6;
  background: var(--terra-soft);
  border-radius: 5px;
  padding: 1px 7px;
  height: fit-content;
  margin-top: 2px;
}

.note-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

/* 备注预览：视觉上等同 textarea，点一下进编辑态 */
.note-view {
  min-height: 90px;
  padding: 10px 13px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: #fffefb;
  cursor: text;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.note-view:hover {
  border-color: var(--accent);
}
.note-placeholder {
  color: #a7aca5;
  font-size: 14px;
  line-height: 1.6;
}
.empty-inline {
  padding: 14px;
  border: 1px dashed var(--line-strong);
  border-radius: 9px;
  color: var(--muted);
  font-size: 12.5px;
  background: var(--panel-soft);
}

.variant-set {
  margin-bottom: 14px;
}
.variant-set-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 7px;
}
.set-badge {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--ink);
  color: #f4efe4;
}
.variant-card {
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 10px 12px;
  margin-bottom: 7px;
  background: var(--panel);
}
.variant-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}
.variant-top .ellipsis {
  flex: 1;
  font-size: 11px;
}
.variant-do {
  margin-left: auto;
}
.variant-stem {
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-2);
}
.variant-stem-rich {
  max-height: 4.9em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.attempt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  border-bottom: 1px dashed var(--line);
  font-size: 12.5px;
}
.attempt-row:last-child {
  border-bottom: 0;
}
.attempt-answer {
  flex: 1;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink-2);
}
.attempt-time {
  white-space: nowrap;
}

/* Modal */
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
  animation: fade-up 0.25s ease both;
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
.import-textarea {
  font-family: var(--mono);
  font-size: 12.5px;
  min-height: 210px;
  background: #fffefb;
}
/* 整理提示词卡片：两步走里的第 1 步 */
.prompt-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--panel-soft);
  padding: 12px 14px;
}
.prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.prompt-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
}
.step-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: #f6f2e7;
  font-size: 11px;
  font-weight: 700;
  flex: none;
}
.prompt-actions {
  display: flex;
  gap: 8px;
}
.prompt-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.prompt-text {
  margin: 10px 0 0;
  max-height: 220px;
  overflow: auto;
  background: #fffefb;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.step-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-2);
}
.step-line strong {
  color: var(--accent);
  font-weight: 600;
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
.import-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 12px;
  background: var(--panel-soft);
}
.import-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.import-skip {
  font-size: 12px;
  margin-top: 3px;
}

@media (max-width: 1280px) {
  .wb-grid {
    grid-template-columns: 168px 300px minmax(0, 1fr);
  }
}
@media (max-width: 1080px) {
  .wb-grid {
    grid-template-columns: 1fr;
  }
  .chapter-panel,
  .list-panel {
    position: static;
    max-height: none;
  }
  .chapter-panel {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .chapter-panel .panel-head {
    width: 100%;
  }
  .chapter-item {
    width: auto;
  }
  .list-panel {
    max-height: 440px;
  }
  .detail-panel {
    max-height: none;
  }
  .detail-scroll {
    overflow: visible;
  }
}
@media (max-width: 640px) {
  .header-actions {
    width: 100%;
    justify-content: space-between;
  }
  .detail-head {
    flex-direction: column;
  }
  .detail-actions {
    flex-direction: row;
    width: 100%;
  }
}
.print-loading {
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  font-size: 14px;
}
</style>
