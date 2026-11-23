-- 英语作文存档：学生把自己写好的作文存进 /vocab「我的作文」。
-- 与 study_notes（自由笔记）、questions.note（错因备注）相互独立，互不污染。
-- 单账号系统仍按 username 隔离，方便以后接 AI 批改或多账号。
CREATE TABLE IF NOT EXISTS english_essays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  title text NOT NULL,
  prompt text NOT NULL DEFAULT '',
  genre text NOT NULL DEFAULT '其它',
  body text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 作文列表按最近修改倒序；量小，标题/正文搜索走顺序扫描即可
CREATE INDEX IF NOT EXISTS idx_english_essays_user_updated
  ON english_essays (username, updated_at DESC);
