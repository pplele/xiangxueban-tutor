<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { QuestionDetail, VariantItem } from '@tutor/shared';
import { errorMessage, get, post } from '@/api/client';
import { cleanOption } from '@/lib/rich';
import MathText from '@/components/MathText.vue';
import MiniChat from '@/components/MiniChat.vue';
import StatusTag from '@/components/StatusTag.vue';
import LoadingState from '@/components/LoadingState.vue';
import ErrorState from '@/components/ErrorState.vue';
import NavIcon from '@/components/NavIcon.vue';

const route = useRoute();
const router = useRouter();
const id = String(route.params.id);
const variantId = Number(route.query.variantId || 0) || null;

const detail = ref<QuestionDetail | null>(null);
const loading = ref(true);
const loadError = ref('');
const answer = ref('');
const selectedLetter = ref('');
const selfRating = ref<'' | 'self_pass' | 'self_partial' | 'self_fail'>('');
const submitting = ref(false);
const submitError = ref('');
const result = ref<any>(null);
const resultEl = ref<HTMLElement | null>(null);
const miniChatRef = ref<InstanceType<typeof MiniChat> | null>(null);

/**
 * 从题目详情中找出 URL 指定的变式题；未指定 variantId 时返回 null。
 * @returns 匹配的变式题，或 null
 */
const variant = computed<VariantItem | null>(() => {
  if (!detail.value || !variantId) return null;
  return detail.value.variants.find((v) => v.id === variantId) ?? null;
});

/** 当前作答的是否为变式题。 */
const isVariant = computed(() => Boolean(variant.value));
/** 当前题型：变式题一律按解答题处理，否则取题目本身的题型。 */
const questionType = computed(() => (isVariant.value ? '解答题' : detail.value?.questionType ?? '计算题'));
/** 当前是否为选择题。 */
const isChoice = computed(() => questionType.value === '选择题');
/** 当前是否为填空题。 */
const isBlank = computed(() => questionType.value === '填空题');
/** 当前是否为主观题（既非选择题也非填空题）。 */
const isSubjective = computed(() => !isChoice.value && !isBlank.value);
/** 选项字母列表：有选项时按数量生成 A/B/C…，否则默认 A~D。 */
const letters = computed(() => {
  const opts = detail.value?.options;
  if (opts && opts.length > 0) return opts.map((_, i) => String.fromCharCode(65 + i));
  return ['A', 'B', 'C', 'D'];
});
/** 当前展示的题干：变式题用变式题干，否则用原题正文。 */
const displayStem = computed(() => (variant.value ? variant.value.stem : detail.value?.textBody ?? ''));
/** 当前展示的选项：变式题不展示选项。 */
const displayOptions = computed(() => (isVariant.value ? [] : detail.value?.options ?? []));
/** 当前作答内容的文本表示：选择题显示所选字母，其余题型为输入文本。 */
const currentAnswer = computed(() => {
  if (isChoice.value) return selectedLetter.value ? `选了 ${selectedLetter.value}` : '';
  return answer.value;
});
/** 题干摘要（截断到 300 字），作为 MiniChat 的上下文标签。 */
const questionLabel = computed(() => displayStem.value.slice(0, 300));
/** 是否可以提交：根据题型检查答案或自评是否已填写，且当前未在提交中。 */
const canSubmit = computed(() => {
  if (submitting.value) return false;
  if (isChoice.value) return Boolean(selectedLetter.value);
  if (isBlank.value) return answer.value.trim().length > 0;
  return Boolean(selfRating.value);
});

/**
 * 加载题目详情，组件挂载后调用。
 * 调用 GET /questions/:id，失败时把错误写入 loadError 供错误态展示与重试。
 */
