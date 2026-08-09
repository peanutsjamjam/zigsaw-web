# 開発ドキュメント

Zigsaw（Web 版）の技術的な構成・API・開発フロー。概要は [../README.md](../README.md) を参照。

> 配信パス（サブパス/サブドメイン直下）に依存しない作りにしてある。配信パスは自動判定する。
> - `vite.config.ts` の `base` は相対 `'./'`（アセットは index.html からの相対参照）。
> - `.htaccess` は `RewriteBase` を持たない。
> - `api.cgi` の Cookie Path は `SCRIPT_NAME` から自動判定。

## 構成

```
ブラウザ (React SPA)
   │  fetch (Cookie セッション認証)
   ▼
api.cgi (Perl CGI, suexec で sugawara 実行)
   │  DBI / DBD::Pg (peer 認証・パスワード不要)
   ▼
PostgreSQL  DB: zigsaw  (users / sessions / signup_tokens / reset_tokens / access_log / rate_events /
                         images / tags / image_tags / puzzles / progress / puzzle_clears / puzzle_comments)
   +
appdata/full, appdata/thumb (画像の実ファイル。Apache が静的配信)
```

- **フロント**: Vite + React + TypeScript。`dist/` に本番ビルド。
- **バックエンド**: `api.cgi`（`#!/usr/bin/perl`、DBI/DBD::Pg/JSON::PP/Digest::SHA）。nenpyo と同じ作り。
- **配信**: Apache UserDir（`~/public_html/zigsaw/` → `/~sugawara/zigsaw/`）。`.htaccess` で
  ルートと未知パスを `dist/` へ rewrite、実在ファイル（`api.cgi`・`appdata/`）はそのまま実行/配信。
- **認証**: パスワードは PBKDF2-HMAC-SHA256（12万回）でハッシュ化して `users` に保存。
  ログイン時にランダムトークンを `sessions` に保存し、`zigsaw_sid` Cookie（HttpOnly/Secure/SameSite=Lax）で受け渡す。
  - **ログインはメールアドレス＋パスワード**（`users.email` を `lower()` で一意）。`username` は表示名（画像の投稿者名）。
  - **サインアップはメール確認つきの2段階**: `signup_request{email}` で確認リンクを送信（`signup_tokens` に一時保存）
    → リンク先で `signup_complete{token,username,password}` して登録。
  - **パスワード再設定**も同様（`reset_request` → メールの `?reset=<token>` → `reset_complete`）。
  - nenpyo と違い**ゲスト（自動一時ユーザー）は無い**。未ログインは「保存しないで遊ぶ」だけ。

### 画像（共有ギャラリー）

- 実ファイルは `appdata/full/<uuid>.<ext>`（遊ぶ用）と `appdata/thumb/<uuid>.<ext>`（一覧・完成図プレビュー用）。
  DB の `images` テーブルが1枚につき1行を持つ（`owner_id` が NULL なら管理者設置、値ありならユーザー投稿）。
- **縮小もサムネ生成もクライアント側で行う**（サーバーに ImageMagick/GD が無いため）。
  アップロードは縮小版（長辺1800）とサムネ（長辺600）を base64 で送り、サーバーはバイトを書くだけ。
- 画像の実ファイルは git 管理外（`.gitignore`）。DB とファイルは対で増える。

### パズルと途中経過

- **パズル** = 画像＋グリッド（`columns`×`rows`）＋作成者。`puzzles` テーブル。同じ画像・同じグリッドは
  1つに束ねる（`UNIQUE(image_id, columns, rows)`）。作成者は最初に作った人（`creator_id`。退会しても NULL に
  なってパズルは残る）。「画像一覧」でピース数を決めて作成し、「パズル一覧」で誰でも遊べる。
- **途中経過** = `progress` テーブル。1ユーザー・1パズルにつき1行（同じパズルは上書き＝`UNIQUE(user_id, puzzle_id)`）。
  `state` は JSONB で、フロントの `SavedGameState`（ピースの位置・回転・つながり方・経過時間・拡大率・
  スクロール位置）＋「現在の様子」用スナップショット画像（data URL）。ピース形状はパズル（画像＋グリッド）から
  決定的に切り直せるので保存しない。完成判定は state の中身（全ピースが1グループ）から。
