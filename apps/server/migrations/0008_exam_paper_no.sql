-- 试卷存档编号：生成的每张卷都永久保存在 exams 表，按「科目 + 模式」独立编号。
-- mode：'mock'=模拟考试（全考纲）、'chapter'=章节考试（所选章节小范围）
ALTER TABLE exams ADD COLUMN mode text NOT NULL DEFAULT 'mock';
ALTER TABLE exams ADD COLUMN paper_no int;

-- 存量卷回填：一律算模拟考试，按创建先后编号
WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY created_at)::int AS no
  FROM exams
  WHERE paper_no IS NULL
)
UPDATE exams e
   SET mode = 'mock',
       paper_no = r.no
  FROM ranked r
 WHERE e.id = r.id;

-- 同科目同模式的编号应唯一（应用层保证 max+1；索引供编号查询加速）
CREATE INDEX idx_exams_mode_no ON exams (subject, mode, paper_no);
