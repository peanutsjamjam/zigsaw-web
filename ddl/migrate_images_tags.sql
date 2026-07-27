-- タグを tags / image_tags（多対多）で持つようにする（既存DBの移行。1回だけ流す）。
--   ごく短いあいだ images.tags（自由入力の1行テキスト）で持っていたので、
--   その列があれば落としてから、tags.sql の2テーブルを作る。
--   本番の CGI は apache ユーザーで動くため、追加したテーブル・シーケンスには
--   apache への GRANT も忘れずに行う（ここで一緒に流す）。
ALTER TABLE images DROP COLUMN IF EXISTS tags;

\i tags.sql

GRANT SELECT, INSERT, UPDATE, DELETE ON tags, image_tags TO apache;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE tags_id_seq TO apache;
