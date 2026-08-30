# ZigsawTest: api.cgi をサンドボックスで直接実行するテストハーネス。
#
# 本物の zigsaw DB・共有画像ディレクトリには一切触れない:
#   - t/tmp/sandbox に api.cgi をコピーし、テスト用 env.pl で
#     DB=zigsaw_test / 偽 sendmail / サンドボックス内 quarantine に差し替える。
#   - zigsaw_test はテストファイルごとに ddl/*.sql から作り直す。
#   - 画像や whois キャッシュは sandbox/appdata に書かれる（api.cgi は自分の場所を基準に解決するため）。
#   - CGI は Apache を介さず、環境変数を組み立てて /usr/bin/perl の子プロセスで実行する。
#
# 実行方法（リポジトリのどこからでも）:
#   /usr/local/bin/prove t          # 全部
#   /usr/local/bin/prove -v t/02_auth.t
#
# 注意: ハーネス自体は /usr/local の perl 5.44（Test::More あり・DBI なし）で動くので、
# DB の直接操作は psql コマンド（peer 認証）で行う。CGI 本体はシステムの
# /usr/bin/perl（DBI あり）で動かす。

package ZigsawTest;
use strict;
use warnings;
use utf8;
use FindBin;
use File::Path qw(rmtree mkpath);
use File::Basename qw(dirname);
use JSON::PP;
use Exporter ();
our @ISA = ('Exporter');

our @EXPORT = qw(
    api api_get api_post api_put api_delete
    db_do db_scalar q_lit
    make_user signup_via_api
    mails clear_mails
    sandbox_dir appdata_dir quarantine_dir
    whois_log clear_whois_log
    TINY_PNG_B64
);

# api.cgi を動かす perl（既定はシステムの /usr/bin/perl。DBI/DBD::Pg 入り）。
# 別の perl での動作を確かめるときは ZIGSAW_TEST_PERL で差し替える:
#   env ZIGSAW_TEST_PERL=/usr/local/bin/perl prove t
my $CGI_PERL = $ENV{ZIGSAW_TEST_PERL} || '/usr/bin/perl';
my $TEST_DB  = 'zigsaw_test';
# テスト対象の api.cgi が読む共通ライブラリ PJJ の置き場所。既定は dev の作業用
# チェックアウト（直したライブラリをその場で試せるように）。PJJ_LIB 環境変数で差し替えられる。
my $PJJ_LIB  = $ENV{PJJ_LIB} || '/home/sugawara/lib/perl5';

my $ROOT;         # リポジトリのルート（api.cgi と ddl/ がある場所）
my $SANDBOX;      # t/tmp/sandbox
my $initialized;

# 1x1 の PNG（中身はサーバー側では検証されないが、本物の画像バイト列を使う）。
use constant TINY_PNG_B64 =>
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

sub sandbox_dir    { $SANDBOX }
sub appdata_dir    { "$SANDBOX/appdata" }
sub quarantine_dir { "$SANDBOX/quarantine" }
sub mail_log       { "$SANDBOX/mail.log" }
sub whois_log_file { "$SANDBOX/whois.log" }

# use ZigsawTest; だけでサンドボックスと DB を作り直す。
sub import {
    my $class = shift;
    # テスト名に日本語を使うので、Test::More の出力を UTF-8 にする（Wide character 警告防止）。
    if (my $builder = eval { Test::More->builder }) {
        binmode($builder->$_, ':encoding(UTF-8)')
            for qw(output failure_output todo_output);
    }
    init() unless $initialized;
    $class->export_to_level(1, $class, @EXPORT);
}