- **クリア歴** = `puzzle_clears` テーブル。「このユーザーはこのパズルを一度はクリアした」という事実だけを
  1行で持つ（`UNIQUE(user_id, puzzle_id)` 相当の複合主キー、`cleared_at` は最初のクリア日時）。
  progress 保存時にサーバー側でクリア状態を検出して記録する。progress 由来の「クリア済み」表示は
  再プレイの上書きで消えるが、こちらは残り続ける。いまのところ画面表示には使っていない。
- **クリアコメント** = `puzzle_comments` テーブル。そのパズルをクリアした人（`puzzle_clears` に行がある人）
  だけが書ける。1ユーザー・1パズルにつき1件（複合主キー）で、登録済みなら上書き（＝「変更」）。
  本文はコードポイントで200文字まで（DB の CHECK と api.cgi の両方で検査）。
  パズル情報カードの「コメント」タブに一覧＋入力欄が出て、完成ダイアログの
  「クリアコメントを書く」からもそのタブへ直行できる。

### ソース（フロント）

| ファイル | 中身 | 移植元 (mac版) |
|---|---|---|
| `src/lib/jigsaw.ts` | シード付き乱数、タブ曲線、グリッド全体の境界線 | `JigsawShape.swift` |
| `src/lib/generator.ts` | 画像の読み込み・縮小・ピース切り出し・アップロード用データ作成 | `PuzzleGenerator.swift` |
| `src/lib/game.ts` | 進行状態（位置・回転・連結・経過時間・保存/復元・スナップショット） | `PuzzleGameState.swift` ほか |
| `src/lib/status.ts` | 途中経過→状態（未プレイ/プレイ中/クリア済み）判定 | `RecentPuzzle.status` |
| `src/lib/settings.ts` / `sound.ts` / `shapes.ts` | 背景色・経過時間表示 / 効果音 / 歩くピースのコマ割り | `AppSettings` / `SoundEffects` / `SetupView` |
| `src/api.ts` | API クライアント（認証・画像・途中経過） | （Web 版で新規） |
| `src/components/SetupView.tsx` | 3欄（画像一覧・パズル一覧・プレイしたパズル）・画像アップロード | `SetupView.swift` |
| `src/components/PuzzleBoard.tsx` | 盤面（canvas 描画・ドラッグ・拡大縮小） | `PuzzleBoardView` + `ZoomableScrollView` |
| `src/components/GameHUD.tsx` / `GameView.tsx` | 上端の操作バー / 一時停止・完成図などの重ね表示・サーバー保存 | `GameHUDView` / `PuzzleBoardView` + `GameCoordinator` |
| `src/components/AuthView.tsx` / `SignupCompleteView.tsx` / `ResetPasswordView.tsx` / `AccountMenu.tsx` | 認証まわり | （Web 版で新規。nenpyo を参考） |

### API（`api.cgi`、`?action=` と HTTP メソッドで分岐）

