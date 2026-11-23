-- 0002_compat_source_data.sql
-- 兼容 F:\wrongbook 源数据的两个真实特性：
-- 1) 56 张卡中有两张共享同一 fingerprint（Q-20261030-017 / Q-20261030-020），
--    但仍要求全部入库，故将 (subject, fingerprint) 唯一约束降为普通索引；
--    应用层仍按 fingerprint 判重，迁移脚本显式允许同指纹不同 id。
-- 2) 考纲层次为「了解」时第三道变式降级为 L1，同一套 V1 会出现两个 L1，
--    故变式唯一键改为 (question_id, dedupe_key)，dedupe_key = md5(set_id:level:stem)。

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_subject_fingerprint_key;
CREATE INDEX IF NOT EXISTS idx_questions_fingerprint ON questions (subject, fingerprint);

ALTER TABLE variants DROP CONSTRAINT IF EXISTS variants_question_id_set_id_level_key;
ALTER TABLE variants ADD COLUMN IF NOT EXISTS dedupe_key text;
UPDATE variants SET dedupe_key = md5(set_id || ':' || level || ':' || stem) WHERE dedupe_key IS NULL;
ALTER TABLE variants ALTER COLUMN dedupe_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_dedupe ON variants (question_id, dedupe_key);
