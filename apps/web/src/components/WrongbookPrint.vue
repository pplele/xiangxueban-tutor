<script setup lang="ts">
/**
 * 错题本密集排版（供打印/另存为 PDF）。
 * 只打印完整题目（选择题/填空题/解答题/证明题等），不含答案与解析——打印出来先自己做，核对在系统里进行。
 * 双栏 + 小字号 + 题间细线，一页多放题。题干与选项完整呈现，不截断。
 * 数据来源：QuestionCard[]（GET /questions，无需逐题请求详情）。
 */
import { computed } from 'vue';
import type { QuestionCard } from '@tutor/shared';
import MathText from '@/components/MathText.vue';
import { cleanOption } from '@/lib/rich';

/** props：items 待打印的完整题目，subjectLabel/scopeLabel 为标题与范围说明 */
const props = defineProps<{
  items: QuestionCard[];
  subjectLabel?: string;
  scopeLabel?: string;
}>();

/** 选项字母序列 */
const LETTERS = 'ABCDEFGH';
/** 打印时间戳（中文格式、24 小时制） */
const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
/** 打印标题：科目标签缺省为「全部科目」 */
const title = computed(() => `错题本 · ${props.subjectLabel || '全部科目'}`);

/** 客观题关键词：命中这些题型的保持密集排版，其余主观题额外留答题空间 */
const OBJECTIVE_KEYWORDS = ['选择题', '填空题', '判断题'];
/**
 * 是否主观题：题型不含任一客观题关键词即视为主观题。
 * @param type 题型文本
 * @returns 是否主观题
 */
function isSubjective(type?: string | null): boolean {
  const t = type || '';
  return !OBJECTIVE_KEYWORDS.some((k) => t.includes(k));
}
/**
 * 主观题书写区行数：证明 10 行、解答/应用/变式 9 行、其余 8 行。
 * @param type 题型文本
 * @returns 书写行数
 */
function answerLines(type?: string | null): number {
  const t = type || '';
  if (t.includes('证明')) return 10;
  if (t.includes('解答') || t.includes('应用') || t.includes('变式')) return 9;
  return 8;
}
/**
 * 书写区前导标签：证明题显示「证明：」，其余主观题显示「解：」。
 * @param type 题型文本
 * @returns 标签文本
 */
function answerLabel(type?: string | null): string {
  return (type || '').includes('证明') ? '证明：' : '解：';
}
</script>

<template>
  <article class="wb-paper">
    <header class="wb-head">
      <h1>{{ title }}</h1>
      <div class="wb-head-meta">
        <span>共 {{ items.length }} 题</span>
        <span v-if="scopeLabel">{{ scopeLabel }}</span>
        <span>打印于 {{ stamp }}</span>
      </div>
    </header>

    <div class="wb-columns">
      <div
        v-for="(q, idx) in items"
        :key="q.id"
        class="wb-item"
        :class="{ 'is-subjective': isSubjective(q.questionType) }"
      >
        <div class="wb-q-head">
          <span class="wb-no">{{ idx + 1 }}.</span>
          <span class="wb-type">{{ q.questionType }}</span>
          <span v-if="q.chapter" class="wb-chapter">{{ q.chapter }}</span>
        </div>
        <div class="wb-stem"><MathText :text="q.textBody" /></div>

        <div v-if="q.options && q.options.length" class="wb-options">
          <span v-for="(opt, oi) in q.options" :key="oi" class="wb-opt">
            <b>{{ LETTERS[oi] }}.</b> <MathText :text="cleanOption(opt)" />
          </span>
        </div>

        <!-- 主观题书写区：只留淡横线，不放答案/解析 -->
        <div v-if="isSubjective(q.questionType)" class="wb-answer-area">
          <span class="wb-answer-label">{{ answerLabel(q.questionType) }}</span>
          <div class="wb-answer-lines" aria-hidden="true">
            <i v-for="n in answerLines(q.questionType)" :key="n" />
          </div>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.wb-paper {
  font-family: var(--sans);
  color: #111;
  font-size: 9pt;
  line-height: 1.5;
}
.wb-head {
  border-bottom: 2px solid #222;
  padding-bottom: 6pt;
  margin-bottom: 10pt;
}
.wb-head h1 {
  font-family: var(--serif);
  font-size: 15pt;
  margin: 0 0 3pt;
}
.wb-head-meta {
  display: flex;
  gap: 14pt;
  font-size: 8.5pt;
  color: #555;
}
/* 双栏密集排版 */
.wb-columns {
  column-count: 2;
  column-gap: 12pt;
}
.wb-item {
  break-inside: avoid;
  page-break-inside: avoid;
  padding: 6pt 0;
  border-bottom: 1px dotted #bbb;
}
.wb-item.is-subjective {
  padding-bottom: 8pt;
}
.wb-q-head {
  display: flex;
  align-items: center;
  gap: 6pt;
  margin-bottom: 3pt;
}
.wb-no {
  font-weight: 700;
}
.wb-type,
.wb-chapter {
  font-size: 7.5pt;
  color: #555;
  border: 1px solid #ccc;
  border-radius: 3pt;
  padding: 0 4pt;
}
.wb-chapter {
  border-color: transparent;
  color: #777;
  padding-left: 0;
}
.wb-stem :deep(.rich),
.wb-opt :deep(.rich) {
  font-family: var(--sans);
  font-size: 9pt;
  line-height: 1.5;
}
.wb-stem :deep(.rich p) {
  margin: 0;
}
.wb-options {
  margin: 3pt 0 0 12pt;
  display: flex;
  flex-wrap: wrap;
  gap: 2pt 12pt;
}
.wb-opt {
  display: inline-flex;
  gap: 2pt;
  align-items: baseline;
}
.wb-opt b {
  font-weight: 600;
}
/* 解答/证明题书写区：淡横线便于写过程，仍保持无答案 */
.wb-answer-area {
  margin-top: 5pt;
}
.wb-answer-label {
  display: block;
  margin-bottom: 1pt;
  font-size: 8.5pt;
  color: #333;
}
.wb-answer-lines i {
  display: block;
  height: 17pt;
  border-bottom: 1px solid #d8d8d8;
}
@media print {
  .wb-columns {
    column-gap: 10pt;
  }
}
</style>
