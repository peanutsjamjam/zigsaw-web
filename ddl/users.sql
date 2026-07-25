-- users: アカウント。パスワードは PBKDF2-HMAC-SHA256 のハッシュで保存する。
--   email は登録で必須。大文字小文字を無視して一意。
--   username は表示名（アップロードした画像の投稿者名などに使う）。一意。
--   zigsaw にはゲスト（一時ユーザー）は無い。未ログインでも遊べるが、そのときは
--   途中経過を保存しない（= アカウントが無い）だけなので users に行を作らない。
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,           -- 登録時に必須
  password_hash TEXT NOT NULL,           -- PBKDF2-HMAC-SHA256 (hex)
  salt          TEXT NOT NULL,           -- hex
  iterations    INTEGER NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT false, -- 管理者（他人の画像も削除できる）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- メールアドレスは大文字小文字を無視して一意。
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));
