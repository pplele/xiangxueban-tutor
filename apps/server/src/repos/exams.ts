import { many, one, query } from '../db/pool';
import type { ExamPaperItem } from '@tutor/shared';

export interface ExamRow {
  id: string;
  subject: string;
  title: string | null;
  /** 'mock'=模拟考试；'chapter'=章节考试 */
  mode: 'mock' | 'chapter';
  /** 第几套（同科目同模式独立编号） */
  paper_no: number | null;
  blueprint: unknown;
  items: ExamPaperItem[];
  total_score: string | number | null;
  max_score: string | number | null;
  duration_min: number;
  submitted_at: Date | null;
  created_at: Date;
  /** 自动保存的作答 { [questionId]: { answer?, selfRating? } } */
  answers: Record<string, { answer?: string; selfRating?: string | null }>;
  /** 手机/网页拍照上传 [{ id, section, questionNo, questionId, file, ocrText, createdAt }] */
  uploads: ExamUpload[];
}

export interface ExamUpload {
  id: string;
  section: 'blank' | 'solve';
  questionNo: number;
  questionId: string | null;
  /** data/exam-uploads/<examId>/<id>.jpg 的文件名 */
  file: string;
  /** 视觉模型识别出的文本（填空=各题答案；解答=学生手写过程转录） */
  ocrText: string;
  createdAt: string;
}

/**
 * 自动保存整张试卷作答到 exams.answers 列（整列覆盖，服务层先读后合并）。
 * @param id 试卷 id
 * @param answers 作答映射 { [questionId]: { answer?, selfRating? } }
 */
export async function saveAnswers(
  id: string,
  answers: Record<string, { answer?: string; selfRating?: string | null }>,
): Promise<void> {
  await query(`UPDATE exams SET answers = $2::jsonb WHERE id = $1`, [id, JSON.stringify(answers)]);
}

/**
 * 覆盖保存试卷的拍照上传记录到 exams.uploads 列（整列覆盖）。
 * @param id 试卷 id
 * @param uploads 上传记录数组
 */
export async function saveUploads(id: string, uploads: ExamUpload[]): Promise<void> {
  await query(`UPDATE exams SET uploads = $2::jsonb WHERE id = $1`, [id, JSON.stringify(uploads)]);
}

/**
 * 向 exams 表插入一张新试卷，blueprint/items 以 jsonb 存储。
 * @param input 试卷信息（科目、标题、模式、套号、蓝图、题目、满分、时长）
 * @returns 插入后的试卷行
 */
export async function insertExam(input: {
  subject: string;
  title: string;
  mode: 'mock' | 'chapter';
  paperNo: number;
  blueprint: unknown;
  items: ExamPaperItem[];
  maxScore: number;
  durationMin: number;
}): Promise<ExamRow> {
  const row = await one<ExamRow>(
    `INSERT INTO exams (subject, title, mode, paper_no, blueprint, items, max_score, duration_min)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,
    [input.subject, input.title, input.mode, input.paperNo, JSON.stringify(input.blueprint), JSON.stringify(input.items), input.maxScore, input.durationMin],
  );
  return row!;
}

/**
 * 统计 exams 表某科目某模式已出的套数（新卷编号 = 返回值 + 1）。
 * @param subject 科目
 * @param mode 考试模式：mock 模拟考 / chapter 章节考
 * @returns 已出套数
 */
export async function countExamsByMode(subject: string, mode: 'mock' | 'chapter'): Promise<number> {
  const row = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM exams WHERE subject = $1 AND mode = $2`,
    [subject, mode],
  );
  return Number(row?.count ?? 0);
}

/**
 * 从 exams 表按 id 读取一张完整试卷（含题目、作答、上传记录）。
 * @param id 试卷 id
 * @returns 试卷行，不存在返回 null
 */
export async function getExam(id: string): Promise<ExamRow | null> {
  return one<ExamRow>(`SELECT * FROM exams WHERE id = $1`, [id]);
}

/**
 * 提交试卷：更新 exams.items、total_score 并写入交卷时间 submitted_at（副作用）。
 * @param id 试卷 id
 * @param items 最终题目与作答
 * @param totalScore 总分
 * @returns 更新后的试卷行，不存在返回 null
 */
export async function saveSubmission(
  id: string,
  items: ExamPaperItem[],
  totalScore: number,
): Promise<ExamRow | null> {
  const row = await one<ExamRow>(
    `UPDATE exams SET items = $2::jsonb, total_score = $3, submitted_at = now() WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(items), totalScore],
  );
  return row;
}

/** 历史列表轻量行：不读 items/blueprint/answers，避免列表接口把整卷题目都传出去 */
export interface ExamSummaryRow {
  id: string;
  subject: string;
  title: string | null;
  mode: 'mock' | 'chapter';
  paper_no: number | null;
  total_score: string | number | null;
  max_score: string | number | null;
  submitted_at: Date | null;
  created_at: Date;
  uploads: ExamUpload[];
}

/**
 * 从 exams 表读取历史试卷轻量列表（不读 items/blueprint/answers），按创建时间倒序。
 * @param limit 最多返回条数，默认 200
 * @returns 试卷摘要列表
 */
export async function listExams(limit = 200): Promise<ExamSummaryRow[]> {
  return many<ExamSummaryRow>(
    `SELECT id, subject, title, mode, paper_no, total_score, max_score,
            submitted_at, created_at, uploads
       FROM exams ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

/**
 * 统计 exams 表试卷总数。
 * @returns 试卷数量
 */
export async function countExams(): Promise<number> {
  const row = await one<{ count: string }>(`SELECT count(*)::text AS count FROM exams`);
  return Number(row?.count ?? 0);
}

/**
 * 从 exams 表删除指定试卷。
 * @param id 试卷 id
 */
export async function deleteExam(id: string): Promise<void> {
  await query(`DELETE FROM exams WHERE id = $1`, [id]);
}

/**
 * 出题池统计：分别统计 questions 与 variants 表中本科目题目的总数与未考过（exam_used_at IS NULL）数量。
 * @param subject 科目
 * @returns 原题与变式各自的总量、未考量
 */
export async function poolStats(subject: string): Promise<{
  questions: { total: number; unused: number };
  variants: { total: number; unused: number };
}> {
  const q = await one<{ total: string; unused: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE exam_used_at IS NULL)::text AS unused
       FROM questions WHERE subject = $1`,
    [subject],
  );
  const v = await one<{ total: string; unused: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE exam_used_at IS NULL)::text AS unused
       FROM variants WHERE question_id IN (SELECT id FROM questions WHERE subject = $1)`,
    [subject],
  );
  return {
    questions: { total: Number(q?.total ?? 0), unused: Number(q?.unused ?? 0) },
    variants: { total: Number(v?.total ?? 0), unused: Number(v?.unused ?? 0) },
  };
}
