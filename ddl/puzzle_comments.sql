-- puzzle_comments: パズルのクリアコメント。そのパズルをクリアした人（puzzle_clears に
--   行がある人）だけが書ける。1ユーザー・1パズルにつき1件（複合主キー）で、
--   登録済みなら上書き（変更）になる。本文はコードポイントで200文字まで
--   （char_length は文字数＝コードポイント数を数える。api.cgi 側でも同じ上限で検査する）。
--   ※ users / puzzles を参照するため、両方の後に流すこと。
CREATE TABLE puzzle_comments (
  user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  puzzle_id  INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL CHECK (char_length(body) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, puzzle_id)
);
