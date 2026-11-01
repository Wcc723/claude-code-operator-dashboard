CREATE TABLE IF NOT EXISTS kanban_columns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  column_id INTEGER NOT NULL REFERENCES kanban_columns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_column ON kanban_cards(column_id, position);

CREATE TABLE IF NOT EXISTS revoked_sessions (
  jti TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS launch_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  env_json TEXT,
  -- project 標記色（colors.js 的 key 或 NULL）；舊 DB 由 db/index.js 的 migration 補上這欄
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- CODD Artifact（Claude 發布給使用者看的 HTML 頁面 / 設計畫布）----------
-- 刪除用 soft delete（deleted_at），不實際刪列

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,                       -- 12 字元 [a-z0-9]
  kind TEXT NOT NULL CHECK (kind IN ('html','canvas')),
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  origin_terminal_id TEXT,                   -- 建立它的 CODD PTY id；host token 建立的是 NULL
  origin_label TEXT,                         -- 建立當下的 session 顯示名（session 結束後列表仍可顯示）
  created_at TEXT NOT NULL,                  -- ISO 8601
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_updated ON artifacts(updated_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_origin ON artifacts(origin_terminal_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,                     -- html：HTML 字串；canvas：正規化後的 spec JSON（含 frame html）
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS artifact_drafts (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,                     -- 正規化後的回覆 payload JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS artifact_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                      -- 每個 artifact 從 1 起算
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  notify_status TEXT NOT NULL DEFAULT 'none',-- none|pending|sent|no_session|expired|failed|disabled|skipped
  created_at TEXT NOT NULL,
  read_at TEXT,                              -- Claude 用 artifact_read_submissions 讀過的時間
  UNIQUE (artifact_id, seq)
);
