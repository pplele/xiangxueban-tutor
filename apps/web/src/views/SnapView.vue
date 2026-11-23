<script setup lang="ts">
/**
 * 手机拍题页（/m/snap）——公开路由，无桌面侧边栏。
 * 局域网内扫码直达：登录 → 拍照/选图 → 识别改错 → 追问讲解 → 存错题本。
 * 接口与微信小程序完全同一套（/capture/* + /chat/*），后端零改动。
 */
import { computed, ref } from 'vue';
import { errorMessage, post } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import MathText from '@/components/MathText.vue';

const auth = useAuthStore();
auth.sync();

// ---------- 登录 ----------
const username = ref('');
const password = ref('');
const loginError = ref('');
const loggingIn = ref(false);

/**
 * 手机拍题页登录表单提交处理器，点击登录按钮时触发。
 * 校验账号密码非空后调用 auth.signIn 发起登录；本页登录后即可直接拍照识别。
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
  } finally {
    loggingIn.value = false;
  }
}

// ---------- 学科 ----------
const SUBJECTS = [
  { key: 'math', label: '高数' },
  { key: 'english', label: '英语' },
  { key: 'cs', label: '计算机' },
] as const;
type Subject = (typeof SUBJECTS)[number]['key'];
const subject = ref<Subject>('math');

// ---------- 图片与识别 ----------
interface RecognizeResult {
  text: string;
  stem: string;
  type: string;
  options: string[];
  subject: string;
  uncertain: string[];
  hasHandwriting: boolean;
}
interface WrongHit {
  id: string;
  title: string;
  stem: string;
  score: number;
}
interface WrongMatchResult {
  exact: WrongHit[];
  similar: WrongHit[];
}

const thumbUrl = ref('');
const recognizing = ref(false);
const recognizeError = ref('');
const questionText = ref('');
const uncertainList = ref<string[]>([]);
const questionType = ref('');
const matchInfo = ref<WrongMatchResult | null>(null);

const fileCamera = ref<HTMLInputElement | null>(null);
const fileAlbum = ref<HTMLInputElement | null>(null);

/**
 * 按来源打开相机或相册选图，点击「拍照」/「从相册选」按钮时触发。
 * @param kind 图片来源：camera（相机）或 album（相册）
 */
function pick(kind: 'camera' | 'album') {
  const el = kind === 'camera' ? fileCamera.value : fileAlbum.value;
  el?.click();
}

/**
 * 选图后的处理器：先本地压缩图片，再调用 recognize 进行 OCR 识别。
 * @param e 文件输入框的 change 事件
 */
async function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  recognizeError.value = '';
  try {
    const dataUrl = await compress(file);
    thumbUrl.value = dataUrl;
    await recognize(dataUrl);
  } catch (err) {
    recognizeError.value = errorMessage(err);
  }
}

/**
 * 压缩图片到 base64 ≤1.9MB（后端上限 2MB）；高像素手机逐级降质并缩小尺寸。
 * @param file 原始图片文件
 * @returns 压缩后的 data URL
 */
async function compress(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const LIMIT = 1.9 * 1024 * 1024;
  let w = bitmap.width;
  let h = bitmap.height;
  let scale = Math.min(1, 1600 / Math.max(w, h));
  for (const quality of [0.82, 0.62, 0.42, 0.25]) {
    const cw = Math.max(320, Math.round(w * scale));
    const ch = Math.max(320, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, cw, ch);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= LIMIT) return dataUrl;
    scale *= 0.75; // 尺寸再缩一档，下一轮继续试
  }
  throw new Error('图片太大，请靠近题目重拍一张');
}

/**
 * 调用 POST /capture/ocr 识别题目文字、题型与学科，并触发错题查重。
 * 识别出的学科与当前所选不一致时自动纠正；未识别出题干则给出重拍提示。
 * @param dataUrl 压缩后的图片 data URL
 */
