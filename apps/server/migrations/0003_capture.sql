-- 拍照识题 / 错题查重：给题目表加向量列与原图引用
ALTER TABLE questions ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url text;

-- 错题查重走余弦距离，题目量级不大，hnsw 足够
CREATE INDEX IF NOT EXISTS idx_questions_embedding
  ON questions USING hnsw (embedding vector_cosine_ops);

-- 指纹查重（同一题精确命中）
CREATE INDEX IF NOT EXISTS idx_questions_fingerprint
  ON questions (fingerprint);
