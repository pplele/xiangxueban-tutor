-- 复习单词：把大词表拆成小块（教材 10 单元 / 题目词法 8 类），复用灰黄绿红记忆法
-- username='*' 为公共内置词条（照片识别后由脚本批量导入），其它为个人上传；状态按账号隔离。
CREATE TABLE IF NOT EXISTS review_words (
  id          bigserial   PRIMARY KEY,
  username    text        NOT NULL,
  group_key   text        NOT NULL,
  term        text        NOT NULL,
  meaning     text        NOT NULL DEFAULT '',
  kind        text        NOT NULL DEFAULT 'word',   -- word 单词 / phrase 短语搭配
  sort_no     integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_review_words
  ON review_words (username, group_key, lower(term));
CREATE INDEX IF NOT EXISTS ix_review_words_group
  ON review_words (username, group_key, sort_no, id);

CREATE TABLE IF NOT EXISTS review_progress (
  username    text        NOT NULL,
  word_id     bigint      NOT NULL REFERENCES review_words(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'gray'
              CHECK (status IN ('gray', 'green', 'yellow', 'red')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, word_id)
);
