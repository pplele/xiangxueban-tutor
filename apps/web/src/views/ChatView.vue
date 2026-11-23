<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ChatMessageDto, ChatSessionDto, Citation, SubjectCode } from '@tutor/shared';
import { SUBJECTS } from '@tutor/shared';
import { errorMessage, get, post } from '@/api/client';
import { streamAsk, type ChatStreamEvent } from '@/api/sse';
import MathText from '@/components/MathText.vue';
import CitationList from '@/components/CitationList.vue';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import NavIcon from '@/components/NavIcon.vue';

interface ToolTrace {
  name: string;
  status: 'running' | 'done';
  summary?: string;
}

interface UiMessage {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  tools?: ToolTrace[];
  streaming?: boolean;
  error?: string;
  messageId?: number;
  createdAt?: string;
}

const route = useRoute();
const router = useRouter();

/**
 * 从路由参数解析当前科目，非法值回退到 math。
 * @returns 科目标识
 */
const subject = computed<SubjectCode>(() => {
  const s = String(route.params.subject || 'math');
  return (['math', 'english', 'cs'].includes(s) ? s : 'math') as SubjectCode;
});
/** 当前科目的元信息（名称、图标、配色等）。 */
const subjectMeta = computed(() => SUBJECTS.find((s) => s.code === subject.value)!);
/** 当前科目的教师称呼。 */
const teacherTitle = computed(
  () => ({ math: '宋浩老师', english: '刘晓艳老师', cs: '计算机老师' }[subject.value] ?? '老师'),
);
/** 当前科目教师头像显示的首字。 */
const teacherAvatar = computed(
  () => ({ math: '宋', english: '艳', cs: '师' }[subject.value] ?? '师'),
);

const sessions = ref<ChatSessionDto[]>([]);
const sessionId = ref('');
const messages = ref<UiMessage[]>([]);
const input = ref('');
const loading = ref(true);
const loadingMessages = ref(false);
const sending = ref(false);
const pageError = ref('');
const streamNotice = ref('');
const historyOpen = ref(false);
const messagesEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
let controller: AbortController | null = null;
let seq = 0;
// 快速切换科目时的请求序号：旧科目后返回的会话不能覆盖新科目的界面
let sessionLoadSeq = 0;

const TOOL_LABEL: Record<string, string> = {
  search_knowledge: '检索知识库',
  get_wrongbook_summary: '查看错题本',
  add_question: '错题入库',
  generate_variant: '生成变式',
  get_profile: '读取画像',
  update_profile: '更新画像',
  assemble_exam: '生成模拟卷',
};

const SUGGESTIONS: Record<string, string[]> = {
  math: ['数列发散的判断', '洛必达法则什么时候失效？', '讲讲定积分的换元法'],
  english: ['现在完成时和一般过去时怎么区分？', '定语从句什么时候只能用 that？', '怎么写好议论文开头？'],
  cs: ['进程和线程的区别是什么？', '循环队列的队满条件怎么推？', 'TCP 三次握手为什么不是两次？'],
};

/** 当前科目的推荐问题列表。 */
const suggestions = computed(() => SUGGESTIONS[subject.value] ?? []);
/** 当前选中的会话对象。 */
const activeSession = computed(() => sessions.value.find((s) => s.id === sessionId.value));
/** 是否可以发送：输入框非空、未在发送中且已有会话。 */
const canSend = computed(() => input.value.trim().length > 0 && !sending.value && Boolean(sessionId.value));

/**
 * 把消息列表滚动到底部；instant=true 时临时改为非平滑滚动，以便立即定位。
 * @param instant 是否立即定位（切换会话/首次打开时用），默认 false
 */
function jumpToBottom(instant = false) {
  const el = messagesEl.value;
  if (!el) return;
  const previous = el.style.scrollBehavior;
  // 切换/首次打开会话时要「立刻」定位；平滑滚动会让用户先看到顶部再慢慢挪下去
  if (instant) el.style.scrollBehavior = 'auto';
  el.scrollTop = el.scrollHeight;
  if (instant) {
    requestAnimationFrame(() => {
      el.style.scrollBehavior = previous;
    });
  }
}

