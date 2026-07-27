-- tags / image_tags: 画像に付けるタグ。タグ名は全体で1行にまとめ（tags）、
--   どの画像にどのタグが付いているかは中間テーブル（image_tags）で多対多に持つ。
--   タグ名は前後の空白を落とし、大文字小文字・全半角はそのまま（見たままを保つ）。
--   同じ名前のタグは1行だけ（UNIQUE）。画像を消せば image_tags は連鎖削除され、
--   どの画像からも参照されなくなった tags 行は api.cgi 側で掃除する。
--   ※ images を参照するため、images の後に流すこと。
CREATE TABLE tags (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE image_tags (
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (image_id, tag_id)
);

-- タグから画像を引く（「このタグの画像一覧」用）。逆向きは主キーで引ける。
CREATE INDEX image_tags_tag_idx ON image_tags (tag_id);
