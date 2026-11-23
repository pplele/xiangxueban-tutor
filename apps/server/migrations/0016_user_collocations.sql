-- 用户自建搭配：账号隔离，随卡片一起背、一起记进度
CREATE TABLE IF NOT EXISTS user_collocations (
  id          serial PRIMARY KEY,
  username    text        NOT NULL,
  word        text        NOT NULL,
  meaning     text        NOT NULL DEFAULT '',
  example_en  text        NOT NULL DEFAULT '',
  example_zh  text        NOT NULL DEFAULT '',
  status      text        NOT NULL DEFAULT 'new',  -- new / learning / known
  seen        integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 同一账号下搭配不重复（大小写不敏感）
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_collocations_word
  ON user_collocations (username, lower(word));

CREATE INDEX IF NOT EXISTS idx_user_collocations_user
  ON user_collocations (username, created_at DESC);
