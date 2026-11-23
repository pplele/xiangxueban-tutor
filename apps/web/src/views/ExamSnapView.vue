<script setup lang="ts">
/**
 * 手机答题卡上传页（/m/exam/:id）——公开路由，无桌面侧边栏。
 * 与电脑端考试页配合：学生在电脑上做题，用本页拍照上传
 * 填空答题卡（一张多题）与解答题过程（一题一张），照片实时进 exams.uploads，
 * 电脑端刷新即可看到；交卷由电脑端（或到点强制）完成。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { ExamPaper, ExamPaperItem, ExamPaperUpload } from '@tutor/shared';
import { API_BASE, errorMessage, get, getAccessToken, post } from '@/api/client';
import { compressImage } from '@/lib/upload';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
auth.sync();

const route = useRoute();
const examId = String(route.params.id ?? '');

// ---------- 登录 ----------
const username = ref('');
const password = ref('');
const loginError = ref('');
const loggingIn = ref(false);

/**
 * 手机端登录表单提交处理器，点击登录按钮时触发。
 * 校验账号密码非空后调用 auth.signIn 发起登录，成功后立即加载试卷。
 */
async function submitLogin() {
  loginError.value = '';
  if (!username.value.trim() || !password.value) {
    loginError.value = '请输入账号和密码';
    return;
  }
  loggingIn.value = true;
  try {
    const ok = await auth.signIn(username.value, password.value);
    if (!ok) loginError.value = auth.error || '登录失败';
    else await loadExam();
  } finally {
    loggingIn.value = false;
  }
}

// ---------- 试卷 ----------
const paper = ref<ExamPaper | null>(null);
const loading = ref(true);
const loadError = ref('');

/** 试卷中的解答类题目（计算题、证明题、应用题），需一题一张上传过程照。 */
const solveItems = computed(
  () =>
    paper.value?.items.filter(
      (it) => it.questionType === '计算题' || it.questionType === '证明题' || it.questionType === '应用题',
    ) ?? [],
);
/** 试卷中的填空题，可一张照片覆盖多题。 */
const blankItems = computed(() => paper.value?.items.filter((it) => it.questionType === '填空题') ?? []);
/** 当前试卷已上传的照片列表。 */
const uploads = computed(() => paper.value?.uploads ?? []);
/** 填空题答题卡照片（一张多题），尚未上传时为 undefined。 */
const blankUpload = computed(() => uploads.value.find((u) => u.section === 'blank'));

/**
 * 按题号查找解答题已上传的过程照。
 * @param no 题号
 * @returns 对应的上传记录，或 undefined
 */
function uploadOf(no: number): ExamPaperUpload | undefined {
  return uploads.value.find((u) => u.section === 'solve' && u.questionNo === no);
}
/**
 * 拼接带 token 的上传图片访问地址（图片接口需要鉴权）。
 * @param u 上传记录
 * @returns 图片 URL
 */
function imgUrl(u: ExamPaperUpload): string {
  return `${API_BASE}/exams/${examId}/uploads/${u.file}?token=${encodeURIComponent(getAccessToken() ?? '')}`;
}

/**
 * 计算交卷倒计时的展示文案，按剩余时长自动切换「小时/分钟」粒度。
 * @returns 倒计时文案；已过交卷时间返回「已到交卷时间」
 */
const deadlineText = computed(() => {
  if (!paper.value?.deadline) return '';
  const ms = new Date(paper.value.deadline).getTime() - Date.now();
  if (ms <= 0) return '已到交卷时间';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `距交卷约 ${Math.floor(m / 60)} 小时 ${m % 60} 分` : `距交卷约 ${m} 分钟`;
});

/**
 * 加载试卷详情，登录成功后或组件挂载时调用。
 * 调用 GET /exams/:id，失败时写入 loadError 供错误态展示。
 */
