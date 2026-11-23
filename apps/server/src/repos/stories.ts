import { pool } from '../db/pool';
import { BUILTIN_PROVERBS, BUILTIN_SIMILARS, type BuiltinItem } from '../data/funMemoryBuiltin';
import { normalizeMemoryBody } from '../lib/memoryBody';

/** 记忆模式：story=单词故事 / proverb=谚语 / similar=近似词 */
export type MemoryMode = 'story' | 'proverb' | 'similar';

/** /vocab「单词趣味记忆」里的一条记录（故事/谚语/近似词共用） */
export interface WordStory {
  id: string;
  title: string;
  body: string;
  mode: MemoryMode;
  builtin: boolean;
  storyDate: string;      // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
  checkinCount: number;   // 这条累计被打卡多少天
  lastCheckin: string | null; // 最近一次打卡日期 YYYY-MM-DD
  checkedToday: boolean;  // 今天是否已打卡
}

/** 记忆页顶部的复习统计（按当前模式统计） */
export interface StoryStats {
  totalStories: number;
  totalCheckins: number;  // 全部累计打卡次数
  activeDays: number;     // 有打卡记录的不同天数
  streak: number;         // 连续打卡天数（今天没打卡时从昨天算起）
  todayChecked: number;   // 今天已打卡的条数
  todayTotal: number;     // 今天需要复习的总条数
}

interface StoryRow {
  id: string;
  title: string;
  body: string;
  mode: MemoryMode;
  builtin: boolean;
  story_date: Date;
  created_at: Date;
  updated_at: Date;
  checkin_count: string;
  last_checkin: Date | null;
  checked_today: boolean;
}

/** Date（date 类型，pg 按本地零点返回）→ YYYY-MM-DD 字符串 */
function dateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 连续打卡天数：把有打卡的日期放集合，今天没打卡就从昨天往前数，断一天即停。
 * @param days 去重的打卡日期字符串数组（YYYY-MM-DD）
 * @returns 连续天数
 */