/**
 * 下次 DOM 更新后滚动到底部；默认仅在用户已接近底部时才滚动，避免打断向上阅读。
 * @param force 是否强制滚动，默认 false
 */
function scrollToBottom(force = false) {
  nextTick(() => {
    const el = messagesEl.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (force || nearBottom) jumpToBottom();
  });
}

/**
 * 把后端消息 DTO 转成界面使用的 UiMessage（补唯一 key 与展示字段）。
 * @param m 后端消息
 * @returns 界面消息对象
 */
function mapMessage(m: ChatMessageDto): UiMessage {
  return {
    key: `db-${m.id ?? ++seq}`,
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
    citations: m.citations ?? undefined,
    messageId: m.id,
    createdAt: m.createdAt,
  };
}

/**
 * 加载指定会话的消息列表，选中会话或 ?session= 直达时调用。
 * 调用 GET /chat/sessions/:id/messages；用 loadSeq 丢弃过期请求，加载完成后按 scroll 参数定位到底部。
 * @param id 会话 ID
 * @param scroll 加载后是否滚动到底部，默认 true
 * @param loadSeq 发起请求时的会话加载序号，用于并发控制
 */
async function loadSession(id: string, scroll = true, loadSeq = sessionLoadSeq) {
  if (!id) return;
  sessionId.value = id;
  loadingMessages.value = true;
  pageError.value = '';
  try {
    const data = await get<{ session: ChatSessionDto; messages: ChatMessageDto[] }>(
      `/chat/sessions/${id}/messages`,
    );
    if (loadSeq !== sessionLoadSeq) return;
    messages.value = data.messages.map(mapMessage);
  } catch (err) {
    if (loadSeq !== sessionLoadSeq) return;
    pageError.value = errorMessage(err);
  } finally {
    if (loadSeq !== sessionLoadSeq) return;
    // 必须等 loading 占位撤掉、消息真正渲染后再定位，否则滚的是占位符的高度
    loadingMessages.value = false;
    if (scroll) {
      await nextTick();
      jumpToBottom(true);
      // KaTeX 公式/长表格首帧后可能再撑高内容，补一次定位
      requestAnimationFrame(() => jumpToBottom(true));
    }
  }
}

/**
 * 初始化当前科目的会话：拉取列表并按 ?session= 参数定位或新建会话，科目切换时也会调用。
 * 用 sessionLoadSeq 保证快速切科时旧请求不会覆盖新界面。
 * @param forceNew 是否强制新建会话，默认 false
 */
async function ensureSession(forceNew = false) {
  const loadSeq = ++sessionLoadSeq;
  loading.value = true;
  pageError.value = '';
  streamNotice.value = '';
  messages.value = [];
  try {
    const data = await get<{ sessions: ChatSessionDto[] }>(`/chat/sessions?subject=${subject.value}`);
    if (loadSeq !== sessionLoadSeq) return;
    sessions.value = data.sessions;
    // 支持从做题小窗/其他页面通过 ?session=xxx 直接定位会话
    const requested = typeof route.query.session === 'string' ? route.query.session : '';
    const requestedExists = requested && data.sessions.some((s) => s.id === requested);
    if (!forceNew && requestedExists) {
      await loadSession(requested, true, loadSeq);
    } else if (!forceNew && data.sessions.length > 0) {
      await loadSession(data.sessions[0].id, true, loadSeq);
    } else {
      const created = await post<ChatSessionDto>('/chat/sessions', { subject: subject.value });
      if (loadSeq !== sessionLoadSeq) return;
      sessions.value = [created, ...data.sessions];
      sessionId.value = created.id;
      messages.value = [];
    }
  } catch (err) {
    if (loadSeq !== sessionLoadSeq) return;
    pageError.value = errorMessage(err);
  } finally {
    if (loadSeq !== sessionLoadSeq) return;
    loading.value = false;
    nextTick(() => textareaEl.value?.focus());
  }
}

/** 新建会话按钮处理器：清掉 URL 中的 ?session= 参数后强制创建新会话。 */
async function createSession() {
  if (sending.value) return;
  historyOpen.value = false;
  if (route.query.session) router.replace({ path: route.path });
  await ensureSession(true);
}

