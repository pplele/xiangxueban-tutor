-- 0002_compat_source_data.down.sql
DROP INDEX IF EXISTS idx_variants_dedupe;
ALTER TABLE variants DROP COLUMN IF EXISTS dedupe_key;
ALTER TABLE variants ADD CONSTRAINT variants_question_id_set_id_level_key UNIQUE (question_id, set_id, level);
DROP INDEX IF EXISTS idx_questions_fingerprint;
ALTER TABLE questions ADD CONSTRAINT questions_subject_fingerprint_key UNIQUE (subject, fingerprint);
