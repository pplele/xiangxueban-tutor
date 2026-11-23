-- 单词故事：把不认识的生词编进一篇故事里，每天回看并打卡。
-- 与 english_essays（整篇作文）相互独立：故事以 markdown 正文保存，重点在「隐藏中文翻译」的自测复习。
CREATE TABLE IF NOT EXISTS word_stories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username    text        NOT NULL,
  title       text        NOT NULL,
  body        text        NOT NULL,          -- markdown 正文，格式：**word**（中文）
  story_date  date        NOT NULL DEFAULT CURRENT_DATE,  -- 记录的是哪一天的故事
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 故事列表按用户名 + 记录日期倒序
CREATE INDEX IF NOT EXISTS idx_word_stories_user_date
  ON word_stories (username, story_date DESC);

-- 打卡：每篇故事每天最多一次，主键去重；删故事时级联清掉打卡记录
CREATE TABLE IF NOT EXISTS story_checkins (
  username     text        NOT NULL,
  story_id     uuid        NOT NULL REFERENCES word_stories(id) ON DELETE CASCADE,
  checkin_date date        NOT NULL DEFAULT CURRENT_DATE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, story_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_story_checkins_user_date
  ON story_checkins (username, checkin_date DESC);