sub init {
    # t/ 直下（*.t から見て $FindBin::Bin）を起点にリポジトリルートを求める。
    my $tdir = $FindBin::Bin;
    $tdir = "$tdir/t" if -d "$tdir/t" && !-f "$tdir/../api.cgi";   # ルートから実行された場合
    $ROOT = dirname($tdir);
    die "api.cgi not found under $ROOT\n" unless -f "$ROOT/api.cgi";
    $SANDBOX = "$tdir/tmp/sandbox";

    rmtree($SANDBOX);
    mkpath(["$SANDBOX/io", "$SANDBOX/quarantine"]);

    # api.cgi をコピー。設定差し替え口が無いコードを誤って動かすと本物の DB に
    # つながってしまうので、コピー時に差し替え口の存在を確かめる。
    my $src = do { open my $fh, '<:raw', "$ROOT/api.cgi" or die "read api.cgi: $!"; local $/; <$fh> };
    die "api.cgi lacks the ZIGSAW_DB override hook; refusing to run tests\n"
        unless $src =~ /our \$ZIGSAW_DB/ && $src =~ /db\s+=>\s+\$ZIGSAW_DB/;
    write_file("$SANDBOX/api.cgi", $src);

    # テスト用 env.pl（DB・sendmail・退避先・whois をサンドボックスに向ける）。
    write_file("$SANDBOX/env.pl", <<EOF);
\$main::PJJ_LIB               = '$PJJ_LIB';
\$main::ZIGSAW_ENV            = 'development';
\$main::ZIGSAW_BASE_URL       = 'https://test.invalid/zigsaw/';
\$main::ZIGSAW_MAIL_FROM      = 'noreply\@test.invalid';
\$main::ZIGSAW_DB             = '$TEST_DB';
\$main::ZIGSAW_SENDMAIL       = '$SANDBOX/sendmail';
\$main::ZIGSAW_QUARANTINE_DIR = '$SANDBOX/quarantine';
\$main::ZIGSAW_WHOIS          = '$SANDBOX/whois';
1;
EOF

    # 偽 sendmail: 受け取った内容を mail.log に追記するだけ。
    write_file("$SANDBOX/sendmail", <<EOF);
#!$CGI_PERL
open my \$fh, '>>', '$SANDBOX/mail.log' or die \$!;
print \$fh "=== MAIL ===\\n";
print \$fh \$_ while <STDIN>;
print \$fh "\\n=== END ===\\n";
close \$fh;
EOF
    chmod 0755, "$SANDBOX/sendmail" or die "chmod sendmail: $!";

    # 偽 whois: 呼び出しを whois.log に追記し、IPv4 なら「その /24 が NetRange」という
    # 体の決まった応答を返す（ネットワークには出ない）。133.* だけは JPNIC の日本語出力を
    # 模した形式（CIDR 表記・[組織名]/[Organization] ラベル）で返し、パーサの対応を試せるようにする。
    my $fake_whois = <<EOF;
#!$CGI_PERL
my \$ip = \$ARGV[0] // '';
open my \$fh, '>>', '$SANDBOX/whois.log' or die \$!;
print \$fh "\$ip\\n";
close \$fh;
my (\$a, \$b, \$c) = \$ip =~ /^(\\d+)\\.(\\d+)\\.(\\d+)\\./ or exit 0;
if (\$a == 133) {
    print "Network Information: [ネットワーク情報]\\n";
    print "a. [IPネットワークアドレス]     \$a.\$b.0.0/16\\n";
    print "b. [ネットワーク名]             TESTNET\\n";
    print "f. [組織名]                     テスト組織\\n";
    print "g. [Organization]               Test Org JP\\n";
    exit 0;
}
print "NetRange:       \$a.\$b.\$c.0 - \$a.\$b.\$c.255\\n";
print "Organization:   Test Org \$a.\$b.\$c (TEST)\\n";
EOF
    utf8::encode($fake_whois);   # 日本語を含むので UTF-8 バイト列にして書く
    write_file("$SANDBOX/whois", $fake_whois);
    chmod 0755, "$SANDBOX/whois" or die "chmod whois: $!";

    # テスト DB を ddl/*.sql から作り直す（依存順に流す）。
    run_or_die('dropdb', '--if-exists', $TEST_DB);
    run_or_die('createdb', $TEST_DB);
    for my $f (qw(users.sql images.sql tags.sql puzzles.sql progress.sql puzzle_clears.sql
                  puzzle_comments.sql sessions.sql signup_tokens.sql reset_tokens.sql
                  access_log.sql rate_events.sql)) {
        run_or_die('psql', '-q', '-v', 'ON_ERROR_STOP=1', '-d', $TEST_DB, '-f', "$ROOT/ddl/$f");
    }

    # 健全性確認: 直接 DB に作ったセッションで action=me が通れば、CGI は確かに
    # zigsaw_test を見ている（本物の DB につながっていればこのセッションは存在せず 401）。
    my ($uid, $sid) = make_user(username => 'sanity-check');
    my $res = api(method => 'GET', action => 'me', sid => $sid);
    die "sandbox sanity check failed (api.cgi is NOT talking to $TEST_DB): "
        . ($res->{raw} // '') . ($res->{stderr} // '') . "\n"
        unless $res->{status} == 200 && ($res->{json}{username} // '') eq 'sanity-check';
    db_do("DELETE FROM sessions WHERE token = " . q_lit($sid));
    db_do("DELETE FROM users WHERE username = 'sanity-check'");

    $initialized = 1;
}

sub write_file {
    my ($path, $content) = @_;
    open my $fh, '>:raw', $path or die "write $path: $!";
    print $fh $content;
    close $fh or die "close $path: $!";
}

sub run_or_die {
    my (@cmd) = @_;
    system(@cmd) == 0 or die "command failed (@cmd): $?\n";
}

# ---- DB（psql 経由。peer 認証なのでパスワード不要） -------------------------
sub db_do {
    my ($sql) = @_;
    run_or_die('psql', '-q', '-v', 'ON_ERROR_STOP=1', '-d', $TEST_DB, '-c', $sql);
}

# 1値を返す（複数行なら改行区切りの文字列）。
sub db_scalar {
    my ($sql) = @_;
    my $pid = open(my $fh, '-|', 'psql', '-qtA', '-d', $TEST_DB, '-c', $sql)
        or die "psql: $!";
    my $out = do { local $/; <$fh> };
    close $fh;
    $out = '' unless defined $out;
    $out =~ s/\n+\z//;
    return $out;
}

# SQL 文字列リテラル用のクォート。
sub q_lit {
    my ($s) = @_;
    $s =~ s/'/''/g;
    return "'$s'";
}

# ---- フィクスチャ ------------------------------------------------------------
my $seq = 0;
sub random_hex {
    my ($bytes) = @_;
    open my $fh, '<:raw', '/dev/urandom' or die "urandom: $!";
    read($fh, my $buf, $bytes);
    close $fh;
    return unpack('H*', $buf);
}

# ユーザーとログイン済みセッションを DB に直接作る（PBKDF2 を回さない高速経路）。
# このユーザーのパスワードはダミーで、API からのログインはできない。
# 戻り値: ($user_id, $session_token)
sub make_user {
    my (%opt) = @_;
    $seq++;
    my $username = $opt{username} // "user$seq";
    my $email    = $opt{email}    // "$username\@test.invalid";
    my $is_admin = $opt{is_admin} ? 'true' : 'false';
    my $uid = db_scalar(
        "INSERT INTO users (username, email, password_hash, salt, iterations, is_admin) VALUES ("
        . q_lit($username) . ", " . q_lit($email) . ", '" . ('0' x 64) . "', '" . ('0' x 32) . "', 1, $is_admin) RETURNING id");
    die "make_user failed for $username\n" unless $uid =~ /^\d+$/;
    my $sid = random_hex(32);
    db_do("INSERT INTO sessions (token, user_id, expires_at) VALUES ("
        . q_lit($sid) . ", $uid, now() + interval '1 day')");
    return ($uid, $sid);
}

# 実際のサインアップフロー（signup_request → トークンを DB から取得 → signup_complete）
# でユーザーを作る。戻り値: ($session_token, $response)。パスワードでログインできる。
sub signup_via_api {
    my (%opt) = @_;
    $seq++;
    my $email    = $opt{email}    // "signup$seq\@test.invalid";
    my $username = $opt{username} // "signup$seq";
    my $password = $opt{password} // 'secret-pw';
    my $res = api(method => 'POST', action => 'signup_request', body => { email => $email });
    die "signup_request failed: $res->{raw}\n" unless $res->{status} == 200;
    my $token = db_scalar("SELECT token FROM signup_tokens WHERE lower(email) = lower(" . q_lit($email) . ")");
    die "no signup token for $email\n" unless $token;
    $res = api(method => 'POST', action => 'signup_complete',
               body => { token => $token, username => $username, password => $password });
    die "signup_complete failed: $res->{raw}\n" unless $res->{status} == 200;
    return ($res->{sid}, $res);
}

# ---- 偽 sendmail が記録したメール --------------------------------------------
sub mails {
    my @m;
    if (-f mail_log()) {
        open my $fh, '<:raw', mail_log() or die $!;
        my $all = do { local $/; <$fh> };
        close $fh;
        @m = ($all =~ /=== MAIL ===\n(.*?)\n=== END ===\n/gs);
    }
    return @m;   # スカラーコンテキストでは通数（空でも 0）
}

sub clear_mails { unlink mail_log(); }

# ---- 偽 whois が記録した呼び出し（1行=1回、引数の IP） -------------------------
sub whois_log {
    my @lines;
    if (-f whois_log_file()) {
        open my $fh, '<:raw', whois_log_file() or die $!;
        chomp(@lines = <$fh>);
        close $fh;
    }
    return @lines;   # スカラーコンテキストでは呼び出し回数（空でも 0）
}

sub clear_whois_log { unlink whois_log_file(); }

# ---- CGI 実行 -----------------------------------------------------------------
sub url_encode {
    my ($s) = @_;
    utf8::encode($s) if utf8::is_utf8($s);
    $s =~ s/([^A-Za-z0-9\-_.~])/sprintf('%%%02X', ord($1))/ge;
    return $s;
}

# api.cgi を1リクエストぶん実行する。
#   api(method => 'POST', action => 'login', body => {...}, sid => $sid,
#       query => { id => 3 } または query => [ tag => 'a', tag => 'b' ], ip => '10.0.0.1')
# 戻り値: { status, status_line, headers, json, raw, sid, stderr }
#   sid は Set-Cookie で張られた zigsaw_sid（クリア時は ''、無ければ undef）。
sub api {
    my (%opt) = @_;
    my $method = uc($opt{method} // 'GET');

    my @pairs = (action => $opt{action} // '');
    if (ref $opt{query} eq 'HASH')  { push @pairs, %{ $opt{query} } }
    if (ref $opt{query} eq 'ARRAY') { push @pairs, @{ $opt{query} } }
    my @qs;
    while (@pairs) {
        my ($k, $v) = splice(@pairs, 0, 2);
        push @qs, url_encode($k) . '=' . url_encode($v // '');
    }
    my $query_string = join '&', @qs;

    my $body = '';
    if (defined $opt{body}) {
        $body = ref $opt{body}
            ? JSON::PP->new->utf8->canonical->encode($opt{body})
            : $opt{body};
        utf8::encode($body) if utf8::is_utf8($body);
    }

    my $io = "$SANDBOX/io";
    write_file("$io/req.body", $body);

    my $pid = fork();
    die "fork: $!" unless defined $pid;
    if ($pid == 0) {
        # 子プロセス: CGI 環境変数を用意して api.cgi を exec する。
        %ENV = (
            PATH              => '/usr/bin:/bin',
            GATEWAY_INTERFACE => 'CGI/1.1',
            SERVER_PROTOCOL   => 'HTTP/1.1',
            REQUEST_METHOD    => $method,
            QUERY_STRING      => $query_string,
            SCRIPT_NAME       => '/zigsaw/api.cgi',
            REMOTE_ADDR       => $opt{ip} // '127.0.0.1',
            HTTPS             => 'on',
            HTTP_HOST         => 'test.invalid',
            CONTENT_TYPE      => 'application/json',
            CONTENT_LENGTH    => length($body),
        );
        $ENV{HTTP_COOKIE} = "zigsaw_sid=$opt{sid}" if defined $opt{sid};
        $ENV{HTTP_COOKIE} = $opt{cookie} if defined $opt{cookie};
        open(STDIN,  '<', "$io/req.body") or die "stdin: $!";
        open(STDOUT, '>', "$io/res.out")  or die "stdout: $!";
        open(STDERR, '>', "$io/res.err")  or die "stderr: $!";
        chdir $SANDBOX;
        exec($CGI_PERL, "$SANDBOX/api.cgi") or die "exec: $!";
    }
    waitpid($pid, 0);

    my $raw    = do { open my $fh, '<:raw', "$io/res.out"; local $/; <$fh> } // '';
    my $stderr = do { open my $fh, '<:raw', "$io/res.err"; local $/; <$fh> } // '';

    my ($head, $payload) = split /\r\n\r\n/, $raw, 2;
    $head    = '' unless defined $head;
    $payload = '' unless defined $payload;
    my %headers;
    my ($status_line, $status) = ('', 0);
    for my $line (split /\r\n/, $head) {
        my ($k, $v) = split /:\s*/, $line, 2;
        next unless defined $v;
        push @{ $headers{lc $k} }, $v;
        if (lc $k eq 'status') {
            $status_line = $v;
            ($status) = $v =~ /^(\d+)/;
        }
    }
    my $sid;
    for my $c (@{ $headers{'set-cookie'} || [] }) {
        $sid = $1 if $c =~ /^zigsaw_sid=([^;]*)/;
    }
    my $json = eval { JSON::PP->new->utf8->decode($payload) };

    return {
        status      => $status || 0,
        status_line => $status_line,
        headers     => \%headers,
        json        => $json,
        raw         => $raw,
        stderr      => $stderr,
        sid         => $sid,
    };
}

# 略記
sub api_get    { api(method => 'GET',    @_) }
sub api_post   { api(method => 'POST',   @_) }
sub api_put    { api(method => 'PUT',    @_) }
sub api_delete { api(method => 'DELETE', @_) }

1;
