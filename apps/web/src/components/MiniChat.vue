<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ChatMessageDto, ChatSessionDto, Citation } from '@tutor/shared';
import { SUBJECTS } from '@tutor/shared';
import { errorMessage, get, post, ApiError } from '@/api/client';
import { streamAsk, type ChatStreamEvent } from '@/api/sse';
import MathText from '@/components/MathText.vue';
import CitationList from '@/components/CitationList.vue';
import LoadingState from '@/components/LoadingState.vue';
import NavIcon from '@/components/NavIcon.vue';

/** props：题目上下文（科目、题目 id、可选变式/标签/学生答案），用于把上下文注入答疑会话 */
const props = defineProps<{
  subject: string;
  questionId: string;
  variantId?: number | null;
  questionLabel?: string;
  studentAnswer?: string;
}>();

/** 工具调用轨迹：名称、运行状态与可选摘要 */
interface ToolTrace {
  name: string;
  status: 'running' | 'done';
  summary?: string;
}

/** 界面消息结构：角色、内容、引用/工具轨迹、流式标记与错误 */
interface UiMessage {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  tools?: ToolTrace[];
  streaming?: boolean;
  error?: string;
}

const router = useRouter();
const open = ref(false);
const sessionId = ref('');
const messages = ref<UiMessage[]>([]);
const input = ref('');
const loading = ref(false);
const sending = ref(false);
const error = ref('');
const notice = ref('');
const listEl = ref<HTMLElement | null>(null);
const textareaEl = ref<HTMLTextAreaElement | null>(null);
let controller: AbortController | null = null;
let seq = 0;

/** 当前科目的元信息 */
const subjectMeta = computed(() => SUBJECTS.find((s) => s.code === props.subject));
/** 按科目映射的虚拟老师称呼 */
const teacherTitle = computed(
  () => ({ math: '宋浩老师', english: '刘晓艳老师', cs: '计算机老师' }[props.subject] ?? '老师'),
);
/** 按科目映射的老师头像首字 */
const teacherAvatar = computed(() => ({ math: '宋', english: '艳', cs: '师' }[props.subject] ?? '师'));
/** 本地保存会话 id 的 key，按题目与变式隔离 */
const storageKey = computed(() => `tutor.miniChat.${props.questionId}.${props.variantId ?? 'original'}`);
/** 是否允许发送：非发送中且输入非空 */
const canSend = computed(() => !sending.value && input.value.trim().length > 0);

/** 工具名到中文展示文案的映射 */
const TOOL_LABEL: Record<string, string> = {
  search_knowledge: '检索知识库',
  get_wrongbook_summary: '查看错题本',
  get_profile: '读取画像',
  generate_variant: '生成变式',
  add_question: '错题入库',
  update_profile: '更新画像',
  assemble_exam: '生成模拟卷',
};

/** 空状态下的快捷提问预设 */
const SUGGESTIONS = ['这题的突破口在哪？', '帮我看看我卡在哪一步？', '为什么不能直接套公式？'];

/** 题目上下文标签：优先自定义题目标签，否则显示「错题 id」 */
const contextLabel = computed(() => props.questionLabel || `错题 ${props.questionId}`);

/** 下次 DOM 更新后把消息列表滚动到底部 */
function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/**
 * 把后端消息 DTO 转成界面消息：tool 角色按助手展示，生成唯一 key。
 * @param m 后端聊天消息
 * @returns 界面消息
 */
function mapMessage(m: ChatMessageDto): UiMessage {
  return {
    key: `db-${m.id ?? ++seq}`,
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
    citations: m.citations ?? undefined,
  };
}

/**
 * 调用 POST /chat/sessions 创建答疑会话，保存 id 到 sessionId 并写入 localStorage。
 */
async function createSession(): Promise<void> {
  const created = await post<ChatSessionDto>('/chat/sessions', {
    subject: props.subject,
    title: `答疑 · ${props.questionId}${props.variantId ? ' 变式' : ''}`,
  });
  sessionId.value = created.id;
  localStorage.setItem(storageKey.value, created.id);
}

/**
 * 只恢复本地记录过的会话；不主动创建，避免“打开小窗但没提问”产生空会话。
 * @returns 是否成功恢复会话
 */
