<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type {
  ExamBlueprint,
  ExamMode,
  ExamPaper,
  ExamPaperItem,
  ExamPaperSummary,
  ExamPaperUpload,
} from '@tutor/shared';
import { API_BASE, del, errorMessage, get, getAccessToken, post, put } from '@/api/client';
import { cleanOption, plainPreview } from '@/lib/rich';
import { compressImage } from '@/lib/upload';
import MathText from '@/components/MathText.vue';
import PrintSheet from '@/components/PrintSheet.vue';
import ExamPrint from '@/components/ExamPrint.vue';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import StatusTag from '@/components/StatusTag.vue';
import NavIcon from '@/components/NavIcon.vue';

const STORAGE_KEY = 'tutor.currentExamId';
const route = useRoute();

/** 当前考试科目：数学用原蓝图（选择/填空/计算），英语用库课章节蓝图（选择/翻译）。 */
const subject = ref<'math' | 'english'>(route.query.subject === 'english' ? 'english' : 'math');
const subjectName = computed(() => (subject.value === 'english' ? '大学英语' : '高等数学'));
const SUBJECT_TABS = [
  { key: 'math', label: '高等数学' },
  { key: 'english', label: '大学英语' },
] as const;

// ---------- 组卷规则 / 题池 ----------
const blueprint = ref<ExamBlueprint | null>(null);
const loadingBlueprint = ref(true);
const blueprintError = ref('');

interface PoolStats {
  questions: { total: number; unused: number };
  variants: { total: number; unused: number };
}
const pool = ref<PoolStats | null>(null);
const resettingPool = ref(false);

/** 从组卷蓝图的所有模块中提取去重后的章节列表。 */
const chapters = computed(() => {
  const list = blueprint.value?.modules.flatMap((m) => m.chapters) ?? [];
  return [...new Set(list)];
});

// ---------- 组卷 ----------
const examMode = ref<ExamMode>('mock');
const pickedChapters = ref<string[]>([]);
const generating = ref(false);
const generateError = ref('');

// ---------- 历史试卷 ----------
const history = ref<ExamPaperSummary[]>([]);
const historyTotal = ref(0);
const loadingHistory = ref(false);
const deletingId = ref('');
const historyError = ref('');

// ---------- 答卷 ----------
const paper = ref<ExamPaper | null>(null);
const answers = reactive<Record<string, string>>({});
const ratings = reactive<Record<string, string>>({});
const uploads = ref<ExamPaperUpload[]>([]);
const submitting = ref(false);
const submitError = ref('');
const confirmSubmit = ref(false);
const result = ref<ExamPaper | null>(null);

// 打印/导出 PDF
const printOpen = ref(false);
const printWithAnswer = ref(false);
/** 当前用于打印的试卷：结果页有 result 用 result，否则用进行中的 paper */
const printPaper = computed(() => result.value ?? paper.value);
/**
 * 打开打印预览，点击「打印」按钮时触发。
 * @param withAnswer 是否连带答案与解析一起打印，默认 false
 */
function openPrint(withAnswer = false) {
  if (!printPaper.value) return;
  printWithAnswer.value = withAnswer;
  printOpen.value = true;
}

// 倒计时以服务器 deadline 为准（刷新 / 换设备不重置）
const remainingSec = ref(0);
let timer: number | null = null;
let autoSubmitted = false;

// 自动保存
const savedAt = ref('');
const saving = ref(false);
let saveTimer: number | null = null;
let suppressWatch = false;

// 拍照上传
const uploadingKey = ref(''); // 'blank' 或 questionNo
const uploadError = ref('');
const ocrNotice = ref(''); // 识别降级提示：照片已保存但视觉服务暂不可用
const fileInput = ref<HTMLInputElement | null>(null);
let pendingUpload: { section: 'blank' | 'solve'; questionNo: number | null } | null = null;

// 手机拍照二维码
const qrVisible = ref(false);
const qrLoading = ref(false);
const qrDataUrl = ref('');
const qrUrl = ref('');
const qrError = ref('');

/** 当前页面阶段：idle（组卷）/ taking（作答中）/ result（已交卷结果）。 */
const mode = computed<'idle' | 'taking' | 'result'>(() => {
  if (result.value) return 'result';
  if (paper.value) return 'taking';
  return 'idle';
});

/** 把剩余秒数格式化为 H:MM:SS（不足 1 小时省略小时位），用于倒计时显示。 */
const timerText = computed(() => {
  const s = Math.max(0, remainingSec.value);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
});
/** 剩余时间不足 5 分钟时进入紧张样式。 */
const timerUrgent = computed(() => remainingSec.value > 0 && remainingSec.value <= 300);

/** 把试卷题目按大题（sectionName）分组，供分段渲染。 */
const sections = computed(() => {
  const src = result.value ?? paper.value;
  if (!src) return [];
  const map = new Map<string, ExamPaperItem[]>();
  for (const item of src.items) {
    if (!map.has(item.sectionName)) map.set(item.sectionName, []);
    map.get(item.sectionName)!.push(item);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
});

/**
 * 判断题目是否为主观题（计算/证明/应用题，以及英语的翻译题），这类题按自评、上传照片或译文文本计为已作答。
 * @param it 试卷题目
 * @returns 是否主观题
 */
const isSolve = (it: ExamPaperItem) =>
  ['计算题', '证明题', '应用题', '翻译题'].includes(it.questionType);

/** 试卷中的填空题列表，支持一张答题卡照片识别多题（英语卷没有填空题）。 */
const blankItems = computed(() => paper.value?.items.filter((it) => it.questionType === '填空题') ?? []);

/** 已作答题目数：选择题/填空题按文本答案，翻译题按译文文本或自评，其它主观题按自评或上传照片。 */
const answeredCount = computed(() => {
  if (!paper.value) return 0;
  return paper.value.items.filter((it) => {
    const text = (answers[it.questionId] ?? '').trim();
    if (it.questionType === '翻译题') {
      return Boolean(text) || Boolean(ratings[it.questionId]) || Boolean(uploadOf(it.no));
    }
    if (isSolve(it)) return Boolean(ratings[it.questionId]) || Boolean(uploadOf(it.no));
    return Boolean(text);
  }).length;
});

/** 得分百分比，用于结果页的分数环展示。 */
const resultPercent = computed(() => {
  if (!result.value || !result.value.maxScore) return 0;
  return Math.round(((result.value.totalScore ?? 0) / result.value.maxScore) * 100);
});

/**
 * 按题号查找解答题已上传的过程照。
 * @param questionNo 题号
 * @returns 上传记录，或 undefined
 */
function uploadOf(questionNo: number): ExamPaperUpload | undefined {
  return uploads.value.find((u) => u.section === 'solve' && u.questionNo === questionNo);
}
/** 填空题答题卡照片（一张覆盖多题），未上传时为 undefined。 */
const blankUpload = computed(() => uploads.value.find((u) => u.section === 'blank'));

/**
 * 拼接带 token 的上传图片地址，供照片预览（图片接口需鉴权）。
 * @param u 上传记录
 * @returns 图片 URL
 */
function uploadImgUrl(u: ExamPaperUpload): string {
  const examId = (result.value ?? paper.value)?.id ?? '';
  return `${API_BASE}/exams/${examId}/uploads/${u.file}?token=${encodeURIComponent(getAccessToken() ?? '')}`;
}

// ---------- 计时 ----------
/** 停止每秒倒计时定时器。 */
function clearTimer() {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }
}

