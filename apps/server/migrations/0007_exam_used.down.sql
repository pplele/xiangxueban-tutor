DROP INDEX IF EXISTS idx_variants_exam_used;
DROP INDEX IF EXISTS idx_questions_exam_used;
ALTER TABLE variants DROP COLUMN IF EXISTS exam_used_at;
ALTER TABLE questions DROP COLUMN IF EXISTS exam_used_at;
