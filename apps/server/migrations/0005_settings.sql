-- 运行期可改的配置（模型 API 通道等），优先级高于 .env，改完即时生效
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
