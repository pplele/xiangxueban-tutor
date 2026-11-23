-- 组卷防重复：被任何考试（章节考试 / 模拟考试）抽过的题与变式都会打标，
-- 下次组卷优先跳过；题库不足时服务层会回退复用，保证卷面完整。
ALTER TABLE questions ADD COLUMN exam_used_at timestamptz;
ALTER TABLE variants ADD COLUMN exam_used_at timestamptz;
CREATE INDEX idx_questions_exam_used ON questions (subject, exam_used_at);
CREATE INDEX idx_variants_exam_used ON variants (exam_used_at);