async function recognize(dataUrl: string) {
  recognizing.value = true;
  recognizeError.value = '';
  matchInfo.value = null;
  try {
    const result = await post<RecognizeResult>('/capture/ocr', {
      image: dataUrl,
      subject: subject.value,
    });
    questionText.value = result.text || '';
    uncertainList.value = result.uncertain ?? [];
    questionType.value = result.type || '';
    if (result.subject && result.subject !== subject.value) {
      subject.value = result.subject as Subject;
    }
    if (questionText.value) void checkDuplicate();
    else recognizeError.value = '没识别出题目，请靠近一点重拍';
  } catch (err) {
    recognizeError.value = errorMessage(err);
  } finally {
    recognizing.value = false;
  }
}

/**
 * 调用 POST /capture/wrong-match 检查题干是否与错题本中已有题目重复或相似。
 * 查重失败不阻塞后续答疑。
 */
async function checkDuplicate() {
  const body = questionText.value.trim().slice(0, 4000);
  if (body.length < 4) return;
  try {
    matchInfo.value = await post<WrongMatchResult>('/capture/wrong-match', {
      subject: subject.value,
      textBody: body,
    });
  } catch {
    /* 查重失败不阻塞答疑 */
  }
}

// ---------- 答疑 ----------
interface Citation {
  content: string;
  sourceName?: string;
  kpCodes?: string[];
}
interface AskResult {
  messageId: string;
  content: string;
  citations?: Citation[];
}
interface ChatItem {
  role: 'student' | 'teacher';
  text: string;
  cites: { source: string; page: string }[];
}

const chat = ref<ChatItem[]>([]);
const asking = ref(false);
const askError = ref('');
const extraQuestion = ref('');
const sessionId = ref('');
const QUICK_ASKS = [
  '还是没懂，讲简单点',
  '这一步为什么可以这样做？',
  '再举一个类似的例子',
];

/**
 * 从答疑引用的正文里提取来源文件名与页码，去重后最多保留 3 条供前端展示出处。
 * @param list 引用列表
 * @returns 出处列表（source / page）
 */
