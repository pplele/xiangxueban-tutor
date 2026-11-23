DROP INDEX IF EXISTS idx_questions_fingerprint;
DROP INDEX IF EXISTS idx_questions_embedding;
ALTER TABLE questions DROP COLUMN IF EXISTS image_url;
ALTER TABLE questions DROP COLUMN IF EXISTS embedding;