async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    detail.value = await get<QuestionDetail>(`/questions/${id}`);
  } catch (err) {
    loadError.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/**
 * 选中选择题的某个选项，点击选项按钮时触发。
 * @param letter 选项字母
 */
function pickLetter(letter: string) {
  selectedLetter.value = letter;
}

/**
 * 把自评状态值转成中文标签，供结果区展示。
 * @param value 自评状态值
 * @returns 中文标签；未知值原样返回
 */
function ratingLabel(value: string) {
  return { self_pass: '已掌握', self_partial: '部分掌握', self_fail: '未掌握' }[value] ?? value;
}

/**
 * 切换主观题的自评状态，再次点击同一项则取消选择。
 * @param opt 自评状态值
 */
function toggleRating(opt: string) {
  const value = opt as '' | 'self_pass' | 'self_partial' | 'self_fail';
  selfRating.value = selfRating.value === value ? '' : value;
}

/**
 * 提交作答处理器，点击提交按钮时触发。
 * 按题型组装 POST /attempts 请求体（变式题附 variantId 与自评），成功后用 nextTick + scrollIntoView 平滑滚动到结果区。
 */
async function submit() {
  if (!detail.value || !canSubmit.value) return;
  submitting.value = true;
  submitError.value = '';
  result.value = null;
  try {
    const body: Record<string, unknown> = {
      questionId: detail.value.id,
      source: 'practice',
    };
    if (variant.value) {
      body.variantId = variant.value.id;
      body.answer = answer.value;
      body.selfRating = selfRating.value || undefined;
    } else if (isChoice.value) {
      body.answer = selectedLetter.value;
    } else if (isBlank.value) {
      body.answer = answer.value;
    } else {
      body.answer = answer.value;
      body.selfRating = selfRating.value || undefined;
    }
    result.value = await post('/attempts', body);
    await nextTick();
    resultEl.value?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    submitError.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}

/** 重置作答区：清除结果、错误提示与全部输入，供「再做一次」使用。 */
function reset() {
  result.value = null;
  submitError.value = '';
  answer.value = '';
  selectedLetter.value = '';
  selfRating.value = '';
}

/** 返回错题本列表。 */
function back() {
  router.push('/wrongbook');
}

onMounted(load);
</script>

<template>
  <div class="page practice-page">
    <button class="back-link" type="button" @click="back">
      <NavIcon name="arrow-left" :size="15" /> 返回错题本
    </button>

    <LoadingState v-if="loading" text="加载题目…" />
    <ErrorState v-else-if="loadError" :message="loadError" @retry="load" />

    <template v-else-if="detail">
      <header class="practice-head">
        <div>
          <div class="eyebrow">
            {{ isVariant ? '变式练习' : '原题练习' }} · {{ detail.chapter }}
          </div>
          <h1 class="page-title">
            {{ isVariant ? `变式 ${variant?.level}` : detail.title || '错题重做' }}
          </h1>
          <div class="head-meta">
            <span class="tag tag-mono">{{ detail.id }}</span>
            <StatusTag :status="detail.status" />
            <span class="tag">{{ questionType }}</span>
            <span v-for="kp in (variant?.kpCodes ?? detail.kpCodes)" :key="kp" class="tag tag-mono">考点 {{ kp }}</span>
          </div>
        </div>
        <div v-if="variant?.targetTrap" class="trap-note">
          <span class="trap-label">本题埋坑</span>
          <MathText :text="variant.targetTrap" class="trap-text" />
        </div>
      </header>

      <div class="practice-grid">
        <section class="card paper">
          <div class="paper-head">
            <span class="paper-label">题目</span>
            <span class="small muted">{{ isVariant ? '变式题' : '错题原题' }}</span>
          </div>
          <div class="stem">
            <MathText :text="displayStem" />
          </div>

          <div v-if="isChoice" class="choice-grid">
            <button
              v-for="(letter, idx) in letters"
              :key="letter"
              type="button"
              class="choice-option"
              :class="{ selected: selectedLetter === letter }"
              @click="pickLetter(letter)"
            >
              <span class="choice-letter">{{ letter }}</span>
              <span class="choice-text">
                <MathText v-if="displayOptions[idx]" :text="cleanOption(displayOptions[idx])" />
                <span v-else>选项 {{ letter }}</span>
              </span>
            </button>
          </div>

          <div v-else-if="isBlank" class="blank-area">
            <label class="label">填写答案</label>
            <input v-model="answer" class="input answer-input" placeholder="在此输入答案（支持公式）" @keyup.enter="submit" />
            <p class="hint">填空题会在本地做归一化比对；数学等价表达（如 1/2 与 0.5）会判为正确。</p>
          </div>

          <div v-else class="subjective-area">
            <label class="label">我的解答（可选，记录思路用）</label>
            <textarea v-model="answer" class="textarea" rows="5" placeholder="写下你的步骤，交卷后可对照解析复盘…" />
          </div>

          <div class="submit-row">
            <button class="btn btn-primary btn-lg" type="button" :disabled="!canSubmit" @click="submit">
              <span v-if="submitting" class="spinner spinner-light" />
              {{ submitting ? '判分中…' : '提交作答' }}
            </button>
            <button v-if="result" class="btn" type="button" @click="reset">再做一遍</button>
            <span v-if="isChoice && !selectedLetter" class="hint">先选择一个选项</span>
            <span v-if="isSubjective && !selfRating" class="hint">解答题请先自评掌握程度</span>
          </div>

          <div v-if="submitError" class="banner banner-error mt-16">{{ submitError }}</div>
        </section>

        <aside class="side">
          <div v-if="isSubjective || isVariant" class="card side-card">
            <div class="side-title">自评掌握程度</div>
            <p class="small muted">解答题与变式题暂不自动判分，请如实自评，结果会写入作答记录并影响画像。</p>
            <div class="rating-buttons">
              <button
                v-for="opt in ['self_pass', 'self_partial', 'self_fail']"
                :key="opt"
                type="button"
                class="rating-btn"
                :class="[opt.replace('self_', 'rate-'), { active: selfRating === opt }]"
                @click="toggleRating(opt)"
              >
                {{ ratingLabel(opt) }}
              </button>
            </div>
          </div>

          <div v-if="result" ref="resultEl" class="card result-card fade-up" :class="result.correct ? 'ok' : 'bad'">
            <div class="result-top">
              <StatusTag :status="result.verdict" />
              <span class="result-title">{{ result.correct ? '这题拿下了' : '再复盘一下' }}</span>
            </div>
            <div v-if="result.expectedAnswer" class="result-block">
              <div class="result-label">参考答案</div>
              <MathText :text="result.expectedAnswer" />
            </div>
            <div v-if="result.solution" class="result-block">
              <div class="result-label">解析</div>
              <MathText :text="result.solution" />
            </div>
            <div class="result-actions">
              <button class="btn btn-sm btn-primary" type="button" @click="back">返回错题本</button>
              <button class="btn btn-sm" type="button" @click="miniChatRef?.open()">
                <NavIcon name="chat" :size="14" /> 问老师
              </button>
              <button class="btn btn-sm" type="button" @click="reset">再做一遍</button>
            </div>
          </div>

          <div v-else class="card side-card tip-card">
            <div class="side-title">做题提示</div>
            <ul class="tip-list">
              <li>先说出「这题考什么」，再动笔。</li>
              <li>错题价值在于错因：是概念、步骤还是计算？</li>
              <li>交卷后对照解析，把关键一步写进备注。</li>
            </ul>
            <button class="ask-teacher" type="button" @click="miniChatRef?.open()">
              <span class="ask-mark">?</span>
              <span>
                还不理解？
                <small>在右侧小窗直接问老师</small>
              </span>
              <NavIcon name="arrow-right" :size="14" />
            </button>
          </div>
        </aside>
      </div>

      <MiniChat
        ref="miniChatRef"
        :subject="detail.subject"
        :question-id="detail.id"
        :variant-id="variant?.id ?? null"
        :question-label="questionLabel"
        :student-answer="currentAnswer"
      />
    </template>
  </div>
</template>

<style scoped>
.practice-page {
  max-width: 1120px;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12.5px;
  cursor: pointer;
  padding: 0 0 16px;
}
.back-link:hover {
  color: var(--accent);
}

.practice-head {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  margin-bottom: 20px;
}
.head-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.trap-note {
  max-width: 300px;
  padding: 10px 13px;
  border-radius: 10px;
  background: var(--terra-soft);
  border: 1px solid #eed3c5;
  color: #7f4328;
  font-size: 12px;
  line-height: 1.7;
}
.trap-label {
  display: block;
  font-family: var(--serif);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin-bottom: 2px;
}

.practice-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  gap: 18px;
  align-items: start;
}

.paper {
  padding: 26px 30px 24px;
}
.paper-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px dashed var(--line-strong);
  margin-bottom: 20px;
}
.paper-label {
  font-family: var(--serif);
  font-size: 13px;
  letter-spacing: 0.14em;
  color: var(--terra);
}
.stem {
  font-size: 16px;
  line-height: 1.9;
}

