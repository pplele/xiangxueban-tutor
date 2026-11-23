-- 单词查漏补缺：词表 + 每轮测试记录（绿=熟悉 黄=模糊 红=遗忘）
CREATE TABLE IF NOT EXISTS vocab_words (
  id serial PRIMARY KEY,
  subject text NOT NULL DEFAULT 'english',
  word text NOT NULL,
  phonetic text NOT NULL DEFAULT '',
  meaning text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'word',
  source_page int,
  sort_no int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 同一科目下同一个词只留一条（大小写不敏感），避免导入重复
CREATE UNIQUE INDEX IF NOT EXISTS uq_vocab_words_word
  ON vocab_words (subject, lower(word));

CREATE INDEX IF NOT EXISTS idx_vocab_words_order
  ON vocab_words (subject, kind, sort_no);

CREATE TABLE IF NOT EXISTS vocab_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  round_no int NOT NULL,
  total int NOT NULL DEFAULT 0,
  green int NOT NULL DEFAULT 0,
  yellow int NOT NULL DEFAULT 0,
  red int NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (username, round_no)
);

CREATE INDEX IF NOT EXISTS idx_vocab_rounds_user
  ON vocab_rounds (username, round_no DESC);

CREATE TABLE IF NOT EXISTS vocab_round_items (
  round_id uuid NOT NULL REFERENCES vocab_rounds(id) ON DELETE CASCADE,
  word_id int NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  -- 本轮开始时这个词所在的区域：green/yellow/red，第一次测是 new
  zone text NOT NULL DEFAULT 'new',
  -- 本轮测完的结果：green/yellow/red
  state text NOT NULL,
  PRIMARY KEY (round_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_vocab_items_word
  ON vocab_round_items (word_id);
