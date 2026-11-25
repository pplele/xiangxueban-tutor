<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { del, errorMessage, get, patch, post } from '@/api/client';
import NavIcon from '@/components/NavIcon.vue';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import MathText from '@/components/MathText.vue';

type Subject = 'math' | 'english';

interface StudyNote {
  id: string;
  username: string;
  subject: Subject;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface NoteCounts {
  math: number;
  english: number;
}

interface DigestItem {
  questionId: string;
  chapter: string;
  kpCodes: string[];
  note: string;
  questionType: string;
  updatedAt: string;
}
interface DigestGroup {
  chapter: string;
  items: DigestItem[];
}

const SUBJECTS: { key: Subject; label: string; desc: string }[] = [
  { key: 'math', label: '高等数学', desc: '公式 · 解题思路 · 章节总结' },
  { key: 'english', label: '大学英语', desc: '库课笔记章节 · 词法句法 · 阅读翻译' },
];

const route = useRoute();
const router = useRouter();

const subject = ref<Subject>(route.query.subject === 'english' ? 'english' : 'math');
const notes = ref<StudyNote[]>([]);
const counts = ref<NoteCounts>({ math: 0, english: 0 });
const digestGroups = ref<DigestGroup[]>([]);
const digestCounts = ref<NoteCounts>({ math: 0, english: 0 });
const digestTotal = ref(0);
const digestLoading = ref(true);
const collapsedChapters = ref<Set<string>>(new Set());
const loading = ref(true);
const error = ref('');
const keyword = ref('');
const notice = ref('');

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const draft = ref({ title: '', body: '', tags: '' });
const expanded = ref<Set<string>>(new Set());

let noticeTimer: number | undefined;
let searchTimer: number | undefined;

/**
 * 在页面顶部显示一条临时提示，3.5 秒后自动消失（期间若出现新提示则不清除新内容）。
 * @param message 提示文案
 */
function flash(message: string) {
  notice.value = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    if (notice.value === message) notice.value = '';
  }, 3500);
}

/**
 * 加载当前科目（及关键词）下的手动笔记列表与计数，组件挂载、切换科目、保存或删除后调用。
 * 调用 GET /notes，附带 subject 与非空搜索词 q。
 */
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const query = new URLSearchParams({ subject: subject.value });
    if (keyword.value.trim()) query.set('q', keyword.value.trim());
    const data = await get<{ notes: StudyNote[]; counts: NoteCounts; digestCounts: NoteCounts }>(
      `/notes?${query.toString()}`,
    );
    notes.value = data.notes;
    counts.value = data.counts ?? { math: 0, english: 0 };
    digestCounts.value = data.digestCounts ?? { math: 0, english: 0 };
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/** 错题备注精华只读汇总，切换科目时重新拉取 */
async function loadDigest() {
  digestLoading.value = true;
  try {
    const data = await get<{ subject: Subject; groups: DigestGroup[]; total: number }>(
      `/notes/digest?subject=${subject.value}`,
    );
    digestGroups.value = data.groups ?? [];
    digestTotal.value = data.total ?? 0;
  } catch {
    // 精华汇总失败不影响手动笔记
    digestGroups.value = [];
    digestTotal.value = 0;
  } finally {
    digestLoading.value = false;
  }
}

/**
 * 展开/收起精华汇总中的某个章节，点击章节标题时触发。
 * @param chapter 章节名
 */
function toggleChapter(chapter: string) {
  const next = new Set(collapsedChapters.value);
  if (next.has(chapter)) next.delete(chapter);
  else next.add(chapter);
  collapsedChapters.value = next;
}

/**
 * 切换笔记科目标签：清空搜索与编辑态，更新 URL query，并重新加载笔记与精华汇总。
 * @param next 目标科目
 */
function switchSubject(next: Subject) {
  if (subject.value === next) return;
  subject.value = next;
  keyword.value = '';
  editorOpen.value = false;
  void router.replace({ query: { subject: next } });
  void load();
  void loadDigest();
}

/**
 * 监听搜索词变化：用 300ms 防抖延迟触发 load，避免每次按键都发起请求。
 */
watch(keyword, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void load(), 300);
});

/** 打开「新建笔记」弹窗：清空编辑 ID 与草稿内容。 */
function openNew() {
  editingId.value = null;
  draft.value = { title: '', body: '', tags: '' };
  editorOpen.value = true;
}

