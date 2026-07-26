-- images に upload_ip を追加する（既存DBの移行。1回だけ流す）。
--   画像ファイルをアップロードした元の IP アドレス（Apache の REMOTE_ADDR）。
--   移行前の行や管理者がシードで置いた画像は不明なので NULL のままにする。
ALTER TABLE images ADD COLUMN upload_ip INET;
