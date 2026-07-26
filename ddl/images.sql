-- images: みんなで遊べる共有ギャラリーの1枚。実ファイルは images/full と
--   images/thumb に置き（api.cgi と同じディレクトリ配下）、DB は1枚につき1行を持つ。
--   owner_id が NULL のものは管理者がシードスクリプトで置いた画像。値があれば
--   その利用者がアップロードした画像（本人・管理者だけが削除できる）。
--   基準名 (basename) は拡張子抜きの UUID。実ファイルは
--     images/full/<basename>.<ext>   （縮小済みの、遊ぶ用の画像）
--     images/thumb/<basename>.jpg    （一覧・完成図プレビュー用のサムネイル）
--   縮小もサムネ生成もクライアント側で行う（サーバーに画像処理系が無いため）。
CREATE TABLE images (
  id           SERIAL PRIMARY KEY,
  owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  basename     TEXT NOT NULL UNIQUE,    -- 拡張子抜きの UUID
  ext          TEXT NOT NULL,           -- 遊ぶ用画像の拡張子（jpg/png/webp など）
  display_name TEXT NOT NULL,           -- 一覧に出す題名（あとで変更できる）
  original_name TEXT NOT NULL,          -- アップロード時の元の名前（当初は display_name と同じ）
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  upload_ip    INET,                    -- アップロード元の IP（管理者設置は NULL）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX images_created_idx ON images (created_at);
CREATE INDEX images_owner_idx ON images (owner_id);