/**
 * 打开「编辑笔记」弹窗：把已有笔记的标题、正文与标签填入草稿。
 * @param note 待编辑的笔记
 */
function openEdit(note: StudyNote) {
  editingId.value = note.id;
  draft.value = { title: note.title, body: note.body, tags: note.tags.join('、') };
  editorOpen.value = true;
}

/** 关闭编辑弹窗；保存进行中时忽略点击，避免误关导致状态丢失。 */
function closeEditor() {
  if (!saving.value) editorOpen.value = false;
}

/**
 * 保存笔记处理器，点击弹窗「保存笔记」按钮时触发。
 * 校验标题并解析标签，按编辑/新建分别 PATCH /notes/:id 或 POST /notes，成功后关闭弹窗并刷新列表。
 */
async function saveNote() {
  const title = draft.value.title.trim();
  if (!title) {
    flash('先写个标题吧');
    return;
  }
  if (saving.value) return;
  saving.value = true;
  try {
    const tags = draft.value.tags
      .split(/[,，、\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (editingId.value) {
      await patch(`/notes/${editingId.value}`, { title, body: draft.value.body, tags });
      flash('笔记已更新');
    } else {
      await post('/notes', { subject: subject.value, title, body: draft.value.body, tags });
      flash('笔记已保存');
    }
    editorOpen.value = false;
    await load();
  } catch (err) {
    flash(errorMessage(err));
  } finally {
    saving.value = false;
  }
}

/**
 * 删除笔记处理器，点击笔记卡片删除按钮时触发。
 * 先弹确认框，确认后调用 DELETE /notes/:id，成功后刷新列表。
 * @param note 待删除的笔记
 */
async function removeNote(note: StudyNote) {
  if (!window.confirm(`确定删除「${note.title}」？删除后无法恢复。`)) return;
  try {
    await del(`/notes/${note.id}`);
    flash('笔记已删除');
    await load();
  } catch (err) {
    flash(errorMessage(err));
  }
}

/**
 * 展开/收起某篇笔记的全文（正文超过 140 字时显示按钮）。
 * @param id 笔记 ID
 */
function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

/**
 * 生成笔记正文的列表预览：压缩空白并截断到 140 字。
 * @param body 笔记正文
 * @returns 预览文本；正文为空时返回占位提示
 */
function preview(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > 140 ? `${text.slice(0, 140)}…` : text || '（还没有正文）';
}

/**
 * 把 ISO 时间格式化为「月-日 时:分」（zh-CN 本地时区），用于笔记卡片更新时间。
 * @param iso 时间字符串
 * @returns 格式化后的时间文本
 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}


/**
 * 把错因备注按行拆成列表项，并去掉 AI 写的「- 」前缀，交给 <li> 渲染真正的圆点。
 * @param note 原始备注文本
 * @returns 逐行文本数组
 */
function noteLines(note: string): string[] {
  return note
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*·]\s+/, ''))
    .filter(Boolean);
}

/**
 * 平滑滚动到某一章错因精华。
 * @param index 章节下标
 */