function citesOf(list: Citation[] | undefined): { source: string; page: string }[] {
  const seen = new Set<string>();
  const out: { source: string; page: string }[] = [];
  for (const c of list ?? []) {
    const body = c.content || '';
    const pm = /书\s*p(\d+)/i.exec(body) || /PDF\s*p(\d+)/i.exec(body);
    const item = {
      source: (c.sourceName || '').split('/').pop()?.replace(/\.md$/, '') ?? '',
      page: pm ? `p${pm[1]}` : '',
    };
    const key = `${item.source}|${item.page}`;
    if (!item.source || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 3);
}

/**
 * 追问处理器，点击「提问」或快捷追问按钮时触发。
 * 首次提问先 POST /chat/sessions 建会话，再 POST /chat/ask-sync 同步取得老师解答并追加到对话列表。
 * @param quick 快捷追问文案；不传则使用输入框中的内容
 */
async function ask(quick?: string) {
  const text = questionText.value.trim();
  const extra = (quick ?? extraQuestion.value).trim();
  if (!text) {
    askError.value = '先拍照识别或手动输入题目';
    return;
  }
  asking.value = true;
  askError.value = '';
  try {
    if (!sessionId.value) {
      const session = await post<{ id: string }>('/chat/sessions', {
        subject: subject.value,
        title: text.slice(0, 24),
      });
      sessionId.value = session.id;
    }
    let content = text.slice(0, 800);
    if (extra) {
      const budget = Math.max(200, 4000 - Math.min(text.length, 800) - 7);
      content = `${extra.slice(0, budget)}\n\n我的疑问：${text.slice(0, 800)}`;
    }
    chat.value.push({ role: 'student', text: extra || '请讲解这道题', cites: [] });
    const res = await post<AskResult>('/chat/ask-sync', {
      sessionId: sessionId.value,
      content,
    });
    chat.value.push({ role: 'teacher', text: res.content || '', cites: citesOf(res.citations) });
    extraQuestion.value = '';
  } catch (err) {
    askError.value = errorMessage(err);
  } finally {
    asking.value = false;
  }
}

// ---------- 存错题本 ----------
const saving = ref(false);
const savedInfo = ref<{ id: string; action: string } | null>(null);
const saveError = ref('');

/**
 * 存入错题本处理器，点击「存错题本」按钮时触发。
 * 调用 POST /capture/wrong-save 保存题干、最近一次老师解答及追问内容。
 */
async function saveToWrongbook() {
  const text = questionText.value.trim();
  if (text.length < 4) {
    saveError.value = '题干太短，请先识别或手动输入';
    return;
  }
  saving.value = true;
  saveError.value = '';
  try {
    const lastAnswer = [...chat.value].reverse().find((c) => c.role === 'teacher')?.text ?? '';
    const res = await post<{ id: string; action: string }>('/capture/wrong-save', {
      subject: subject.value,
      textBody: text,
      solution: lastAnswer ? lastAnswer.slice(0, 3000) : undefined,
      note: extraQuestion.value ? extraQuestion.value.slice(0, 4000) : undefined,
      title: text.slice(0, 120),
    });
    savedInfo.value = res;
  } catch (err) {
    saveError.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}

/**
 * 根据查重结果生成提示：完全重复提示「已在错题本」，有相似题则提示相似数量。
 * @returns 提示文案；无匹配时为空串
 */
const dupHint = computed(() => {
  if (!matchInfo.value) return '';
  if (matchInfo.value.exact.length > 0) return '这道题之前错过，已在错题本里';
  if (matchInfo.value.similar.length > 0) {
    return `错题本里有 ${matchInfo.value.similar.length} 道相似题`;
  }
  return '';
});
</script>

<template>
  <div class="snap-shell">
    <!-- 未登录：登录卡 -->
    <section v-if="!auth.authenticated" class="card login-card">
      <div class="brand-row">
        <div class="seal">湘</div>
        <div>
          <b>湘学伴 · 拍题</b>
          <span class="mild">手机拍题 · 局域网直连</span>
        </div>
      </div>
      <input v-model="username" autocomplete="username" placeholder="账号" type="text" />
      <input v-model="password" autocomplete="current-password" placeholder="密码" type="password" />
      <p v-if="loginError" class="err">{{ loginError }}</p>
      <button :disabled="loggingIn" class="btn primary block" type="button" @click="submitLogin">
        {{ loggingIn ? '登录中…' : '登录' }}
      </button>
    </section>

    <!-- 已登录：拍题主界面 -->
    <template v-else>
      <header class="snap-head">
        <div class="brand-row">
          <div class="seal">湘</div>
          <div>
            <b>拍题答疑</b>
            <span class="mild">{{ auth.username }} · 局域网直连</span>
          </div>
        </div>
        <div class="subject-tabs">
          <button
            v-for="s in SUBJECTS"
            :key="s.key"
            :class="{ on: subject === s.key }"
            class="tab"
            type="button"
            @click="subject = s.key"
          >
            {{ s.label }}
          </button>
        </div>
      </header>

      <!-- 拍照 / 选图 -->
      <section class="card">
        <div v-if="thumbUrl" class="thumb-row">
          <img :src="thumbUrl" alt="题目照片" />
          <button class="btn sm" type="button" @click="pick('camera')">重拍</button>
        </div>
        <div v-else class="pick-row">
          <button class="btn primary" type="button" @click="pick('camera')">📷 拍照</button>
          <button class="btn" type="button" @click="pick('album')">🖼 从相册选</button>
        </div>
        <input ref="fileCamera" accept="image/*" capture="environment" hidden type="file" @change="onFile" />
        <input ref="fileAlbum" accept="image/*" hidden type="file" @change="onFile" />
        <p v-if="recognizing" class="hint">正在识别题目…</p>
        <p v-if="recognizeError" class="err">{{ recognizeError }}</p>
      </section>

      <!-- 题干（识别结果，可改） -->
      <section class="card">
        <div class="card-title-row">
          <b>题干</b>
          <span v-if="questionType" class="chip">{{ questionType }}</span>
          <span v-if="dupHint" class="chip warn">{{ dupHint }}</span>
        </div>
        <textarea
          v-model="questionText"
          placeholder="拍照后自动填入，识别有误可直接修改；也可以手动输入题目"
          rows="6"
        ></textarea>
        <div v-if="uncertainList.length" class="uncertain">
          <span class="chip warn" v-for="u in uncertainList" :key="u">看不准：{{ u }}</span>
          <p class="hint">以上片段模型没把握，请对照照片核对</p>
        </div>
      </section>

      <!-- 追问 & 讲解 -->
      <section class="card">
        <div class="card-title-row"><b>讲解</b></div>
        <div v-if="chat.length" class="chat-thread">
          <div v-for="(m, i) in chat" :key="i" class="msg" :class="m.role">
            <div v-if="m.role === 'student'" class="bubble">{{ m.text }}</div>
            <div v-else class="bubble rich-wrap">
              <MathText :text="m.text" />
              <div v-if="m.cites.length" class="cites">
                <span v-for="c in m.cites" :key="c.source + c.page" class="chip">
                  📖 {{ c.source }} {{ c.page }}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div class="quick-row" v-if="chat.length">
          <button v-for="q in QUICK_ASKS" :key="q" :disabled="asking" class="btn sm" type="button" @click="ask(q)">
            {{ q }}
          </button>
        </div>
        <div class="ask-row">
          <input
            v-model="extraQuestion"
            :disabled="asking"
            placeholder="想问什么（可留空）"
            type="text"
            @keyup.enter="ask()"
          />
          <button :disabled="asking || !questionText" class="btn primary" type="button" @click="ask()">
            {{ asking ? '讲解中…' : chat.length ? '追问' : '提问' }}
          </button>
        </div>
        <p v-if="askError" class="err">{{ askError }}</p>
      </section>

      <!-- 存错题本 -->
      <section class="card">
        <button :disabled="saving || !questionText" class="btn block" type="button" @click="saveToWrongbook">
          {{ saving ? '保存中…' : '存入错题本' }}
        </button>
        <p v-if="savedInfo" class="ok">
          ✓ {{ savedInfo.action === 'updated' ? '已更新错题本里同一道题的解析' : '已存入错题本' }}（{{ savedInfo.id }}）
        </p>
        <p v-if="saveError" class="err">{{ saveError }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.snap-shell {
  min-height: 100vh;
  max-width: 560px;
  margin: 0 auto;
  padding: 16px 14px 48px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--bg);
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: var(--shadow);
}

.login-card {
  margin-top: 20vh;
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-row b {
  display: block;
  font-size: 16px;
  color: var(--ink);
}

.seal {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-family: var(--serif);
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mild {
  font-size: 12px;
  color: var(--muted);
}

.snap-head {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.subject-tabs {
  display: flex;
  gap: 8px;
}

.subject-tabs .tab {
  flex: 1;
  padding: 8px 0;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-soft);
  color: var(--ink-2);
  font-size: 14px;
}

.subject-tabs .tab.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}

.btn {
  border: 1px solid var(--line-strong);
  background: var(--panel-soft);
  color: var(--ink);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 14px;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}

.btn.sm {
  padding: 6px 10px;
  font-size: 12.5px;
}

.btn.block {
  width: 100%;
}

.pick-row {
  display: flex;
  gap: 10px;
}

.pick-row .btn {
  flex: 1;
  padding: 14px 0;
  font-size: 15px;
}

.thumb-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.thumb-row img {
  width: 96px;
  height: 96px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
}

.card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.chip {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-dark);
}

.chip.warn {
  background: var(--amber-soft);
  color: var(--amber);
}

textarea,
input[type='text'],
input[type='password'] {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-soft);
  padding: 10px;
  font-size: 14px;
  font-family: var(--sans);
  color: var(--ink);
  resize: vertical;
}

textarea {
  line-height: 1.7;
  min-height: 110px;
}

.hint {
  font-size: 12px;
  color: var(--muted);
}

.err {
  font-size: 13px;
  color: var(--danger);
}

.ok {
  font-size: 13px;
  color: var(--accent-dark);
}

.uncertain {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.uncertain .hint {
  width: 100%;
}

.chat-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg .bubble {
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.7;
}

.msg.student {
  display: flex;
  justify-content: flex-end;
}

.msg.student .bubble {
  background: var(--accent-soft);
  color: var(--accent-dark);
  max-width: 85%;
}

.msg.teacher .bubble {
  background: var(--panel-soft);
  border: 1px solid var(--line);
}

.rich-wrap :deep(.rich) {
  font-size: 14px;
}

.cites {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quick-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ask-row {
  display: flex;
  gap: 8px;
}

.ask-row input {
  flex: 1;
}

.ask-row .btn {
  flex: none;
}
</style>