| メソッド | action | 内容 |
|---|---|---|
| GET | env | `{env}` 実行環境名（env.pl 由来） |
| POST | signup_request | `{email}` 確認リンクをメール送信（既登録でも {ok} を返し、存在を秘匿） |
| GET | signup_verify&token=T | リンクの有効性確認 → `{email}` |
| POST | signup_complete | `{token,username,password}` 登録してログイン |
| POST | login | `{email,password}` ログイン |
| POST | logout | ログアウト |
| POST | change_password | `{current_password,new_password}` パスワード変更 |
| POST | reset_request | `{email}` 登録済みなら再設定リンクを送る（存在は秘匿） |
| GET | reset_verify&token=T | → `{email}` |
| POST | reset_complete | `{token,password}` 新パスワードを設定してログイン |
| DELETE | account | アカウント削除（progress は CASCADE、アップロード画像は残る） |
| GET | me | `{username,email,is_admin}` / 未ログインは 401 |
| GET | images | アップロード画像一覧 |
| POST | image | `{display_name,ext,width,height,full,thumb}` アップロード（要ログイン。full/thumb は base64） |
| DELETE | image&id=ID | 画像削除（本人または管理者。パズル・進行も CASCADE 削除） |
| GET | puzzles | 作成済みパズル一覧（誰でも。画像情報＋作成者名つき） |
| POST | puzzle | `{image_id,columns,rows}` パズルを作成（同じ画像＋グリッドは束ねる。要ログイン） |
| GET | progress | 自分の途中経過一覧（要ログイン。パズル＋画像情報つき） |
| PUT | progress | `{puzzle_id,state}` 保存（upsert。要ログイン。クリア状態なら puzzle_clears にクリア歴も記録） |
| DELETE | progress&id=ID | 途中経過を削除（要ログイン） |
| GET | puzzle_comments&puzzle_id=ID | クリアコメント一覧（誰でも。自分の分は mine で返る） |
| PUT | puzzle_comment | `{puzzle_id,body}` クリアコメントの登録/変更（クリアした人のみ・1人1件・200文字まで） |

## 遊び方の仕組み（mac 版と同じ）

- ピース形状は**シード 453 の決定的な乱数**から作る。画像とグリッドさえ分かれば同じ形に切り直せる。
- 隣り合う2ピースは**同じ境界曲線**を共有するので必ずかみ合う。
- 開始時、ピースは盤面の周り（盤面の 1.4 倍の帯）に散らばり、30度刻みでランダムに回っている。
  つかむと必ず 0 度に戻る。**回ったままのピースは連結の相手にならない**。
- 正しい隣どうしが近づくと、**動かした側だけ**が寄ってつながる。正解位置の近くへ持っていくとはまる。
- **全ピースが1つのかたまりになったら完成**（ログイン中なら自動で「クリア済み」として記録）。

### 操作

| 操作 | 動き |
|---|---|
| ピースをドラッグ | 動かす（つながっているものは一緒に動く） |
| 何もない所をドラッグ／スクロール | 画面を移動 |
| Ctrl+スクロール／トラックパッドのピンチ | カーソル位置を中心に拡大縮小 |
| 2本指ピンチ（タッチ） | 拡大縮小＋移動 |

## 管理者による画像の追加

画像をギャラリーに置くには、共有画像ディレクトリの `incoming/` に画像ファイル（jpg/png/webp/gif）を
置いてシードスクリプトを実行する（`owner_id=NULL`＝管理者設置として登録される）。`appdata/incoming/` は
`/var/jp.peanutsjamjam.zigsaw.appdata/incoming/` へのシンボリックリンク越しに同じ場所を指す。

```
cp <画像...> /var/jp.peanutsjamjam.zigsaw.appdata/incoming/
/usr/bin/perl ~/public_html/zigsaw/ddl/seed_images.pl
```

サーバーに画像処理系が無いので縮小はしない（full/thumb には元画像をそのまま置く）。
大きすぎる画像は、あらかじめ手元で長辺 1800px 程度に縮小してから置くのが望ましい。

## 開発・公開フロー

編集は dev（`~/public_html/zigsaw` → `/~sugawara/zigsaw/`）で行う。ビルド前に nvm を有効化する。

```
cd ~/public_html/zigsaw
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
npm run dev      # ローカル確認 (http://localhost:5173) ※api.cgi/DB はローカルには無い
npm run build    # dist/ を更新（dev 配信 /~sugawara/zigsaw/ に反映）
npm run lint
```

- `api.cgi` は編集後 `git pull` だけで反映（ビルド不要）。構文確認は `/usr/bin/perl -c api.cgi`。
- ブラウザ確認時はキャッシュに注意（Ctrl+F5 / Cmd+Shift+R）。

## 本番（zigsaw.peanutsjamjam.jp）

dev（`~/public_html/zigsaw` → `/~sugawara/zigsaw/`）とは別系統の本番サイト。**データ（DB `zigsaw`・
画像の実ファイル）は dev と共有する**。

