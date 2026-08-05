#!/usr/bin/perl
use strict;
use warnings;
use utf8;
use DBI;
use JSON::PP;
use Digest::SHA qw(hmac_sha256);
use MIME::Base64 ();
use File::Basename qw(dirname);
use Socket qw(inet_pton AF_INET AF_INET6);

# Zigsaw (ジグソーパズル) API  (CGI / Perl + PostgreSQL)
#
# 配信:  Apache UserDir 配下、suexec で sugawara として実行される。
#        そのため PostgreSQL へは peer 認証（パスワード不要）で接続できる。
# DB:    zigsaw（users / sessions / signup_tokens / reset_tokens / access_log / rate_events / images /
#        tags / image_tags / puzzles / progress）。
#        画像のタグは tags / image_tags（多対多）。定義は ddl/*.sql 参照。
# 認証:  ログイン時にランダムトークンを sessions に保存し、HttpOnly Cookie
#        (zigsaw_sid) で受け渡す。パスワードは PBKDF2-HMAC-SHA256 で保存。
#        未ログインでもギャラリー閲覧・プレイはできる（保存だけできない）。
#
# 画像:  みんなで遊べる共有ギャラリー。実ファイルは api.cgi と同じディレクトリの
#        appdata/full（遊ぶ用の縮小画像）と appdata/thumb（一覧用サムネ）に置く。
#        縮小もサムネ生成もクライアント側で行い、アップロードは base64 で受け取って
#        バイトを書くだけ（サーバーに画像処理系が無いため）。
#
# エンドポイント（?action= と REQUEST_METHOD で分岐）:
#   GET    ?action=env                              -> {env}（実行環境名。env.pl 由来）
#   POST   ?action=signup_request  {email}          -> 確認リンクをメール送信（まだ登録しない）
#   GET    ?action=signup_verify&token=<t>          -> {email}（リンクの有効性確認）
#   POST   ?action=signup_complete {token,username,password}
#                                                   -> 登録してログイン状態に
#                                                      重複時は 409 {error:'duplicate', fields:[...]}
#   POST   ?action=login     {email,password}       -> ログイン（メールアドレスで認証）
#   POST   ?action=logout                           -> ログアウト
#   POST   ?action=change_password {current_password,new_password}
#   POST   ?action=reset_request  {email}           -> 登録済みなら再設定リンクを送る（存在は秘匿）
#   GET    ?action=reset_verify&token=<t>           -> {email}
#   POST   ?action=reset_complete {token,password}  -> 新パスワードを設定してログイン状態に
#   DELETE ?action=account                          -> アカウント削除（progress は CASCADE 削除、
#                                                      アップロード画像は owner_id が NULL になり残る）
#   GET    ?action=me                               -> {username,email,is_admin} or 401
#   （dev_* は「開発環境」かつ「管理者でログイン中」のときだけ応答する。どちらか欠けると 404）
#   GET    ?action=dev_storage                      -> 画像ディレクトリの画像数/合計サイズ・FSの空き/総容量
#   GET    ?action=dev_users                        -> 全ユーザー一覧（salt/iterations は返さない）
#   GET    ?action=dev_user_detail&id=<uid>         -> 指定ユーザーの画像/パズル/保存ゲーム
#   GET    ?action=dev_access_log                   -> access_log のダイジェスト（IP ごとに最新の1行。
#                                                      whois で調べた Organization 付き）
#   GET    ?action=images[&page=&per_page=&tag=&tag=&mine=1&pieces=2-50,401-]
#                                                   -> アップロード画像一覧（未ログインでも可）。
#                                                      {images,total,page,per_page}。絞り込み・
#                                                      ページングはサーバー側で行う（tag は複数=AND、
#                                                      pieces のカンマ区切りは OR）
#   GET    ?action=image&id=<id>                    -> 画像1件（一覧に無い1件を引く用）
#   GET    ?action=tags                             -> 使われているタグ名の一覧（誰でも）
#   POST   ?action=image  {display_name,original_name,width,height,ext,full,thumb}
#                                                   -> 画像アップロード（要ログイン。full/thumb は base64。
#                                                      display_name=タイトル、original_name=ファイル名）
#   PUT    ?action=image&id=<id>  {display_name,tags?}  -> display_name/タグを変更（本人または管理者。
#                                                      tags はタグ名の配列。キーが無ければタグは変えない）
#   DELETE ?action=image&id=<id>                    -> 画像削除（本人または管理者。パズル/進行も CASCADE 削除）
#   POST   ?action=image_quarantine&id=<id>         -> 緊急退避（管理者のみ）。画像・パズル・進捗を
#                                                      アプリから消し、実ファイルと消す前の内容を
#                                                      /home/zigsaw/quarantine へ移す
#   GET    ?action=puzzles[&page=&per_page=&tag=&tag=&mine=1&pieces=2-50,401-]
#                                                   -> 作成済みパズル一覧（誰でも。画像情報+作成者名つき）。
#                                                      {puzzles,total,page,per_page}
#          ?action=puzzles&image_id=<id>            -> その画像のパズルを全件（ページングなし）
#   POST   ?action=puzzle {image_id,columns,rows}   -> パズルを作成（同じ画像+グリッドは1つに束ねる。要ログイン）
#   DELETE ?action=puzzle&id=<id>                   -> パズル削除（作成者/管理者。プレイ中の人がいると 409）
#   GET    ?action=progress                         -> 自分の途中経過一覧（要ログイン。パズル+画像情報つき。
#                                                      一覧では重い snapshot は省く）
#   GET    ?action=progress_snapshot&id=<id>        -> その途中経過の「現在の様子」snapshot だけを返す（要ログイン）
#   PUT    ?action=progress {puzzle_id,state}       -> 途中経過を保存（upsert。要ログイン）
#   DELETE ?action=progress&id=<id>                 -> 途中経過を削除（要ログイン）

my $COOKIE_NAME  = 'zigsaw_sid';
# Cookie の Path は配信パスに合わせて自動判定する（環境ごとに固定値を持たない）。
# SCRIPT_NAME から api.cgi を除いたディレクトリ部を使う。
#   dev: /~sugawara/zigsaw/api.cgi -> /~sugawara/zigsaw/
#   本番: /api.cgi                -> /
my $COOKIE_PATH  = $ENV{SCRIPT_NAME} || '/';
$COOKIE_PATH =~ s#/[^/]*$#/#;
$COOKIE_PATH = '/' if $COOKIE_PATH eq '';
my $SESSION_DAYS = 30;
my $PBKDF2_ITER  = 120000;
my $SIGNUP_TOKEN_HOURS = 1;
my $RESET_TOKEN_HOURS  = 1;
my $MAIL_FROM    = 'zigsaw@peanutsjamjam.jp';
# アップロード画像の最大バイト数（full/thumb それぞれの、デコード後のサイズ）。
my $MAX_IMAGE_BYTES = 8 * 1024 * 1024;
# リクエストボディの最大バイト数。画像は base64 で約 4/3 に膨らむので、その余裕をみる。
# Apache 側の LimitRequestBody（.htaccess）と同じ値にしておくこと。
my $MAX_BODY_BYTES = 12 * 1024 * 1024;
# progress の state（プレイ中の盤面スナップショット）の最大バイト数（JSON エンコード後）。
my $MAX_STATE_BYTES = 1024 * 1024;

# ---- レート制限のしきい値（rate_events テーブルで直近件数を数える） --------
# login: 直近 $LOGIN_WINDOW_MIN 分の失敗が、同一メール/同一IPでこの回数以上なら一時的に拒否。
my $LOGIN_WINDOW_MIN    = 15;
my $LOGIN_MAX_PER_EMAIL = 5;
my $LOGIN_MAX_PER_IP    = 20;
# signup/reset のメール送信: 直近 $MAIL_WINDOW_MIN 分に、同一宛先/同一IPでこの通数以上なら送らない
# （応答は存在秘匿・スロットル秘匿のため通常どおり {ok}）。
my $MAIL_WINDOW_MIN     = 60;
my $MAIL_MAX_PER_EMAIL  = 3;
my $MAIL_MAX_PER_IP     = 10;

# アクセスログの保持日数。これより古い行は log_access のついでに時々（確率的に）掃除する。
my $ACCESS_LOG_KEEP_DAYS = 90;

# 実行環境名。api.cgi と同じディレクトリの env.pl（git 管理外。dev/本番で内容が異なる）を
# require し、その中で $main::ZIGSAW_ENV を設定する。未設置なら 'unknown'。
our $ZIGSAW_ENV = 'unknown';
# アプリのベース URL（末尾スラッシュ付き。例 https://zigsaw.peanutsjamjam.jp/）。
# env.pl で $main::ZIGSAW_BASE_URL に設定する。メール内リンク等の絶対 URL 生成に使い、
# これがあると Host ヘッダに依存しない（＝リセットリンク等の Host インジェクションを防ぐ）。
our $ZIGSAW_BASE_URL = '';
# 接続する PostgreSQL のデータベース名。テスト（t/）がサンドボックスの env.pl で
# 専用 DB（zigsaw_test）に差し替える。dev / 本番では既定値のまま使う。
our $ZIGSAW_DB = 'zigsaw';
# sendmail のパス。テストでは送信内容をファイルに記録する偽 sendmail に差し替える。
our $ZIGSAW_SENDMAIL = '/usr/sbin/sendmail';
# 緊急退避（公序良俗に反する投稿などを、管理者がアプリから消して隔離する）先。
# 実ファイルと、消す前の DB の行（画像・パズル・進捗・タグ）をここに書き出す。
# dev / 本番で同じ場所を使う。書き込めるよう ACL で apache と sugawara に rwx を与えてある。
our $ZIGSAW_QUARANTINE_DIR = '/home/zigsaw/quarantine';
# whois コマンドのパス（dev_access_log の Organization 表示に使う）。
# テストでは決まった応答を返す偽 whois に差し替える。
our $ZIGSAW_WHOIS = '/usr/bin/whois';
{
    my $env_file = dirname(__FILE__) . '/env.pl';
    require $env_file if -f $env_file;
}

# アプリデータ（画像の実ファイル・whois キャッシュ）を置くディレクトリ
# （api.cgi と同じ場所を基準にする）。
my $APPDATA_DIR = dirname(__FILE__) . '/appdata';
# whois の結果をキャッシュするディレクトリ（無ければ使うときに作る）。
# appdata/ はシンボリックリンクなので、実体は /var/jp.peanutsjamjam.zigsaw.appdata/whois になる。
my $WHOIS_CACHE_DIR = "$APPDATA_DIR/whois";