async function restoreSession(): Promise<boolean> {
  if (sessionId.value) return true;
  loading.value = true;
  error.value = '';
  try {
    const stored = localStorage.getItem(storageKey.value);
    if (!stored) return false;
    try {
      const data = await get<{ session: ChatSessionDto; messages: ChatMessageDto[] }>(
        `/chat/sessions/${stored}/messages`,
      );
      if (data.session.subject !== props.subject) {
        localStorage.removeItem(storageKey.value);
        return false;
      }
      sessionId.value = stored;
      messages.value = data.messages.map(mapMessage);
      scrollToBottom();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        localStorage.removeItem(storageKey.value);
        return false;
      }
      error.value = errorMessage(err);
      return false;
    }
  } finally {
    loading.value = false;
  }
}

/**
 * 确保会话存在：已有则复用，否则先尝试恢复，再不行才创建新会话。
 * @returns 是否就绪可发送
 */
async function ensureSession(): Promise<boolean> {
  if (sessionId.value) return true;
  if (await restoreSession()) return true;
  if (error.value) return false;
  loading.value = true;
  error.value = '';
  try {
    await createSession();
    messages.value = [];
    return true;
  } catch (err) {
    error.value = errorMessage(err);
    return false;
  } finally {
    loading.value = false;
  }
}

/** 打开小窗：尝试恢复历史会话并聚焦输入框 */
async function openPanel(): Promise<void> {
  open.value = true;
  await restoreSession();
  nextTick(() => textareaEl.value?.focus());
}

/** 切换小窗开合：开则收起，关则打开 */
function toggle(): void {
  if (open.value) {
    open.value = false;
  } else {
    void openPanel();
  }
}

/** 收起小窗 */
function close(): void {
  open.value = false;
}

/** 展开到完整答疑页：关闭小窗并携带当前会话 id 跳转 */
function expand(): void {
  open.value = false;
  router.push({
    path: `/chat/${props.subject}`,
    query: sessionId.value ? { session: sessionId.value } : undefined,
  });
}

/**
 * 把工具轨迹并入列表：running 追加，done 时更新同名 running 项为完成，否则直接追加。
 * @param tools 现有轨迹
 * @param trace 新到达的轨迹
 * @returns 更新后的轨迹数组
 */
function attachTool(tools: ToolTrace[] | undefined, trace: ToolTrace): ToolTrace[] {
  const list = [...(tools ?? [])];
  if (trace.status === 'running') {
    list.push(trace);
    return list;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].name === trace.name && list[i].status === 'running') {
      list[i] = { ...list[i], status: 'done', summary: trace.summary };
      return list;
    }
  }
  list.push(trace);
  return list;
}

/**
 * 处理一条 SSE 事件并更新对应界面消息：token 追加内容、tool 更新轨迹、citations/done/error 更新状态。
 * @param msg 目标界面消息
 * @param event 流式事件
 */
function handleEvent(msg: UiMessage, event: ChatStreamEvent): void {
  if (event.type === 'token') {
    msg.content += event.text;
    scrollToBottom();
  } else if (event.type === 'tool') {
    msg.tools = attachTool(msg.tools, { name: event.name, status: event.status, summary: event.summary });
  } else if (event.type === 'citations') {
    msg.citations = event.citations;
  } else if (event.type === 'done') {
    msg.streaming = false;
    if (event.citations?.length) msg.citations = event.citations;
    scrollToBottom();
  } else if (event.type === 'error') {
    msg.error = event.message;
    msg.streaming = false;
    notice.value = event.message;
  }
}

/**
 * 发送提问：确保会话后追加用户/助手消息，调用 streamAsk 流式接收并更新界面。
 * @param text 指定提问文本（快捷提问用），缺省取输入框内容
 */