- **場所**: `/var/jp.peanutsjamjam.zigsaw/html`（GitHub `zigsaw-web` の git clone）。`env.pl` は
  `$main::ZIGSAW_ENV = 'production'`。
- **Apache**: vhost は `/etc/httpd/conf.d/zigsaw.conf`（HTTP→HTTPS リダイレクト＋HTTPS）。証明書は
  Let's Encrypt（`certbot certonly --webroot -w /var/jp.peanutsjamjam.zigsaw/html -d zigsaw.peanutsjamjam.jp`、
  自動更新あり）。
- **実行ユーザーと DB**: 本番の CGI は **`apache` ユーザー**で動く（suexec の docroot は `/var/www` のみで
  この場所は対象外、`SuexecUserGroup` も無いため）。PostgreSQL へは **peer 認証で role=`apache`** として
  接続する。よって `apache` ロールに `zigsaw` の各テーブル/シーケンスへの権限を付与してある
  （`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES` ＋ `USAGE,SELECT ON ALL SEQUENCES` ＋
  同内容の `ALTER DEFAULT PRIVILEGES`。今後テーブルを追加したら同じ付与が必要）。
  - dev 側の CGI は UserDir + suexec で **`sugawara`** として動き、role=`sugawara`（テーブル所有者）で接続する。
- **画像の実ファイル**: 正本は **`/var/jp.peanutsjamjam.zigsaw.appdata`**（`full/` `thumb/` `incoming/`。
  ほかに whois キャッシュの `whois/` もここに置く）。
  dev の `~/public_html/zigsaw/appdata` と本番の `html/appdata` は、どちらもここへの**シンボリックリンク**。
  リンク・実体とも sugawara 所有なので、dev/本番の vhost の `Options SymLinksIfOwnerMatch` で追従できる。
  dev は sugawara、本番は apache が書き込むため、この正本ディレクトリに **POSIX ACL** を設定して両ユーザーに
  rwx を許可し、新規ファイルにも継承させてある:
  ```
  setfacl -R    -m u:apache:rwx -m u:sugawara:rwx /var/jp.peanutsjamjam.zigsaw.appdata
  setfacl -R -d -m u:apache:rwx -m u:sugawara:rwx /var/jp.peanutsjamjam.zigsaw.appdata
  ```
  CGI の `APPDATA_DIR` は `dirname(api.cgi)/appdata` で、このシンボリックリンク越しに正本へ解決される
  （dev・本番でコードは同じ）。
- **デプロイ**（フロント／`api.cgi` を更新したとき）:
  ```
  git -C /var/jp.peanutsjamjam.zigsaw/html pull --ff-only
  # フロント(src/)を変えたときだけビルド:
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
  npm --prefix /var/jp.peanutsjamjam.zigsaw/html run build
  ```
  `api.cgi` は pull だけで反映（ビルド不要）。

## サーバー前提（セットアップ済み）

- システム perl `/usr/bin/perl` に `perl-DBI` / `perl-DBD-Pg` / `perl-JSON-PP` / `perl-Digest-SHA` を導入済み。
- DB `zigsaw` は作成済み（`createdb zigsaw`）。スキーマは `ddl/` にリレーションごとに置いてある。
  新規構築は依存順に流す:
  `for f in users sessions signup_tokens reset_tokens access_log rate_events images tags puzzles progress puzzle_clears puzzle_comments; do psql -d zigsaw -f ddl/$f.sql; done`
  （`tags.sql` は tags と image_tags の2つを作る。`migrate_*.sql` は既存 DB 用なので新規構築では流さない）。
- CGI は suexec で `sugawara` として動くため、peer 認証でパスワード無し接続できる。
- 環境名は `env.pl`（git 管理外。`env.pl.example` をコピーして作る）の `$main::ZIGSAW_ENV`。
- メール送信は `/usr/sbin/sendmail` を使う（差出人 `zigsaw@peanutsjamjam.jp`）。
