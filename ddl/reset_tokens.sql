-- reset_tokens: パスワード再設定用の一時トークン。
--   「パスワードをお忘れですか？」からメールアドレスを受け取り、登録済みなら
--   ランダムトークンを保存してリンク（?reset=<token>）をメールで送る。
--   リンクから新しいパスワードを設定して再設定が完了したらトークンは削除する。
--   期限切れは reset_request などのついでに掃除する。
--   user_id は ON DELETE CASCADE なので、ユーザー削除で道連れに消える。
CREATE TABLE reset_tokens (
  token      TEXT PRIMARY KEY,        -- ランダム hex
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reset_tokens_user_idx ON reset_tokens (user_id);