.choice-grid {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 22px;
}
.choice-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  text-align: left;
  border: 1px solid var(--line);
  background: var(--panel-soft);
  border-radius: 10px;
  padding: 11px 14px;
  cursor: pointer;
  transition: 0.18s ease;
  font-size: 14px;
  color: var(--ink);
}
.choice-option:hover {
  border-color: var(--line-strong);
  background: #fff;
}
.choice-option.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 2px rgba(30, 107, 87, 0.08);
}
.choice-letter {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: var(--panel);
  font-family: var(--serif);
  font-size: 12px;
}
.choice-option.selected .choice-letter {
  background: var(--accent);
  border-color: var(--accent);
  color: #f4efe4;
}
.choice-text {
  padding-top: 1px;
  min-width: 0;
}

.blank-area,
.subjective-area {
  margin-top: 22px;
}
.answer-input {
  font-size: 15px;
}
.hint {
  font-size: 11.5px;
  color: var(--muted);
  margin: 7px 0 0;
}

.submit-row {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: sticky;
  top: 20px;
}
.side-card {
  padding: 18px;
}
.side-title {
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 7px;
}
.rating-buttons {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 12px;
}
.rating-btn {
  border: 1px solid var(--line-strong);
  background: var(--panel);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: 0.16s ease;
  color: var(--ink-2);
}
.rating-btn:hover {
  border-color: var(--ink-2);
}
.rating-btn.active.rate-pass {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-dark);
  font-weight: 600;
}
.rating-btn.active.rate-partial {
  background: var(--amber-soft);
  border-color: var(--amber);
  color: #7c540e;
  font-weight: 600;
}
.rating-btn.active.rate-fail {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: #7f2c24;
  font-weight: 600;
}

