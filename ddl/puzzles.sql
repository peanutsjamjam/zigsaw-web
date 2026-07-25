-- puzzles: 作成されたパズル。1枚の画像＋グリッド(columns×rows)の組を、みんなで遊べる
--   共有のパズルとして表す。同じ画像・同じグリッドは1つに束ねる（UNIQUE）。作成者は
--   最初に作った人（creator_id。退会しても NULL になってパズル自体は残る）。
--   ※ images / users を参照するため、それらの後に流すこと。
CREATE TABLE puzzles (
  id         SERIAL PRIMARY KEY,
  image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  columns    INTEGER NOT NULL,
  rows       INTEGER NOT NULL,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (image_id, columns, rows)
);

CREATE INDEX puzzles_image_idx ON puzzles (image_id);
CREATE INDEX puzzles_created_idx ON puzzles (created_at);