/**
 * 启动考试倒计时：按服务器 deadline 每秒刷新剩余秒数，归零时自动交卷（仅触发一次）。
 * 以服务器截止时间为准，刷新页面或换设备不会重置考试时长。
 * @param deadline 交卷截止时间；不传则立即归零
 */
function startTimer(deadline?: string) {
  clearTimer();
  autoSubmitted = false;
  const tick = () => {
    const end = deadline ? new Date(deadline).getTime() : Date.now();
    remainingSec.value = Math.max(0, Math.round((end - Date.now()) / 1000));
    if (remainingSec.value <= 0) {
      clearTimer();
      if (!autoSubmitted && mode.value === 'taking') {
        autoSubmitted = true;
        void submitExam(true);
      }
    }
  };
  tick();
  timer = window.setInterval(tick, 1000);
}

// ---------- 自动保存 ----------
/**
 * 作答内容变动时安排 1.5 秒防抖自动保存；仅在作答阶段且非回填数据时生效。
 */
function scheduleSave() {
  if (suppressWatch || mode.value !== 'taking' || !paper.value) return;
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 1500);
}

/**
 * 把当前所有作答与自评立即 PUT 到 /exams/:id/answers，并更新「已保存」时间。
 * 自动保存失败不打扰用户，下次改动会重试。
 */
