#!/usr/bin/perl
use strict;
use warnings;
use utf8;
use DBI;
use JSON::PP;
use Digest::SHA qw(hmac_sha256);
use MIME::Base64 ();
use File::Basename qw(dirname);

# Zigsaw (ジグソーパズル) API  (CGI / Perl + PostgreSQL)
#
# 配信:  Apache UserDir 配下、suexec で sugawara として実行される。
#        そのため PostgreSQL へは peer 認証（パスワード不要）で接続できる。
# DB:    zigsaw（users / sessions / signup_tokens / reset_tokens / images / progress）。
#        定義は ddl/*.sql 参照。
# 認証:  ログイン時にランダムトークンを sessions に保存し、HttpOnly Cookie
#        (zigsaw_sid) で受け渡す。パスワードは PBKDF2-HMAC-SHA256 で保存。
#        未ログインでもギャラリー閲覧・プレイはできる（保存だけできない）。
#
# 画像:  みんなで遊べる共有ギャラリー。実ファイルは api.cgi と同じディレクトリの
#        images/full（遊ぶ用の縮小画像）と images/thumb（一覧用サムネ）に置く。
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
#   GET    ?action=dev_users                        -> 全ユーザー一覧（開発環境のみ。本番は404。salt/iterations は返さない）
#   GET    ?action=dev_user_detail&id=<uid>         -> 指定ユーザーの画像/パズル/保存ゲーム（開発環境のみ）
#   GET    ?action=images                           -> アップロード画像一覧（未ログインでも可）
#   POST   ?action=image  {display_name,width,height,ext,full,thumb}
#                                                   -> 画像アップロード（要ログイン。full/thumb は base64）
#   DELETE ?action=image&id=<id>                    -> 画像削除（本人または管理者。パズル/進行も CASCADE 削除）
#   GET    ?action=puzzles                          -> 作成済みパズル一覧（誰でも。画像情報+作成者名つき）
#   POST   ?action=puzzle {image_id,columns,rows}   -> パズルを作成（同じ画像+グリッドは1つに束ねる。要ログイン）
#   GET    ?action=progress                         -> 自分の途中経過一覧（要ログイン。パズル+画像情報つき）
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

# 実行環境名。api.cgi と同じディレクトリの env.pl（git 管理外。dev/本番で内容が異なる）を
# require し、その中で $main::ZIGSAW_ENV を設定する。未設置なら 'unknown'。
our $ZIGSAW_ENV = 'unknown';
{
    my $env_file = dirname(__FILE__) . '/env.pl';
    require $env_file if -f $env_file;
}

# 画像の実ファイルを置くディレクトリ（api.cgi と同じ場所を基準にする）。
my $IMAGE_DIR = dirname(__FILE__) . '/images';

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
        return $v;
    }
    return undef;
}

sub read_body_json {
    my $length = $ENV{CONTENT_LENGTH} || 0;
    return {} if $length <= 0;
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
        'dbi:Pg:dbname=zigsaw', '', '',
        { RaiseError => 1, AutoCommit => 1, PrintError => 0, pg_enable_utf8 => 1 }
    ) or fail('db_error', '500 Internal Server Error');
    return $dbh;
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
        open(my $mh, '|-', '/usr/sbin/sendmail', '-t', '-i') or die "sendmail: $!";
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
# ファイル名に使ってよい安全な basename/ext か確認する。
sub safe_basename { my $s = shift; return defined $s && $s =~ /^[0-9a-f]{16,64}$/; }
sub safe_ext      { my $s = shift; return defined $s && $s =~ /^[a-z0-9]{1,5}$/; }

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

sub write_file {
    my ($path, $bytes) = @_;
    open my $fh, '>:raw', $path or die "open $path: $!";
    print $fh $bytes;
    close $fh or die "close $path: $!";
}

