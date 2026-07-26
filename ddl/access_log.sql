-- access_log: どの IP アドレスからのアクセスかを記録する簡易アクセスログ。
--   DB を使う API リクエストごとに1行。ログイン中ならその user_id、未ログインなら NULL。
--   user_id は ON DELETE SET NULL（アカウント削除後もログは残す）。
--   ※ users を参照するため、users.sql の後に流すこと。
CREATE TABLE access_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_addr     INET,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX access_log_user_idx ON access_log (user_id);
CREATE INDEX access_log_time_idx ON access_log (accessed_at);
