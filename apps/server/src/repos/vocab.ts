import { many, one, pool, query } from '../db/pool';

/** 词汇表 vocab_words 中的词条 */
export interface VocabWord {
  id: number;
  word: string;
  phonetic: string;
  meaning: string;
  kind: string;
  sourcePage: number | null;
}

/** 单词背诵轮次 vocab_rounds 记录 */
export interface VocabRound {
  id: string;
  roundNo: number;
  total: number;
  green: number;
  yellow: number;
  red: number;
  startedAt: string;
  finishedAt: string;
}

/** 单词所在色区：green 会 / yellow 模糊 / red 不认识 */
export type VocabState = 'green' | 'yellow' | 'red';

/**
 * 从 vocab_words 表按科目读取词表，按 sort_no、id 排序。
 * @param subject 科目，默认 english
 * @returns 词条列表
 */
export async function listWords(subject = 'english'): Promise<VocabWord[]> {
  const rows = await many<{
    id: number;
    word: string;
    phonetic: string;
    meaning: string;
    kind: string;
    source_page: number | null;
  }>(
    `SELECT id, word, phonetic, meaning, kind, source_page
       FROM vocab_words WHERE subject = $1
      ORDER BY sort_no, id`,
    [subject],
  );
  return rows.map((r) => ({
    id: r.id,
    word: r.word,
    phonetic: r.phonetic,
    meaning: r.meaning,
    kind: r.kind,
    sourcePage: r.source_page,
  }));
}

/**
 * 从 vocab_rounds 表读取某用户最近一轮背诵记录（按轮次号倒序）。
 * @param username 用户名
 * @returns 最近一轮，无记录返回 null
 */
export async function latestRound(username: string): Promise<VocabRound | null> {
  return one<VocabRound>(
    `SELECT id, round_no AS "roundNo", total, green, yellow, red,
            started_at AS "startedAt", finished_at AS "finishedAt"
       FROM vocab_rounds WHERE username = $1
      ORDER BY round_no DESC LIMIT 1`,
    [username],
  );
}

/**
 * 从 vocab_round_items 表读取上一轮每个词落在哪个色区，返回 word_id → state 映射。
 * @param roundId 轮次 id
 * @returns 单词 id 到色区的映射
 */
export async function lastStates(roundId: string): Promise<Map<number, VocabState>> {
  const rows = await many<{ word_id: number; state: VocabState }>(
    `SELECT word_id, state FROM vocab_round_items WHERE round_id = $1`,
    [roundId],
  );
  return new Map(rows.map((r) => [r.word_id, r.state]));
}

/**
 * 写入一轮完整背诵结果：事务内先插 vocab_rounds，再分批插 vocab_round_items（每批 500 避免参数过多），
 * 冲突时更新 state；异常回滚并释放连接。
 * @param input 用户名、轮次号、三色统计、开始时间与各词结果
 * @returns 新建轮次 id
 */
export async function insertRound(input: {
  username: string;
  roundNo: number;
  green: number;
  yellow: number;
  red: number;
  startedAt: Date;
  items: { wordId: number; zone: string; state: VocabState }[];
}): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const round = await client.query<{ id: string }>(
      `INSERT INTO vocab_rounds (username, round_no, total, green, yellow, red, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       RETURNING id`,
      [
        input.username,
        input.roundNo,
        input.items.length,
        input.green,
        input.yellow,
        input.red,
        input.startedAt,
      ],
    );
    const roundId = round.rows[0].id;
    // 分批插入，避免单条 SQL 参数过多（词表 2000+ 条）
    const CHUNK = 500;
    for (let i = 0; i < input.items.length; i += CHUNK) {
      const slice = input.items.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = slice.map((it, idx) => {
        values.push(roundId, it.wordId, it.zone, it.state);
        const base = idx * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      });
      await client.query(
        `INSERT INTO vocab_round_items (round_id, word_id, zone, state) VALUES ${tuples.join(', ')}
         ON CONFLICT (round_id, word_id) DO UPDATE SET state = EXCLUDED.state`,
        values,
      );
    }
    await client.query('COMMIT');
    return roundId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 从 vocab_rounds 表读取某用户的历史轮次列表，按轮次号倒序。
 * @param username 用户名
 * @param limit 最多返回条数，默认 30
 * @returns 轮次记录列表
 */
