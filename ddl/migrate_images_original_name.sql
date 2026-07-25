-- images に original_name を追加する（既存DBの移行。1回だけ流す）。
--   original_name はアップロード時の元の名前。当初は display_name と同じ値を入れる。
--   のちほど display_name だけを変更する UI を追加する予定（original_name は元の名前として残す）。
ALTER TABLE images ADD COLUMN original_name TEXT NOT NULL DEFAULT '';
UPDATE images SET original_name = display_name;
ALTER TABLE images ALTER COLUMN original_name DROP DEFAULT;