my $JSON = JSON::PP->new->utf8->canonical;

# ---- HTTP 出力 -------------------------------------------------------------
my @EXTRA_HEADERS;
sub add_header { push @EXTRA_HEADERS, $_[0]; }

sub respond {
    my ($data, $status) = @_;
    $status ||= '200 OK';
    my $body = $JSON->encode($data);
    binmode STDOUT;
    print "Status: $status\r\n";
    print "Content-Type: application/json; charset=utf-8\r\n";
    print "$_\r\n" for @EXTRA_HEADERS;
    print "Content-Length: " . length($body) . "\r\n";
    print "\r\n";
    print $body;
    exit 0;
}

sub fail {
    # $code はエラーコード（フロントで表示）。$params は補間値（任意）。
    my ($code, $status, $params) = @_;
    $status ||= '400 Bad Request';
    my $body = { error => $code };
    $body->{params} = $params if defined $params;
    respond($body, $status);
}

# ---- 入力 ------------------------------------------------------------------
sub query_param {
    my ($name) = @_;
    my $qs = $ENV{QUERY_STRING} || '';
    for my $pair (split /&/, $qs) {
        my ($k, $v) = split /=/, $pair, 2;
        next unless defined $k && $k eq $name;
        $v = '' unless defined $v;
        $v =~ tr/+/ /;
        $v =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
        # %xx を戻した時点ではバイト列なので、UTF-8 として文字列に直す
        # （タグ名など非 ASCII を DB と突き合わせるのに必要。壊れていればそのまま返す）。
        utf8::decode($v);
        return $v;
    }
    return undef;
}

# 同じ名前のクエリパラメータを全部返す（tag=a&tag=b のような複数指定用）。
sub query_params {
    my ($name) = @_;
    my $qs = $ENV{QUERY_STRING} || '';
    my @out;
    for my $pair (split /&/, $qs) {
        my ($k, $v) = split /=/, $pair, 2;
        next unless defined $k && $k eq $name;
        $v = '' unless defined $v;
        $v =~ tr/+/ /;
        $v =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
        utf8::decode($v);
        push @out, $v;
    }
    return @out;
}

sub read_body_json {
    my $length = $ENV{CONTENT_LENGTH} || 0;
    return {} if $length <= 0;
    # 読み込む前に上限で弾く。通常は Apache の LimitRequestBody が先に 413 を返すが、
    # そちらの設定が失われてもメモリを食い潰さないよう、ここでも見る。
    fail('payload_too_large', '413 Payload Too Large') if $length > $MAX_BODY_BYTES;
    my $raw = '';
    my $got = 0;
    # 大きめのアップロードでも取りこぼさないよう、必要分を読み切る。
    while ($got < $length) {
        my $chunk = '';
        my $n = read(STDIN, $chunk, $length - $got);
        last if !defined $n || $n == 0;
        $raw .= $chunk;
        $got += $n;
    }
    return {} if $raw eq '';
    my $data = eval { $JSON->decode($raw) };
    return $data && ref($data) eq 'HASH' ? $data : {};
}

sub get_cookie {
    my ($name) = @_;
    my $raw = $ENV{HTTP_COOKIE} || '';
    for my $pair (split /;\s*/, $raw) {
        my ($k, $v) = split /=/, $pair, 2;
        next unless defined $k && $k eq $name;
        return defined $v ? $v : '';
    }
    return undef;
}

# ---- 乱数・パスワード ------------------------------------------------------
sub random_hex {
    my ($bytes) = @_;
    open my $fh, '<:raw', '/dev/urandom' or die "urandom: $!";
    read($fh, my $buf, $bytes);
    close $fh;
    return unpack('H*', $buf);
}

# PBKDF2-HMAC-SHA256, 1 ブロック (32byte) 分。hex を返す。
sub pbkdf2 {
    my ($password, $salt_hex, $iter) = @_;
    my $salt = pack('H*', $salt_hex);
    utf8::encode($password) if utf8::is_utf8($password);
    my $u   = hmac_sha256($salt . pack('N', 1), $password);
    my $out = $u;
    for (my $i = 1; $i < $iter; $i++) {
        $u = hmac_sha256($u, $password);
        $out ^= $u;
    }
    return unpack('H*', $out);
}

# 一定時間比較（タイミング攻撃緩和）
sub const_eq {
    my ($a, $b) = @_;
    return 0 if length($a) != length($b);
    my $r = 0;
    $r |= ord(substr($a, $_, 1)) ^ ord(substr($b, $_, 1)) for 0 .. length($a) - 1;
    return $r == 0;
}

# PostgreSQL の bool（'t'/'f' や 1/0）を JSON::PP の true/false にする。
sub pgbool {
    my ($v) = @_;
    return JSON::PP::false unless defined $v;
    return ($v eq 't' || $v eq '1' || $v eq 'true' || (Scalar_true($v))) ? JSON::PP::true : JSON::PP::false;
}
sub Scalar_true { my $v = shift; return (!ref($v) && $v =~ /^\d+$/ && $v != 0) ? 1 : 0; }

# ---- DB --------------------------------------------------------------------
sub db {
    my $dbh = DBI->connect(
        "dbi:Pg:dbname=$ZIGSAW_DB", '', '',
        { RaiseError => 1, AutoCommit => 1, PrintError => 0, pg_enable_utf8 => 1 }
    ) or fail('db_error', '500 Internal Server Error');
    return $dbh;
}

# アクセスログ: 送信元 IP（Apache が付ける REMOTE_ADDR）と、ログイン中ならその user_id を
# 1行記録する。記録に失敗してもリクエスト自体は止めない（warn のみ）。未ログインは undef（NULL）。
sub log_access {
    my ($dbh, $user_id) = @_;
    my $ip = $ENV{REMOTE_ADDR};
    return unless defined $ip && $ip ne '';
    eval { $dbh->do('INSERT INTO access_log (user_id, ip_addr) VALUES (?, ?)', undef, $user_id, $ip); 1 }
        or warn "log_access failed: $@\n";
    # 毎リクエストで DELETE を打つのは無駄なので、たまに（約2%）だけ古い行を掃除する。
    purge_old_access_log($dbh) if rand() < 0.02;
}

# 保持日数より古いアクセスログを掃除する（ついで掃除。テーブル肥大化を防ぐ）。
sub purge_old_access_log {
    my ($dbh) = @_;
    eval {
        $dbh->do('DELETE FROM access_log WHERE accessed_at < now() - make_interval(days => ?)',
            undef, $ACCESS_LOG_KEEP_DAYS);
        1;
    } or warn "purge_old_access_log failed: $@\n";
}

# ---- whois（dev_access_log の Organization 表示） ---------------------------
# IP アドレスを whois で調べ、Organization の値を返す。結果はアドレス範囲
# （NetRange / inetnum）ごとに $WHOIS_CACHE_DIR に JSON で1ファイルずつ保存し、
# 同じ範囲に入る IP については whois コマンドを叩き直さない。

# IP 文字列をバイト列にする（範囲比較用。v4/v6 とも網羅。不正な形式なら undef）。
# ネットワークバイトオーダーの固定長なので、同じ長さどうしの文字列比較が数値比較になる。
sub ip_pack {
    my ($ip) = @_;
    return undef unless defined $ip && $ip =~ /^[0-9A-Fa-f.:]+$/;
    return inet_pton($ip =~ /:/ ? AF_INET6 : AF_INET, $ip);
}

# キャッシュから $ip を含む範囲のエントリを探す。無ければ undef。
sub whois_cache_find {
    my ($ip) = @_;
    my $packed = ip_pack($ip) or return undef;
    opendir(my $dh, $WHOIS_CACHE_DIR) or return undef;
    while (defined(my $name = readdir $dh)) {
        next unless $name =~ /\.json$/;
        my $entry = eval {
            open my $fh, '<:raw', "$WHOIS_CACHE_DIR/$name" or die $!;
            local $/; $JSON->decode(scalar <$fh>);
        } or next;
        my $s = ip_pack($entry->{start});
        my $e = ip_pack($entry->{end});
        next unless defined $s && defined $e && length($s) == length($packed);
        return $entry if $packed ge $s && $packed le $e;
    }
    return undef;
}

# whois コマンドを実行して出力を返す。失敗・タイムアウト時は空文字列。
sub whois_fetch {
    my ($ip) = @_;
    my $out = '';
    eval {
        local $SIG{ALRM} = sub { die "whois timeout\n" };
        alarm 10;
        open(my $fh, '-|', $ZIGSAW_WHOIS, $ip) or die "exec: $!\n";
        local $/; $out = <$fh> // '';
        close $fh;
        alarm 0;
        1;
    } or do { alarm 0; $out = ''; warn "whois $ip failed: $@" };
    # RIR によっては非 ASCII が混ざる（JPNIC など）。UTF-8 なら文字列として扱う。
    utf8::decode($out);
    return $out;
}

# whois 出力からアドレス範囲と Organization を抜き出す。
#   範囲: NetRange（ARIN）/ inetnum・inet6num（APNIC・RIPE）の「開始 - 終了」形式。
#   組織: Organization（ARIN）を第一候補に、OrgName / org-name / descr の順で拾う。
sub whois_parse {
    my ($out) = @_;
    my ($start, $end);
    if ($out =~ /^\s*(?:NetRange|inet6?num):\s*([0-9A-Fa-f.:]+)\s*-\s*([0-9A-Fa-f.:]+)\s*$/mi) {
        ($start, $end) = ($1, $2);
    }
    my $org;
    for my $re (qr/^\s*Organization:\s*(.+?)\s*$/mi, qr/^\s*OrgName:\s*(.+?)\s*$/mi,
                qr/^\s*org-name:\s*(.+?)\s*$/mi,     qr/^\s*descr:\s*(.+?)\s*$/mi) {
        if ($out =~ $re) { $org = $1; last }
    }
    return ($start, $end, $org);
}

