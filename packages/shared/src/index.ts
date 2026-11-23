// 前后端共享类型与常量

export * from './tex';

/** 科目代码联合类型：数学 / 英语 / 计算机 */
export type SubjectCode = 'math' | 'english' | 'cs';

/** 科目基础信息 */
export interface SubjectInfo {
  code: SubjectCode;
  name: string;
  shortName: string;
}

/** 全部科目元数据列表 */
export const SUBJECTS: SubjectInfo[] = [
  { code: 'math', name: '高等数学', shortName: '数学' },
  { code: 'english', name: '大学英语', shortName: '英语' },
  { code: 'cs', name: '计算机基础', shortName: '计算机' },
];

/** 科目代码到全称的映射 */
export const SUBJECT_NAME: Record<string, string> = Object.fromEntries(
  SUBJECTS.map((s) => [s.code, s.name]),
);

/** 题目类型常量表 */
export const QUESTION_TYPES = ['选择题', '填空题', '计算题', '证明题', '应用题'] as const;
/** 由 QUESTION_TYPES 派生的题目类型联合类型 */
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** 章节信息：名称、知识点数与可选题目数 */
export interface ChapterInfo {
  name: string;
  kpCount: number;
  questionCount?: number;
}

/** 科目信息 + 其下的章节列表 */
export interface SubjectWithChapters extends SubjectInfo {
  chapters: ChapterInfo[];
}

/** 知识点条目：编码、名称、可选等级与所属章节 */
export interface KpItem {
  code: string;
  name: string;
  level?: string;
  chapter?: string;
}

/** 题目卡片：题干、选项、答案、解析、考点与溯源等完整题目数据 */
export interface QuestionCard {
  id: string;
  subject: string;
  chapter: string;
  kpCodes: string[];
  kpLevels?: string[];
  questionType: string;
  title?: string;
  textBody: string;
  options?: string[] | null;
  answer?: string | null;
  solution?: string | null;
  note?: string | null;
  tags?: string[];
  fingerprint: string;
  status: string;
  source: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt?: string;
  variantCount?: number;
  attemptCount?: number;
}

/** 变式题：基于某道母题生成的同考点新题 */
export interface VariantItem {
  id: number;
  questionId: string;
  setId: string;
  level: 'L1' | 'L2' | 'L5' | string;
  stem: string;
  answer: string;
  solution: string;
  kpCodes: string[];
  targetTrap?: string | null;
  createdAt: string;
}

/** 一次作答记录：题目、变式、答案、判定与来源时间 */
export interface AttemptItem {
  id: number;
  questionId: string;
  variantId?: number | null;
  subject: string;
  answer?: string | null;
  verdict?: string | null;
  source: string;
  at: string;
}

/** 题目详情：卡片 + 变式列表、变式集与作答历史 */
export interface QuestionDetail extends QuestionCard {
  variants: VariantItem[];
  variantSets: { setId: string; createdAt: string; items: VariantItem[] }[];
  attempts: AttemptItem[];
}

/** 回答引用片段：出处、内容、相关度与关联章节/考点 */
export interface Citation {
  sourceName: string;
  content: string;
  score?: number;
  kpCodes?: string[];
  chapter?: string | null;
}

/** 聊天消息 DTO：角色（用户/助手/工具）、内容与引用 */
export interface ChatMessageDto {
  id?: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  citations?: Citation[] | null;
  createdAt?: string;
}

/** 聊天会话 DTO：会话 id、科目、标题与时间戳 */
export interface ChatSessionDto {
  id: string;
  subject: string;
  title?: string | null;
  createdAt: string;
  updatedAt?: string;
}

/** 考试事件：一次考试的科目、分数、满分与失分知识点 */
export interface ExamEvent {
  id: string;
  date: string;
  subject: string;
  title?: string;
  score: number;
  maxScore: number;
  lostKps: string[];
}

/** AI 学情评语：优势、薄弱点、建议与生成时间 */
export interface TeacherNarrative {
  strengths: string[];
  weaknesses: string[];
  advice: string;
  generatedAt: string;
}

/** 学习画像：学生标签、考试事件与各科学情评语 */
export interface UserProfile {
  labels: {
    base_level?: string;
    target?: string;
    weak_kp?: string[];
    target_score?: number;
    self_level?: 'weak' | 'medium' | 'strong';
    [key: string]: unknown;
  };
  examEvents: ExamEvent[];
  narratives: Record<string, TeacherNarrative>;
  updatedAt?: string;
}

/** 试卷大题配置：键、名称、题型、题数与分值（可统一或按题） */
export interface ExamSection {
  key: string;
  name: string;
  type: string;
  count: number;
  points: number | number[];
}