async function send(text?: string): Promise<void> {
  const content = (text ?? input.value).trim();
  if (!content || sending.value) return;
  const ready = await ensureSession();
  if (!ready || !sessionId.value) return;

  notice.value = '';
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
  scrollToBottom();

  try {
    await streamAsk({
      sessionId: sessionId.value,
      content,
      questionId: props.questionId,
      variantId: props.variantId ?? null,
      studentAnswer: props.studentAnswer,
      signal: controller.signal,
      onEvent: (event) => handleEvent(assistantMsg, event),
    });
    if (!assistantMsg.content && !assistantMsg.error) {
      assistantMsg.error = '老师没有返回内容，请换个问法再试。';
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      assistantMsg.streaming = false;
      if (!assistantMsg.content) assistantMsg.content = '（已停止生成）';
    } else {
      assistantMsg.streaming = false;
      assistantMsg.error = errorMessage(err);
      notice.value = errorMessage(err);
    }
  } finally {
    assistantMsg.streaming = false;
    sending.value = false;
    controller = null;
    scrollToBottom();
  }
}

/** 停止生成：中断当前 AbortController */
function stop(): void {
  controller?.abort();
}

/** 输入框回车（非 Shift、非中文输入法组字）时发送 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}

/** 输入框高度自适应内容，最高 96px */
function adjustHeight(): void {
  nextTick(() => {
    const el = textareaEl.value;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  });
}

/** 组件卸载时中断未完成的流，避免后台继续回调 */
onBeforeUnmount(() => {
  controller?.abort();
});

/** 对外暴露 open 方法，父组件可主动打开小窗 */
defineExpose({ open: openPanel });
</script>

<template>
  <Teleport to="body">
    <transition name="mini-pop">
      <section v-if="open" class="mini-chat" aria-label="向老师提问">
        <header class="mini-head">
          <div class="mini-avatar">{{ teacherAvatar }}</div>
          <div class="mini-title">
            <strong>问{{ teacherTitle }}</strong>
            <span>{{ subjectMeta?.name ?? '答疑' }} · 记录会同步到答疑解惑</span>
          </div>
          <div class="mini-actions">
            <button class="mini-icon" type="button" title="在完整答疑页打开" aria-label="展开到完整答疑页" @click="expand">
              <NavIcon name="arrow-right" :size="15" />
            </button>
            <button class="mini-icon" type="button" title="收起" aria-label="收起" @click="close">
              <NavIcon name="x" :size="16" />
            </button>
          </div>
        </header>

        <div class="mini-context">
          <span class="tag tag-mono">{{ questionId }}{{ variantId ? ` · 变式` : '' }}</span>
          <MathText v-if="questionLabel" :text="questionLabel" class="ctx-rich" />
          <span v-else class="ctx-label ellipsis">{{ contextLabel }}</span>
        </div>

        <div ref="listEl" class="mini-list">
          <div v-if="loading" class="mini-loading"><LoadingState text="正在连接老师…" /></div>

          <div v-else-if="error" class="mini-error">
            <span>{{ error }}</span>
            <button class="btn btn-sm" type="button" @click="restoreSession">重试</button>
          </div>

          <div v-else-if="messages.length === 0" class="mini-empty">
            <div class="mini-quote">“</div>
            <h4>这题哪里卡住了？</h4>
            <p>可以直接说「这一步为什么成立」「我算出来是 A，为什么不对」。老师会围绕这道题讲，不会直接跳走。</p>
            <button
              v-for="q in SUGGESTIONS"
              :key="q"
              class="mini-suggestion"
              type="button"
              @click="send(q)"
            >
              <NavIcon name="spark" :size="13" /> {{ q }}
            </button>
          </div>

          <template v-else>
            <article
              v-for="msg in messages"
              :key="msg.key"
              class="mini-message"
              :class="msg.role === 'user' ? 'from-user' : 'from-tutor'"
            >
              <div v-if="msg.role === 'assistant'" class="mini-msg-avatar">{{ teacherAvatar }}</div>
              <div class="mini-bubble-wrap">
                <div v-if="msg.tools?.length" class="mini-tools">
                  <span v-for="(tool, i) in msg.tools" :key="i" class="mini-tool" :class="{ done: tool.status === 'done' }">
                    {{ TOOL_LABEL[tool.name] ?? tool.name }}
                  </span>
                </div>
                <div class="mini-bubble" :class="msg.role === 'user' ? 'user' : 'tutor'">
                  <MathText v-if="msg.content" :text="msg.content" />
                  <span v-else-if="msg.streaming" class="mini-typing"><i /><i /><i /></span>
                  <span v-if="msg.streaming && msg.content" class="mini-caret" />
                  <div v-if="msg.error" class="mini-bubble-error">{{ msg.error }}</div>
                </div>
                <CitationList v-if="msg.role === 'assistant'" :citations="msg.citations" />
              </div>
            </article>
          </template>
        </div>

        <div v-if="notice" class="mini-notice">{{ notice }}</div>

        <footer class="mini-composer">
          <textarea
            ref="textareaEl"
            v-model="input"
            class="mini-input"
            rows="1"
            placeholder="例如：为什么用等价无穷小替换这一步？"
            @keydown="onKeydown"
            @input="adjustHeight"
          />
          <button v-if="sending" class="mini-send stop" type="button" title="停止" @click="stop">
            <NavIcon name="x" :size="15" />
          </button>
          <button v-else class="mini-send" type="button" :disabled="!canSend" title="发送" @click="send()">
            <NavIcon name="send" :size="15" />
          </button>
        </footer>
        <div class="mini-foot">回答会保存到「答疑解惑」的同一会话</div>
      </section>
    </transition>

    <button
      class="mini-fab"
      :class="{ active: open }"
      type="button"
      title="问老师"
      aria-label="问老师"
      @click="toggle"
    >
      <NavIcon :name="open ? 'x' : 'chat'" :size="18" />
      <span>{{ open ? '收起' : '问老师' }}</span>
      <i v-if="!open" class="mini-fab-dot" />
    </button>
  </Teleport>