# $ip の Organization を返す（キャッシュ優先。分からなければ undef）。
sub whois_org_for_ip {
    my ($ip) = @_;
    return undef unless defined ip_pack($ip);
    if (my $hit = whois_cache_find($ip)) { return $hit->{organization} }

    my $out = whois_fetch($ip);
    return undef if $out eq '';   # 失敗は保存しない（次回また試す）
    my ($start, $end, $org) = whois_parse($out);
    # 範囲が読み取れない出力だったら、その IP 1つだけの範囲として保存する
    # （同じ IP で毎回叩き直すのを避ける。Organization 無しでもその事実を保存する）。
    ($start, $end) = ($ip, $ip)
        unless defined ip_pack($start) && defined ip_pack($end)
            && length(ip_pack($start)) == length(ip_pack($end));

    mkdir $WHOIS_CACHE_DIR unless -d $WHOIS_CACHE_DIR;
    (my $fname = "$start-$end.json") =~ tr/:/_/;   # v6 の ':' はファイル名では '_' にする
    eval {
        write_file("$WHOIS_CACHE_DIR/$fname", $JSON->encode({
            start        => $start,
            end          => $end,
            organization => $org,
            queried_ip   => $ip,
            fetched_at   => time(),
            raw          => $out,
        }));
        1;
    } or warn "whois cache write failed: $@";
    return $org;
}

# ---- レート制限 ------------------------------------------------------------
# 直近 $minutes 分の (action, subject) 件数を数える。
sub rate_count {
    my ($dbh, $action, $subject, $minutes) = @_;
    my ($n) = $dbh->selectrow_array(
        'SELECT count(*) FROM rate_events
          WHERE action = ? AND subject = ? AND created_at > now() - make_interval(mins => ?)',
        undef, $action, $subject, $minutes
    );
    return $n || 0;
}
sub rate_add {
    my ($dbh, $action, $subject) = @_;
    eval { $dbh->do('INSERT INTO rate_events (action, subject) VALUES (?, ?)', undef, $action, $subject); 1 }
        or warn "rate_add failed: $@\n";
}
sub rate_clear {
    my ($dbh, $action, $subject) = @_;
    eval { $dbh->do('DELETE FROM rate_events WHERE action = ? AND subject = ?', undef, $action, $subject); 1 }
        or warn "rate_clear failed: $@\n";
}
# 古いレートイベントを掃除する（ついで掃除）。
sub purge_old_rate_events {
    my ($dbh) = @_;
    eval { $dbh->do("DELETE FROM rate_events WHERE created_at < now() - interval '1 day'"); 1 }
        or warn "purge_old_rate_events failed: $@\n";
}

# ---- セッション ------------------------------------------------------------
sub set_session_cookie {
    my ($token, $days) = @_;
    $days ||= $SESSION_DAYS;
    my $max = $days * 24 * 3600;
    add_header("Set-Cookie: $COOKIE_NAME=$token; Path=$COOKIE_PATH; Max-Age=$max; HttpOnly; Secure; SameSite=Lax");
}

