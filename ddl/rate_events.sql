-- rate_events: レート制限用のイベント記録（CGI はプロセスをまたいで状態を持てないので DB に置く）。
--   action … 種別（'login_fail' / 'mail_signup' / 'mail_reset' など）
--   subject … 判定キー（'email:foo@bar' や 'ip:1.2.3.4'）
--   直近 N 分の件数を数えて閾値超なら弾く。古い行は「ついで掃除」で削除する。
CREATE TABLE rate_events (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rate_events_lookup_idx ON rate_events (action, subject, created_at);