/**
 * 切换科目导航，点击科目标签时触发；发送中忽略操作。
 * @param code 目标科目
 */
function switchSubject(code: SubjectCode) {
  if (sending.value) return;
  router.push(`/chat/${code}`);
}

/**
 * 会话下拉框选择处理器：清掉 URL 中的 ?session= 参数并切换到选中的会话。
 * @param event select 的 change 事件
 */
function onSelectSession(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  historyOpen.value = false;
  if (route.query.session) router.replace({ path: route.path });
  if (id && id !== sessionId.value) loadSession(id);
}

/**
 * 把一条工具追踪事件合并进消息的工具列表：running 追加，done 则回填同名 running 项。
 * @param tools 现有工具列表
 * @param trace 新的工具事件
 * @returns 合并后的工具列表
 */
function attachTool(tools: ToolTrace[] | undefined, trace: ToolTrace): ToolTrace[] {
  const list = [...(tools ?? [])];
  if (trace.status === 'running') {
    list.push(trace);
  } else {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].name === trace.name && list[i].status === 'running') {
        list[i] = { ...list[i], status: 'done', summary: trace.summary };
        return list;
      }
    }
    list.push(trace);
  }
  return list;
}

/**
 * SSE 流式事件分发：按 token/tool/citations/done/error 更新助手消息的内容、工具、出处与状态，并按需滚动。
 * @param msg 正在流式输出的助手消息（响应式对象）
 * @param event SSE 事件
 */
function handleStreamEvent(msg: UiMessage, event: ChatStreamEvent) {
  if (event.type === 'token') {
    msg.content += event.text;
    scrollToBottom();
  } else if (event.type === 'tool') {
    msg.tools = attachTool(msg.tools, {
      name: event.name,
      status: event.status,
      summary: event.summary,
    });
    scrollToBottom();
  } else if (event.type === 'citations') {
    msg.citations = event.citations;
  } else if (event.type === 'done') {
    msg.streaming = false;
    msg.messageId = event.messageId;
    if (event.citations?.length) msg.citations = event.citations;
    scrollToBottom();
  } else if (event.type === 'error') {
    msg.error = event.message;
    msg.streaming = false;
    streamNotice.value = event.message;
  }
}

/**
 * 发送消息处理器，点击发送或回车时触发，是答疑 SSE 流的核心入口。
 * 校验后追加用户/助手消息，用 AbortController 调用 streamAsk 流式接收解答；
 * 支持停止生成（AbortError 分支）与错误提示，结束后刷新会话列表。
 * @param text 要发送的问题文本；不传则取输入框内容
 */
async function send(text?: string) {
  const content = (text ?? input.value).trim();
  if (!content || sending.value || !sessionId.value) return;
  if (content.length > 4000) {
    streamNotice.value = '问题过长，请分次提问（最多 4000 字）';
    return;
  }
  streamNotice.value = '';
  sending.value = true;
  controller = new AbortController();

  const userMsg: UiMessage = { key: `u-${++seq}`, role: 'user', content };
  const assistantMsg = reactive<UiMessage>({
    key: `a-${++seq}`,
    role: 'assistant',
    content: '',
    streaming: true,
    tools: [],
  });
  messages.value.push(userMsg, assistantMsg);
  input.value = '';
  adjustHeight();
  scrollToBottom(true);

  try {
    await streamAsk({
      sessionId: sessionId.value,
      content,
      signal: controller.signal,
      onEvent: (event) => handleStreamEvent(assistantMsg, event),
    });
    if (!assistantMsg.content && !assistantMsg.error) {
      assistantMsg.error = '模型没有返回内容，请换个问法再试一次。';
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      assistantMsg.streaming = false;
      if (!assistantMsg.content) assistantMsg.content = '（已停止生成）';
      else assistantMsg.content += '\n\n（已停止生成）';
    } else {
      assistantMsg.error = errorMessage(err);
      assistantMsg.streaming = false;
      streamNotice.value = errorMessage(err);
    }
  } finally {
    assistantMsg.streaming = false;
    sending.value = false;
    controller = null;
    scrollToBottom();
    refreshSessions();
  }
}