sub clear_session_cookie {
    add_header("Set-Cookie: $COOKIE_NAME=; Path=$COOKIE_PATH; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
}

# 期限切れセッションを掃除する（ついで掃除。テーブル肥大化を防ぐ）。
sub purge_expired_sessions {
    my ($dbh) = @_;
    eval { $dbh->do('DELETE FROM sessions WHERE expires_at < now()'); 1 }
        or warn "purge_expired_sessions failed: $@\n";
}
sub purge_expired_signup_tokens {
    my ($dbh) = @_;
    eval { $dbh->do('DELETE FROM signup_tokens WHERE expires_at < now()'); 1 }
        or warn "purge_expired_signup_tokens failed: $@\n";
}
sub purge_expired_reset_tokens {
    my ($dbh) = @_;
    eval { $dbh->do('DELETE FROM reset_tokens WHERE expires_at < now()'); 1 }
        or warn "purge_expired_reset_tokens failed: $@\n";
}

# ---- メール ----------------------------------------------------------------
# アプリのベース URL（api.cgi のあるディレクトリ）を、リクエストの host/scheme から組み立てる。
sub app_base_url {
    # 設定済みの固定ベース URL があれば最優先で使う。Host ヘッダに依存しないので、
    # メール内リンク（サインアップ/リセット）の Host インジェクションを防げる。
    if (defined $ZIGSAW_BASE_URL && $ZIGSAW_BASE_URL ne '') {
        my $b = $ZIGSAW_BASE_URL;
        $b .= '/' unless $b =~ m#/$#;   # 末尾スラッシュを保証
        return $b;
    }
    # 未設定時のフォールバック（後方互換）。この経路は HTTP_HOST に依存するので、
    # 本番/dev とも env.pl に ZIGSAW_BASE_URL を設定しておくこと。
    my $scheme = ($ENV{HTTPS} && lc $ENV{HTTPS} eq 'on') ? 'https'
               : ($ENV{REQUEST_SCHEME} || 'https');
    my $host = $ENV{HTTP_HOST} || 'localhost';
    my $base = $ENV{SCRIPT_NAME} || '/';
    $base =~ s#/[^/]*$#/#;
    return "$scheme://$host$base";
}

sub mime_word {
    my ($s) = @_;
    utf8::encode($s) if utf8::is_utf8($s);
    return '=?UTF-8?B?' . MIME::Base64::encode_base64($s, '') . '?=';
}

# 共通のメール送信。件名・本文（UTF-8 文字列）を受け取り、base64 で送る。
sub send_mail {
    my ($to, $subject, $body) = @_;
    utf8::encode($body) if utf8::is_utf8($body);
    my $ok = eval {
        open(my $mh, '|-', $ZIGSAW_SENDMAIL, '-t', '-i') or die "sendmail: $!";
        print $mh "From: Zigsaw <$MAIL_FROM>\r\n";
        print $mh "To: $to\r\n";
        print $mh "Subject: " . mime_word($subject) . "\r\n";
        print $mh "MIME-Version: 1.0\r\n";
        print $mh "Content-Type: text/plain; charset=\"UTF-8\"\r\n";
        print $mh "Content-Transfer-Encoding: base64\r\n";
        print $mh "\r\n";
        print $mh MIME::Base64::encode_base64($body);
        close($mh) or die "sendmail close: $!";
        1;
    };
    warn "send_mail failed: $@\n" unless $ok;
    return $ok ? 1 : 0;
}

sub send_signup_email {
    my ($to, $url) = @_;
    my $body = "Thank you for signing up for Zigsaw.\n"
             . "Open the link below and set your username and password to complete your registration.\n"
             . "(This link is valid for ${SIGNUP_TOKEN_HOURS} hour(s) only.)\n\n"
             . "$url\n\n"
             . "If you did not request this email, please ignore it.\n"
             . "\n----------------------------------------\n\n"
             . "Zigsaw への登録ありがとうございます。\n"
             . "下記のリンクを開き、ユーザー名とパスワードを設定すると登録が完了します。\n"
             . "（このリンクは ${SIGNUP_TOKEN_HOURS} 時間のみ有効です）\n\n"
             . "$url\n\n"
             . "このメールに心当たりがない場合は、破棄してください。\n";
    return send_mail($to, 'Your Zigsaw sign-up link / 【Zigsaw】登録用リンクのお知らせ', $body);
}

sub send_reset_email {
    my ($to, $url) = @_;
    my $body = "We received a request to reset your Zigsaw password.\n"
             . "Open the link below to set a new password.\n"
             . "(This link is valid for ${RESET_TOKEN_HOURS} hour(s) only.)\n\n"
             . "$url\n\n"
             . "If you did not request this, please ignore this email; your password will not change.\n"
             . "\n----------------------------------------\n\n"
             . "Zigsaw のパスワード再設定のリクエストを受け付けました。\n"
             . "下記のリンクを開いて、新しいパスワードを設定してください。\n"
             . "（このリンクは ${RESET_TOKEN_HOURS} 時間のみ有効です）\n\n"
             . "$url\n\n"
             . "心当たりがない場合は、このメールを破棄してください（パスワードは変更されません）。\n";
    return send_mail($to, 'Reset your Zigsaw password / 【Zigsaw】パスワード再設定のお知らせ', $body);
}

sub send_signup_exists_email {
    my ($to, $url) = @_;
    my $body = "Someone (perhaps you) tried to sign up for Zigsaw with this email address,\n"
             . "but an account already exists for it.\n"
             . "You can simply log in below. If you forgot your password, use \"Forgot your password?\".\n\n"
             . "$url\n\n"
             . "If this wasn't you, no action is needed; your account is unaffected.\n"
             . "\n----------------------------------------\n\n"
             . "このメールアドレスで Zigsaw への新規登録が試みられましたが、\n"
             . "すでにアカウントが存在します。\n"
             . "下記からそのままログインできます。パスワードをお忘れの場合は、ログイン画面の\n"
             . "「パスワードをお忘れですか？」から再設定してください。\n\n"
             . "$url\n\n"
             . "心当たりがない場合は、対応は不要です（アカウントに影響はありません）。\n";
    return send_mail($to, 'About your Zigsaw account / 【Zigsaw】アカウントについてのお知らせ', $body);
}

# ---- 認証ヘルパ ------------------------------------------------------------
# 現在のログインユーザー {id, username, email, is_admin} を返す。未ログインなら undef。
sub current_user {
    my ($dbh) = @_;
    my $token = get_cookie($COOKIE_NAME);
    return undef unless defined $token && $token =~ /^[0-9a-f]{16,128}$/;
    return $dbh->selectrow_hashref(
        'SELECT u.id, u.username, u.email, u.is_admin FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > now()',
        undef, $token
    );
}

sub require_user {
    my ($dbh) = @_;
    my $u = current_user($dbh);
    fail('not_authenticated', '401 Unauthorized') unless $u;
    return $u;
}

# 管理者専用エンドポイント用。未ログイン・非管理者はどちらも 404 で返す
# （401/403 で返し分けると、そのエンドポイントの存在自体を教えてしまう）。
sub require_admin {
    my ($dbh) = @_;
    my $u = current_user($dbh);
    fail('not_found', '404 Not Found')
        unless $u && pgbool($u->{is_admin}) == JSON::PP::true;
    return $u;
}

# 新しいセッションを作って Cookie を張る。
sub start_session {
    my ($dbh, $uid) = @_;
    my $token = random_hex(32);
    $dbh->do(
        "INSERT INTO sessions (token, user_id, expires_at)
         VALUES (?,?, now() + interval '$SESSION_DAYS days')",
        undef, $token, $uid
    );
    purge_expired_sessions($dbh);
    set_session_cookie($token);
}

# ---- 画像 ------------------------------------------------------------------
# ファイル名に使ってよい安全な basename か確認する。
sub safe_basename { my $s = shift; return defined $s && $s =~ /^[0-9a-f]{16,64}$/; }

# アップロードで受け付ける画像の拡張子（正規化後）。html/svg/js などを弾いて保存型 XSS を防ぐ。
# 入力の jpeg はアップロード処理で jpg に正規化してからこの集合で判定する。
my %ALLOWED_IMAGE_EXT = map { $_ => 1 } qw(jpg png webp gif);
sub allowed_image_ext { my $s = shift; return defined $s && $ALLOWED_IMAGE_EXT{$s}; }

# base64（data URL 前置きがあれば剥がす）をデコードして返す。長さ超過なら fail。
sub decode_upload {
    my ($b64, $what) = @_;
    fail('image_missing', '400 Bad Request', { field => $what }) unless defined $b64 && $b64 ne '';
    $b64 =~ s/^data:[^,]*,//;           # "data:image/png;base64," を剥がす
    $b64 =~ s/\s+//g;
    my $bytes = MIME::Base64::decode_base64($b64);
    fail('image_missing', '400 Bad Request', { field => $what }) if !defined $bytes || $bytes eq '';
    fail('image_too_large', '413 Payload Too Large', { field => $what }) if length($bytes) > $MAX_IMAGE_BYTES;
    return $bytes;
}

# ファイルを移す。まず rename、ダメなら（別ファイルシステム等）読み書きして元を消す。
sub move_file {
    my ($src, $dst) = @_;
    return 1 if rename($src, $dst);
    open my $in,  '<:raw', $src or die "open $src: $!";
    open my $out, '>:raw', $dst or die "open $dst: $!";
    my $buf;
    while (my $n = read($in, $buf, 1 << 20)) { print $out $buf }
    close $in;
    close $out or die "close $dst: $!";
    unlink $src;
    return 1;
}

sub write_file {
    my ($path, $bytes) = @_;
    open my $fh, '>:raw', $path or die "open $path: $!";
    print $fh $bytes;
    close $fh or die "close $path: $!";
}

# ---- タグ（tags / image_tags の多対多） ------------------------------------
# 行（の配列）に、その画像に付いているタグ名を名前順の配列で載せる。
# $key はその行のどの列が画像 id かで、画像行なら 'id'、パズル行なら 'image_id'。
# 1件ごとに引くと件数ぶん問い合わせが増えるので、まとめて1回で引く。
sub attach_tags {
    my ($dbh, $rows, $key) = @_;
    $key ||= 'id';
    my %uniq = map { $_->{$key} => 1 } @$rows;
    my @ids = keys %uniq;
    return $rows unless @ids;
    my $ph = join ',', ('?') x @ids;
    my $pairs = $dbh->selectall_arrayref(
        "SELECT it.image_id, t.name
           FROM image_tags it JOIN tags t ON t.id = it.tag_id
          WHERE it.image_id IN ($ph) ORDER BY t.name",
        { Slice => {} }, @ids
    );
    my %by_image;
    push @{ $by_image{ $_->{image_id} } }, $_->{name} for @$pairs;
    $_->{tags} = $by_image{ $_->{$key} } || [] for @$rows;
    return $rows;
}

# 受け取ったタグ（配列、または区切り文字で並べた1つの文字列）を、保存できる名前の配列に整える。
# 前後の空白を落とし、空・制御文字を除き、重複は1つにまとめる。長さと個数にも上限を置く。
my $MAX_TAG_LENGTH = 30;
my $MAX_TAGS_PER_IMAGE = 20;
sub normalize_tags {
    my ($input) = @_;
    my @raw = ref($input) eq 'ARRAY' ? @$input
            : defined $input         ? split(/[,、\s]+/, $input)
            :                          ();
    my (@names, %seen);
    for my $name (@raw) {
        next unless defined $name && !ref $name;
        $name =~ s/[\x00-\x1f\x7f]//g;      # 制御文字は落とす
        $name =~ s/^[\s\x{3000}]+|[\s\x{3000}]+$//g;   # 全角空白も含めて trim
        next if $name eq '';
        $name = substr($name, 0, $MAX_TAG_LENGTH);
        next if $seen{$name}++;
        push @names, $name;
        last if @names >= $MAX_TAGS_PER_IMAGE;
    }
    return \@names;
}

# 画像に付いているタグを、渡された名前の集合そのものに置き換える。
# 無い名前は tags に作り、外れたタグはどの画像からも参照されなくなったら消す。
sub set_image_tags {
    my ($dbh, $image_id, $names) = @_;
    my @tag_ids;
    for my $name (@$names) {
        my $tag_id = $dbh->selectrow_array('SELECT id FROM tags WHERE name = ?', undef, $name);
        $tag_id = $dbh->selectrow_array(
            'INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            undef, $name
        ) unless defined $tag_id;
        push @tag_ids, $tag_id;
    }
    if (@tag_ids) {
        my $ph = join ',', ('?') x @tag_ids;
        $dbh->do("DELETE FROM image_tags WHERE image_id = ? AND tag_id NOT IN ($ph)", undef, $image_id, @tag_ids);
        $dbh->do('INSERT INTO image_tags (image_id, tag_id) VALUES (?,?) ON CONFLICT DO NOTHING', undef, $image_id, $_)
            for @tag_ids;
    } else {
        $dbh->do('DELETE FROM image_tags WHERE image_id = ?', undef, $image_id);
    }
    purge_unused_tags($dbh);
}

# どの画像からも使われなくなったタグ行を消す（タグ変更・画像削除のついでに呼ぶ）。
sub purge_unused_tags {
    my ($dbh) = @_;
    $dbh->do('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM image_tags it WHERE it.tag_id = tags.id)');
}

# ---- 一覧の絞り込みとページング --------------------------------------------
# 一覧に効く絞り込みを、SQL の条件（WHERE に AND で足す）と束縛値にする。
#   tag=<名前>（複数可）  … そのタグが付いた画像／その画像から作られたパズル。
#                          複数指定は AND（全部のタグが付いているものだけ）。
#   mine=1               … 自分がアップロードした画像／その画像から作られたパズル。
#   pieces=2-50,401-     … ピース数の範囲。カンマ区切りで複数指定でき、そちらは OR
#                          （どれかの範囲に当てはまればよい）。上限なしは "401-"。
# $image_col は「その問い合わせで画像 id を指す式」（画像一覧なら i.id、パズル一覧なら p.image_id）。
# $piece_expr を渡すと、ピース数はその式（＝パズル自身の列×行）で判定する。渡さなければ
# 「その範囲のパズルを持っている画像か」を EXISTS で判定する。
sub list_filters {
    my ($image_col, $uid, $piece_expr) = @_;
    my (@where, @bind);

    for my $tag (query_params('tag')) {
        next if $tag eq '';
        push @where, "EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                               WHERE it.image_id = $image_col AND t.name = ?)";
        push @bind, $tag;
    }

    my $mine = query_param('mine');
    if (defined $mine && $mine eq '1') {
        push @where, "EXISTS (SELECT 1 FROM images mi WHERE mi.id = $image_col AND mi.owner_id = ?)";
        push @bind, $uid;
    }

    my $pieces = query_param('pieces');
    if (defined $pieces && $pieces ne '') {
        my $expr = $piece_expr || 'pz.columns * pz.rows';
        my (@ors, @pbind);
        for my $range (split /,/, $pieces) {
            my ($min, $max) = split /-/, $range, 2;
            next unless defined $min && $min =~ /^[0-9]+$/;
            if (defined $max && $max =~ /^[0-9]+$/) {
                push @ors, "($expr >= ? AND $expr <= ?)";
                push @pbind, int($min), int($max);
            } else {
                push @ors, "($expr >= ?)";
                push @pbind, int($min);
            }
        }
        if (@ors) {
            my $cond = '(' . join(' OR ', @ors) . ')';
            push @where, $piece_expr ? $cond
                       : "EXISTS (SELECT 1 FROM puzzles pz WHERE pz.image_id = $image_col AND $cond)";
            push @bind, @pbind;
        }
    }

    my $sql = @where ? ' AND ' . join(' AND ', @where) : '';
    return ($sql, \@bind);
}

# page / per_page を読んで (LIMIT, OFFSET) にする。per_page は 1〜200 に丸める。
sub list_paging {
    my $per_page = int(query_param('per_page') || 0);
    $per_page = 30  if $per_page < 1;
    $per_page = 200 if $per_page > 200;
    my $page = int(query_param('page') || 1);
    $page = 1 if $page < 1;
    return ($per_page, ($page - 1) * $per_page, $page);
}

# 画像1行を、フロントが使いやすい形（URL 付き）に整える。
sub image_row_to_json {
    my ($base_url, $row) = @_;
    return {
        id            => 0 + $row->{id},
        display_name  => $row->{display_name},
        original_name => $row->{original_name},
        tags          => $row->{tags} || [],        # タグ名の配列（名前順。attach_tags で載せる）
        width         => 0 + $row->{width},
        height        => 0 + $row->{height},
        owner         => $row->{owner_username},   # 投稿者名（管理者設置は null）
        upload_ip     => $row->{upload_ip},         # アップロード元 IP（不明なら null）
        created_at    => $row->{created_at},        # 投稿日時
        mine          => $row->{mine} ? JSON::PP::true : JSON::PP::false,
        full_url      => "${base_url}appdata/full/$row->{basename}.$row->{ext}",
        thumb_url    => "${base_url}appdata/thumb/$row->{basename}.jpg",   # サムネは常に JPEG
    };
}

# パズル1行（画像とjoin済み）を、フロントが使いやすい形（画像URL付き）に整える。
sub puzzle_row_to_json {
    my ($base_url, $row) = @_;
    return {
        id           => 0 + $row->{id},
        image_id     => 0 + $row->{image_id},
        columns      => 0 + $row->{columns},
        rows         => 0 + $row->{rows},
        creator       => $row->{creator_username},   # 作成者名（退会済みは null）
        mine          => $row->{mine} ? JSON::PP::true : JSON::PP::false,   # 作成者が自分か
        play_count    => 0 + ($row->{play_count} // 0),   # このパズルの進行状況の数（プレイ中の人数）
        tags          => $row->{tags} || [],        # 元画像に付いているタグ（タグでの絞り込みに使う）
        display_name  => $row->{display_name},
        original_name => $row->{original_name},
        width         => 0 + $row->{width},
        height        => 0 + $row->{height},
        full_url      => "${base_url}appdata/full/$row->{basename}.$row->{ext}",
        thumb_url     => "${base_url}appdata/thumb/$row->{basename}.jpg",   # サムネは常に JPEG
    };
}

# ---- ルーティング ----------------------------------------------------------
my $method = uc($ENV{REQUEST_METHOD} || 'GET');
my $action = query_param('action') || '';

eval {
    # 環境名（dev / production など）は DB 不要で返せるよう、接続前に処理する。
    if ($action eq 'env' && $method eq 'GET') {
        respond({ env => $ZIGSAW_ENV });
    }

    my $dbh = db();

    # アクセスログ: リクエストごとに、送信元 IP と（ログイン中なら）その user_id を1行残す。
    log_access($dbh, do { my $lu = current_user($dbh); $lu ? $lu->{id} : undef });

    if ($action eq 'signup_request' && $method eq 'POST') {
        my $body = read_body_json();
        my $email = defined $body->{email} ? $body->{email} : '';
        $email =~ s/^\s+|\s+$//g;
        fail('email_required') if $email eq '';
        fail('email_invalid')  if length($email) > 254 || $email !~ /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

        # メール爆撃対策: 直近の送信が宛先/IP ごとに多すぎるときは送らない。存在秘匿・スロットル
        # 秘匿のため応答は常に {ok}。しきい値内なら1通ぶんを記録してから送る。
        my $ip = $ENV{REMOTE_ADDR} // '';
        if (rate_count($dbh, 'mail_signup', 'email:' . lc($email), $MAIL_WINDOW_MIN) >= $MAIL_MAX_PER_EMAIL
            || ($ip ne '' && rate_count($dbh, 'mail_signup', 'ip:' . $ip, $MAIL_WINDOW_MIN) >= $MAIL_MAX_PER_IP)) {
            respond({ ok => JSON::PP::true });
        }
        rate_add($dbh, 'mail_signup', 'email:' . lc($email));
        rate_add($dbh, 'mail_signup', 'ip:' . $ip) if $ip ne '';
        purge_old_rate_events($dbh);

        # 既に登録済みでも、存在の有無を秘匿するため未登録時と同じ {ok} を返す。
        if ($dbh->selectrow_array('SELECT 1 FROM users WHERE lower(email) = lower(?)', undef, $email)) {
            send_signup_exists_email($email, app_base_url());
            respond({ ok => JSON::PP::true });
        }
        $dbh->do('DELETE FROM signup_tokens WHERE lower(email) = lower(?)', undef, $email);
        my $token = random_hex(32);
        $dbh->do(
            "INSERT INTO signup_tokens (token, email, expires_at)
             VALUES (?,?, now() + interval '$SIGNUP_TOKEN_HOURS hours')",
            undef, $token, $email
        );
        purge_expired_signup_tokens($dbh);
        send_signup_email($email, app_base_url() . "?signup=$token")
            or fail('mail_failed', '500 Internal Server Error');
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'signup_verify' && $method eq 'GET') {
        my $token = query_param('token') || '';
        my $row = $dbh->selectrow_hashref(
            'SELECT email FROM signup_tokens WHERE token = ? AND expires_at > now()',
            undef, $token
        );
        fail('signup_token_invalid', '400 Bad Request') unless $row;
        respond({ email => $row->{email} });
    }
    elsif ($action eq 'signup_complete' && $method eq 'POST') {
        my $body = read_body_json();
        my $token    = defined $body->{token}    ? $body->{token}    : '';
        my $username = defined $body->{username} ? $body->{username} : '';
        my $password = defined $body->{password} ? $body->{password} : '';
        $username =~ s/^\s+|\s+$//g;

        my $email = $dbh->selectrow_array(
            'SELECT email FROM signup_tokens WHERE token = ? AND expires_at > now()',
            undef, $token
        );
        fail('signup_token_invalid', '400 Bad Request') unless defined $email;

        fail('username_length') if $username eq '' || length($username) > 50;
        fail('password_too_short') if length($password) < 4;
        fail('password_too_long') if length($password) > 128;

        my @taken;
        push @taken, 'email'
            if $dbh->selectrow_array('SELECT 1 FROM users WHERE lower(email) = lower(?)', undef, $email);
        push @taken, 'username'
            if $dbh->selectrow_array('SELECT 1 FROM users WHERE username = ?', undef, $username);
        respond({ error => 'duplicate', fields => \@taken }, '409 Conflict') if @taken;

        my $salt = random_hex(16);
        my $hash = pbkdf2($password, $salt, $PBKDF2_ITER);
        my $uid = $dbh->selectrow_array(
            'INSERT INTO users (username, email, password_hash, salt, iterations)
             VALUES (?,?,?,?,?) RETURNING id',
            undef, $username, $email, $hash, $salt, $PBKDF2_ITER
        );
        $dbh->do('DELETE FROM signup_tokens WHERE lower(email) = lower(?)', undef, $email);
        start_session($dbh, $uid);
        respond({ username => $username, email => $email, is_admin => JSON::PP::false });
    }
    elsif ($action eq 'login' && $method eq 'POST') {
        my $body = read_body_json();
        my $email    = defined $body->{email}    ? $body->{email}    : '';
        my $password = defined $body->{password} ? $body->{password} : '';
        $email =~ s/^\s+|\s+$//g;
        my $ip = $ENV{REMOTE_ADDR} // '';
        my $ekey = 'email:' . lc($email);
        my $ikey = 'ip:' . $ip;

        # 直近の失敗が多すぎる（同一メール or 同一IP）なら一時的に拒否する（総当たり抑止）。
        if (rate_count($dbh, 'login_fail', $ekey, $LOGIN_WINDOW_MIN) >= $LOGIN_MAX_PER_EMAIL
            || ($ip ne '' && rate_count($dbh, 'login_fail', $ikey, $LOGIN_WINDOW_MIN) >= $LOGIN_MAX_PER_IP)) {
            fail('too_many_attempts', '429 Too Many Requests');
        }

        my $u = $dbh->selectrow_hashref(
            'SELECT id, username, email, password_hash, salt, iterations, is_admin
               FROM users WHERE lower(email) = lower(?)',
            undef, $email
        );
        # ユーザーが存在しなくてもダミーで PBKDF2 を回し、応答時間でのアカウント列挙を防ぐ。
        my $ok = 0;
        if ($u) {
            my $hash = pbkdf2($password, $u->{salt}, $u->{iterations});
            $ok = const_eq($hash, $u->{password_hash});
        } else {
            pbkdf2($password, '0' x 32, $PBKDF2_ITER);
        }
        unless ($ok) {
            rate_add($dbh, 'login_fail', $ekey);
            rate_add($dbh, 'login_fail', $ikey) if $ip ne '';
            purge_old_rate_events($dbh);
            fail('invalid_credentials', '401 Unauthorized');
        }
        # 成功したらそのメールの失敗記録をクリア（正規利用者が締め出されないように）。
        rate_clear($dbh, 'login_fail', $ekey);
        start_session($dbh, $u->{id});
        respond({ username => $u->{username}, email => $u->{email}, is_admin => pgbool($u->{is_admin}) });
    }
    elsif ($action eq 'logout' && $method eq 'POST') {
        my $token = get_cookie($COOKIE_NAME);
        $dbh->do('DELETE FROM sessions WHERE token = ?', undef, $token)
            if defined $token && $token =~ /^[0-9a-f]+$/;
        clear_session_cookie();
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'change_password' && $method eq 'POST') {
        my $u = require_user($dbh);
        my $body = read_body_json();
        my $current = defined $body->{current_password} ? $body->{current_password} : '';
        my $new     = defined $body->{new_password}     ? $body->{new_password}     : '';
        my $row = $dbh->selectrow_hashref(
            'SELECT password_hash, salt, iterations FROM users WHERE id = ?', undef, $u->{id}
        );
        fail('not_found', '404 Not Found') unless $row;
        my $cur_hash = pbkdf2($current, $row->{salt}, $row->{iterations});
        fail('current_password_wrong', '403 Forbidden')
            unless const_eq($cur_hash, $row->{password_hash});
        fail('password_too_short') if length($new) < 4;
        fail('password_too_long')  if length($new) > 128;
        my $salt = random_hex(16);
        my $hash = pbkdf2($new, $salt, $PBKDF2_ITER);
        $dbh->do('UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?',
            undef, $hash, $salt, $PBKDF2_ITER, $u->{id});
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'reset_request' && $method eq 'POST') {
        my $body = read_body_json();
        my $email = defined $body->{email} ? $body->{email} : '';
        $email =~ s/^\s+|\s+$//g;
        fail('email_required') if $email eq '';

        # メール爆撃対策: 直近の送信が宛先/IP ごとに多すぎるときは送らない（応答は常に {ok}）。
        my $ip = $ENV{REMOTE_ADDR} // '';
        if (rate_count($dbh, 'mail_reset', 'email:' . lc($email), $MAIL_WINDOW_MIN) >= $MAIL_MAX_PER_EMAIL
            || ($ip ne '' && rate_count($dbh, 'mail_reset', 'ip:' . $ip, $MAIL_WINDOW_MIN) >= $MAIL_MAX_PER_IP)) {
            respond({ ok => JSON::PP::true });
        }

        my $uid = $dbh->selectrow_array('SELECT id FROM users WHERE lower(email) = lower(?)', undef, $email);
        if ($uid) {
            # 実際に送るときだけ1通ぶんを記録する（爆撃されるのは実在アドレス宛のため）。
            rate_add($dbh, 'mail_reset', 'email:' . lc($email));
            rate_add($dbh, 'mail_reset', 'ip:' . $ip) if $ip ne '';
            $dbh->do('DELETE FROM reset_tokens WHERE user_id = ?', undef, $uid);
            my $token = random_hex(32);
            $dbh->do(
                "INSERT INTO reset_tokens (token, user_id, expires_at)
                 VALUES (?,?, now() + interval '$RESET_TOKEN_HOURS hours')",
                undef, $token, $uid
            );
            purge_expired_reset_tokens($dbh);
            purge_old_rate_events($dbh);
            send_reset_email($email, app_base_url() . "?reset=$token");
        }
        # 存在の有無は秘匿。登録の有無に関わらず {ok} を返す。
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'reset_verify' && $method eq 'GET') {
        my $token = query_param('token') || '';
        my $row = $dbh->selectrow_hashref(
            'SELECT u.email FROM reset_tokens r JOIN users u ON u.id = r.user_id
              WHERE r.token = ? AND r.expires_at > now()',
            undef, $token
        );
        fail('reset_token_invalid', '400 Bad Request') unless $row;
        respond({ email => $row->{email} });
    }
    elsif ($action eq 'reset_complete' && $method eq 'POST') {
        my $body = read_body_json();
        my $token    = defined $body->{token}    ? $body->{token}    : '';
        my $password = defined $body->{password} ? $body->{password} : '';
        my $row = $dbh->selectrow_hashref(
            'SELECT u.id, u.username, u.email, u.is_admin FROM reset_tokens r JOIN users u ON u.id = r.user_id
              WHERE r.token = ? AND r.expires_at > now()',
            undef, $token
        );
        fail('reset_token_invalid', '400 Bad Request') unless $row;
        fail('password_too_short') if length($password) < 4;
        fail('password_too_long')  if length($password) > 128;
        my $salt = random_hex(16);
        my $hash = pbkdf2($password, $salt, $PBKDF2_ITER);
        $dbh->do('UPDATE users SET password_hash = ?, salt = ?, iterations = ? WHERE id = ?',
            undef, $hash, $salt, $PBKDF2_ITER, $row->{id});
        $dbh->do('DELETE FROM reset_tokens WHERE user_id = ?', undef, $row->{id});
        $dbh->do('DELETE FROM sessions WHERE user_id = ?', undef, $row->{id});
        start_session($dbh, $row->{id});
        respond({ username => $row->{username}, email => $row->{email}, is_admin => pgbool($row->{is_admin}) });
    }
    elsif ($action eq 'account' && $method eq 'DELETE') {
        my $u = require_user($dbh);
        # users を消すと progress / sessions / reset_tokens は CASCADE で消える。
        # アップロード画像は owner_id が NULL になり、ギャラリーには残る（他の人が遊べる）。
        $dbh->do('DELETE FROM users WHERE id = ?', undef, $u->{id});
        clear_session_cookie();
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'me' && $method eq 'GET') {
        my $u = require_user($dbh);
        respond({ username => $u->{username}, email => $u->{email}, is_admin => pgbool($u->{is_admin}) });
    }
    elsif ($action eq 'dev_storage' && $method eq 'GET') {
        # 開発用: 画像ディレクトリのファイル数・合計サイズと、それが載っている
        # ファイルシステムの総容量・空き容量。開発環境の管理者でのみ有効。
        fail('not_found', '404 Not Found') unless $ZIGSAW_ENV eq 'development';
        require_admin($dbh);

        # 画像数は full/ のファイル数（画像1枚につき full が1つ）。
        # 合計サイズは appdata ディレクトリの画像置き場（full/thumb/incoming）の実ファイルの総和。
        my $image_count = 0;
        my $total_bytes = 0;
        for my $sub (qw(full thumb incoming)) {
            my $dir = "$APPDATA_DIR/$sub";
            opendir(my $dh, $dir) or next;
            while (defined(my $name = readdir $dh)) {
                next if $name eq '.' || $name eq '..';
                my $path = "$dir/$name";
                next unless -f $path;
                $image_count++ if $sub eq 'full';
                $total_bytes += (stat($path))[7];
            }
            closedir $dh;
        }

        # df -TP -B1 <images> の2行目: Filesystem Type 総bytes 使用 空き 容量% マウント位置
        my ($fs_type, $fs_total, $fs_free) = ('', 0, 0);
        my @lines = split /\n/, (`df -TP -B1 '$APPDATA_DIR' 2>/dev/null` || '');
        if (@lines >= 2) {
            my @f = split /\s+/, $lines[1];
            if (@f >= 5) { $fs_type = $f[1]; $fs_total = 0 + $f[2]; $fs_free = 0 + $f[4]; }
        }

        respond({
            image_count => $image_count,
            total_bytes => $total_bytes,
            fs_type     => $fs_type,
            fs_total    => $fs_total,
            fs_free     => $fs_free,
        });
    }
    elsif ($action eq 'dev_users' && $method eq 'GET') {
        # 開発用: 全ユーザーの一覧。開発環境の管理者でのみ有効（本番では 404 扱い）。
        # 認証情報（password_hash / salt / iterations）は返さない。
        fail('not_found', '404 Not Found') unless $ZIGSAW_ENV eq 'development';
        require_admin($dbh);
        my $rows = $dbh->selectall_arrayref(
            'SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
                    (SELECT count(*) FROM images   i  WHERE i.owner_id   = u.id) AS image_count,
                    (SELECT count(*) FROM puzzles  p  WHERE p.creator_id = u.id) AS puzzle_count,
                    (SELECT count(*) FROM progress pr WHERE pr.user_id   = u.id) AS progress_count,
                    (SELECT host(a.ip_addr) FROM access_log a WHERE a.user_id = u.id
                      ORDER BY a.accessed_at DESC LIMIT 1) AS last_ip,
                    (SELECT a.accessed_at FROM access_log a WHERE a.user_id = u.id
                      ORDER BY a.accessed_at DESC LIMIT 1) AS last_access
               FROM users u ORDER BY u.id',
            { Slice => {} }
        );
        # 画像ファイルの合計サイズはユーザーごとに集計する（DB には無いので実ファイルを stat）。
        my $imgs = $dbh->selectall_arrayref(
            'SELECT owner_id, basename, ext FROM images WHERE owner_id IS NOT NULL',
            { Slice => {} }
        );
        my %bytes;
        for my $im (@$imgs) {
            my $path = "$APPDATA_DIR/full/$im->{basename}.$im->{ext}";
            $bytes{$im->{owner_id}} += (-f $path) ? (stat($path))[7] : 0;
        }
        for my $r (@$rows) {
            $r->{id}             = 0 + $r->{id};
            $r->{is_admin}       = pgbool($r->{is_admin});
            $r->{image_count}    = 0 + $r->{image_count};
            $r->{puzzle_count}   = 0 + $r->{puzzle_count};
            $r->{progress_count} = 0 + $r->{progress_count};
            $r->{image_bytes}    = 0 + ($bytes{$r->{id}} || 0);
        }
        respond({ users => $rows });
    }
    elsif ($action eq 'dev_user_detail' && $method eq 'GET') {
        # 開発用: 指定ユーザーが登録した画像・作成したパズル・保存したゲーム（progress）。
        # 開発環境の管理者でのみ有効。
        fail('not_found', '404 Not Found') unless $ZIGSAW_ENV eq 'development';
        require_admin($dbh);
        my $uid = int(query_param('id') || 0);
        fail('bad_request') if $uid < 1;
        my $base = app_base_url();

        my $img_rows = $dbh->selectall_arrayref(
            'SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height, i.created_at, host(i.upload_ip) AS upload_ip,
                    ou.username AS owner_username, false AS mine
               FROM images i LEFT JOIN users ou ON ou.id = i.owner_id
              WHERE i.owner_id = ? ORDER BY i.created_at DESC, i.id DESC',
            { Slice => {} }, $uid
        );
        my $puz_rows = $dbh->selectall_arrayref(
            'SELECT p.id, p.image_id, p.columns, p.rows, cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.original_name, i.width, i.height
               FROM puzzles p JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE p.creator_id = ? ORDER BY p.created_at DESC, p.id DESC',
            { Slice => {} }, $uid
        );
        my $prog_rows = $dbh->selectall_arrayref(
            'SELECT pr.id, pr.puzzle_id, pr.state, pr.updated_at,
                    p.image_id, p.columns, p.rows, cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.original_name, i.width, i.height
               FROM progress pr
               JOIN puzzles p ON p.id = pr.puzzle_id
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE pr.user_id = ? ORDER BY pr.updated_at DESC',
            { Slice => {} }, $uid
        );
        attach_tags($dbh, $prog_rows, 'image_id');
        my @progress = map {
            {
                id         => 0 + $_->{id},
                puzzle_id  => 0 + $_->{puzzle_id},
                state      => (eval { $JSON->decode($_->{state}) } || {}),
                updated_at => $_->{updated_at},
                # $_->{id} は progress 行の id なので、パズルの id（=puzzle_id）で上書きして渡す。
                puzzle     => puzzle_row_to_json($base, { %$_, id => $_->{puzzle_id} }),
            }
        } @$prog_rows;

        respond({
            images   => [ map { image_row_to_json($base, $_) } @{ attach_tags($dbh, $img_rows) } ],
            puzzles  => [ map { puzzle_row_to_json($base, $_) } @{ attach_tags($dbh, $puz_rows, 'image_id') } ],
            progress => \@progress,
        });
    }
    elsif ($action eq 'dev_access_log' && $method eq 'GET') {
        # 開発用: access_log のダイジェスト。IP アドレスごとに最新の1行だけを、
        # 新しい順で返す。開発環境の管理者でのみ有効。
        fail('not_found', '404 Not Found') unless $ZIGSAW_ENV eq 'development';
        require_admin($dbh);
        # DISTINCT ON で IP ごとの最新行を取り、外側で新しい順に並べ替える。
        # user_id は最新行のもの（未ログインのアクセスなら NULL）。
        my $rows = $dbh->selectall_arrayref(
            'SELECT t.id, t.ip_addr, t.user_id, t.username, t.accessed_at FROM (
                SELECT DISTINCT ON (a.ip_addr)
                       a.id, host(a.ip_addr) AS ip_addr, a.user_id, u.username, a.accessed_at
                  FROM access_log a LEFT JOIN users u ON u.id = a.user_id
                 ORDER BY a.ip_addr, a.accessed_at DESC, a.id DESC
             ) t ORDER BY t.accessed_at DESC, t.id DESC',
            { Slice => {} }
        );
        for my $r (@$rows) {
            $r->{id}           = 0 + $r->{id};
            $r->{user_id}      = defined $r->{user_id} ? 0 + $r->{user_id} : undef;
            # whois で調べた Organization（キャッシュ優先。初見の範囲だけ whois を叩く）。
            $r->{organization} = whois_org_for_ip($r->{ip_addr});
        }
        respond({ entries => $rows });
    }
    elsif ($action eq 'images' && $method eq 'GET') {
        # ギャラリー一覧。未ログインでも見られる（遊べる）。ログイン中なら mine を立てる。
        # 全件返すと件数ぶん際限なく重くなるので、絞り込みとページングはここ（SQL）で行い、
        # 総件数（total）も返してフロントのページ送りに使う。
        my $u = current_user($dbh);
        my $uid = $u ? $u->{id} : -1;
        my ($cond, $bind) = list_filters('i.id', $uid);
        my ($per_page, $offset, $page) = list_paging();
        my $total = $dbh->selectrow_array(
            "SELECT count(*) FROM images i WHERE true $cond", undef, @$bind
        );
        my $rows = $dbh->selectall_arrayref(
            "SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height, i.created_at, host(i.upload_ip) AS upload_ip,
                    ou.username AS owner_username,
                    (i.owner_id = ?) AS mine
               FROM images i
               LEFT JOIN users ou ON ou.id = i.owner_id
              WHERE true $cond
              ORDER BY i.created_at DESC, i.id DESC
              LIMIT ? OFFSET ?",
            { Slice => {} }, $uid, @$bind, $per_page, $offset
        );
        my $base = app_base_url();
        respond({
            images   => [ map { image_row_to_json($base, $_) } @{ attach_tags($dbh, $rows) } ],
            total    => 0 + $total,
            page     => 0 + $page,
            per_page => 0 + $per_page,
        });
    }
    elsif ($action eq 'image' && $method eq 'GET') {
        # 画像1件。パズル情報画面から元画像へ移るときなど、一覧に無い1件を引くのに使う。
        my $u = current_user($dbh);
        my $uid = $u ? $u->{id} : -1;
        my $id = int(query_param('id') || 0);
        my $row = $dbh->selectrow_hashref(
            'SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height, i.created_at, host(i.upload_ip) AS upload_ip,
                    ou.username AS owner_username, (i.owner_id = ?) AS mine
               FROM images i LEFT JOIN users ou ON ou.id = i.owner_id WHERE i.id = ?',
            undef, $uid, $id
        );
        fail('not_found', '404 Not Found') unless $row;
        attach_tags($dbh, [$row]);
        respond({ image => image_row_to_json(app_base_url(), $row) });
    }
    elsif ($action eq 'tags' && $method eq 'GET') {
        # 使われているタグの名前一覧（絞り込みのタグ一覧に使う。誰でも見られる）。
        # 参照されなくなったタグ行は消しているので、tags の中身がそのまま「使われているタグ」。
        my $rows = $dbh->selectcol_arrayref('SELECT name FROM tags ORDER BY name');
        respond({ tags => $rows });
    }
    elsif ($action eq 'image' && $method eq 'POST') {
        my $u = require_user($dbh);
        my $body = read_body_json();
        my $display_name = defined $body->{display_name} ? $body->{display_name} : '';
        $display_name =~ s/^\s+|\s+$//g;
        $display_name = 'untitled' if $display_name eq '';
        $display_name = substr($display_name, 0, 200);
        # ファイル名（変更不可）。未指定なら display_name を流用（後方互換）。
        my $original_name = defined $body->{original_name} ? $body->{original_name} : $display_name;
        $original_name =~ s/^\s+|\s+$//g;
        $original_name = $display_name if $original_name eq '';
        $original_name = substr($original_name, 0, 200);
        my $ext = lc(defined $body->{ext} ? $body->{ext} : '');
        $ext = 'jpg' if $ext eq 'jpeg';
        # 拡張子はホワイトリスト（jpg/png/webp/gif）に限定する。html/svg 等は拒否。
        fail('image_ext_invalid') unless allowed_image_ext($ext);
        my $width  = int($body->{width}  || 0);
        my $height = int($body->{height} || 0);
        fail('image_dimensions_invalid') if $width < 1 || $height < 1 || $width > 20000 || $height > 20000;

        my $full_bytes  = decode_upload($body->{full},  'full');
        my $thumb_bytes = decode_upload($body->{thumb}, 'thumb');

        # 実ファイルを書く。ディレクトリが無ければ作る。
        eval {
            mkdir $APPDATA_DIR unless -d $APPDATA_DIR;
            mkdir "$APPDATA_DIR/full"  unless -d "$APPDATA_DIR/full";
            mkdir "$APPDATA_DIR/thumb" unless -d "$APPDATA_DIR/thumb";
            1;
        } or fail('image_write_failed', '500 Internal Server Error');

        my $basename = random_hex(16);
        eval {
            write_file("$APPDATA_DIR/full/$basename.$ext", $full_bytes);
            # サムネは常に JPEG（クライアントが image/jpeg で生成して送る）。full の
            # 拡張子（png/webp/gif）に関わらず thumb は .jpg に統一する。
            write_file("$APPDATA_DIR/thumb/$basename.jpg", $thumb_bytes);
            1;
        } or do {
            unlink "$APPDATA_DIR/full/$basename.$ext", "$APPDATA_DIR/thumb/$basename.jpg";
            fail('image_write_failed', '500 Internal Server Error');
        };

        # display_name＝タイトル（編集可）、original_name＝ファイル名（変更不可）、
        # upload_ip＝アップロード元 IP（REMOTE_ADDR。空なら NULL）。
        my $upload_ip = $ENV{REMOTE_ADDR};
        $upload_ip = undef if !defined $upload_ip || $upload_ip eq '';
        my $id = $dbh->selectrow_array(
            'INSERT INTO images (owner_id, basename, ext, display_name, original_name, width, height, upload_ip)
             VALUES (?,?,?,?,?,?,?,?) RETURNING id',
            undef, $u->{id}, $basename, $ext, $display_name, $original_name, $width, $height, $upload_ip
        );
        my $row = $dbh->selectrow_hashref(
            'SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height, i.created_at, host(i.upload_ip) AS upload_ip,
                    ?::text AS owner_username, true AS mine
               FROM images i WHERE i.id = ?',
            undef, $u->{username}, $id
        );
        attach_tags($dbh, [$row]);
        respond({ image => image_row_to_json(app_base_url(), $row) }, '201 Created');
    }
    elsif ($action eq 'image' && $method eq 'PUT') {
        # 画像情報の変更。変更できるのは display_name と tags。本人か管理者のみ。
        my $u = require_user($dbh);
        my $id = int(query_param('id') || 0);
        my $body = read_body_json();
        my $display_name = defined $body->{display_name} ? $body->{display_name} : '';
        $display_name =~ s/^\s+|\s+$//g;
        fail('bad_request') if $display_name eq '';
        $display_name = substr($display_name, 0, 200);
        my $row = $dbh->selectrow_hashref('SELECT * FROM images WHERE id = ?', undef, $id);
        fail('not_found', '404 Not Found') unless $row;
        fail('forbidden', '403 Forbidden')
            unless (defined $row->{owner_id} && $row->{owner_id} == $u->{id}) || pgbool($u->{is_admin}) == JSON::PP::true;
        $dbh->do('UPDATE images SET display_name = ? WHERE id = ?', undef, $display_name, $id);
        # タグ（tags / image_tags）。キーが無ければ今のタグを変えない。空配列なら全部外す。
        set_image_tags($dbh, $id, normalize_tags($body->{tags})) if exists $body->{tags};
        my $updated = $dbh->selectrow_hashref(
            'SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height, i.created_at, host(i.upload_ip) AS upload_ip,
                    ou.username AS owner_username, (i.owner_id = ?) AS mine
               FROM images i LEFT JOIN users ou ON ou.id = i.owner_id WHERE i.id = ?',
            undef, $u->{id}, $id
        );
        attach_tags($dbh, [$updated]);
        respond({ image => image_row_to_json(app_base_url(), $updated) });
    }
    elsif ($action eq 'image' && $method eq 'DELETE') {
        my $u = require_user($dbh);
        my $id = int(query_param('id') || 0);
        my $row = $dbh->selectrow_hashref('SELECT * FROM images WHERE id = ?', undef, $id);
        fail('not_found', '404 Not Found') unless $row;
        # 本人か管理者のみ削除できる。
        fail('forbidden', '403 Forbidden')
            unless (defined $row->{owner_id} && $row->{owner_id} == $u->{id}) || pgbool($u->{is_admin}) == JSON::PP::true;
        $dbh->do('DELETE FROM images WHERE id = ?', undef, $id);   # puzzles→progress、image_tags も CASCADE で消える
        purge_unused_tags($dbh);   # その画像にしか付いていなかったタグを残さない
        unlink "$APPDATA_DIR/full/$row->{basename}.$row->{ext}", "$APPDATA_DIR/thumb/$row->{basename}.jpg";
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'image_quarantine' && $method eq 'POST') {
        # 緊急退避（管理者のみ）。その画像・それを使ったパズル・進捗をアプリから消し、
        # 実ファイルと消す前の内容を $QUARANTINE_DIR へ移す。＝無かった状態に戻す。
        my $u = require_user($dbh);
        fail('forbidden', '403 Forbidden') unless pgbool($u->{is_admin}) == JSON::PP::true;
        my $id = int(query_param('id') || 0);
        my $image = $dbh->selectrow_hashref('SELECT * FROM images WHERE id = ?', undef, $id);
        fail('not_found', '404 Not Found') unless $image;

        # 消す前に、ぶら下がっているものを控えておく。
        my $puzzles = $dbh->selectall_arrayref(
            'SELECT * FROM puzzles WHERE image_id = ?', { Slice => {} }, $id);
        my $progress = $dbh->selectall_arrayref(
            'SELECT pr.*, u.username AS player
               FROM progress pr JOIN puzzles p ON p.id = pr.puzzle_id
               LEFT JOIN users u ON u.id = pr.user_id
              WHERE p.image_id = ?', { Slice => {} }, $id);
        my $tags = $dbh->selectcol_arrayref(
            'SELECT t.name FROM image_tags it JOIN tags t ON t.id = it.tag_id WHERE it.image_id = ?',
            undef, $id);

        # 退避先は「日時-image<id>」の1件1ディレクトリ。
        my @now = localtime;
        my $stamp = sprintf('%04d%02d%02d-%02d%02d%02d',
                            $now[5] + 1900, $now[4] + 1, $now[3], $now[2], $now[1], $now[0]);
        my $dir = "$ZIGSAW_QUARANTINE_DIR/$stamp-image$id";
        my $full  = "$APPDATA_DIR/full/$image->{basename}.$image->{ext}";
        my $thumb = "$APPDATA_DIR/thumb/$image->{basename}.jpg";
        my $moved = eval {
            mkdir $ZIGSAW_QUARANTINE_DIR unless -d $ZIGSAW_QUARANTINE_DIR;
            mkdir $dir or die "mkdir $dir: $!";
            my $meta = {
                removed_at => $stamp,
                removed_by => $u->{username},
                image      => $image,
                puzzles    => $puzzles,
                progress   => $progress,
                tags       => $tags,
            };
            write_file("$dir/meta.json", $JSON->encode($meta));
            # 実ファイルは移動（別ファイルシステムなら move_file が copy+unlink する）。
            move_file($full,  "$dir/full-$image->{basename}.$image->{ext}") if -f $full;
            move_file($thumb, "$dir/thumb-$image->{basename}.jpg")          if -f $thumb;
            1;
        };
        fail('quarantine_failed', '500 Internal Server Error') unless $moved;

        # DB から消す。puzzles / progress / image_tags は CASCADE で一緒に消える。
        $dbh->do('DELETE FROM images WHERE id = ?', undef, $id);
        purge_unused_tags($dbh);
        respond({
            ok       => JSON::PP::true,
            dir      => $dir,
            puzzles  => 0 + scalar(@$puzzles),
            progress => 0 + scalar(@$progress),
        });
    }
    elsif ($action eq 'puzzles' && $method eq 'GET') {
        # 作成済みパズルの一覧（誰でも見られる）。使っている画像の id 順、
        # 同じ画像の中はピース数の少ない順（同数なら作成順）。
        # mine=作成者が自分か、play_count=そのパズルの進行状況（＝プレイ中/クリア済みの人）の数。
        # 画像一覧と同様、絞り込みとページングは SQL で行い total を返す。
        # ただし image_id 指定のとき（画像情報画面の「作成済みのパズル」）は、その画像ぶんを全件返す。
        my $u = current_user($dbh);
        my $uid = $u ? $u->{id} : -1;
        my $image_id = int(query_param('image_id') || 0);
        my ($cond, $bind, $per_page, $offset, $page);
        if ($image_id > 0) {
            ($cond, $bind) = (' AND p.image_id = ?', [$image_id]);
            ($per_page, $offset, $page) = (200, 0, 1);
        } else {
            ($cond, $bind) = list_filters('p.image_id', $uid, 'p.columns * p.rows');
            ($per_page, $offset, $page) = list_paging();
        }
        my $total = $dbh->selectrow_array(
            "SELECT count(*) FROM puzzles p WHERE true $cond", undef, @$bind
        );
        my $rows = $dbh->selectall_arrayref(
            "SELECT p.id, p.image_id, p.columns, p.rows,
                    cu.username AS creator_username, (p.creator_id = ?) AS mine,
                    (SELECT count(*) FROM progress pr WHERE pr.puzzle_id = p.id) AS play_count,
                    i.basename, i.ext, i.display_name, i.original_name, i.width, i.height
               FROM puzzles p
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE true $cond
              ORDER BY p.image_id, p.columns * p.rows, p.id
              LIMIT ? OFFSET ?",
            { Slice => {} }, $uid, @$bind, $per_page, $offset
        );
        my $base = app_base_url();
        attach_tags($dbh, $rows, 'image_id');
        respond({
            puzzles  => [ map { puzzle_row_to_json($base, $_) } @$rows ],
            total    => 0 + $total,
            page     => 0 + $page,
            per_page => 0 + $per_page,
        });
    }
    elsif ($action eq 'puzzle' && $method eq 'POST') {
        # パズルを作成する（要ログイン）。同じ画像＋グリッドがあればそれを返す（束ねる）。
        my $u = require_user($dbh);
        my $body = read_body_json();
        my $image_id = int($body->{image_id} || 0);
        my $columns  = int($body->{columns}  || 0);
        my $rows     = int($body->{rows}     || 0);
        fail('bad_request') if $image_id < 1;
        fail('grid_invalid') if $columns < 2 || $rows < 2 || $columns > 40 || $rows > 40;
        fail('not_found', '404 Not Found')
            unless $dbh->selectrow_array('SELECT 1 FROM images WHERE id = ?', undef, $image_id);
        # 既存があれば作らずにそのまま使う。無ければ作成者を自分にして作る。
        $dbh->do(
            'INSERT INTO puzzles (image_id, columns, rows, creator_id)
             VALUES (?,?,?,?) ON CONFLICT (image_id, columns, rows) DO NOTHING',
            undef, $image_id, $columns, $rows, $u->{id}
        );
        my $row = $dbh->selectrow_hashref(
            'SELECT p.id, p.image_id, p.columns, p.rows,
                    cu.username AS creator_username, (p.creator_id = ?) AS mine,
                    (SELECT count(*) FROM progress pr WHERE pr.puzzle_id = p.id) AS play_count,
                    i.basename, i.ext, i.display_name, i.original_name, i.width, i.height
               FROM puzzles p
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE p.image_id = ? AND p.columns = ? AND p.rows = ?',
            undef, $u->{id}, $image_id, $columns, $rows
        );
        attach_tags($dbh, [$row], 'image_id');
        respond({ puzzle => puzzle_row_to_json(app_base_url(), $row) }, '201 Created');
    }
    elsif ($action eq 'puzzle' && $method eq 'DELETE') {
        # パズルを削除する（要ログイン。作成者または管理者）。
        # すでにそのパズルでプレイしている人（progress がある人）がいる場合は削除しない。
        my $u = require_user($dbh);
        my $id = int(query_param('id') || 0);
        my $row = $dbh->selectrow_hashref('SELECT * FROM puzzles WHERE id = ?', undef, $id);
        fail('not_found', '404 Not Found') unless $row;
        fail('forbidden', '403 Forbidden')
            unless (defined $row->{creator_id} && $row->{creator_id} == $u->{id}) || pgbool($u->{is_admin}) == JSON::PP::true;
        my $players = $dbh->selectrow_array('SELECT count(*) FROM progress WHERE puzzle_id = ?', undef, $id);
        fail('puzzle_in_use', '409 Conflict') if $players > 0;
        $dbh->do('DELETE FROM puzzles WHERE id = ?', undef, $id);
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'progress' && $method eq 'GET') {
        # 自分の途中経過を、パズル＋画像の情報つきで返す（「プレイしたパズル」用）。
        my $u = require_user($dbh);
        my $rows = $dbh->selectall_arrayref(
            'SELECT pr.id, pr.puzzle_id, pr.state, pr.updated_at,
                    p.image_id, p.columns, p.rows,
                    cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.original_name, i.width, i.height
               FROM progress pr
               JOIN puzzles p ON p.id = pr.puzzle_id
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE pr.user_id = ?
              ORDER BY pr.updated_at DESC',
            { Slice => {} }, $u->{id}
        );
        my $base = app_base_url();
        attach_tags($dbh, $rows, 'image_id');   # 各パズルの元画像のタグ
        my @out;
        for my $r (@$rows) {
            my $state = eval { $JSON->decode($r->{state}) } || {};   # JSONB は文字列で来る
            # 一覧では重い「現在の様子」スナップショット（数十KB/件）を省く。
            # 詳細を開いたときに ?action=progress_snapshot で個別取得する。
            delete $state->{snapshot};
            push @out, {
                id         => 0 + $r->{id},
                puzzle_id  => 0 + $r->{puzzle_id},
                state      => $state,
                updated_at => $r->{updated_at},
                # $r->{id} は progress 行の id なので、パズルの id（=puzzle_id）で上書きして渡す。
                puzzle     => puzzle_row_to_json($base, { %$r, id => $r->{puzzle_id} }),
            };
        }
        respond({ progress => \@out });
    }
    elsif ($action eq 'progress_snapshot' && $method eq 'GET') {
        # 「現在の様子」スナップショット（data URL）を1件だけ返す。一覧では省いているので、
        # 詳細を開いたときにここで取得する。自分の progress のみ。無ければ snapshot=null。
        my $u = require_user($dbh);
        my $id = int(query_param('id') || 0);
        my $snap = $dbh->selectrow_array(
            "SELECT state->>'snapshot' FROM progress WHERE id = ? AND user_id = ?",
            undef, $id, $u->{id}
        );
        respond({ snapshot => (defined $snap && $snap ne '') ? $snap : undef });
    }
    elsif ($action eq 'progress' && $method eq 'PUT') {
        my $u = require_user($dbh);
        my $body = read_body_json();
        my $puzzle_id = int($body->{puzzle_id} || 0);
        my $state     = $body->{state};
        fail('bad_request') if $puzzle_id < 1 || ref($state) ne 'HASH';
        # プレイ中に管理者がその画像を退避（緊急削除）するとパズルごと消える。
        # 遊んでいる人に伝わるよう、専用のコードを返す（フロントはゲームを終了させる）。
        fail('puzzle_removed', '404 Not Found')
            unless $dbh->selectrow_array('SELECT 1 FROM puzzles WHERE id = ?', undef, $puzzle_id);
        my $state_json = $JSON->encode($state);
        # 自動保存で 60 秒ごとに書き込まれる経路なので、1件あたりの上限を設ける。
        fail('payload_too_large', '413 Payload Too Large')
            if length($state_json) > $MAX_STATE_BYTES;
        $dbh->do(
            'INSERT INTO progress (user_id, puzzle_id, state, updated_at)
             VALUES (?,?,?, now())
             ON CONFLICT (user_id, puzzle_id)
             DO UPDATE SET state = EXCLUDED.state, updated_at = now()',
            undef, $u->{id}, $puzzle_id, $state_json
        );
        my $id = $dbh->selectrow_array(
            'SELECT id FROM progress WHERE user_id = ? AND puzzle_id = ?',
            undef, $u->{id}, $puzzle_id
        );
        respond({ id => 0 + $id });
    }
    elsif ($action eq 'progress' && $method eq 'DELETE') {
        my $u = require_user($dbh);
        my $id = int(query_param('id') || 0);
        $dbh->do('DELETE FROM progress WHERE id = ? AND user_id = ?', undef, $id, $u->{id});
        respond({ ok => JSON::PP::true });
    }
    else {
        fail('not_found', '404 Not Found');
    }
    1;
} or do {
    my $err = $@ || 'unknown error';
    # fail()/respond() は exit するのでここには来ない。ここに来るのは DB 例外など想定外のもの。
    # 詳細はサーバーログ（Apache error_log）にだけ残し、クライアントには汎用メッセージのみ返す
    # （内部エラー文やパスの漏えいを防ぐ）。
    warn "unhandled: $err\n";
    respond({ error => 'server_error' }, '500 Internal Server Error') unless $err =~ /^ *$/;
};
