-- 模拟卷答题卡升级：自动保存的作答 + 手机拍照上传的记录
-- answers：{ [questionId]: { answer?: string, selfRating?: string } }，到点强制交卷时以它为准
ALTER TABLE exams ADD COLUMN answers jsonb NOT NULL DEFAULT '{}';
-- uploads：[{ id, section: 'blank'|'solve', questionNo, questionId, file, ocrText, createdAt }]
ALTER TABLE exams ADD COLUMN uploads jsonb NOT NULL DEFAULT '[]';
