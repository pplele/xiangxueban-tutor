-- 学习笔记：数学 / 英语分科记录。
-- 与 questions.note（题目错因备注）相互独立，互不污染。
CREATE TABLE IF NOT EXISTS study_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  subject text NOT NULL CHECK (subject IN ('math', 'english')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 按学生 + 科目倒序取笔记；标题/正文搜索走顺序扫描即可（量小）
CREATE INDEX IF NOT EXISTS idx_study_notes_user_subject
  ON study_notes (username, subject, updated_at DESC);