/** 刷新会话列表（GET /chat/sessions），用于发送完成后同步标题等变化，失败静默忽略。 */
async function refreshSessions() {
  try {
    const data = await get<{ sessions: ChatSessionDto[] }>(`/chat/sessions?subject=${subject.value}`);
    sessions.value = data.sessions;
  } catch {
    /* 忽略列表刷新失败 */
  }
}

/** 停止生成按钮处理器：通过 AbortController 中断当前 SSE 请求。 */
function stop() {
  controller?.abort();
}

/**
 * 输入框键盘处理器：Enter（非 Shift、非中文输入法组合态）时阻止换行并发送消息。
 * @param e 键盘事件
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

/** 让输入框高度随内容自增高，最多 180px，超出后由输入框内部滚动。 */
function adjustHeight() {
  nextTick(() => {
    const el = textareaEl.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  });
}

/**
 * 监听路由科目变化：发送中先中断当前请求，再重新初始化该科目的会话（immediate 使首屏也触发）。
 */
watch(
  () => route.params.subject,
  () => {
    if (sending.value) {
      controller?.abort();
      sending.value = false;
    }
    void ensureSession();
  },
  { immediate: true },
);

/** 组件卸载：中断可能仍在进行的 SSE 请求，避免回调操作已卸载的组件。 */
onBeforeUnmount(() => {
  controller?.abort();
});
</script>

