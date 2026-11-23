import { pool } from '../db/pool';

/**
 * 英语错题精华的章节顺序：与 data/kb/english 下《库课·大学英语》笔记目录一致。
 * 与 apps/server/migrations/0011 写入 kp_whitelist 的 chapter 名保持同步，改章节名要一起改。
 */
const ENGLISH_CHAPTER_ORDER = [
  '第一章 词法',
  '第二章 句法上',
  '第二章 句法下',
  '第三章 词汇和语法',
  '第四章 完形填空',
  '第五章 阅读理解',
  '第六章 翻译',
  '第七章 写作上（应用文）',
  '第七章 写作下（提纲·图画·图表）',
];

/** 学习笔记（与 questions.note 题目错因备注完全独立） */
export interface StudyNote {
  id: string;
  username: string;
  subject: 'math' | 'english';
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** study_notes 表原始行结构（tags 可为 null，时间为 Date 或字符串） */
interface NoteRow {
  id: string;
  username: string;
  subject: string;
  title: string;
  body: string;
  tags: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * 将 study_notes 表原始行映射为前端 StudyNote（tags 兜底空数组、时间转 ISO 字符串）。
 * @param row study_notes 表查询结果行
 * @returns 前端学习笔记
 */
function toNote(row: NoteRow): StudyNote {
  return {
    id: row.id,
    username: row.username,
    subject: row.subject as StudyNote['subject'],
    title: row.title,
    body: row.body,
    tags: row.tags ?? [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** 笔记列表筛选条件：按科目、关键词过滤 */
export interface ListNotesParams {
  subject?: StudyNote['subject'];
  q?: string;
}

/**
 * 从 study_notes 表按用户名读取笔记列表，按更新时间倒序；q 同时匹配标题、正文、标签，最多 500 条。
 * @param username 用户名
 * @param params 可选筛选条件（科目、关键词）
 * @returns 学习笔记列表
 */
export async function listNotes(username: string, params: ListNotesParams = {}): Promise<StudyNote[]> {
  const clauses: string[] = ['username = $1'];
  const values: unknown[] = [username];

  if (params.subject) {
    values.push(params.subject);
    clauses.push(`subject = $${values.length}`);
  }
  if (params.q) {
    const like = `%${params.q}%`;
    values.push(like);
    const i = values.length;
    clauses.push(`(title ILIKE $${i} OR body ILIKE $${i} OR array_to_string(tags, ',') ILIKE $${i})`);
  }

  const { rows } = await pool.query<NoteRow>(
    `SELECT * FROM study_notes
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT 500`,
    values,
  );
  return rows.map(toNote);
}

/**
 * 从 study_notes 表按 id + 用户名读取单条笔记（带用户名防止越权访问）。
 * @param id 笔记 id
 * @param username 用户名
 * @returns 学习笔记，不存在返回 null
 */
export async function getNote(id: string, username: string): Promise<StudyNote | null> {
  const { rows } = await pool.query<NoteRow>(
    `SELECT * FROM study_notes WHERE id = $1 AND username = $2`,
    [id, username],
  );
  return rows[0] ? toNote(rows[0]) : null;
}

/** 新建笔记的输入字段 */
export interface NoteInput {
  subject: StudyNote['subject'];
  title: string;
  body: string;
  tags: string[];
}

/**
 * 向 study_notes 表插入一条新笔记。
 * @param username 用户名
 * @param input 笔记内容（科目、标题、正文、标签）
 * @returns 新建的学习笔记
 */
export async function createNote(username: string, input: NoteInput): Promise<StudyNote> {
  const { rows } = await pool.query<NoteRow>(
    `INSERT INTO study_notes (username, subject, title, body, tags)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [username, input.subject, input.title, input.body, input.tags],
  );
  return toNote(rows[0]);
}

/** 笔记局部更新字段（只更新传入的字段） */
export interface NotePatch {
  title?: string;
  body?: string;
  tags?: string[];
}

/**
 * 局部更新 study_notes 表笔记：用 COALESCE 只覆盖传入字段，并刷新 updated_at。
 * @param id 笔记 id
 * @param username 用户名（越权校验）
 * @param patch 待更新字段
 * @returns 更新后的笔记，不存在返回 null
 */
export async function updateNote(id: string, username: string, patch: NotePatch): Promise<StudyNote | null> {
  const { rows } = await pool.query<NoteRow>(
    `UPDATE study_notes
        SET title = COALESCE($3, title),
            body  = COALESCE($4, body),
            tags  = COALESCE($5, tags),
            updated_at = now()
      WHERE id = $1 AND username = $2
      RETURNING *`,
    [id, username, patch.title ?? null, patch.body ?? null, patch.tags ?? null],
  );
  return rows[0] ? toNote(rows[0]) : null;
}

/**
 * 从 study_notes 表删除指定用户的笔记。
 * @param id 笔记 id
 * @param username 用户名（越权校验）
 * @returns 是否删除成功
 */
export async function deleteNote(id: string, username: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM study_notes WHERE id = $1 AND username = $2`,
    [id, username],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 从 study_notes 表统计某用户各科目笔记数量（用于导航角标 / 概览）。
 * @param username 用户名
 * @returns 各科目笔记数（math/english）
 */
export async function countBySubject(username: string): Promise<Record<StudyNote['subject'], number>> {
  const { rows } = await pool.query<{ subject: string; count: string }>(
    `SELECT subject, count(*)::text AS count FROM study_notes WHERE username = $1 GROUP BY subject`,
    [username],
  );
  const result: Record<StudyNote['subject'], number> = { math: 0, english: 0 };
  for (const row of rows) {
    if (row.subject === 'math' || row.subject === 'english') result[row.subject] = Number(row.count);
  }
  return result;
}

// ============ 错题备注精华（只读汇总，来源是 questions.note，不含题干） ============

/** 错题备注精华条目：只含错因文本，不含题干 */
export interface DigestItem {
  questionId: string;
  chapter: string;
  kpCodes: string[];
  note: string;
  questionType: string;
  updatedAt: string;
}

/** 按章节分组的错题备注 */
export interface DigestGroup {
  chapter: string;
  items: DigestItem[];
}

/** questions 表错题备注查询的原始行 */
interface DigestRow {
  id: string;
  chapter: string;
  kp_codes: string[] | null;
  note: string;
  question_type: string;
  updated_at: Date | string;
}

/**
 * 从考点编码中抽取数字序列用于自然排序；无数字时返回 MAX_SAFE_INTEGER 排末尾。
 * @param code 考点编码
 * @returns 数字序列
 */
function naturalKey(code: string): number[] {
  const nums = code.match(/\d+/g);
  return nums ? nums.map(Number) : [Number.MAX_SAFE_INTEGER];
}

/**
 * 比较两个考点编码的自然顺序：先逐段比数字（1.x < 2.x < 10.x），相同则按中文文本比较。
 * @param a 考点编码 a
 * @param b 考点编码 b
 * @returns 负数 a 在前，正数 b 在前，0 相等
 */
function compareNatural(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const va = ka[i] ?? 0;
    const vb = kb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return a.localeCompare(b, 'zh-CN');
}

/**
 * 取某科目所有「有备注」的错题（来源 questions 表），按章节分组。
 * 只回传 note 文本，绝不回传题干、选项、答案；章节与组内按考点编号自然排序。
 * @param subject 科目
 * @returns 按章节分组的错题备注；辅助箭头函数 itemKey 取条目首个考点编码作为排序键
 */
export async function listNoteDigest(subject: StudyNote['subject']): Promise<DigestGroup[]> {
  const { rows } = await pool.query<DigestRow>(
    `SELECT id, chapter, kp_codes, note, question_type, updated_at
       FROM questions
      WHERE subject = $1 AND note IS NOT NULL AND btrim(note) <> ''
      ORDER BY updated_at DESC`,
    [subject],
  );

  const byChapter = new Map<string, DigestItem[]>();
  for (const row of rows) {
    const chapter = row.chapter || '未分章节';
    const item: DigestItem = {
      questionId: row.id,
      chapter,
      kpCodes: row.kp_codes ?? [],
      note: row.note.trim(),
      questionType: row.question_type,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
    const bucket = byChapter.get(chapter);
    if (bucket) bucket.push(item);
    else byChapter.set(chapter, [item]);
  }

  // 排序键：取条目首个考点编码，缺失则返回空串排最前
  const itemKey = (item: DigestItem) => item.kpCodes[0] ?? '';
  // 英语按《库课·大学英语》笔记目录排章节：E 编码跨章（如第二章句法上是 E1.5~E1.12、
  // 第五章阅读理解是 E2.x），直接按编码排会把教材章节顺序打乱。数学仍按考点编号自然排序。
  const chapterRank = (chapter: string) => {
    const i = ENGLISH_CHAPTER_ORDER.indexOf(chapter);
    return i >= 0 ? i : ENGLISH_CHAPTER_ORDER.length;
  };
  return [...byChapter.entries()]
    .map(([chapter, items]) => ({
      chapter,
      items: items.sort((a, b) => compareNatural(itemKey(a), itemKey(b))),
    }))
    .sort((a, b) => {
      if (subject === 'english') {
        const byChapterOrder = chapterRank(a.chapter) - chapterRank(b.chapter);
        if (byChapterOrder !== 0) return byChapterOrder;
      }
      const ka = a.items[0] ? itemKey(a.items[0]) : '';
      const kb = b.items[0] ? itemKey(b.items[0]) : '';
      return compareNatural(ka, kb);
    });
}

/**
 * 从 questions 表统计各科目有备注的错题条数（笔记页 Tab 角标用）。
 * @returns 各科目错题备注数（math/english）
 */
export async function countDigestBySubject(): Promise<Record<StudyNote['subject'], number>> {
  const { rows } = await pool.query<{ subject: string; count: string }>(
    `SELECT subject, count(*)::text AS count
       FROM questions
      WHERE note IS NOT NULL AND btrim(note) <> '' AND subject IN ('math','english')
      GROUP BY subject`,
  );
  const result: Record<StudyNote['subject'], number> = { math: 0, english: 0 };
  for (const row of rows) {
    if (row.subject === 'math' || row.subject === 'english') result[row.subject] = Number(row.count);
  }
  return result;
}
