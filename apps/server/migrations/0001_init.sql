-- 0001_init.sql
-- 基于大语言模型 Agent 的专升本个性化自适应学习系统 · 初始结构

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------- 科目 ----------
CREATE TABLE subjects (
  code text PRIMARY KEY
);

INSERT INTO subjects (code) VALUES ('math'), ('english'), ('cs')
ON CONFLICT (code) DO NOTHING;

-- ---------- 考纲考点白名单 ----------
CREATE TABLE kp_whitelist (
  subject text NOT NULL REFERENCES subjects(code) ON DELETE CASCADE,
  kp_code text NOT NULL,
  kp_name text NOT NULL,
  level text,
  chapter text NOT NULL DEFAULT '',
  PRIMARY KEY (subject, kp_code)
);
CREATE INDEX idx_kp_chapter ON kp_whitelist (subject, chapter);

-- ---------- 错题 ----------
CREATE TABLE questions (
  id text PRIMARY KEY,
  subject text NOT NULL REFERENCES subjects(code),
  chapter text NOT NULL,
  kp_codes text[] NOT NULL DEFAULT '{}',
  kp_levels text[] NOT NULL DEFAULT '{}',
  question_type text NOT NULL,
  title text,
  text_body text NOT NULL,
  options jsonb,
  answer text,
  solution text,
  note text,
  tags text[] NOT NULL DEFAULT '{}',
  no text NOT NULL DEFAULT '',
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT '待变式',
  source text NOT NULL DEFAULT 'json',
  schema_version int NOT NULL DEFAULT 3,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject, fingerprint)
);
CREATE INDEX idx_questions_subject_chapter ON questions (subject, chapter);
CREATE INDEX idx_questions_status ON questions (subject, status);
CREATE INDEX idx_questions_created ON questions (created_at DESC);

-- ---------- 变式 ----------
CREATE TABLE variants (
  id bigserial PRIMARY KEY,
  question_id text NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  set_id text NOT NULL,
  level text NOT NULL,
  stem text NOT NULL,
  answer text NOT NULL,
  solution text NOT NULL,
  kp_codes text[] NOT NULL,
  target_trap text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, set_id, level)
);
CREATE INDEX idx_variants_q ON variants (question_id);

-- ---------- 作答记录 ----------
CREATE TABLE attempts (
  id bigserial PRIMARY KEY,
  question_id text NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  variant_id bigint REFERENCES variants(id) ON DELETE SET NULL,
  subject text NOT NULL,
  answer text,
  verdict text,
  source text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_attempts_q ON attempts (question_id);
CREATE INDEX idx_attempts_subject_at ON attempts (subject, at DESC);

-- ---------- RAG 知识库 ----------
CREATE TABLE knowledge_chunks (
  id bigserial PRIMARY KEY,
  subject text NOT NULL REFERENCES subjects(code),
  chapter text,
  kp_codes text[] NOT NULL DEFAULT '{}',
  source_name text NOT NULL,
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  tsv tsvector NOT NULL
);
CREATE INDEX idx_chunks_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_chunks_tsv ON knowledge_chunks USING gin (tsv);
CREATE INDEX idx_chunks_subject ON knowledge_chunks (subject, chapter);
CREATE INDEX idx_chunks_source ON knowledge_chunks (source_name);

-- ---------- 全局画像（单用户） ----------
CREATE TABLE user_profile (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  labels jsonb NOT NULL DEFAULT '{}',
  emotion_events jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO user_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------- 会话 ----------
CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL REFERENCES subjects(code),
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  citations jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_session ON chat_messages (session_id, id);

-- ---------- 模拟卷 ----------
CREATE TABLE exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL DEFAULT 'math',
  title text,
  blueprint jsonb NOT NULL,
  items jsonb NOT NULL,
  total_score numeric,
  max_score numeric,
  duration_min int DEFAULT 120,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_exams_created ON exams (created_at DESC);

-- ---------- 刷新令牌（服务端存储，SHA-256 哈希） ----------
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  username text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_expires ON refresh_tokens (expires_at);

-- ---------- 变式生成队列 ----------
CREATE TABLE variant_jobs (
  id bigserial PRIMARY KEY,
  question_id text NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  error text,
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX idx_variant_jobs_status ON variant_jobs (status, id);