async function flushSave() {
  if (!paper.value || mode.value !== 'taking') return;
  const patch: Record<string, { answer?: string; selfRating?: string | null }> = {};
  for (const it of paper.value.items) {
    const qid = it.questionId;
    const entry: { answer?: string; selfRating?: string | null } = {};
    if (answers[qid] !== undefined) entry.answer = answers[qid];
    if (ratings[qid]) entry.selfRating = ratings[qid];
    if (Object.keys(entry).length > 0) patch[qid] = entry;
  }
  if (Object.keys(patch).length === 0) return;
  saving.value = true;
  try {
    await put(`/exams/${paper.value.id}/answers`, { answers: patch });
    const d = new Date();
    savedAt.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
      d.getSeconds(),
    ).padStart(2, '0')}`;
  } catch {
    // 自动保存失败不打扰，下次改动会重试
  } finally {
    saving.value = false;
  }
}

/** 监听答案与自评的变化，触发防抖自动保存。 */
watch([() => ({ ...answers }), () => ({ ...ratings })], scheduleSave);

/** 清空所有作答、自评、上传照片与交卷确认态，用于进入新试卷。 */
function resetAnswers() {
  for (const key of Object.keys(answers)) delete answers[key];
  for (const key of Object.keys(ratings)) delete ratings[key];
  uploads.value = [];
  confirmSubmit.value = false;
  submitError.value = '';
  savedAt.value = '';
}

/** 把服务器返回的自动保存作答填回表单（不触发自动保存） */
function applySavedAnswers(data: ExamPaper) {
  suppressWatch = true;
  try {
    for (const [qid, v] of Object.entries(data.answers ?? {})) {
      if (typeof v.answer === 'string') answers[qid] = v.answer;
      if (typeof v.selfRating === 'string' && v.selfRating) ratings[qid] = v.selfRating;
    }
  } finally {
    suppressWatch = false;
  }
}

// ---------- 数据加载 ----------
/** 调用 GET /exams/blueprint 按科目加载组卷规则与可选章节范围。 */
async function loadBlueprint() {
  loadingBlueprint.value = true;
  blueprintError.value = '';
  try {
    blueprint.value = await get<ExamBlueprint>(`/exams/blueprint?subject=${subject.value}`);
  } catch (err) {
    blueprintError.value = errorMessage(err);
  } finally {
    loadingBlueprint.value = false;
  }
}

/** 调用 GET /exams/pool 加载当前科目的题库使用统计（已用/未用题数），失败时置空。 */
async function loadPool() {
  try {
    pool.value = await get<PoolStats>(`/exams/pool?subject=${subject.value}`);
  } catch {
    pool.value = null;
  }
}

/** 调用 GET /exams 加载历史试卷，只保留当前科目的卷；失败时展示错误提示。 */
async function loadHistory() {
  loadingHistory.value = true;
  historyError.value = '';
  try {
    const data = await get<{ items: ExamPaperSummary[]; total: number }>('/exams?limit=200');
    history.value = data.items.filter((h) => h.subject === subject.value);
    historyTotal.value = history.value.length;
  } catch {
    history.value = [];
    historyTotal.value = 0;
    historyError.value = '历史试卷加载失败，请稍后重试';
  } finally {
    loadingHistory.value = false;
  }
}

/** 手动删除已保存的试卷；删除正在查看/作答的卷时回到组卷页 */
async function removeExam(h: ExamPaperSummary) {
  const label = `${h.paperNo ? `第 ${h.paperNo} 套 · ` : ''}${h.title}`;
  if (!window.confirm(`确定删除「${label}」吗？\n\n试卷记录、作答与答题卡照片将一并删除且不可恢复；错题本里的错题记录会保留。`)) {
    return;
  }
  deletingId.value = h.id;
  historyError.value = '';
  try {
    await del(`/exams/${h.id}`);
    const isCurrent = paper.value?.id === h.id || result.value?.id === h.id;
    if (isCurrent) {
      restart();
    } else {
      await loadHistory();
    }
  } catch (err) {
    historyError.value = `删除失败：${errorMessage(err)}`;
  } finally {
    deletingId.value = '';
  }
}

/** 重置题池使用记录（POST /exams/pool/reset）让题目重新可用，随后刷新统计。 */
async function resetPool() {
  resettingPool.value = true;
  try {
    await post('/exams/pool/reset', { subject: subject.value });
    await loadPool();
  } catch {
    // 忽略
  } finally {
    resettingPool.value = false;
  }
}

/**
 * 打开历史试卷：调用 GET /exams/:id 加载后进入试卷。
 * @param id 试卷 ID
 */
async function openExam(id: string) {
  try {
    const data = await get<ExamPaper>(`/exams/${id}`);
    enterPaper(data);
  } catch (err) {
    generateError.value = errorMessage(err);
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * 进入一份试卷：重置作答区并把试卷 ID 写入 localStorage。
 * 已交卷的卷直接展示结果；未交卷的回填自动保存的作答，并以服务器 deadline 启动倒计时。
 * @param data 试卷数据
 */
function enterPaper(data: ExamPaper) {
  resetAnswers();
  paper.value = data;
  uploads.value = data.uploads ?? [];
  localStorage.setItem(STORAGE_KEY, data.id);
  if (data.submittedAt) {
    result.value = data;
    paper.value = null;
    uploads.value = data.uploads ?? [];
  } else {
    result.value = null;
    applySavedAnswers(data);
    startTimer(data.deadline);
  }
}

/** 页面初始化时根据 localStorage 中的试卷 ID 自动恢复上次作答/查看的试卷。 */
async function resumeSaved() {
  const savedId = localStorage.getItem(STORAGE_KEY);
  if (!savedId) return;
  try {
    const data = await get<ExamPaper>(`/exams/${savedId}`);
    // 上一科目留下的续答缓存不能串到当前科目页（数学卷别出现在英语页）
    if (data.subject !== subject.value) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    enterPaper(data);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * 勾选/取消章节考试的章节范围，点击章节时触发。
 * @param c 章节名
 */
function toggleChapter(c: string) {
  const i = pickedChapters.value.indexOf(c);
  if (i >= 0) pickedChapters.value.splice(i, 1);
  else pickedChapters.value.push(c);
}

/**
 * 组卷按钮处理器，点击「生成试卷」时触发。
 * 章节模式需先勾选章节；调用 POST /exams/generate 组卷后进入试卷，并刷新题池统计与历史列表。
 */
async function generate() {
  if (examMode.value === 'chapter' && pickedChapters.value.length === 0) {
    generateError.value = '章节考试请先勾选至少一个章节';
    return;
  }
  generating.value = true;
  generateError.value = '';
  try {
    const data = await post<ExamPaper>('/exams/generate', {
      subject: subject.value,
      mode: examMode.value,
      range: examMode.value === 'chapter' ? pickedChapters.value : undefined,
    });
    enterPaper(data);
    void loadPool();
    void loadHistory();
  } catch (err) {
    generateError.value = errorMessage(err);
  } finally {
    generating.value = false;
  }
}

// ---------- 作答 ----------
/**
 * 选择题作答处理器，再次点击同一选项则取消选择。
 * @param item 题目
 * @param letter 选项字母
 */
function setChoice(item: ExamPaperItem, letter: string) {
  answers[item.questionId] = answers[item.questionId] === letter ? '' : letter;
}

/**
 * 解答题自评处理器，再次点击同一项则取消。
 * @param item 题目
 * @param value 自评状态值
 */
function toggleRating(item: ExamPaperItem, value: string) {
  ratings[item.questionId] = ratings[item.questionId] === value ? '' : value;
}

// ---------- 拍照上传 ----------
/**
 * 记录待上传目标并触发拍照/选图，点击拍照上传按钮时触发。
 * @param section 上传目标：blank（填空答题卡）或 solve（解答过程）
 * @param questionNo 解答题题号；填空题传 null
 */
function pickPhoto(section: 'blank' | 'solve', questionNo: number | null) {
  pendingUpload = { section, questionNo };
  uploadError.value = '';
  fileInput.value?.click();
}

/**
 * 照片选择后的上传处理器：压缩后 POST 到 /exams/:id/uploads，重拍会替换同题旧照。
 * 填空题会尝试 OCR 识别答案并回填输入框，识别服务不可用时给出降级提示。
 * @param e 文件输入框的 change 事件
 */
async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const pending = pendingUpload;
  pendingUpload = null;
  if (!file || !pending || !paper.value) return;
  uploadingKey.value = pending.section === 'blank' ? 'blank' : String(pending.questionNo);
  uploadError.value = '';
  ocrNotice.value = '';
  try {
    const dataUrl = await compressImage(file);
    const res = await post<{ upload: ExamPaperUpload; blankAnswers: Record<string, { answer?: string }>; ocrFailed: boolean }>(
      `/exams/${paper.value.id}/uploads`,
      { section: pending.section, questionNo: pending.questionNo, image: dataUrl },
    );
    // 更新本地照片列表（填空区一张 / 解答题每题一张，重拍替换）
    uploads.value = [
      res.upload,
      ...uploads.value.filter((u) =>
        res.upload.section === 'blank' ? u.section !== 'blank' : !(u.section === 'solve' && u.questionNo === res.upload.questionNo),
      ),
    ];
    if (res.ocrFailed) {
      ocrNotice.value = '照片已保存，但识别服务暂时不可用：请手动填写填空答案，解答题请在下方自评（或稍后重拍）。';
    }
    // 填空识别结果回填输入框（可继续手改，改动会随自动保存覆盖）
    for (const [qid, v] of Object.entries(res.blankAnswers ?? {})) {
      if (typeof v.answer === 'string') answers[qid] = v.answer;
    }
  } catch (err) {
    uploadError.value = errorMessage(err);
  } finally {
    uploadingKey.value = '';
  }
}

// ---------- 手机拍照二维码 ----------
/**
 * 打开手机拍照二维码弹窗，调用 GET /settings/mobile 生成本场考试专属的扫码访问地址。
 */
async function openQr() {
  if (!paper.value) return;
  qrVisible.value = true;
  qrLoading.value = true;
  qrError.value = '';
  qrDataUrl.value = '';
  try {
    const data = await get<{ url: string; qrDataUrl: string }>(
      `/settings/mobile?path=${encodeURIComponent(`/m/exam/${paper.value.id}`)}`,
    );
    qrDataUrl.value = data.qrDataUrl;
    qrUrl.value = data.url;
  } catch (err) {
    qrError.value = errorMessage(err);
  } finally {
    qrLoading.value = false;
  }
}

// ---------- 交卷 ----------
/**
 * 交卷处理器，点击「交卷」或倒计时归零时触发。
 * 首次点击仅弹出二次确认；确认后先 flushSave 落盘，再 POST /exams/:id/submit，成功后停止计时、展示结果并刷新历史。
 * @param auto 是否为到点自动交卷，默认 false
 */
async function submitExam(auto = false) {
  if (!paper.value || submitting.value) return;
  if (!auto && !confirmSubmit.value) {
    confirmSubmit.value = true;
    return;
  }
  if (saveTimer) window.clearTimeout(saveTimer);
  submitting.value = true;
  submitError.value = '';
  try {
    await flushSave();
    const payload = {
      answers: paper.value.items.map((it) => ({
        questionId: it.questionId,
        answer: answers[it.questionId] ?? '',
        selfRating: ratings[it.questionId] || undefined,
      })),
    };
    const data = await post<ExamPaper>(`/exams/${paper.value.id}/submit`, payload);
    clearTimer();
    uploads.value = data.uploads ?? [];
    result.value = data;
    paper.value = null;
    confirmSubmit.value = false;
    localStorage.setItem(STORAGE_KEY, data.id);
    void loadHistory();
  } catch (err) {
    submitError.value = errorMessage(err);
    confirmSubmit.value = false;
  } finally {
    submitting.value = false;
  }
}

/** 返回组卷页：停计时与自动保存、清空试卷/作答/打印状态、移除本地试卷 ID，并刷新题池与历史。 */
function restart() {
  clearTimer();
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = null;
  printOpen.value = false;
  paper.value = null;
  result.value = null;
  resetAnswers();
  localStorage.removeItem(STORAGE_KEY);
  void loadPool();
  void loadHistory();
}

/**
 * 把时间格式化为 YYYY-MM-DD HH:mm，用于历史试卷列表。
 * @param value 时间字符串，可为空
 * @returns 格式化后的时间；入参为空时返回空串
 */
function formatDate(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(
    2,
    '0',
  )} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 把自评状态值转成中文标签。
 * @param value 自评状态值
 * @returns 中文标签；未知值原样返回
 */
function ratingLabel(value: string) {
  return { self_pass: '已掌握', self_partial: '部分掌握', self_fail: '未掌握' }[value] ?? value;
}

/**
 * 组件挂载：加载组卷规则、题池统计与历史试卷，并尝试从本地记录恢复上次未完成的试卷。
 */
/** 切换科目：丢弃上一科的续答缓存与章节勾选，重新加载蓝图、题池与历史。 */
watch(subject, () => {
  localStorage.removeItem(STORAGE_KEY);
  pickedChapters.value = [];
  examMode.value = 'mock';
  restart();
  void loadBlueprint();
});

onMounted(async () => {
  await loadBlueprint();
  void loadPool();
  void loadHistory();
  await resumeSaved();
});

/** 组件卸载：停止倒计时与自动保存定时器，避免离开页面后继续触发。 */
onBeforeUnmount(() => {
  clearTimer();
  if (saveTimer) window.clearTimeout(saveTimer);
});
</script>

<template>
  <div class="page page-wide exam-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">答题卡考试 · 按湖南专升本组卷规则</div>
        <h1 class="page-title">模拟考试</h1>
        <p class="page-desc">
          题目从错题本与变式中抽取（考过自动打标、不重复出）；{{ subjectName }}按{{ subject === 'english' ? '库课英语笔记章节组卷，选择题自动判定、翻译题输入译文由 AI 按采分点评分' : '填空/计算题可拍照识别与 AI 按步骤评分' }}；到点未交自动交卷。
        </p>
        <div v-if="mode === 'idle'" class="header-subject-switch">
          <span class="header-label">考试科目</span>
          <div class="mode-switch subject-switch">
            <button
              v-for="s in SUBJECT_TABS"
              :key="s.key"
              type="button"
              class="mode-chip"
              :class="{ active: subject === s.key }"
              @click="subject = s.key"
            >
              {{ s.label }}
            </button>
          </div>
        </div>
      </div>
      <div v-if="mode !== 'idle'" class="exam-status">
        <div v-if="mode === 'taking'" class="timer" :class="{ urgent: timerUrgent }">
          <span class="timer-label">剩余</span>
          <span class="timer-value mono">{{ timerText }}</span>
        </div>
        <button v-if="mode === 'taking'" class="btn btn-sm" type="button" @click="openPrint(false)">
          <NavIcon name="print" :size="14" /> 打印空白卷
        </button>
        <button class="btn btn-sm" type="button" @click="restart">
          <NavIcon name="arrow-left" :size="14" /> {{ mode === 'result' ? '返回组卷' : '放弃本卷' }}
        </button>
      </div>
    </header>

    <LoadingState v-if="loadingBlueprint" text="加载组卷规则…" />
    <ErrorState v-else-if="blueprintError" :message="blueprintError" @retry="loadBlueprint" />

    <!-- 空闲：组卷 + 历史 -->
    <template v-else-if="mode === 'idle'">
      <div class="exam-intro-grid">
        <section class="card intro-card">
          <div class="intro-mark"><NavIcon name="exam" :size="24" /></div>
          <h2>{{ blueprint?.meta.title || `湖南专升本${subjectName}模拟卷` }}</h2>

          <p v-if="subject === 'english'" class="small muted subject-hint">
            按《库课·大学英语》笔记章节组卷 · 题型只有选择题与翻译题
          </p>

          <div class="mode-switch">
            <button
              type="button"
              class="mode-chip"
              :class="{ active: examMode === 'mock' }"
              @click="examMode = 'mock'"
            >
              模拟考试 · 全考纲
            </button>
            <button
              type="button"
              class="mode-chip"
              :class="{ active: examMode === 'chapter' }"
              @click="examMode = 'chapter'"
            >
              章节考试 · 小范围
            </button>
          </div>

          <p v-if="examMode === 'mock'" class="muted mode-desc">
            按「{{ blueprint?.meta.question_count || 22 }} 题 / {{ blueprint?.meta.total_score || 150 }} 分 /
            {{ blueprint?.meta.minutes || 120 }} 分钟」全真结构组卷。
          </p>
          <template v-else>
            <p class="muted mode-desc">勾选要考的章节，题量与时长按所选范围等比缩放：</p>
            <div class="chapter-pick">
              <button
                v-for="c in chapters"
                :key="c"
                type="button"
                class="chapter-chip"
                :class="{ active: pickedChapters.includes(c) }"
                @click="toggleChapter(c)"
              >
                {{ c }}
              </button>
            </div>
          </template>

          <div v-if="pool" class="pool-line small muted">
            出题池：原题未考 {{ pool.questions.unused }}/{{ pool.questions.total }} · 变式未考
            {{ pool.variants.unused }}/{{ pool.variants.total }}
            <button class="pool-reset" type="button" :disabled="resettingPool" @click="resetPool">
              {{ resettingPool ? '重置中…' : '重置考过标记' }}
            </button>
          </div>

          <button class="btn btn-primary btn-lg generate-btn" type="button" :disabled="generating" @click="generate">
            <span v-if="generating" class="spinner spinner-light" />
            <NavIcon v-else name="spark" :size="18" />
            {{ generating ? '正在组卷…' : examMode === 'mock' ? '生成一套模拟卷' : '生成章节考试卷' }}
          </button>
          <p v-if="generateError" class="banner banner-error mt-16">{{ generateError }}</p>
        </section>

        <aside class="card rules-card">
          <h3>历史试卷 <span v-if="historyTotal" class="history-total small muted">共 {{ historyTotal }} 套</span></h3>
          <p class="small muted history-hint">生成的试卷会自动保存，可随时打开继续作答或打印；不需要的可手动删除。</p>
          <div v-if="loadingHistory" class="small muted">加载中…</div>
          <div v-else-if="history.length === 0" class="small muted">还没有考过，生成第一套吧。</div>
          <div v-else class="history-list">
            <div v-for="h in history" :key="h.id" class="history-entry">
              <button type="button" class="history-row" @click="openExam(h.id)">
                <span class="history-title">{{ h.title }}</span>
                <span class="history-meta small muted">
                  {{ h.mode === 'mock' ? '模拟' : '章节' }} · {{ formatDate(h.createdAt) }}
                </span>
                <span v-if="h.submittedAt" class="history-score mono">{{ h.totalScore ?? 0 }}/{{ h.maxScore }}</span>
                <span v-else class="history-pending">继续作答</span>
              </button>
              <button
                type="button"
                class="history-delete"
                :disabled="deletingId === h.id"
                :title="`删除${h.title}`"
                :aria-label="`删除${h.title}`"
                @click="removeExam(h)"
              >
                <NavIcon name="trash" :size="15" />
              </button>
            </div>
          </div>
          <p v-if="historyError" class="banner banner-error small mt-8">{{ historyError }}</p>
          <div class="rule-note">
            <strong>评分说明</strong>
            <p v-if="subject === 'english'">
              选择题自动判定；翻译题直接输入译文，AI 按关键词、时态语态、从句语序与整体意思给分（也可拍照上传手写译文）。错题自动回写错题本。
            </p>
            <p v-else>
              选择题自动判定；填空题可手输或整张拍照识别，AI 判数学等价；计算题逐题拍照上传手写过程，AI
              按步骤给分（未上传按自评计分）。错题自动回写错题本。
            </p>
          </div>
        </aside>
      </div>
    </template>

    <!-- 答题 -->
    <template v-else-if="mode === 'taking' && paper">
      <div class="take-bar card">
        <div class="take-info">
          <span class="tag tag-mono">{{ paper.paperNo ? `第 ${paper.paperNo} 套` : paper.id.slice(0, 8) }}</span>
          <span class="small muted">{{ paper.title }}</span>
          <span class="small muted">已答 {{ answeredCount }} / {{ paper.items.length }}</span>
          <span v-if="saving" class="small muted">保存中…</span>
          <span v-else-if="savedAt" class="small muted">已自动保存 {{ savedAt }}</span>
        </div>
        <div class="take-actions">
          <button class="btn btn-sm" type="button" @click="openQr">
            <NavIcon name="scan" :size="14" /> 手机拍照
          </button>
          <span v-if="confirmSubmit" class="confirm-text">确认交卷？未作答题目将记 0 分</span>
          <button v-if="!confirmSubmit" class="btn btn-sm" type="button" @click="confirmSubmit = true">交卷</button>
          <template v-else>
            <button class="btn btn-sm" type="button" :disabled="submitting" @click="confirmSubmit = false">取消</button>
            <button class="btn btn-sm btn-primary" type="button" :disabled="submitting" @click="submitExam()">
              <span v-if="submitting" class="spinner spinner-light" /> 确认交卷
            </button>
          </template>
        </div>
      </div>
      <div v-if="submitError" class="banner banner-error">{{ submitError }}</div>
      <div v-if="uploadError" class="banner banner-error">{{ uploadError }}</div>
      <div v-if="ocrNotice" class="banner banner-warn">{{ ocrNotice }}</div>

      <section v-for="sec in sections" :key="sec.name" class="exam-section">
        <div class="section-head">
          <h2>{{ sec.name }}</h2>
          <span class="small muted">{{ sec.items.length }} 题 · {{ sec.items.reduce((s, i) => s + i.points, 0) }} 分</span>
        </div>

        <!-- 填空区：整张答题卡拍照入口（按题型判断，英语卷没有填空题） -->
        <div v-if="sec.items.some((i) => i.questionType === '填空题')" class="card blank-card">
          <div class="blank-card-head">
            <strong>填空答题卡</strong>
            <span class="small muted">把 {{ blankItems.map((i) => i.no).join('、') }} 题答案标清题号写在一张纸上，拍一张全部识别</span>
          </div>
          <div class="blank-card-body">
            <button
              class="btn btn-sm"
              type="button"
              :disabled="uploadingKey === 'blank'"
              @click="pickPhoto('blank', null)"
            >
              <span v-if="uploadingKey === 'blank'" class="spinner" />
              <NavIcon v-else name="camera" :size="14" />
              {{ blankUpload ? '重拍答题卡' : '拍照上传答题卡' }}
            </button>
            <template v-if="blankUpload">
              <img :src="uploadImgUrl(blankUpload)" class="upload-thumb" alt="填空答题卡" />
              <span v-if="blankUpload.ocrText" class="small muted">已识别，答案已填入下面各题，可手动修改</span>
              <span v-else class="small muted">照片已保存，识别未成功，请手动填写答案</span>
            </template>
          </div>
        </div>

        <article v-for="item in sec.items" :key="item.no" class="card exam-item">
          <div class="item-head">
            <span class="item-no">{{ item.no }}</span>
            <span class="tag">{{ item.questionType }}</span>
            <span class="small muted">{{ item.module }}</span>
            <span v-if="item.variantId" class="tag tag-variant">变式</span>
            <span class="item-points mono">{{ item.points }} 分</span>
          </div>
          <div class="item-stem">
            <MathText :text="item.stem" />
          </div>

          <div v-if="item.questionType === '选择题'" class="exam-choices">
            <button
              v-for="letter in ['A', 'B', 'C', 'D']"
              :key="letter"
              type="button"
              class="exam-choice"
              :class="{ selected: answers[item.questionId] === letter }"
              @click="setChoice(item, letter)"
            >
              <span class="exam-letter">{{ letter }}</span>
              <span v-if="item.options?.[letter.charCodeAt(0) - 65]" class="choice-body">
                <MathText :text="cleanOption(item.options[letter.charCodeAt(0) - 65])" />
              </span>
              <span v-else class="choice-body muted">选项 {{ letter }}</span>
            </button>
          </div>

          <div v-else-if="item.questionType === '填空题'" class="exam-blank">
            <input
              v-model="answers[item.questionId]"
              class="input"
              placeholder="填写答案（或拍照识别）"
              :aria-label="`第 ${item.no} 题答案`"
            />
          </div>

          <div v-else class="exam-solve">
            <div class="solve-upload">
              <button
                class="btn btn-sm"
                type="button"
                :disabled="uploadingKey === String(item.no)"
                @click="pickPhoto('solve', item.no)"
              >
                <span v-if="uploadingKey === String(item.no)" class="spinner" />
                <NavIcon v-else name="camera" :size="14" />
                {{ uploadOf(item.no)
                  ? item.questionType === '翻译题' ? '重拍译文' : '重拍本题过程'
                  : item.questionType === '翻译题' ? '拍照上传手写译文（可选）' : '拍照上传解答过程' }}
              </button>
              <template v-if="uploadOf(item.no)">
                <img :src="uploadImgUrl(uploadOf(item.no)!)" class="upload-thumb" alt="解答过程" />
                <span class="small muted">已转录，交卷时 AI {{ item.questionType === '翻译题' ? '按译文采分点' : '按步骤' }}评分</span>
              </template>
            </div>
            <details v-if="uploadOf(item.no)?.ocrText" class="ocr-toggle">
              <summary>查看识别转录</summary>
              <pre class="ocr-text">{{ uploadOf(item.no)!.ocrText }}</pre>
            </details>
            <textarea
              v-model="answers[item.questionId]"
              class="textarea"
              :rows="item.questionType === '翻译题' ? 4 : 3"
              :placeholder="item.questionType === '翻译题'
                ? '输入你的译文（交卷时 AI 按采分点评分）…'
                : '备注 / 关键步骤（可选，不影响 AI 评分）…'"
            />
            <div class="rating-inline">
              <span class="small muted">自评（未上传照片时按此计分）：</span>
              <button
                v-for="opt in ['self_pass', 'self_partial', 'self_fail']"
                :key="opt"
                type="button"
                class="rating-chip"
                :class="{ active: ratings[item.questionId] === opt }"
                @click="toggleRating(item, opt)"
              >
                {{ ratingLabel(opt) }}
              </button>
            </div>
          </div>
        </article>
      </section>

      <div class="exam-bottom card">
        <div>
          <strong>已答 {{ answeredCount }} / {{ paper.items.length }}</strong>
          <span class="small muted"> · 交卷后不可修改</span>
        </div>
        <button class="btn btn-primary" type="button" :disabled="submitting" @click="submitExam()">
          <span v-if="submitting" class="spinner spinner-light" /> 交卷并判分
        </button>
      </div>

      <input ref="fileInput" type="file" accept="image/*" capture="environment" hidden @change="onFilePicked" />
    </template>

    <!-- 结果 -->
    <template v-else-if="mode === 'result' && result">
      <section class="card result-hero">
        <div class="score-ring" :style="{ '--pct': `${resultPercent}%` }">
          <div class="ring-inner">
            <span class="score-num">{{ result.totalScore ?? 0 }}</span>
            <span class="score-max">/ {{ result.maxScore }}</span>
          </div>
        </div>
        <div class="result-copy">
          <div class="eyebrow">{{ result.title }}</div>
          <h2>{{ resultPercent >= 85 ? '状态很稳，保持节奏。' : resultPercent >= 60 ? '基础在，细节还要抠。' : '先别急着刷题，回错题本补洞。' }}</h2>
          <p class="muted">
            共 {{ result.items.length }} 题，得分率 {{ resultPercent }}%。错题已写入作答记录并标记「待复习」，
            答疑时会结合它们给你针对性提醒。
          </p>
          <div class="result-meta small muted">
            <span>{{ result.mode === 'mock' ? '模拟考试' : '章节考试' }}</span>
            <span>交卷 {{ formatDate(result.submittedAt) }}</span>
          </div>
        </div>
        <div class="result-actions">
          <button class="btn" type="button" @click="openPrint(false)">
            <NavIcon name="print" :size="15" /> 打印空白卷
          </button>
          <button class="btn" type="button" @click="openPrint(true)">
            <NavIcon name="print" :size="15" /> 打印解析卷
          </button>
          <button class="btn btn-primary" type="button" @click="restart">再组一套</button>
        </div>
      </section>

      <section v-for="sec in sections" :key="sec.name" class="exam-section">
        <div class="section-head">
          <h2>{{ sec.name }}</h2>
          <span class="small muted">
            {{ sec.items.filter((i) => i.verdict === 'correct' || i.verdict === 'self_pass').length }} / {{ sec.items.length }} 全对
          </span>
        </div>
        <article v-for="item in sec.items" :key="item.no" class="card result-item">
          <div class="item-head">
            <span class="item-no">{{ item.no }}</span>
            <StatusTag :status="item.verdict" />
            <span class="small muted">{{ item.questionType }}</span>
            <span v-if="item.variantId" class="tag tag-variant">变式</span>
            <span class="item-points mono">{{ item.earned ?? 0 }} / {{ item.points }} 分</span>
          </div>
          <div class="item-stem"><MathText :text="item.stem" /></div>
          <div class="result-detail">
            <div v-if="uploadOf(item.no)" class="kv">
              <span class="kv-label">作答照片</span>
              <span class="kv-value">
                <a :href="uploadImgUrl(uploadOf(item.no)!)" target="_blank" rel="noopener">
                  <img :src="uploadImgUrl(uploadOf(item.no)!)" class="upload-thumb large" alt="作答照片" />
                </a>
              </span>
            </div>
            <div class="kv">
              <span class="kv-label">我的答案</span>
              <span class="kv-value">{{ item.userAnswer || (uploadOf(item.no) ? '（见照片）' : '（未作答）') }}</span>
            </div>
            <div v-if="item.answer" class="kv">
              <span class="kv-label">标准答案</span>
              <span class="kv-value">{{ plainPreview(item.answer, 80) }}</span>
            </div>
            <div v-if="item.reason" class="kv">
              <span class="kv-label">判定理由</span>
              <span class="kv-value">{{ plainPreview(item.reason, 160) }}</span>
            </div>
            <div v-if="item.suggestion" class="kv">
              <span class="kv-label">AI 建议</span>
              <span class="kv-value suggestion">{{ item.suggestion }}</span>
            </div>
          </div>
          <details v-if="item.solution" class="solution-toggle">
            <summary>查看解析</summary>
            <MathText :text="item.solution" />
          </details>
        </article>
      </section>
    </template>

    <!-- 手机拍照二维码弹窗 -->
    <Teleport to="body">
      <div v-if="qrVisible" class="modal-backdrop" @click.self="qrVisible = false">
        <div class="modal qr-modal">
          <div class="modal-head">
            <strong>手机拍照上传</strong>
            <button class="icon-btn" type="button" @click="qrVisible = false">✕</button>
          </div>
          <div class="modal-body qr-body">
            <p class="small muted">手机与电脑连同一 WiFi，扫码后即可拍照上传填空答题卡与解答题过程，照片实时同步到本页。</p>
            <div v-if="qrLoading" class="small muted">生成二维码…</div>
            <div v-else-if="qrError" class="banner banner-error">{{ qrError }}</div>
            <template v-else-if="qrDataUrl">
              <img :src="qrDataUrl" class="qr-img" alt="手机上传二维码" />
              <div class="qr-url mono">{{ qrUrl }}</div>
            </template>
          </div>
        </div>
      </div>
    </Teleport>

    <PrintSheet :open="printOpen" variant="exam" :title="`${printPaper?.title || '模拟卷'} · ${printWithAnswer ? '答案解析卷' : '空白试卷'}`" @close="printOpen = false">
      <ExamPrint v-if="printPaper" :paper="printPaper" :show-answer="printWithAnswer" />
    </PrintSheet>
  </div>
</template>

<style scoped>
.exam-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.exam-status {
  display: flex;
  align-items: center;
  gap: 12px;
}
.timer {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 8px 14px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow);
}
.timer.urgent {
  border-color: #e5b5ae;
  background: var(--danger-soft);
  color: var(--danger);
}
.timer-label {
  font-size: 11px;
  color: var(--muted);
}
.timer-value {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.exam-intro-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr);
  gap: 18px;
  align-items: start;
}
.intro-card {
  padding: 30px 32px;
}
.intro-mark {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  background: var(--accent-soft);
  color: var(--accent-dark);
  margin-bottom: 16px;
}
.intro-card h2 {
  font-size: 25px;
  margin-bottom: 14px;
}
.mode-switch {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.subject-switch {
  margin-top: 14px;
  margin-bottom: 8px;
}
.subject-hint {
  margin: 0 0 14px;
}
.header-subject-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.header-label {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.header-subject-switch .mode-switch {
  margin-bottom: 0;
}
.mode-chip {
  border: 1px solid var(--line-strong);
  background: var(--panel);
  border-radius: 99px;
  padding: 7px 16px;
  font-size: 13px;
  cursor: pointer;
  color: var(--ink-2);
}
.mode-chip.active {
  background: var(--ink);
  border-color: var(--ink);
  color: #f4efe4;
}
.mode-desc {
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 10px;
}
.chapter-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 12px;
}
.chapter-chip {
  border: 1px solid var(--line);
  background: var(--panel-soft);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--ink-2);
}
.chapter-chip.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-dark);
}
.pool-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 6px 0 16px;
}
.pool-reset {
  border: none;
  background: none;
  color: var(--accent-dark);
  font-size: 11.5px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}
.generate-btn {
  width: 100%;
}

.rules-card {
  padding: 22px;
}
.rules-card h3 {
  font-size: 16px;
  margin-bottom: 6px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.history-total {
  font-weight: 400;
  font-size: 11px;
}
.history-hint {
  margin: 0 0 10px;
  line-height: 1.6;
}
.history-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-height: 380px;
  overflow: auto;
}
.history-entry {
  display: grid;
  grid-template-columns: 1fr 30px;
  gap: 5px;
  align-items: center;
}
.history-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 10px;
  width: 100%;
  min-width: 0;
  text-align: left;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  border-radius: 9px;
  padding: 9px 12px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--ink);
}
.history-row:hover {
  border-color: var(--line-strong);
  background: #fff;
}
.history-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-meta {
  grid-column: 1;
  font-size: 10.5px;
}
.history-score {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  font-size: 13px;
  color: var(--terra);
}
.history-pending {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  font-size: 11.5px;
  color: var(--accent-dark);
}
.history-delete {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.history-delete:hover:not(:disabled) {
  color: var(--danger);
  border-color: #e3b7ad;
  background: var(--danger-soft);
}
.history-delete:disabled {
  opacity: 0.45;
  cursor: default;
}
.rule-note {
  margin-top: 17px;
  padding: 12px;
  border-radius: 9px;
  background: var(--amber-soft);
  border: 1px solid #eddcb5;
  font-size: 12px;
  line-height: 1.75;
  color: #6f4c0d;
}
.rule-note p {
  margin: 4px 0 0;
}

.take-bar {
  position: sticky;
  top: 10px;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  padding: 11px 16px;
  backdrop-filter: blur(8px);
}
.take-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.take-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.confirm-text {
  font-size: 12px;
  color: var(--danger);
}

.exam-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 10px;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 6px 4px;
  border-bottom: 2px solid var(--ink);
}
.section-head h2 {
  font-size: 19px;
}
.exam-item {
  padding: 19px 22px;
}
.item-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 12px;
}
.item-no {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: var(--ink);
  color: #f4efe4;
  font-family: var(--mono);
  font-size: 12px;
}
.item-points {
  margin-left: auto;
  font-size: 12px;
  color: var(--terra);
}
.item-stem {
  font-size: 14.5px;
}
.tag-variant {
  background: var(--accent-soft);
  color: var(--accent-dark);
}

.blank-card {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  border-style: dashed;
}
.blank-card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.blank-card-body {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.upload-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
}
.upload-thumb.large {
  width: 180px;
  height: 180px;
}

.exam-choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
  margin-top: 14px;
}
.exam-choice {
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  border-radius: 9px;
  padding: 8px 11px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink);
  transition: 0.16s ease;
}
.exam-choice:hover {
  border-color: var(--line-strong);
  background: #fff;
}
.exam-choice.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.exam-letter {
  width: 23px;
  height: 23px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: var(--panel);
  font-family: var(--serif);
  font-size: 11px;
}
.exam-choice.selected .exam-letter {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.exam-blank {
  margin-top: 14px;
  max-width: 420px;
}
.exam-solve {
  margin-top: 14px;
}
.solve-upload {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.ocr-toggle {
  margin-bottom: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-soft);
}
.ocr-toggle summary {
  cursor: pointer;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--ink-2);
  list-style: none;
}
.ocr-toggle summary::-webkit-details-marker {
  display: none;
}
.ocr-text {
  border-top: 1px solid var(--line);
  padding: 10px 13px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
  margin: 0;
  font-family: var(--mono);
}
.rating-inline {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 9px;
  flex-wrap: wrap;
}
.rating-chip {
  border: 1px solid var(--line-strong);
  background: var(--panel);
  border-radius: 99px;
  padding: 4px 12px;
  font-size: 11.5px;
  cursor: pointer;
  color: var(--ink-2);
}
.rating-chip.active {
  background: var(--ink);
  border-color: var(--ink);
  color: #f4efe4;
}

.exam-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  margin-top: 16px;
}

.result-hero {
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 28px 32px;
  background: linear-gradient(135deg, var(--panel) 40%, var(--accent-soft));
  border-color: #cfe6dd;
}
.score-ring {
  width: 128px;
  height: 128px;
  border-radius: 50%;
  flex: none;
  display: grid;
  place-items: center;
  background: conic-gradient(var(--accent) var(--pct), rgba(30, 107, 87, 0.14) 0);
  position: relative;
}
.score-ring::before {
  content: "";
  position: absolute;
  inset: 9px;
  border-radius: 50%;
  background: var(--panel);
}
.ring-inner {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 3px;
}
.score-num {
  font-family: var(--serif);
  font-size: 38px;
  font-weight: 700;
  color: var(--accent-dark);
  line-height: 1;
}
.score-max {
  font-size: 12px;
  color: var(--muted);
}
.result-copy {
  flex: 1;
}
.result-copy h2 {
  font-size: 24px;
  margin-bottom: 7px;
}
.result-copy p {
  margin: 0 0 8px;
  font-size: 13px;
  max-width: 640px;
}
.result-meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.result-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result-item {
  padding: 18px 22px;
}
.result-detail {
  margin-top: 12px;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kv {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
}
.kv-label {
  flex: none;
  width: 64px;
  color: var(--muted);
}
.kv-value {
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.kv-value.suggestion {
  color: var(--accent-dark);
}
.solution-toggle {
  margin-top: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-soft);
}
.solution-toggle summary {
  cursor: pointer;
  padding: 8px 12px;
  font-size: 12.5px;
  color: var(--ink-2);
  list-style: none;
}
.solution-toggle summary::-webkit-details-marker {
  display: none;
}
.solution-toggle > .rich {
  border-top: 1px solid var(--line);
  padding: 11px 13px;
  background: var(--panel);
  font-size: 13px;
}

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
  align-items: center;
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--line);
}
.modal-body {
  padding: 16px 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.qr-modal {
  max-width: 380px;
}
.qr-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}
.qr-img {
  width: 240px;
  height: 240px;
  border-radius: 10px;
  border: 1px solid var(--line);
}
.qr-url {
  font-size: 11.5px;
  color: var(--muted);
  word-break: break-all;
}

@media (max-width: 960px) {
  .exam-intro-grid {
    grid-template-columns: 1fr;
  }
  .result-hero {
    flex-wrap: wrap;
    gap: 18px;
    padding: 22px;
  }
  .result-actions {
    flex-direction: row;
    width: 100%;
  }
  .exam-choices {
    grid-template-columns: 1fr;
  }
}
</style>
