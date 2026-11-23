-- 学习画像改造：以考试分数与失分知识点为核心，移除情绪事件。
-- exam_events：每次交卷追加一条 { id, date, subject, title, score, maxScore, lostKps }
-- narratives：按科目保存老师点评 { math: {...}, english: {...} }
ALTER TABLE user_profile DROP COLUMN IF EXISTS emotion_events;
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS exam_events jsonb NOT NULL DEFAULT '[]';
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS narratives jsonb NOT NULL DEFAULT '{}';