</template>

<style scoped>
.mini-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 72;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 46px;
  padding: 0 17px;
  border-radius: 99px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: var(--accent);
  color: #f4efe4;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 10px 26px rgba(22, 77, 63, 0.32);
  transition: transform 0.18s ease, background 0.18s ease;
}
.mini-fab:hover {
  background: var(--accent-dark);
  transform: translateY(-2px);
}
.mini-fab.active {
  background: var(--ink);
  box-shadow: var(--shadow-lift);
}
.mini-fab-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f0c27b;
  box-shadow: 0 0 0 3px rgba(240, 194, 123, 0.25);
}

.mini-chat {
  position: fixed;
  right: 24px;
  bottom: 82px;
  z-index: 74;
  width: 392px;
  height: min(620px, calc(100vh - 120px));
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(23, 37, 34, 0.24);
  overflow: hidden;
}

.mini-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 13px;
  background: linear-gradient(180deg, var(--panel), var(--panel-soft));
  border-bottom: 1px solid var(--line);
}
.mini-avatar,
.mini-msg-avatar {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: var(--accent);
  color: #f1ece0;
  font-family: var(--serif);
  font-size: 13px;
  box-shadow: 0 3px 9px rgba(30, 107, 87, 0.22);
}
.mini-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.mini-title strong {
  font-family: var(--serif);
  font-size: 14px;
  color: var(--ink);
}
.mini-title span {
  font-size: 10.5px;
  color: var(--muted);
}
.mini-actions {
  display: flex;
  gap: 3px;
}
.mini-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.mini-icon:hover {
  background: rgba(27, 41, 38, 0.06);
  color: var(--ink);
}

.mini-context {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 13px;
  border-bottom: 1px dashed var(--line);
  background: var(--panel-soft);
}
.ctx-label {
  font-size: 11.5px;
  color: var(--muted);
  min-width: 0;
}
.ctx-rich {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--ink-2);
  max-height: 3.1em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.ctx-rich :deep(p) {
  margin: 0;
}

.mini-list {
  flex: 1;
  overflow-y: auto;
  padding: 14px 13px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background:
    radial-gradient(300px 200px at 100% 0%, rgba(30, 107, 87, 0.035), transparent 70%),
    var(--panel);
}
.mini-loading {
  margin: auto;
}
.mini-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 30px 18px;
  text-align: center;
  color: var(--danger);
  font-size: 12.5px;
}
.mini-empty {
  margin: auto;
  text-align: center;
  padding: 4px 12px 12px;
}
.mini-quote {
  font-family: var(--serif);
  font-size: 40px;
  line-height: 1;
  color: var(--terra);
  opacity: 0.3;
}
.mini-empty h4 {
  font-size: 17px;
  margin: 2px 0 7px;
}
.mini-empty p {
  font-size: 12px;
  line-height: 1.75;
  color: var(--muted);
  margin: 0 auto 13px;
  max-width: 290px;
}
.mini-suggestion {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink-2);
  border-radius: 99px;
  padding: 7px 10px;
  font-size: 11.5px;
  cursor: pointer;
  transition: 0.16s ease;
}
.mini-suggestion:hover {
  border-color: var(--accent);
  color: var(--accent-dark);
  background: var(--accent-soft);
}