/** 试卷模块：覆盖章节及各题型题数与分值 */
export interface ExamModule {
  name: string;
  chapters: string[];
  choice: number;
  blank: number;
  solve: number;
  score: number;
}

/** 组卷蓝图：元信息、大题配置、模块范围与判分规则 */
export interface ExamBlueprint {
  meta: { title: string; total_score: number; minutes: number; question_count: number; [k: string]: unknown };
  sections: ExamSection[];
  modules: ExamModule[];
  grading?: Record<string, string>;
}

/** 试卷中的一道题：题号、分值、题干选项、考点、答案与判分结果 */
export interface ExamPaperItem {
  no: number;
  sectionKey: string;
  sectionName: string;
  module: string;
  questionId: string;
  points: number;
  questionType: string;
  stem: string;
  options?: string[] | null;
  kpCodes: string[];
  answer?: string | null;
  solution?: string | null;
  userAnswer?: string | null;
  verdict?: string | null;
  earned?: number;
  reason?: string | null;
  /** AI 评卷给的针对性建议（解答题） */
  suggestion?: string | null;
  /** 该题取自变式时的变式 id（答题记录会带上，用于统计变式掌握度） */
  variantId?: number | null;
}

/** 答题卡照片（手机 / 网页上传，落盘 data/exam-uploads） */
export interface ExamPaperUpload {
  id: string;
  section: 'blank' | 'solve';
  questionNo: number;
  questionId: string | null;
  file: string;
  ocrText: string;
  createdAt: string;
}

/** 考试模式：mock=模拟考（全考纲）/ chapter=章节考（指定章节） */
export type ExamMode = 'mock' | 'chapter';

export interface ExamPaper {
  id: string;
  subject: string;
  title: string;
  /** 'mock'=模拟考试（全考纲）；'chapter'=章节考试（所选章节小范围） */
  mode: ExamMode;
  /** 第几套（同科目同模式独立编号） */
  paperNo: number | null;
  durationMin: number;
  maxScore: number;
  totalScore?: number | null;
  createdAt: string;
  submittedAt?: string | null;
  items: ExamPaperItem[];
  /** 截止时刻（ISO）：createdAt + durationMin，到点未交强制判分 */
  deadline?: string;
  /** 自动保存的作答 { [questionId]: { answer?, selfRating? } }（未交卷才返回） */
  answers?: Record<string, { answer?: string; selfRating?: string | null }>;
  /** 答题卡照片列表（未交卷返回全部；交卷后结果页也返回，供回看） */
  uploads?: ExamPaperUpload[];
}

/** 历史列表条目：只带列表所需字段，避免整卷题目随列表传输 */
export interface ExamPaperSummary {
  id: string;
  subject: string;
  title: string;
  mode: ExamMode;
  paperNo: number | null;
  maxScore: number;
  totalScore?: number | null;
  createdAt: string;
  submittedAt?: string | null;
  /** 仅用于列表判断有无答题卡照片 */
  uploads?: ExamPaperUpload[];
}

/** 变式生成任务：题目、状态、尝试次数与时间戳 */
export interface VariantJobDto {
  id: number;
  questionId: string;
  subject?: string;
  chapter?: string;
  stem?: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  error?: string | null;
  attempts: number;
  createdAt: string;
  finishedAt?: string | null;
}

/** 变式生成进度：各状态计数与任务列表 */
export interface VariantProgress {
  counts: { queued: number; running: number; done: number; failed: number };
  jobs: VariantJobDto[];
}

/** 单项评估指标：命中率、引用率、平均质量、越界率与延迟 */
export interface EvalMetric {
  config: string;
  hitRate: number;
  citationRate: number;
  avgQuality: number;
  outOfScopeRate: number;
  avgLatencyMs: number;
  count: number;
  errors?: number;
}

/** 评估结果：样本总数、各配置指标与消融实验明细 */
export interface EvalResult {
  total: number;
  limit: number;
  ablations: string[];
  metrics: EvalMetric[];
  generatedAt: string;
  details?: unknown[];
}

/** 后端错误响应体：error 对象含 code、message 与可选 details */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, string> };
}

/** 判题结果：正确/错误，或自评的掌握/部分掌握/未掌握 */
export type Verdict = 'correct' | 'wrong' | 'self_pass' | 'self_partial' | 'self_fail';

/** 判题结果到中文标签的映射 */
export const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  wrong: '错误',
  self_pass: '自评：已掌握',
  self_partial: '自评：部分掌握',
  self_fail: '自评：未掌握',
};

/** 错题状态到标签色（amber/blue/green）的映射 */
export const STATUS_COLORS: Record<string, string> = {
  待变式: 'amber',
  待复习: 'blue',
  已生成变式: 'green',
};
