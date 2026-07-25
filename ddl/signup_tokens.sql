-- signup_tokens: メール確認つきサインアップの一時トークン。
--   サインアップ申請時に email とランダムトークンを保存し、リンクで送る。
--   リンクから username/password を設定して登録が完了したらトークンは削除する。
--   期限切れは login/register などのついでに掃除する。
CREATE TABLE signup_tokens (
  token      TEXT PRIMARY KEY,        -- ランダム hex
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX signup_tokens_email_idx ON signup_tokens (lower(email));
