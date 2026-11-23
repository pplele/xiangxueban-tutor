<script setup lang="ts">
/**
 * 湖南专升本试卷排版（供打印/另存为 PDF）。
 * 数学：标题 + 考生注意事项 + 选择/填空/解答 + 题号分值 + 解答题留白。
 * 英语：同一套版式，但考生须知与大题说明换成选择题 + 翻译题口径。
 * 只放题目与选项，不放答案——用于模考打印；如需答案解析版可传 showAnswer。
 */
import { computed } from 'vue';
import type { ExamPaper, ExamPaperItem } from '@tutor/shared';
import MathText from '@/components/MathText.vue';
import { cleanOption } from '@/lib/rich';

/** props：paper 为试卷数据，showAnswer 是否附带答案与解析（默认否，用于模考打印） */
const props = withDefaults(
  defineProps<{ paper: ExamPaper; showAnswer?: boolean }>(),
  { showAnswer: false },
);

/** 选项字母序列，按索引取 A/B/C… */
const LETTERS = 'ABCDEFGH';

/** 按大题名称分组并按题号排序，得到 [{ name, key, items }] */
const sections = computed(() => {
  const map = new Map<string, ExamPaperItem[]>();
  for (const it of props.paper.items) {
    if (!map.has(it.sectionName)) map.set(it.sectionName, []);
    map.get(it.sectionName)!.push(it);
  }
  return [...map.entries()].map(([name, items]) => ({
    name,
    key: items[0]?.sectionKey ?? '',
    items: [...items].sort((a, b) => a.no - b.no),
  }));
});

/** 求某大题的总分（各题 points 之和） */
const sectionScore = (items: ExamPaperItem[]) => items.reduce((s, it) => s + (it.points || 0), 0);

/** 当前是否为英语卷（决定考生须知与翻译题说明的措辞） */
const isEnglish = computed(() => props.paper.subject === 'english');

/**
 * 按大题类型生成「本大题共 N 小题…」的考生须知文案。
 * @param sec 大题（含类型 key 与题目列表）
 * @returns 须知文案
 */
function instruction(sec: { key: string; items: ExamPaperItem[] }): string {
  const n = sec.items.length;
  const pts = sec.items.map((it) => it.points);
  const uniform = pts.every((p) => p === pts[0]);
  if (sec.key === 'choice') {
    return `本大题共 ${n} 小题，每小题 ${pts[0]} 分，共 ${sectionScore(sec.items)} 分。在每小题给出的四个选项中，只有一项是符合题目要求的。`;
  }
  if (sec.key === 'blank') {
    return `本大题共 ${n} 小题，每小题 ${pts[0]} 分，共 ${sectionScore(sec.items)} 分。请把答案填在题中横线上。`;
  }
  const ptsText = uniform ? `每小题 ${pts[0]} 分` : `分值分别为 ${pts.join('、')} 分`;
  if (isEnglish.value) {
    return `本大题共 ${n} 小题，共 ${sectionScore(sec.items)} 分（${ptsText}）。请把完整译文写在答题卡指定区域内，意思准确、语法正确即可。`;
  }
  return `本大题共 ${n} 小题，共 ${sectionScore(sec.items)} 分（${ptsText}）。解答应写出必要的文字说明、证明过程或演算步骤。`;
}

/** 是否解答/证明题大题 */
const isSolve = (sec: { key: string }) => sec.key === 'solve';
/** 解答题答题留白行数：证明题 10 行、其余 8 行 */
const solveLines = (it: ExamPaperItem) => ((it.questionType || '').includes('证明') ? 10 : 8);
/** 试卷标题：若 paperNo 未体现在 title 中则补「（第 N 套）」 */
const paperTitle = computed(() => {
  const base = props.paper.title || `湖南专升本${isEnglish.value ? '大学英语' : '高等数学'}模拟卷`;
  // paper.title 通常已含「第 N 套」，避免重复拼接
  const alreadyNumbered = props.paper.paperNo && base.includes(`第 ${props.paper.paperNo} 套`);
  return props.paper.paperNo && !alreadyNumbered ? `${base}（第 ${props.paper.paperNo} 套）` : base;
});
</script>