.mini-message {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.mini-message.from-user {
  justify-content: flex-end;
}
.mini-msg-avatar {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  font-size: 11px;
  margin-top: 2px;
}
.mini-bubble-wrap {
  max-width: 84%;
  min-width: 0;
}
.from-user .mini-bubble-wrap {
  max-width: 80%;
}
.mini-bubble {
  border-radius: 11px;
  padding: 8px 11px;
  font-size: 12.5px;
  line-height: 1.7;
}
.mini-bubble.tutor {
  background: var(--panel-soft);
  border: 1px solid var(--line);
  border-top-left-radius: 3px;
}
.mini-bubble.user {
  background: #1f4d42;
  color: #f4efe4;
  border-top-right-radius: 3px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mini-bubble :deep(.rich) {
  font-size: 12.5px;
  line-height: 1.72;
}
.mini-bubble :deep(.rich p) {
  margin: 0 0 0.5em;
}
.mini-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}
.mini-tool {
  font-size: 9.5px;
  color: var(--blue);
  background: var(--blue-soft);
  border: 1px solid #d2e2eb;
  border-radius: 99px;
  padding: 1px 7px;
}
.mini-tool.done {
  color: var(--accent-dark);
  background: var(--accent-soft);
  border-color: #c9e3d9;
}
.mini-bubble-error {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px dashed var(--line);
  color: var(--danger);
  font-size: 11px;
}
.mini-caret {
  display: inline-block;
  width: 5px;
  height: 12px;
  background: var(--accent);
  margin-left: 2px;
  vertical-align: -1px;
  animation: mini-blink 0.9s steps(2) infinite;
}
.mini-typing {
  display: inline-flex;
  gap: 3px;
  padding: 2px 0;
}
.mini-typing i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.4;
  animation: mini-bounce 1.1s infinite;
}
.mini-typing i:nth-child(2) {
  animation-delay: 0.15s;
}
.mini-typing i:nth-child(3) {
  animation-delay: 0.3s;
}

.mini-notice {
  margin: 0 12px 6px;
  padding: 6px 9px;
  border-radius: 7px;
  background: var(--danger-soft);
  border: 1px solid #efd2cd;
  color: #7f2c24;
  font-size: 10.5px;
  line-height: 1.5;
}

.mini-composer {
  display: flex;
  align-items: flex-end;
  gap: 7px;
  padding: 9px 10px 7px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}
.mini-input {
  flex: 1;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: #fffefb;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.6;
  resize: none;
  max-height: 96px;
  outline: none;
  color: var(--ink);
}
.mini-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(30, 107, 87, 0.1);
}
.mini-send {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #f4efe4;
  cursor: pointer;
}
.mini-send:hover:not(:disabled) {
  background: var(--accent-dark);
}
.mini-send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mini-send.stop {
  background: var(--danger-soft);
  color: var(--danger);
}
.mini-foot {
  padding: 0 12px 8px;
  font-size: 9.5px;
  color: var(--muted);
  text-align: center;
}

.mini-pop-enter-active,
.mini-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
  transform-origin: bottom right;
}
.mini-pop-enter-from,
.mini-pop-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

@keyframes mini-blink {
  50% {
    opacity: 0;
  }
}
@keyframes mini-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-2px);
    opacity: 1;
  }
}

@media (max-width: 640px) {
  .mini-fab {
    right: 14px;
    bottom: 78px;
    height: 42px;
    padding: 0 14px;
    font-size: 12px;
  }
  .mini-chat {
    right: 10px;
    left: 10px;
    bottom: 128px;
    width: auto;
    height: min(70vh, 560px);
  }
}
</style>
