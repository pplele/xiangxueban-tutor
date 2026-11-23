DROP INDEX IF EXISTS idx_word_stories_user_mode;
ALTER TABLE word_stories
  DROP CONSTRAINT IF EXISTS word_stories_mode_check,
  DROP COLUMN IF EXISTS builtin,
  DROP COLUMN IF EXISTS mode;