async function loadExam() {
  loading.value = true;
  loadError.value = '';
  try {
    paper.value = await get<ExamPaper>(`/exams/${examId}`);
  } catch (err) {
    loadError.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

// ---------- 上传 ----------
const fileCamera = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadError = ref('');
const notice = ref('');
let pending: { section: 'blank' | 'solve'; questionNo: number | null } | null = null;
const pickedSolveNo = ref<number | null>(null);

/**
 * 记录待上传目标并触发手机相机/文件选择，点击「拍照上传」时触发。
 * @param section 上传目标：blank（填空答题卡，一题多张）或 solve（解答过程，一题一张）
 * @param questionNo 解答题题号；填空题传 null
 */
function shoot(section: 'blank' | 'solve', questionNo: number | null) {
  pending = { section, questionNo };
  uploadError.value = '';
  notice.value = '';
  fileCamera.value?.click();
}

/**
 * 拍照/选图后的上传处理器：压缩图片后调用 POST /exams/:id/uploads 上传。
 * 填空题答题卡会尝试 OCR 识别答案并同步到电脑端；成功后更新本地上传列表并按识别情况给出提示。
 * @param e 文件输入框的 change 事件
 */
async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const p = pending;
  pending = null;
  if (!file || !p) return;
  uploading.value = true;
  uploadError.value = '';
  try {
    const dataUrl = await compressImage(file);
    const res = await post<{ upload: ExamPaperUpload; blankAnswers: Record<string, { answer?: string }>; ocrFailed: boolean }>(
      `/exams/${examId}/uploads`,
      { section: p.section, questionNo: p.questionNo, image: dataUrl },
    );
    if (paper.value) {
      const rest = (paper.value.uploads ?? []).filter((u) =>
        res.upload.section === 'blank'
          ? u.section !== 'blank'
          : !(u.section === 'solve' && u.questionNo === res.upload.questionNo),
      );
      paper.value = { ...paper.value, uploads: [res.upload, ...rest] };
    }
    const n = Object.keys(res.blankAnswers ?? {}).length;
    notice.value =
      p.section === 'blank'
        ? n > 0
          ? `识别出 ${n} 题填空答案，已同步到电脑端`
          : res.ocrFailed
            ? '照片已保存，识别服务暂不可用，请在电脑端手动填写答案'
            : '照片已上传，但没认出答案，可在电脑端手动填写'
        : res.ocrFailed
          ? `第 ${p.questionNo} 题照片已保存，识别暂不可用，请在电脑端自评或稍后重拍`
          : `第 ${p.questionNo} 题解答过程已上传，电脑端可查看转录`;
  } catch (err) {
    uploadError.value = errorMessage(err);
  } finally {
    uploading.value = false;
  }
}

/** 组件挂载：已登录则直接加载试卷，未登录则关闭加载态、等待用户在页面内登录。 */
onMounted(() => {
  if (auth.authenticated) void loadExam();
  else loading.value = false;
});
</script>

<template>
  <div class="m-page">
    <header class="m-head">
      <h1>答题卡上传</h1>
      <p v-if="paper" class="m-sub">{{ paper.title }}<template v-if="deadlineText"> · {{ deadlineText }}</template></p>
    </header>

    <!-- 登录 -->
    <div v-if="!auth.authenticated" class="m-card">
      <h2>先登录</h2>
      <input v-model="username" class="m-input" placeholder="账号" autocomplete="username" />
      <input
        v-model="password"
        class="m-input"
        type="password"
        placeholder="密码"
        autocomplete="current-password"
        @keyup.enter="submitLogin"
      />
      <p v-if="loginError" class="m-error">{{ loginError }}</p>
      <button class="m-btn primary" type="button" :disabled="loggingIn" @click="submitLogin">
        {{ loggingIn ? '登录中…' : '登录' }}
      </button>
    </div>

    <div v-else-if="loading" class="m-card muted">加载试卷…</div>
    <div v-else-if="loadError" class="m-card">
      <p class="m-error">{{ loadError }}</p>
      <button class="m-btn" type="button" @click="loadExam">重试</button>
    </div>

    <div v-else-if="paper && paper.submittedAt" class="m-card">
      <h2>本卷已交卷</h2>
      <p class="muted">得分 {{ paper.totalScore ?? 0 }} / {{ paper.maxScore }}，详细结果请在电脑端查看。</p>
    </div>

    <template v-else-if="paper">
      <p v-if="notice" class="m-notice">{{ notice }}</p>
      <p v-if="uploadError" class="m-error">{{ uploadError }}</p>

      <!-- 填空答题卡 -->
      <div v-if="blankItems.length > 0" class="m-card">
        <h2>填空答题卡</h2>
        <p class="muted">
          把第 {{ blankItems.map((i) => i.no).join('、') }} 题答案标清题号写在一张纸上，拍一张自动识别。
        </p>
        <button class="m-btn primary" type="button" :disabled="uploading" @click="shoot('blank', null)">
          {{ uploading ? '上传识别中…' : blankUpload ? '重拍答题卡' : '拍填空答题卡' }}
        </button>
        <div v-if="blankUpload" class="m-thumb-row">
          <img :src="imgUrl(blankUpload)" class="m-thumb" alt="填空答题卡" />
          <span class="muted small">已上传 {{ blankUpload.createdAt.slice(11, 16) }}</span>
        </div>
      </div>

      <!-- 解答题逐题 -->
      <div v-if="solveItems.length > 0" class="m-card">
        <h2>解答题过程</h2>
        <p class="muted">先选题号，再拍这一题的手写解答过程（每题一张，重拍覆盖）。</p>
        <div class="m-no-grid">
          <button
            v-for="it in solveItems"
            :key="it.no"
            type="button"
            class="m-no"
            :class="{ active: pickedSolveNo === it.no, done: Boolean(uploadOf(it.no)) }"
            @click="pickedSolveNo = it.no"
          >
            {{ it.no }}
            <span v-if="uploadOf(it.no)" class="m-no-check">✓</span>
          </button>
        </div>
        <button
          class="m-btn primary"
          type="button"
          :disabled="uploading || !pickedSolveNo"
          @click="shoot('solve', pickedSolveNo)"
        >
          {{ uploading ? '上传识别中…' : pickedSolveNo ? `拍第 ${pickedSolveNo} 题过程` : '先选择题号' }}
        </button>
        <div v-if="pickedSolveNo && uploadOf(pickedSolveNo)" class="m-thumb-row">
          <img :src="imgUrl(uploadOf(pickedSolveNo)!)" class="m-thumb" alt="解答过程" />
          <span class="muted small">已上传，重拍会覆盖</span>
        </div>
      </div>

      <button class="m-btn" type="button" @click="loadExam">刷新状态</button>
      <input ref="fileCamera" type="file" accept="image/*" capture="environment" hidden @change="onFile" />
    </template>
  </div>
</template>

<style scoped>
.m-page {
  max-width: 480px;
  margin: 0 auto;
  padding: 18px 16px 60px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 15px;
}
.m-head h1 {
  font-size: 22px;
}
.m-sub {
  color: var(--muted);
  font-size: 12.5px;
  margin-top: 4px;
}
.m-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.m-card h2 {
  font-size: 16.5px;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 12px;
}
.m-input {
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 15px;
  background: var(--panel-soft);
  color: var(--ink);
}
.m-btn {
  border: 1px solid var(--line-strong);
  background: var(--panel);
  border-radius: 10px;
  padding: 12px;
  font-size: 15px;
  cursor: pointer;
  color: var(--ink);
}
.m-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
.m-btn:disabled {
  opacity: 0.55;
}
.m-error {
  color: var(--danger);
  font-size: 13px;
}
.m-notice {
  color: var(--accent-dark);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 13px;
}
.m-no-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.m-no {
  position: relative;
  border: 1px solid var(--line-strong);
  background: var(--panel-soft);
  border-radius: 10px;
  padding: 12px 0;
  font-size: 16px;
  font-family: var(--mono);
  cursor: pointer;
  color: var(--ink);
}
.m-no.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.m-no.done {
  color: var(--accent-dark);
}
.m-no-check {
  position: absolute;
  top: 2px;
  right: 6px;
  font-size: 11px;
  color: var(--accent-dark);
}
.m-thumb-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.m-thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--line-strong);
}
</style>
