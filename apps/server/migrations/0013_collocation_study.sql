-- 固定搭配学习：词库加英文例句与中文翻译；按账号记录搭配掌握进度
ALTER TABLE vocab_words
  ADD COLUMN IF NOT EXISTS example_en text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS example_zh text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS collocation_progress (
  username  text        NOT NULL,
  word_id   integer     NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  status    text        NOT NULL DEFAULT 'new',   -- new / learning / known
  seen      integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, word_id)
);

CREATE INDEX IF NOT EXISTS idx_colloc_progress_user ON collocation_progress(username, status);
