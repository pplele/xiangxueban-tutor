// 复习单词：分块结构（教材单词 10 单元 / 题目单词 词法 8 类，句法暂未开放）

/** 复习单词的两大区域 */
export type ReviewArea = 'textbook' | 'question';

/** 题目单词下的分部：词法（已开放）/ 句法（还没学到，占位） */
export type ReviewPart = 'unit' | 'morphology' | 'syntax';

/** 一个小块（一组词），key 直接作为数据库 group_key */
export interface ReviewGroup {
  key: string;
  label: string;
  area: ReviewArea;
  part: ReviewPart;
  /** 句法部分暂未开放，界面显示占位不可导入 */
  disabled?: boolean;
}

/** 教材单词：10 个单元 */
export const TEXTBOOK_UNITS: ReviewGroup[] = Array.from({ length: 10 }, (_, i) => ({
  key: `textbook:unit${i + 1}`,
  label: `Unit ${i + 1}`,
  area: 'textbook' as const,
  part: 'unit' as const,
}));

/** 题目单词 · 词法：8 个分类 */
export const MORPHOLOGY_GROUPS: ReviewGroup[] = [
  { key: 'question:noun', label: '名词', area: 'question', part: 'morphology' },
  { key: 'question:pronoun', label: '代词', area: 'question', part: 'morphology' },
  { key: 'question:verb', label: '动词', area: 'question', part: 'morphology' },
  { key: 'question:modal', label: '情态动词', area: 'question', part: 'morphology' },
  { key: 'question:adjadv', label: '形容词和副词', area: 'question', part: 'morphology' },
  { key: 'question:conjprep', label: '连词和介词', area: 'question', part: 'morphology' },
  { key: 'question:numart', label: '数词和冠词', area: 'question', part: 'morphology' },
  { key: 'question:other', label: '其他', area: 'question', part: 'morphology' },
];

/** 题目单词 · 句法：还没学到，先占位 */
export const SYNTAX_GROUPS: ReviewGroup[] = [
  { key: 'question:syntax', label: '句法', area: 'question', part: 'syntax', disabled: true },
];

/** 全部小块，用于后端校验 group_key 合法性 */
export const REVIEW_GROUPS: ReviewGroup[] = [
  ...TEXTBOOK_UNITS,
  ...MORPHOLOGY_GROUPS,
  ...SYNTAX_GROUPS,
];

/** 合法 group_key 集合 */
export const REVIEW_GROUP_KEYS: string[] = REVIEW_GROUPS.map((g) => g.key);

/** 单词掌握状态：灰（未选/新词）/ 绿（熟悉）/ 黄（模糊）/ 红（遗忘） */
export type ReviewStatus = 'gray' | 'green' | 'yellow' | 'red';
export const REVIEW_STATUSES: ReviewStatus[] = ['gray', 'green', 'yellow', 'red'];