function scrollToChapter(index: number) {
  document.getElementById(`digest-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 平滑滚动到「我的补充笔记」。 */
function scrollToNotes() {
  document.getElementById('manual-notes')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 组件挂载：加载手动笔记列表与错因精华汇总。 */
onMounted(() => {
  void load();
  void loadDigest();
});
/** 组件卸载：清除提示与搜索防抖计时器，避免卸载后仍触发回调。 */
onBeforeUnmount(() => {
  window.clearTimeout(noticeTimer);
  window.clearTimeout(searchTimer);
});
</script>

<template>
  <div class="page notes-page">
    <header class="page-header">
      <div>
        <div class="eyebrow">Study Notes</div>
        <h1 class="page-title">学习笔记</h1>
        <p class="page-desc">
          上半部分是你在错题本里写下的错因与口诀，自动汇成精华（不显示题目）；下半部分可以自由补充自己的笔记。数学与英语分开存放，英语按《库课·大学英语》笔记章节分组。
        </p>
      </div>
      <button class="btn btn-primary" type="button" @click="openNew">
        <NavIcon name="plus" :size="16" />
        新建笔记
      </button>
    </header>

    <div v-if="notice" class="banner banner-info">{{ notice }}</div>

    <div class="subject-tabs" role="tablist" aria-label="笔记科目">
      <button
        v-for="item in SUBJECTS"
        :key="item.key"
        type="button"
        class="subject-tab"
        :class="{ active: subject === item.key }"
        :title="item.desc"
        role="tab"
        :aria-selected="subject === item.key"
        @click="switchSubject(item.key)"
      >
        <span class="tab-title">{{ item.label }}</span>
        <span class="tab-count">{{ digestCounts[item.key] }}</span>
      </button>
      <span class="tabs-note">条错因精华 · 按科目分开存放</span>
    </div>

    <div class="notes-layout">
      <!-- 左侧：章节导航（跟随滚动固定） -->
      <aside class="notes-rail">
        <div class="rail-head"><span>本页导航</span><span class="rail-line" /></div>
        <button class="rail-link" type="button" @click="scrollToChapter(0)">
          <span class="rail-dot" /> 错因精华 <em>{{ digestTotal }}</em>
        </button>
        <div v-for="(g, i) in digestGroups" :key="g.chapter" class="rail-sub">
          <button class="rail-link" type="button" @click="scrollToChapter(i)">
            <span class="rail-idx">{{ String(i + 1).padStart(2, '0') }}</span>
            {{ g.chapter }} <em>{{ g.items.length }}</em>
          </button>
        </div>
        <div class="rail-gap" />
        <button class="rail-link" type="button" @click="scrollToNotes">
          <span class="rail-dot" /> 我的补充笔记 <em>{{ notes.length }}</em>
        </button>
        <p class="rail-tip">点击章节可直接跳到对应内容</p>
      </aside>

      <!-- 右侧：正文 -->
      <main class="notes-main">
        <!-- ========== 错题备注精华（只读，来源 questions.note） ========== -->
        <section class="paper-block">
          <div class="block-header">
            <div class="block-eyebrow">FROM WRONGBOOK · 自动汇总</div>
            <h2>错因精华 <span class="block-count">{{ digestTotal }}</span></h2>
            <p>
              来自错题本里写下的错因与口诀，只显示提醒、不显示题目。{{
                subject === 'english' ? '按《库课·大学英语》笔记章节整理。' : '按教材章节顺序整理。'
              }}
            </p>
          </div>

          <LoadingState v-if="digestLoading" text="正在整理错因精华…" />

          <template v-else-if="digestGroups.length">
            <article
              v-for="(group, gi) in digestGroups"
              :id="`digest-${gi}`"
              :key="group.chapter"
              class="chapter-paper"
            >
              <header class="chapter-head">
                <span class="chapter-no">{{ String(gi + 1).padStart(2, '0') }}</span>
                <h3>{{ group.chapter }}</h3>
                <span class="chapter-total">{{ group.items.length }} 条</span>
              </header>
              <div class="entry-list">
                <div v-for="item in group.items" :key="item.questionId" class="entry">
                  <div class="entry-meta">
                    <span v-for="kp in item.kpCodes" :key="kp" class="kp-chip">{{ kp }}</span>
                    <span class="entry-type">{{ item.questionType }}</span>
                  </div>
                  <ul class="entry-lines">
                    <li v-for="(line, li) in noteLines(item.note)" :key="li">
                      <MathText :text="line" />
                    </li>
                  </ul>
                </div>
              </div>
            </article>
          </template>

          <div v-else class="empty-inline">
            <div class="empty-mark"><NavIcon name="note" :size="24" /></div>
            <h3>{{ subject === 'english' ? '英语暂无错因精华' : '还没有错因备注' }}</h3>
            <p>
              {{
                subject === 'english'
                  ? '在错题本给英语题目写下错因或口诀，这里会按《库课·大学英语》笔记章节自动汇总。'
                  : '去错题本给题目写下错因或口诀，这里会自动汇总成精华。'
              }}
            </p>
          </div>
        </section>

        <!-- ========== 我的手动笔记（补充） ========== -->
        <section id="manual-notes" class="paper-block">
          <div class="block-header">
            <div class="block-eyebrow">MY NOTES · 自由记录</div>
            <h2>我的补充笔记 <span class="block-count">{{ notes.length }}</span></h2>
            <p>错因精华之外的自由记录，数学与英语分开存放。</p>
          </div>

          <div class="notes-toolbar">
            <div class="search-box">
              <NavIcon name="search" :size="16" />
              <input v-model="keyword" class="search-input" type="search" placeholder="搜索标题、正文或标签" />
            </div>
            <span class="notes-count">共 {{ notes.length }} 篇</span>
          </div>

          <LoadingState v-if="loading" />
          <ErrorState v-else-if="error" :message="error" @retry="load" />

          <div v-else-if="notes.length" class="manual-list">
            <article v-for="note in notes" :key="note.id" class="manual-card" :class="note.subject">
              <div class="manual-stripe" />
              <div class="manual-inner">
                <header class="manual-head">
                  <h3>{{ note.title }}</h3>
                  <div class="manual-actions">
                    <button class="icon-btn" type="button" title="编辑" @click="openEdit(note)">
                      <NavIcon name="edit" :size="15" />
                    </button>
                    <button class="icon-btn danger" type="button" title="删除" @click="removeNote(note)">
                      <NavIcon name="trash" :size="15" />
                    </button>
                  </div>
                </header>
                <div v-if="note.tags.length" class="manual-tags">
                  <span v-for="tag in note.tags" :key="tag" class="tag tag-blue">{{ tag }}</span>
                </div>
                <div class="manual-body" :class="{ 'manual-body-full': expanded.has(note.id) }">
                  <MathText v-if="expanded.has(note.id)" :text="note.body" />
                  <p v-else>{{ preview(note.body) }}</p>
                </div>
                <button v-if="note.body.length > 140" class="expand-btn" type="button" @click="toggleExpand(note.id)">
                  {{ expanded.has(note.id) ? '收起全文' : '展开全文（含公式渲染）' }}
                </button>
                <footer class="manual-foot">
                  <span class="subject-badge" :class="note.subject">{{ note.subject === 'math' ? '数学' : '英语' }}</span>
                  <span class="muted small">更新于 {{ formatTime(note.updatedAt) }}</span>
                </footer>
              </div>
            </article>
          </div>

          <div v-else class="empty-inline">
            <div class="empty-mark"><NavIcon name="note" :size="28" /></div>
            <h3>{{ keyword ? '没有找到匹配的笔记' : '还没有补充笔记' }}</h3>
            <p>
              {{
                keyword
                  ? '换个关键词试试，或清空搜索条件。'
                  : '上面的错因精华是自动汇总的；这里可以另外记自己的笔记。点右上角「新建笔记」写第一篇。'
              }}
            </p>
            <button v-if="!keyword" class="btn btn-primary btn-sm" type="button" @click="openNew">写第一篇</button>
          </div>
        </section>
      </main>
    </div>

    <!-- 编辑弹窗：Teleport 到 body，避免被页面层叠上下文裁切 -->
    <Teleport to="body">
      <div v-if="editorOpen" class="modal-mask" @click.self="closeEditor">
        <section class="note-modal card" role="dialog" aria-modal="true" aria-label="编辑笔记">
          <div class="modal-head">
            <h3>{{ editingId ? '编辑笔记' : '新建笔记' }}</h3>
            <button class="icon-btn" type="button" title="关闭" @click="closeEditor">
              <NavIcon name="x" :size="17" />
            </button>
          </div>
          <div class="modal-body">
            <label class="field">
              <span class="label">标题</span>
              <input
                v-model="draft.title"
                class="input"
                type="text"
                maxlength="200"
                placeholder="例如：洛必达法则的使用条件"
              />
            </label>
            <label class="field">
              <span class="label">标签 <small class="muted">（可选，逗号或顿号分隔）</small></span>
              <input v-model="draft.tags" class="input" type="text" placeholder="极限, 易错点" />
            </label>
            <label class="field">
              <span class="label">正文</span>
              <textarea
                v-model="draft.body"
                class="textarea note-textarea"
                maxlength="20000"
                placeholder="写下公式、解题思路、单词用法……支持多行。"
              ></textarea>
            </label>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" type="button" @click="closeEditor">取消</button>
            <button class="btn btn-primary" type="button" :disabled="saving" @click="saveNote">
              {{ saving ? '保存中…' : '保存笔记' }}
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.notes-page {
  max-width: 1280px;
}
.page-header .btn {
  flex-shrink: 0;
}

/* ---------- 科目切换：紧凑分段控件 ---------- */
.subject-tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-soft);
}
.subject-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 15px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}
.subject-tab:hover {
  color: var(--accent);
}
.subject-tab.active {
  background: var(--panel);
  color: var(--accent);
  box-shadow: var(--shadow);
}
.tab-title {
  font-family: var(--serif);
  font-size: 14px;
  font-weight: 700;
}
.tab-count {
  min-width: 22px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-deep);
  color: var(--ink-2);
  font-size: 11.5px;
  text-align: center;
}
.subject-tab.active .tab-count {
  background: var(--accent);
  color: #f6f2e7;
}
.tabs-note {
  padding: 0 10px 0 6px;
  color: var(--muted);
  font-size: 12px;
}

/* ---------- 双栏：左导航 + 右文档 ---------- */
.notes-layout {
  display: grid;
  grid-template-columns: 214px minmax(0, 1fr);
  gap: 30px;
  align-items: start;
  margin-top: 22px;
}
.notes-rail {
  position: sticky;
  top: 20px;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  padding: 6px 4px 24px 0;
}
.rail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
}
.rail-line {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.rail-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.rail-link:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.rail-link em {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
  font-style: normal;
}
.rail-sub {
  padding-left: 14px;
}
.rail-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--accent);
}
.rail-idx {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
}
.rail-gap {
  height: 1px;
  margin: 12px 9px;
  background: var(--line);
}
.rail-tip {
  padding: 0 9px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}

/* ---------- 右侧文档区 ---------- */
.notes-main {
  min-width: 0;
}
.paper-block {
  margin-bottom: 38px;
}
.block-header {
  margin-bottom: 20px;
}
.block-eyebrow {
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.block-header h2 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--serif);
  font-size: 22px;
}
.block-count {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 600;
}
.block-header p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}

/* ---------- 笔记本 · 活页纸 ---------- */
.chapter-paper {
  position: relative;
  margin: 0 0 24px 18px;
  padding: 20px 24px 22px 44px;
  border: 1px solid var(--line-strong);
  border-left: 0;
  border-radius: 3px 12px 12px 3px;
  background-color: #fffdf7;
  /* 淡横线纸 */
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0 27px,
    rgba(53, 106, 140, 0.13) 27px 28px
  );
  background-position: 0 6px;
  box-shadow: 0 2px 3px rgba(27, 41, 38, 0.04), 0 12px 26px rgba(27, 41, 38, 0.07);
  scroll-margin-top: 20px;
}
/* 左侧装订孔 */
.chapter-paper::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 16px;
  bottom: 16px;
  width: 18px;
  background-image: radial-gradient(
    circle at 9px 9px,
    var(--bg) 0 5px,
    var(--line-strong) 5px 6px,
    transparent 6.5px
  );
  background-size: 18px 46px;
  background-repeat: repeat-y;
}
/* 红色装订边线 */
.chapter-paper::after {
  content: '';
  position: absolute;
  left: 34px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(180, 95, 59, 0.3);
}
.chapter-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0 0 14px;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--terra-soft);
}
.chapter-no {
  color: var(--terra);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  font-weight: 700;
}
.chapter-head h3 {
  flex: 1;
  font-family: var(--serif);
  font-size: 18px;
  line-height: 1.5;
}
.chapter-total {
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}
.entry-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 给每条记录自动编号 */
  counter-reset: entryno;
}
.entry {
  position: relative;
  padding: 8px 12px 9px 44px;
  border-radius: 6px;
  transition: background 0.15s ease;
}
.entry:hover {
  background: rgba(227, 240, 234, 0.4);
}
/* 手写序号圆章 */
.entry::before {
  counter-increment: entryno;
  content: counter(entryno);
  position: absolute;
  left: 6px;
  top: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1.5px solid var(--terra);
  border-radius: 50%;
  color: var(--terra);
  background: #fffdf7;
  font-family: var(--serif);
  font-size: 13px;
  font-weight: 700;
  transform: rotate(-8deg);
}
.entry-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.kp-chip {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--blue-soft);
  color: var(--blue);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
}
.entry-type {
  color: var(--muted);
  font-size: 11px;
}
.entry-lines {
  margin: 0;
  padding: 0;
  list-style: none;
}
.entry-lines li {
  position: relative;
  padding: 3px 0 3px 18px;
  color: var(--ink-2);
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
/* 每条要点前的小铅笔标记 */
.entry-lines li::before {
  content: '✎';
  position: absolute;
  left: 0;
  top: 3px;
  color: var(--terra);
  font-size: 13px;
  opacity: 0.7;
}
/* 要点之间用虚线分隔，像逐条写下的笔记 */
.entry-lines li + li {
  margin-top: 5px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.entry-lines .rich {
  display: inline;
}
.entry-lines .rich p {
  display: inline;
  margin: 0;
}

/* 手动笔记：单列宽条 + 左侧科目色条 */
.notes-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 14px;
}
.search-box {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  max-width: 380px;
  padding: 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: #fffefb;
  color: var(--muted);
}
.search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(30, 107, 87, 0.12);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13.5px;
}
.search-input::placeholder {
  color: #a7aca5;
}
.notes-count {
  color: var(--muted);
  font-size: 12.5px;
  white-space: nowrap;
}
.manual-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  counter-reset: noteno;
}
.manual-card {
  counter-increment: noteno;
}
/* 标题前的手写编号 */
.manual-head h3::before {
  content: counter(noteno) '.';
  display: inline-block;
  margin-right: 8px;
  color: var(--terra);
  font-family: var(--serif);
  font-weight: 700;
  opacity: 0.8;
}
.manual-card {
  position: relative;
  display: flex;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 3px 12px 12px 3px;
  /* 便签纸横线 + 淡黄底 */
  background-color: #fffdf7;
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0 27px,
    rgba(53, 106, 140, 0.1) 27px 28px
  );
  background-position: 0 8px;
  box-shadow: 0 2px 3px rgba(27, 41, 38, 0.04), 0 10px 24px rgba(27, 41, 38, 0.06);
  transition: box-shadow 0.16s ease, transform 0.16s ease;
}
.manual-card:hover {
  box-shadow: 0 4px 6px rgba(27, 41, 38, 0.06), 0 16px 34px rgba(27, 41, 38, 0.1);
  transform: translateY(-1px);
}
/* 活页装订孔条 */
.manual-stripe {
  position: relative;
  width: 26px;
  flex-shrink: 0;
  background: var(--panel-soft);
  border-right: 1px solid var(--line);
}
.manual-stripe::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 14px;
  bottom: 14px;
  width: 14px;
  background-image: radial-gradient(
    circle at 7px 7px,
    var(--bg) 0 4px,
    var(--line-strong) 4px 4.8px,
    transparent 5px
  );
  background-size: 14px 46px;
  background-repeat: repeat-y;
}
/* 科目色标：顶部小色条 */
.manual-stripe::after {
  content: '';
  position: absolute;
  top: 12px;
  bottom: 12px;
  right: 0;
  width: 3px;
  background: var(--blue);
}
.manual-card.english .manual-stripe::after {
  background: var(--terra);
}
.manual-inner {
  position: relative;
  flex: 1;
  min-width: 0;
  padding: 16px 22px 14px;
}
.manual-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.manual-head h3 {
  font-family: var(--serif);
  font-size: 16px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.manual-actions {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  opacity: 0.35;
  transition: opacity 0.16s ease;
}
.manual-card:hover .manual-actions,
.manual-card:focus-within .manual-actions {
  opacity: 1;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.icon-btn.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
.manual-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.manual-body {
  margin-top: 9px;
  color: var(--ink-2);
  font-size: 14px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}
.manual-body p {
  margin: 0;
  white-space: pre-wrap;
}
.manual-body-full .rich p {
  margin: 0 0 0.65em;
}
.expand-btn {
  align-self: flex-start;
  margin-top: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 12.5px;
  cursor: pointer;
}
.expand-btn:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.manual-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.subject-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
}
.subject-badge.math {
  background: var(--blue-soft);
  color: var(--blue);
}
.subject-badge.english {
  background: var(--terra-soft);
  color: var(--terra);
}

/* 空状态 */
.empty-inline {
  padding: 34px 20px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  text-align: center;
}
.empty-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  margin-bottom: 4px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}
.empty-inline h3 {
  margin: 8px 0 4px;
  color: var(--ink);
  font-size: 15px;
}
.empty-inline p {
  max-width: 520px;
  margin: 0 auto 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
}

/* 编辑弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(27, 41, 38, 0.38);
  backdrop-filter: blur(2px);
}
.note-modal {
  width: min(640px, 100%);
  max-height: min(88vh, 760px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 17px 20px;
  border-bottom: 1px solid var(--line);
}
.modal-head h3 {
  font-size: 17px;
}
.modal-body {
  padding: 18px 20px 4px;
  overflow-y: auto;
}
.modal-body .field > span {
  color: var(--ink-2);
  font-size: 12.5px;
  font-weight: 600;
}
.note-textarea {
  min-height: 240px;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.75;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--line);
  background: var(--panel-soft);
}

@media (max-width: 900px) {
  .notes-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .notes-rail {
    position: static;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: none;
    padding: 0;
  }
  .rail-head,
  .rail-tip,
  .rail-gap,
  .rail-sub {
    display: none;
  }
  .rail-link {
    width: auto;
  }
}
</style>
