-- 单词故事 → 单词趣味记忆：一条记录可以是 故事/谚语/近似 三种记忆模式之一。
-- 原有数据默认 story，平滑升级。
ALTER TABLE word_stories
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'story',   -- story / proverb / similar
  ADD COLUMN IF NOT EXISTS builtin boolean NOT NULL DEFAULT false; -- 系统内置素材，不可删除

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'word_stories_mode_check') THEN
    ALTER TABLE word_stories ADD CONSTRAINT word_stories_mode_check
      CHECK (mode IN ('story', 'proverb', 'similar'));
  END IF;
END $$;

-- 列表按 用户 + 模式 + 日期 倒序
CREATE INDEX IF NOT EXISTS idx_word_stories_user_mode
  ON word_stories (username, mode, story_date DESC, created_at DESC);
