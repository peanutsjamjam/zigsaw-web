-- puzzle_clears: 「このユーザーはこのパズルを一度はクリアしたことがある」という事実だけを持つ。
--   画面の「プレイ中/クリア済み」表示は progress.state（現在の盤面）から毎回導出しており、
--   クリア後に再度遊んで上書き保存すると「クリア済み」は消える。この表はそれとは独立な
--   クリア歴で、行は残り続ける。いまのところ画面表示には使わない。
--   行の追加は api.cgi の progress 保存時（全ピースが1グループになった state を検出したとき）。
--   ※ users / puzzles を参照するため、両方の後に流すこと。
CREATE TABLE puzzle_clears (
  user_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  puzzle_id  INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  cleared_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- 最初にクリアした日時（再クリアでは更新しない）
  PRIMARY KEY (user_id, puzzle_id)
);
