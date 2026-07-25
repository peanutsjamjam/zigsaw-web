-- sessions: ログイン状態の保持。ログイン時にランダムトークンを発行して保存し、
-- Cookie (zigsaw_sid) で受け渡す。expires_at で失効。
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,           -- ランダムトークン (hex)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions(user_id);
