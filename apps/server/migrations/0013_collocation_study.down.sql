DROP TABLE IF EXISTS collocation_progress;
ALTER TABLE vocab_words
  DROP COLUMN IF EXISTS example_en,
  DROP COLUMN IF EXISTS example_zh;