.result-card {
  padding: 18px;
  border-width: 1px;
}
.result-card.ok {
  border-color: #c9e3d9;
  background: linear-gradient(180deg, var(--panel), var(--accent-soft));
}
.result-card.bad {
  border-color: #efd2cd;
  background: linear-gradient(180deg, var(--panel), var(--danger-soft));
}
.result-top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.result-title {
  font-family: var(--serif);
  font-size: 16px;
  font-weight: 700;
}
.result-block {
  border-top: 1px solid var(--line);
  padding-top: 11px;
  margin-top: 11px;
  font-size: 13px;
}
.result-label {
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-bottom: 4px;
}
.result-actions {
  display: flex;
  gap: 8px;
  margin-top: 15px;
  flex-wrap: wrap;
}
.tip-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--ink-2);
  line-height: 1.85;
}
.tip-list li {
  margin-bottom: 3px;
}
.ask-teacher {
  width: 100%;
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 11px;
  border: 1px dashed var(--line-strong);
  border-radius: 9px;
  background: linear-gradient(135deg, var(--panel-soft), var(--accent-soft));
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: 0.18s ease;
}
.ask-teacher:hover {
  border-color: var(--accent);
  box-shadow: 0 4px 14px rgba(30, 107, 87, 0.1);
  transform: translateY(-1px);
}
.ask-teacher small {
  display: block;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--muted);
  margin-top: 1px;
}
.ask-teacher svg {
  margin-left: auto;
  color: var(--accent);
  flex: none;
}
.ask-mark {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--accent);
  color: #f4efe4;
  font-family: var(--serif);
  font-size: 14px;
  font-weight: 700;
}

@media (max-width: 900px) {
  .practice-grid {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
  .practice-head {
    flex-direction: column;
  }
  .paper {
    padding: 20px 20px;
  }
}
</style>
