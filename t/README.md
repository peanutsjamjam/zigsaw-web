# api.cgi のテスト

`api.cgi` を Apache を介さず CGI プロセスとして直接実行する結合テスト。
本物の `zigsaw` DB・共有画像ディレクトリ・実メールには一切触れない。

## 実行方法

```
cd ~/public_html/zigsaw
/usr/local/bin/prove t            # 全部
/usr/local/bin/prove -v t/02_auth.t   # 1ファイルだけ・詳細表示
```

（PATH の `prove` は /usr/local の perl 5.44 のもの。ハーネスはそれで動き、
api.cgi 本体は DBI の入ったシステムの /usr/bin/perl の子プロセスで動く。）

## 仕組み

- `t/lib/ZigsawTest.pm` がテストファイルごとに次を用意する:
  - `t/tmp/sandbox/` に api.cgi をコピーし、テスト用 `env.pl` を書く。
    api.cgi の設定差し替え口（`$ZIGSAW_DB` / `$ZIGSAW_SENDMAIL` /
    `$ZIGSAW_QUARANTINE_DIR`）を、専用 DB **zigsaw_test**・偽 sendmail
    （送信内容を `mail.log` に記録するだけ）・サンドボックス内の隔離先に向ける。
  - `zigsaw_test` DB を `ddl/*.sql` から作り直す（毎回まっさら）。
  - 画像の実ファイルは api.cgi が自分の場所を基準に解決するので、
    サンドボックス内の `images/` に書かれる。
- リクエストは CGI の環境変数（REQUEST_METHOD / QUERY_STRING / HTTP_COOKIE
  など）を組み立てて子プロセスで実行し、Status 行・ヘッダ・JSON を検証する。
- 起動時に「zigsaw_test に直接作ったセッションで `action=me` が通るか」を
  確認し、通らなければ（＝本物の DB を見ていれば）即座に中断する。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `01_basic.t` | ルーティング、401/404、Cookie 属性、ボディ上限、アクセスログ |
| `02_auth.t` | サインアップ（メール確認・重複・レート制限）、ログイン（総当たり抑止）、パスワード変更・再設定、退会 |
| `03_images.t` | アップロード（検証・実ファイル）、一覧・ページング・絞り込み、タイトル/タグ変更、権限、削除、タグ掃除 |
| `04_puzzles_progress.t` | パズル作成・束ね・一覧・絞り込み・削除（使用中 409）、進捗の upsert・一覧・snapshot・削除、CASCADE |
| `05_admin.t` | dev_*（非管理者には 404）、緊急退避（ファイル移動・meta.json・巻き添え削除） |

`02_auth.t` は PBKDF2（12万回）を実際に回すので十数秒かかる。
