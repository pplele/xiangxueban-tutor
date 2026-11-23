-- 回滚 0009：恢复情绪事件列，移除考试事件与老师点评列
ALTER TABLE user_profile DROP COLUMN IF EXISTS narratives;
ALTER TABLE user_profile DROP COLUMN IF EXISTS exam_events;
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS emotion_events jsonb NOT NULL DEFAULT '[]';