# 画像1行を、フロントが使いやすい形（URL 付き）に整える。
sub image_row_to_json {
    my ($base_url, $row) = @_;
    return {
        id            => 0 + $row->{id},
        display_name  => $row->{display_name},
        original_name => $row->{original_name},
        width         => 0 + $row->{width},
        height        => 0 + $row->{height},
        owner         => $row->{owner_username},   # 投稿者名（管理者設置は null）
        mine          => $row->{mine} ? JSON::PP::true : JSON::PP::false,
        full_url      => "${base_url}images/full/$row->{basename}.$row->{ext}",
        thumb_url    => "${base_url}images/thumb/$row->{basename}.$row->{ext}",
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
        creator      => $row->{creator_username},   # 作成者名（退会済みは null）
        display_name => $row->{display_name},
        width        => 0 + $row->{width},
        height       => 0 + $row->{height},
        full_url     => "${base_url}images/full/$row->{basename}.$row->{ext}",
        thumb_url    => "${base_url}images/thumb/$row->{basename}.$row->{ext}",
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

    if ($action eq 'signup_request' && $method eq 'POST') {
        my $body = read_body_json();
        my $email = defined $body->{email} ? $body->{email} : '';
        $email =~ s/^\s+|\s+$//g;
        fail('email_required') if $email eq '';
        fail('email_invalid')  if length($email) > 254 || $email !~ /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
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
        my $u = $dbh->selectrow_hashref(
            'SELECT id, username, email, password_hash, salt, iterations, is_admin
               FROM users WHERE lower(email) = lower(?)',
            undef, $email
        );
        fail('invalid_credentials', '401 Unauthorized') unless $u;
        my $hash = pbkdf2($password, $u->{salt}, $u->{iterations});
        fail('invalid_credentials', '401 Unauthorized')
            unless const_eq($hash, $u->{password_hash});
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
        my $uid = $dbh->selectrow_array('SELECT id FROM users WHERE lower(email) = lower(?)', undef, $email);
        if ($uid) {
            $dbh->do('DELETE FROM reset_tokens WHERE user_id = ?', undef, $uid);
            my $token = random_hex(32);
            $dbh->do(
                "INSERT INTO reset_tokens (token, user_id, expires_at)
                 VALUES (?,?, now() + interval '$RESET_TOKEN_HOURS hours')",
                undef, $token, $uid
            );
            purge_expired_reset_tokens($dbh);
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
    elsif ($action eq 'dev_users' && $method eq 'GET') {
        # 開発用: 全ユーザーの一覧。開発環境でのみ有効（本番では 404 扱い）。
        # 認証情報（password_hash / salt / iterations）は返さない。
        fail('not_found', '404 Not Found') unless $ZIGSAW_ENV eq 'development';
        my $rows = $dbh->selectall_arrayref(
            'SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
                    (SELECT count(*) FROM images   i  WHERE i.owner_id   = u.id) AS image_count,
                    (SELECT count(*) FROM puzzles  p  WHERE p.creator_id = u.id) AS puzzle_count,
                    (SELECT count(*) FROM progress pr WHERE pr.user_id   = u.id) AS progress_count
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
            my $path = "$IMAGE_DIR/full/$im->{basename}.$im->{ext}";
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
        fail('not_found', '404 Not Found') unless $ZIGSAW_ENV eq 'development';
        my $uid = int(query_param('id') || 0);
        fail('bad_request') if $uid < 1;
        my $base = app_base_url();

        my $img_rows = $dbh->selectall_arrayref(
            'SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height,
                    ou.username AS owner_username, false AS mine
               FROM images i LEFT JOIN users ou ON ou.id = i.owner_id
              WHERE i.owner_id = ? ORDER BY i.created_at DESC, i.id DESC',
            { Slice => {} }, $uid
        );
        my $puz_rows = $dbh->selectall_arrayref(
            'SELECT p.id, p.image_id, p.columns, p.rows, cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.width, i.height
               FROM puzzles p JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE p.creator_id = ? ORDER BY p.created_at DESC, p.id DESC',
            { Slice => {} }, $uid
        );
        my $prog_rows = $dbh->selectall_arrayref(
            'SELECT pr.id, pr.puzzle_id, pr.state, pr.updated_at,
                    p.image_id, p.columns, p.rows, cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.width, i.height
               FROM progress pr
               JOIN puzzles p ON p.id = pr.puzzle_id
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE pr.user_id = ? ORDER BY pr.updated_at DESC',
            { Slice => {} }, $uid
        );
        my @progress = map {
            {
                id         => 0 + $_->{id},
                puzzle_id  => 0 + $_->{puzzle_id},
                state      => (eval { $JSON->decode($_->{state}) } || {}),
                updated_at => $_->{updated_at},
                puzzle     => puzzle_row_to_json($base, $_),
            }
        } @$prog_rows;

        respond({
            images   => [ map { image_row_to_json($base, $_) } @$img_rows ],
            puzzles  => [ map { puzzle_row_to_json($base, $_) } @$puz_rows ],
            progress => \@progress,
        });
    }
    elsif ($action eq 'images' && $method eq 'GET') {
        # ギャラリー一覧。未ログインでも見られる（遊べる）。ログイン中なら mine を立てる。
        my $u = current_user($dbh);
        my $uid = $u ? $u->{id} : -1;
        my $rows = $dbh->selectall_arrayref(
            'SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height,
                    ou.username AS owner_username,
                    (i.owner_id = ?) AS mine
               FROM images i
               LEFT JOIN users ou ON ou.id = i.owner_id
              ORDER BY i.created_at DESC, i.id DESC',
            { Slice => {} }, $uid
        );
        my $base = app_base_url();
        respond({ images => [ map { image_row_to_json($base, $_) } @$rows ] });
    }
    elsif ($action eq 'image' && $method eq 'POST') {
        my $u = require_user($dbh);
        my $body = read_body_json();
        my $display_name = defined $body->{display_name} ? $body->{display_name} : '';
        $display_name =~ s/^\s+|\s+$//g;
        $display_name = 'untitled' if $display_name eq '';
        $display_name = substr($display_name, 0, 200);
        my $ext = lc(defined $body->{ext} ? $body->{ext} : '');
        $ext = 'jpg' if $ext eq 'jpeg';
        fail('image_ext_invalid') unless safe_ext($ext);
        my $width  = int($body->{width}  || 0);
        my $height = int($body->{height} || 0);
        fail('image_dimensions_invalid') if $width < 1 || $height < 1 || $width > 20000 || $height > 20000;

        my $full_bytes  = decode_upload($body->{full},  'full');
        my $thumb_bytes = decode_upload($body->{thumb}, 'thumb');

        # 実ファイルを書く。ディレクトリが無ければ作る。
        eval {
            mkdir $IMAGE_DIR unless -d $IMAGE_DIR;
            mkdir "$IMAGE_DIR/full"  unless -d "$IMAGE_DIR/full";
            mkdir "$IMAGE_DIR/thumb" unless -d "$IMAGE_DIR/thumb";
            1;
        } or fail('image_write_failed', '500 Internal Server Error');

        my $basename = random_hex(16);
        eval {
            write_file("$IMAGE_DIR/full/$basename.$ext", $full_bytes);
            write_file("$IMAGE_DIR/thumb/$basename.$ext", $thumb_bytes);
            1;
        } or do {
            unlink "$IMAGE_DIR/full/$basename.$ext", "$IMAGE_DIR/thumb/$basename.$ext";
            fail('image_write_failed', '500 Internal Server Error');
        };

        # 当初は display_name と original_name に同じ値（アップロード時の名前）を入れる。
        my $id = $dbh->selectrow_array(
            'INSERT INTO images (owner_id, basename, ext, display_name, original_name, width, height)
             VALUES (?,?,?,?,?,?,?) RETURNING id',
            undef, $u->{id}, $basename, $ext, $display_name, $display_name, $width, $height
        );
        my $row = $dbh->selectrow_hashref(
            'SELECT i.id, i.basename, i.ext, i.display_name, i.original_name, i.width, i.height,
                    ?::text AS owner_username, true AS mine
               FROM images i WHERE i.id = ?',
            undef, $u->{username}, $id
        );
        respond({ image => image_row_to_json(app_base_url(), $row) }, '201 Created');
    }
    elsif ($action eq 'image' && $method eq 'DELETE') {
        my $u = require_user($dbh);
        my $id = int(query_param('id') || 0);
        my $row = $dbh->selectrow_hashref('SELECT * FROM images WHERE id = ?', undef, $id);
        fail('not_found', '404 Not Found') unless $row;
        # 本人か管理者のみ削除できる。
        fail('forbidden', '403 Forbidden')
            unless (defined $row->{owner_id} && $row->{owner_id} == $u->{id}) || pgbool($u->{is_admin}) == JSON::PP::true;
        $dbh->do('DELETE FROM images WHERE id = ?', undef, $id);   # puzzles→progress も CASCADE で消える
        unlink "$IMAGE_DIR/full/$row->{basename}.$row->{ext}", "$IMAGE_DIR/thumb/$row->{basename}.$row->{ext}";
        respond({ ok => JSON::PP::true });
    }
    elsif ($action eq 'puzzles' && $method eq 'GET') {
        # 作成済みパズルの一覧（誰でも見られる）。新しい順。
        my $rows = $dbh->selectall_arrayref(
            'SELECT p.id, p.image_id, p.columns, p.rows,
                    cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.width, i.height
               FROM puzzles p
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              ORDER BY p.created_at DESC, p.id DESC',
            { Slice => {} }
        );
        my $base = app_base_url();
        respond({ puzzles => [ map { puzzle_row_to_json($base, $_) } @$rows ] });
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
                    cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.width, i.height
               FROM puzzles p
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE p.image_id = ? AND p.columns = ? AND p.rows = ?',
            undef, $image_id, $columns, $rows
        );
        respond({ puzzle => puzzle_row_to_json(app_base_url(), $row) }, '201 Created');
    }
    elsif ($action eq 'progress' && $method eq 'GET') {
        # 自分の途中経過を、パズル＋画像の情報つきで返す（「プレイしたパズル」用）。
        my $u = require_user($dbh);
        my $rows = $dbh->selectall_arrayref(
            'SELECT pr.id, pr.puzzle_id, pr.state, pr.updated_at,
                    p.image_id, p.columns, p.rows,
                    cu.username AS creator_username,
                    i.basename, i.ext, i.display_name, i.width, i.height
               FROM progress pr
               JOIN puzzles p ON p.id = pr.puzzle_id
               JOIN images i ON i.id = p.image_id
               LEFT JOIN users cu ON cu.id = p.creator_id
              WHERE pr.user_id = ?
              ORDER BY pr.updated_at DESC',
            { Slice => {} }, $u->{id}
        );
        my $base = app_base_url();
        my @out;
        for my $r (@$rows) {
            push @out, {
                id         => 0 + $r->{id},
                puzzle_id  => 0 + $r->{puzzle_id},
                state      => (eval { $JSON->decode($r->{state}) } || {}),   # JSONB は文字列で来る
                updated_at => $r->{updated_at},
                puzzle     => puzzle_row_to_json($base, $r),
            };
        }
        respond({ progress => \@out });
    }
    elsif ($action eq 'progress' && $method eq 'PUT') {
        my $u = require_user($dbh);
        my $body = read_body_json();
        my $puzzle_id = int($body->{puzzle_id} || 0);
        my $state     = $body->{state};
        fail('bad_request') if $puzzle_id < 1 || ref($state) ne 'HASH';
        fail('not_found', '404 Not Found')
            unless $dbh->selectrow_array('SELECT 1 FROM puzzles WHERE id = ?', undef, $puzzle_id);
        my $state_json = $JSON->encode($state);
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
    warn "unhandled: $err\n";
    respond({ error => 'server_error', detail => "$err" }, '500 Internal Server Error') unless $err =~ /^ *$/;
};