<template>
  <article class="exam-paper">
    <header class="ep-head">
      <h1>{{ paperTitle }}</h1>
      <p class="ep-sub">（满分 {{ paper.maxScore }} 分　考试时间 {{ paper.durationMin }} 分钟）</p>
    </header>

    <section class="ep-notice">
      <h2>考生注意事项</h2>
      <ol>
        <li>答题前，考生务必将自己的姓名、准考证号填写在试卷和答题卡指定位置上。</li>
        <li>选择题每小题选出答案后，用 2B 铅笔把答题卡上对应题目的答案标号涂黑；如需改动，用橡皮擦干净后，再选涂其他答案标号。</li>
        <li v-if="isEnglish">翻译题请把完整译文写在答题卡指定区域内，写在本试卷上无效；意思准确、语法正确即可，措辞不必与参考答案完全一致。</li>
        <li v-else>填空题和解答题的答案必须写在答题卡指定区域内，写在本试卷上无效。</li>
        <li>考试结束后，将本试卷和答题卡一并交回。</li>
      </ol>
    </section>

    <section v-for="sec in sections" :key="sec.key" class="ep-section" :class="{ 'ep-solve': isSolve(sec) }">
      <h2 class="ep-sec-title">{{ sec.name }}</h2>
      <p class="ep-instruction">{{ instruction(sec) }}</p>

      <div v-for="it in sec.items" :key="it.no" class="ep-question" :class="{ 'no-break': !isSolve(sec) }">
        <div class="ep-q-head">
          <span class="ep-q-no">{{ it.no }}.</span>
          <span class="ep-q-points">（{{ it.points }} 分）</span>
        </div>
        <div class="ep-stem"><MathText :text="it.stem" /></div>

        <div v-if="it.options && it.options.length" class="ep-options">
          <div v-for="(opt, idx) in it.options" :key="idx" class="ep-option">
            <span class="ep-letter">{{ LETTERS[idx] }}.</span>
            <span><MathText :text="cleanOption(opt)" /></span>
          </div>
        </div>

        <!-- 填空题横线 -->
        <div v-if="sec.key === 'blank'" class="ep-blank-line" />

        <!-- 解答/证明题答题留白（证明题多留两行） -->
        <div v-if="isSolve(sec)" class="ep-answer-space" aria-hidden="true">
          <i v-for="n in solveLines(it)" :key="n" />
        </div>

        <div v-if="showAnswer && (it.answer || it.solution)" class="ep-answer">
          <div v-if="it.answer"><b>答案：</b><MathText :text="it.answer" /></div>
          <div v-if="it.solution"><b>解析：</b><MathText :text="it.solution" /></div>
        </div>
      </div>
    </section>
  </article>
</template>

<style scoped>
.exam-paper {
  font-family: var(--sans);
  color: #000;
  font-size: 11pt;
  line-height: 1.7;
}
.ep-head {
  text-align: center;
  margin-bottom: 16pt;
  padding-bottom: 12pt;
  border-bottom: 1px solid #999;
}
.ep-head h1 {
  font-family: var(--serif);
  font-size: 20pt;
  font-weight: 700;
  letter-spacing: 2px;
  margin: 0 0 6pt;
}
.ep-sub {
  margin: 0;
  font-size: 12pt;
}
.ep-notice {
  border: 1px solid #666;
  padding: 10pt 14pt;
  margin-bottom: 18pt;
  font-size: 10pt;
  line-height: 1.6;
}
.ep-notice h2 {
  font-size: 11pt;
  margin: 0 0 5pt;
}
.ep-notice ol {
  margin: 0;
  padding-left: 18pt;
}
.ep-notice li {
  margin: 2pt 0;
}
.ep-section {
  margin-bottom: 8pt;
}
.ep-sec-title {
  font-family: var(--serif);
  font-size: 13pt;
  font-weight: 700;
  margin: 14pt 0 4pt;
}
.ep-instruction {
  font-size: 10.5pt;
  margin: 0 0 8pt;
}
.ep-question {
  margin-bottom: 9pt;
}
.ep-question.no-break {
  break-inside: avoid;
  page-break-inside: avoid;
}
.ep-q-head {
  display: flex;
  gap: 6pt;
  align-items: baseline;
}
.ep-q-no {
  font-weight: 700;
}
.ep-q-points {
  color: #444;
  font-size: 10pt;
}
.ep-stem {
  margin: 2pt 0;
}
.ep-stem :deep(.rich),
.ep-option :deep(.rich),
.ep-answer :deep(.rich) {
  font-family: var(--sans);
  font-size: 11pt;
  line-height: 1.6;
}
.ep-options {
  margin: 3pt 0 3pt 14pt;
}
.ep-option {
  display: flex;
  gap: 4pt;
  align-items: baseline;
  margin: 1pt 0;
}
.ep-letter {
  font-weight: 600;
  min-width: 14pt;
}
.ep-blank-line {
  border-bottom: 1px solid #333;
  height: 16pt;
  margin: 4pt 0 0 14pt;
  max-width: 60%;
}
.ep-answer-space {
  margin: 6pt 0 0;
}
.ep-answer-space i {
  display: block;
  height: 20pt;
  border-bottom: 1px solid #e0e0e0;
}
.ep-solve .ep-question {
  break-inside: avoid;
  page-break-inside: avoid;
}
.ep-answer {
  margin-top: 5pt;
  padding: 5pt 8pt;
  background: #f6f6f6;
  border-left: 3px solid #888;
  font-size: 10pt;
}
.ep-answer > div {
  margin: 2pt 0;
}
@media print {
  .ep-answer-space i {
    height: 19pt;
  }
}
</style>