export function calcStreak(days: string[]): number {
  const set = new Set(days);
  if (set.size === 0) return 0;
  const today = new Date();
  const cursor = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  // 今天还没打卡不算断，从昨天开始数
  if (!set.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (set.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

/** 首次进入某模式时灌入内置素材（幂等：以 username+mode+title 去重） */
async function ensureBuiltin(username: string, mode: MemoryMode): Promise<void> {
  const items: BuiltinItem[] = mode === 'proverb' ? BUILTIN_PROVERBS : mode === 'similar' ? BUILTIN_SIMILARS : [];
  if (!items.length) return;
  for (const it of items) {
    await pool.query(
      `INSERT INTO word_stories (username, title, body, mode, builtin, story_date)
       SELECT $1, $2, $3, $4, true, CURRENT_DATE
       WHERE NOT EXISTS (
         SELECT 1 FROM word_stories WHERE username = $1 AND mode = $4 AND title = $2
       )`,
      [username, it.title, it.body, mode],
    );
  }
}

/**
 * 读取某学生某模式的全部记录（按记录日期倒序），附带每条打卡情况与统计。
 * 首次进入 proverb/similar 模式会自动灌入内置素材。
 * @param username 用户名
 * @param mode 记忆模式，默认 story
 * @returns 记录列表 + 复习统计
 */
export async function listStories(
  username: string,
  mode: MemoryMode = 'story',
): Promise<{ stories: WordStory[]; stats: StoryStats }> {
  await ensureBuiltin(username, mode);

  const { rows } = await pool.query<StoryRow>(
    `SELECT s.id, s.title, s.body, s.mode, s.builtin, s.story_date, s.created_at, s.updated_at,
            COUNT(c.story_id)::text AS checkin_count,
            MAX(c.checkin_date) AS last_checkin,
            BOOL_OR(c.checkin_date = CURRENT_DATE) AS checked_today
       FROM word_stories s
       LEFT JOIN story_checkins c ON c.story_id = s.id AND c.username = s.username
      WHERE s.username = $1 AND s.mode = $2
      GROUP BY s.id
      ORDER BY s.builtin DESC, s.story_date DESC, s.created_at DESC`,
    [username, mode],
  );

  const stories: WordStory[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    mode: r.mode,
    builtin: Boolean(r.builtin),
    storyDate: dateStr(r.story_date),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    checkinCount: Number(r.checkin_count ?? 0),
    lastCheckin: r.last_checkin ? dateStr(r.last_checkin) : null,
    checkedToday: Boolean(r.checked_today),
  }));

  // 统计：只算本模式的打卡（按 story_id 关联回 mode）
  const dayRows = await pool.query<{ d: Date; n: string }>(
    `SELECT c.checkin_date AS d, COUNT(*)::text AS n
       FROM story_checkins c
       JOIN word_stories s ON s.id = c.story_id AND s.username = c.username
      WHERE c.username = $1 AND s.mode = $2
      GROUP BY c.checkin_date`,
    [username, mode],
  );
  const distinctDays = dayRows.rows.map((r) => dateStr(r.d));
  const totalCheckins = dayRows.rows.reduce((sum, r) => sum + Number(r.n ?? 0), 0);

  const stats: StoryStats = {
    totalStories: stories.length,
    totalCheckins,
    activeDays: distinctDays.length,
    streak: calcStreak(distinctDays),
    todayChecked: stories.filter((s) => s.checkedToday).length,
    todayTotal: stories.length,
  };
  return { stories, stats };
}

/** 新建/更新记录的可写字段 */
export interface StoryInput {
  title: string;
  body: string;
  storyDate?: string; // YYYY-MM-DD，默认今天
  mode?: MemoryMode;  // 默认 story
}

/**
 * 新建一条记录。
 * @param username 用户名
 * @param input 内容
 * @returns 新建的记录
 */
export async function createStory(username: string, input: StoryInput): Promise<WordStory> {
  const date = input.storyDate || new Date().toISOString().slice(0, 10);
  const mode = input.mode || 'story';
  // 写入前规范化：把 `trust信任` 这类散写收成 `**trust**（信任）`，保证朗读/翻转可用
  const body = normalizeMemoryBody(input.body, mode);
  const { rows } = await pool.query<StoryRow>(
    `INSERT INTO word_stories (username, title, body, story_date, mode)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [username, input.title, body, date, mode],
  );
  return toStory(rows[0]);
}

/** 局部更新：只覆盖传入字段 */
export type StoryPatch = Partial<StoryInput>;

/**
 * 修改一条自建记录（带 username 越权校验，内置素材不可改）。
 * @param id 记录 id
 * @param username 用户名
 * @param patch 待更新字段
 * @returns 更新后的记录，不存在或内置返回 null
 */
export async function updateStory(id: string, username: string, patch: StoryPatch): Promise<WordStory | null> {
  let next = patch;
  // 改正文时按这条记录的模式规范化；模式不在 patch 里，先查一次
  if (patch.body !== undefined) {
    const { rows: cur } = await pool.query<{ mode: string }>(
      `SELECT mode FROM word_stories WHERE id = $1 AND username = $2`,
      [id, username],
    );
    if (cur[0]) next = { ...patch, body: normalizeMemoryBody(patch.body, cur[0].mode) };
  }
  const { rows } = await pool.query<StoryRow>(
    `UPDATE word_stories
        SET title = COALESCE($3, title),
            body = COALESCE($4, body),
            story_date = COALESCE($5, story_date),
            updated_at = now()
      WHERE id = $1 AND username = $2 AND builtin = false
      RETURNING *`,
    [id, username, next.title ?? null, next.body ?? null, next.storyDate ?? null],
  );
  return rows[0] ? toStory(rows[0]) : null;
}

/**
 * 删除一条自建记录（内置素材不可删；打卡记录随外键级联删除）。
 * @param id 记录 id
 * @param username 用户名
 * @returns 是否删除成功
 */
export async function deleteStory(id: string, username: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM word_stories WHERE id = $1 AND username = $2 AND builtin = false`,
    [id, username],
  );
  return (rowCount ?? 0) > 0;
}

/** 数据库行 → 对外结构（无打卡字段时用默认值） */
function toStory(r: StoryRow): WordStory {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    mode: r.mode,
    builtin: Boolean(r.builtin),
    storyDate: dateStr(r.story_date),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    checkinCount: 0,
    lastCheckin: null,
    checkedToday: false,
  };
}

/**
 * 给一条记录打卡（今天）；已打过则不重复插入。
 * @param id 记录 id
 * @param username 用户名
 * @returns 是否本次新打卡
 */
export async function checkinStory(id: string, username: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO story_checkins (username, story_id, checkin_date)
     SELECT $1, id, CURRENT_DATE FROM word_stories WHERE id = $2 AND username = $1
     ON CONFLICT (username, story_id, checkin_date) DO NOTHING`,
    [username, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 撤销一条记录今天的打卡（点错了可以取消）。
 * @param id 记录 id
 * @param username 用户名
 * @returns 是否撤销成功
 */
export async function uncheckinStory(id: string, username: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM story_checkins
      WHERE username = $1 AND story_id = $2 AND checkin_date = CURRENT_DATE`,
    [username, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * 一键把某模式的全部记录都打卡（今天复习完一整轮时用）。
 * @param username 用户名
 * @param mode 记忆模式
 * @returns 本次新打卡的条数
 */
export async function checkinAllStories(username: string, mode: MemoryMode = 'story'): Promise<number> {
  await ensureBuiltin(username, mode);
  const { rowCount } = await pool.query(
    `INSERT INTO story_checkins (username, story_id, checkin_date)
     SELECT $1, id, CURRENT_DATE FROM word_stories WHERE username = $1 AND mode = $2
     ON CONFLICT (username, story_id, checkin_date) DO NOTHING`,
    [username, mode],
  );
  return rowCount ?? 0;
}