<template>
  <div class="page chat-page">
    <header class="chat-header">
      <div>
        <div class="eyebrow">答疑解惑 · 混合检索</div>
        <h1 class="page-title">问{{ teacherTitle }}</h1>
        <p class="page-desc">基于湖南专升本考纲知识库回答并标注出处；明显超纲会直接提示。三科教师各有风格。</p>
      </div>

      <div class="chat-controls">
        <div class="subject-tabs" role="tablist" aria-label="切换科目">
          <button
            v-for="s in SUBJECTS"
            :key="s.code"
            type="button"
            class="subject-tab"
            :class="{ active: s.code === subject }"
            role="tab"
            :aria-selected="s.code === subject"
            @click="switchSubject(s.code)"
          >
            {{ s.shortName }}
          </button>
        </div>
        <div class="session-actions">
          <select
            v-if="sessions.length > 0"
            class="select session-select"
            :value="sessionId"
            aria-label="历史会话"
            @change="onSelectSession"
          >
            <option v-for="s in sessions" :key="s.id" :value="s.id">
              {{ s.title || '新会话' }} · {{ new Date(s.createdAt).toLocaleDateString('zh-CN') }}
            </option>
          </select>
          <button class="btn btn-sm" type="button" :disabled="sending" @click="createSession">
            <NavIcon name="plus" :size="15" /> 新会话
          </button>
          <button
            v-if="subject === 'math' || subject === 'english'"
            class="btn btn-sm"
            type="button"
            title="打开对应科目的学习笔记"
            @click="router.push({ path: '/notes', query: { subject } })"
          >
            <NavIcon name="note" :size="15" /> 记笔记
          </button>
        </div>
      </div>
    </header>

    <div v-if="streamNotice" class="banner banner-error chat-notice">
      <span>{{ streamNotice }}</span>
      <button class="btn btn-sm btn-ghost" type="button" @click="streamNotice = ''">关闭</button>
    </div>

    <section ref="messagesEl" class="messages" aria-live="polite">
      <div v-if="loading" class="message-loading"><LoadingState text="正在准备会话…" /></div>
      <ErrorState v-else-if="pageError" :message="pageError" @retry="ensureSession()" />

      <template v-else>
        <div v-if="messages.length === 0 && !loadingMessages" class="chat-empty">
          <div class="empty-quote">
            <div class="quote-mark">“</div>
            <h2>今天想弄懂哪一道？</h2>
            <p>
              直接描述卡住的地方就好，不必把题目抄得很工整。老师会先查考纲知识库，
              再结合你的错题本和画像回答。
            </p>
          </div>
          <div class="suggestions">
            <button
              v-for="q in suggestions"
              :key="q"
              class="suggestion"
              type="button"
              @click="send(q)"
            >
              <NavIcon name="spark" :size="15" />
              <span>{{ q }}</span>
            </button>
          </div>
        </div>

        <div v-if="loadingMessages" class="message-loading"><LoadingState text="加载历史消息…" /></div>

        <article
          v-for="msg in messages"
          :key="msg.key"
          class="message"
          :class="msg.role === 'user' ? 'from-user' : 'from-tutor'"
        >
          <div v-if="msg.role === 'assistant'" class="avatar tutor-avatar">{{ teacherAvatar }}</div>
          <div class="message-main">
            <div v-if="msg.role === 'assistant'" class="message-meta">
              <span class="teacher-name">{{ teacherTitle }}</span>
              <span class="small muted">{{ subjectMeta.name }}</span>
            </div>

            <div v-if="msg.tools && msg.tools.length > 0" class="tool-traces">
              <span
                v-for="(tool, index) in msg.tools"
                :key="index"
                class="tool-chip"
                :class="{ done: tool.status === 'done' }"
              >
                <span class="tool-dot" />
                {{ TOOL_LABEL[tool.name] || tool.name }}
                <span v-if="tool.status === 'running'" class="tool-pulse">…</span>
              </span>
            </div>

            <div class="bubble" :class="{ 'bubble-user': msg.role === 'user', 'bubble-tutor': msg.role === 'assistant' }">
              <MathText v-if="msg.content" :text="msg.content" />
              <div v-else-if="msg.streaming" class="typing">
                <span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />
              </div>
              <span v-if="msg.streaming && msg.content" class="caret" />
              <div v-if="msg.error" class="bubble-error">{{ msg.error }}</div>
            </div>

            <CitationList v-if="msg.role === 'assistant'" :citations="msg.citations" />
          </div>
          <div v-if="msg.role === 'user'" class="avatar user-avatar">我</div>
        </article>
      </template>
    </section>

    <footer class="composer">
      <div class="composer-box">
        <textarea
          ref="textareaEl"
          v-model="input"
          class="composer-input"
          rows="1"
          placeholder="把卡住的地方说清楚一点，例如「数列发散的判断怎么想」…"
          :disabled="loading"
          @keydown="onKeydown"
          @input="adjustHeight"
        />
        <div class="composer-side">
          <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          <button v-if="sending" class="btn btn-sm stop-btn" type="button" @click="stop">停止</button>
          <button
            v-else
            class="btn btn-primary send-btn"
            type="button"
            :disabled="!canSend"
            aria-label="发送"
            @click="send()"
          >
            <NavIcon name="send" :size="17" />
          </button>
        </div>
      </div>
      <div class="composer-foot">
        <span>回答由模型生成，请结合考纲核对</span>
        <span v-if="activeSession" class="mono">会话 {{ activeSession.id.slice(0, 8) }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.chat-page {
  /* 覆盖全局 .page 的 flex:1，否则高度会被内容撑开、整页滚动，输入框随页面滚走 */
  flex: none;
  height: 100vh;
  max-width: 1060px;
  display: flex;
  flex-direction: column;
  padding-bottom: 18px;
  min-height: 0;
}

.chat-header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line);
}

.chat-controls {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
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
  padding: 6px 14px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--ink-2);
  cursor: pointer;
  transition: 0.18s ease;
}
.subject-tab:hover {
  color: var(--accent);
}
.subject-tab.active {
  background: var(--panel);
  color: var(--accent-dark);
  font-weight: 600;
  box-shadow: 0 2px 6px rgba(27, 41, 38, 0.08);
}

.session-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.session-select {
  width: 220px;
  padding: 7px 10px;
  font-size: 12px;
  border-radius: 8px;
  background: var(--panel);
}

.chat-notice {
  margin-top: 12px;
  justify-content: space-between;
  align-items: center;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 26px 4px 10px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  scroll-behavior: smooth;
}

.message-loading {
  display: grid;
  place-items: center;
  flex: 1;
}

.message {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  animation: fade-up 0.25s ease both;
}
.from-user {
  justify-content: flex-end;
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  flex: none;
  display: grid;
  place-items: center;
  font-family: var(--serif);
  font-size: 14px;
  user-select: none;
}
.tutor-avatar {
  background: var(--accent);
  color: #f1ece0;
  box-shadow: 0 4px 12px rgba(30, 107, 87, 0.25);
}
.user-avatar {
  background: var(--panel);
  border: 1px solid var(--line-strong);
  color: var(--ink-2);
}

