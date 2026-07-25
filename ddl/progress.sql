-- progress: ログイン中の利用者ごとの、あるパズルの途中経過。
--   1ユーザー・1パズルにつき1つ持つ（同じパズルは上書き）。
--   state はフロントの SavedGameState をそのまま入れた JSONB（ピースの位置・回転・
--   つながり方・経過時間・拡大率・スクロール位置）＋一覧の「現在の様子」用スナップショット
--   画像（data URL）。ピース形状はパズル（画像＋グリッド）から決定的に切り直せるので保存しない。
--   完成済みかどうかは state の中身（全ピースが1グループ）から判定する。
--   ※ puzzles / users を参照するため、それらの後に流すこと。
CREATE TABLE progress (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  puzzle_id  INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  state      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, puzzle_id)
);

CREATE INDEX progress_user_idx ON progress (user_id, updated_at);