export async function listRounds(username: string, limit = 30): Promise<VocabRound[]> {
  return many<VocabRound>(
    `SELECT id, round_no AS "roundNo", total, green, yellow, red,
            started_at AS "startedAt", finished_at AS "finishedAt"
       FROM vocab_rounds WHERE username = $1
      ORDER BY round_no DESC LIMIT $2`,
    [username, limit],
  );
}

/**
 * 读取某轮详情：vocab_rounds 轮次信息 + 联 vocab_words 的词条明细（按 sort_no 排序）。
 * @param roundId 轮次 id
 * @returns 轮次与各词结果；轮次不存在时返回空明细
 */
export async function roundDetail(roundId: string): Promise<{
  round: VocabRound | null;
  items: { wordId: number; word: string; meaning: string; zone: string; state: VocabState }[];
}> {
  const round = await one<VocabRound>(
    `SELECT id, round_no AS "roundNo", total, green, yellow, red,
            started_at AS "startedAt", finished_at AS "finishedAt"
       FROM vocab_rounds WHERE id = $1`,
    [roundId],
  );
  if (!round) return { round: null, items: [] };
  const items = await many<{
    wordId: number;
    word: string;
    meaning: string;
    zone: string;
    state: VocabState;
  }>(
    `SELECT i.word_id AS "wordId", w.word, w.meaning, i.zone, i.state
       FROM vocab_round_items i
       JOIN vocab_words w ON w.id = i.word_id
      WHERE i.round_id = $1
      ORDER BY w.sort_no`,
    [roundId],
  );
  return { round, items };
}

/**
 * 教师视图：从 vocab_rounds 按用户聚合轮次数、最近一轮编号、三色分布与完成时间。
 * @returns 每个学生一行（按最近完成时间倒序）
 */
export async function studentsOverview(): Promise<
  {
    username: string;
    rounds: number;
    lastRoundNo: number | null;
    lastAt: string | null;
    green: number;
    yellow: number;
    red: number;
    total: number;
  }[]
> {
  return many(
    `SELECT r.username,
            count(*)::int AS rounds,
            max(r.round_no)::int AS "lastRoundNo",
            max(r.finished_at)::text AS "lastAt",
            (array_agg(r.green ORDER BY r.round_no DESC))[1]::int AS green,
            (array_agg(r.yellow ORDER BY r.round_no DESC))[1]::int AS yellow,
            (array_agg(r.red ORDER BY r.round_no DESC))[1]::int AS red,
            (array_agg(r.total ORDER BY r.round_no DESC))[1]::int AS total
       FROM vocab_rounds r
      GROUP BY r.username
      ORDER BY max(r.finished_at) DESC`,
  );
}

/**
 * 从 vocab_words 表统计词条总数及单词(kind='word')/短语数。
 * @param subject 科目，默认 english
 * @returns 总数、单词数、短语数
 */
export async function countWords(subject = 'english'): Promise<{ total: number; words: number; phrases: number }> {
  const row = await one<{ total: number; words: number; phrases: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE kind = 'word')::int AS words,
            count(*) FILTER (WHERE kind <> 'word')::int AS phrases
       FROM vocab_words WHERE subject = $1`,
    [subject],
  );
  return row ?? { total: 0, words: 0, phrases: 0 };
}

/**
 * 清空 vocab_round_items、vocab_rounds、vocab_words 三张表并重置自增 id（危险操作，用于重置词库）。
 */
export async function truncateAll(): Promise<void> {
  await query('TRUNCATE vocab_round_items, vocab_rounds, vocab_words RESTART IDENTITY CASCADE');
}