.message-main {
  max-width: min(760px, 88%);
  min-width: 0;
}
.from-user .message-main {
  max-width: min(640px, 82%);
}

.message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 2px 0 6px 2px;
}
.teacher-name {
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-dark);
}

.bubble {
  border-radius: 14px;
  padding: 13px 16px;
  line-height: 1.8;
}
.bubble-tutor {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top-left-radius: 4px;
  box-shadow: var(--shadow);
  font-size: 14.5px;
}
.bubble-user {
  background: #1f4d42;
  color: #f4efe4;
  border-top-right-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-shadow: 0 6px 18px rgba(31, 77, 66, 0.18);
}

.bubble-error {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
  color: var(--danger);
  font-size: 12.5px;
}

.tool-traces {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 7px 1px;
}
.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--blue);
  background: var(--blue-soft);
  border: 1px solid #d2e2eb;
  padding: 3px 9px;
  border-radius: 99px;
}
.tool-chip.done {
  color: var(--accent-dark);
  background: var(--accent-soft);
  border-color: #c9e3d9;
}
.tool-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.tool-pulse {
  animation: blink 1s infinite;
}

.caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  background: var(--accent);
  margin-left: 2px;
  vertical-align: -2px;
  animation: blink 0.9s steps(2) infinite;
}

.typing {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}
.typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.4;
  animation: bounce 1.1s infinite;
}
.typing-dot:nth-child(2) {
  animation-delay: 0.15s;
}
.typing-dot:nth-child(3) {
  animation-delay: 0.3s;
}

.chat-empty {
  margin: auto;
  max-width: 620px;
  text-align: center;
  padding: 20px;
}
.empty-quote {
  position: relative;
}
.quote-mark {
  font-family: var(--serif);
  font-size: 58px;
  line-height: 1;
  color: var(--terra);
  opacity: 0.35;
}
.empty-quote h2 {
  font-size: 25px;
  margin: -10px 0 10px;
}
.empty-quote p {
  color: var(--muted);
  font-size: 13.5px;
  line-height: 1.9;
  max-width: 440px;
  margin: 0 auto 22px;
}
.suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.suggestion {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink-2);
  padding: 9px 16px;
  border-radius: 99px;
  font-size: 13px;
  cursor: pointer;
  transition: 0.18s ease;
  text-align: left;
}
.suggestion:hover {
  border-color: var(--accent);
  color: var(--accent-dark);
  transform: translateY(-1px);
  box-shadow: var(--shadow);
}

.composer {
  flex: none;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  background: var(--bg);
}
.composer-box {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  padding: 10px 10px 10px 16px;
  box-shadow: var(--shadow);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.composer-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(30, 107, 87, 0.1), var(--shadow);
}
.composer-input {
  flex: 1;
  border: 0;
  background: transparent;
  resize: none;
  font-family: inherit;
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--ink);
  padding: 4px 0;
  max-height: 180px;
  outline: none;
}
.composer-input::placeholder {
  color: #a3a89f;
}
.composer-side {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.composer-hint {
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}
.send-btn {
  width: 38px;
  height: 38px;
  padding: 0;
  border-radius: 10px;
}
.stop-btn {
  color: var(--danger);
  border-color: #e8c9c4;
  background: var(--danger-soft);
}
.composer-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 10.5px;
  color: var(--muted);
  padding: 8px 4px 0;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

@media (max-width: 860px) {
  .chat-page {
    height: 100vh;
    min-height: 0;
  }
  .chat-header {
    flex-direction: column;
    align-items: flex-start;
  }
  .chat-controls {
    width: 100%;
    align-items: flex-start;
  }
  .session-select {
    width: 100%;
    max-width: 240px;
  }
  .messages {
    min-height: 0;
  }
  .composer-hint {
    display: none;
  }
}

/* 手机端底部导航占位 72px，聊天区避让后输入框仍固定可见 */
@media (max-width: 640px) {
  .chat-page {
    height: calc(100vh - 72px);
  }
}
</style>
