#!/usr/local/bin/perl
# 基本のルーティングと共通挙動。
use strict;
use warnings;
use utf8;
use FindBin;
use lib "$FindBin::Bin/lib";
use Test::More;
use ZigsawTest;

# ---- env: DB 不要で環境名を返す ---------------------------------------------
my $res = api_get(action => 'env');
is $res->{status}, 200, 'env: 200';
is $res->{json}{env}, 'development', 'env: サンドボックスの env.pl の値を返す';
like $res->{headers}{'content-type'}[0], qr/application\/json/, 'env: JSON で返る';

# ---- 未知の action / メソッド違いは 404 --------------------------------------
$res = api_get(action => 'no_such_action');
is $res->{status}, 404, '未知 action: 404';
is $res->{json}{error}, 'not_found', '未知 action: error=not_found';

$res = api_post(action => 'env');
is $res->{status}, 404, 'env に POST: 404（メソッド違い）';

$res = api_get(action => 'login');
is $res->{status}, 404, 'login に GET: 404（メソッド違い）';

$res = api_get(action => '');
is $res->{status}, 404, 'action なし: 404';

# ---- 認証必須エンドポイントは未ログインで 401 --------------------------------
for my $ep ([GET => 'me'], [GET => 'progress'], [POST => 'image'],
            [POST => 'puzzle'], [PUT => 'progress'], [DELETE => 'account'],
            [POST => 'change_password']) {
    my ($m, $a) = @$ep;
    my $r = api(method => $m, action => $a);
    is $r->{status}, 401, "$m $a: 未ログインは 401";
    is $r->{json}{error}, 'not_authenticated', "$m $a: error=not_authenticated";
}

# ---- 不正な Cookie は未ログイン扱い ------------------------------------------
$res = api_get(action => 'me', sid => 'not-a-hex-token');
is $res->{status}, 401, '形式外のセッショントークン: 401';

$res = api_get(action => 'me', sid => 'f' x 64);
is $res->{status}, 401, '存在しないセッショントークン: 401';

# ---- セッションが有効なら me が返る（Cookie の属性も確認） --------------------
my ($uid, $sid) = make_user(username => 'basic-user');
$res = api_get(action => 'me', sid => $sid);
is $res->{status}, 200, 'me: 200';
is $res->{json}{username}, 'basic-user', 'me: username';
is $res->{json}{email}, 'basic-user@test.invalid', 'me: email';
ok !$res->{json}{is_admin}, 'me: is_admin=false';

# ログインで張られる Cookie の属性（logout で確認しやすいので logout 側で見る）
$res = api_post(action => 'logout', sid => $sid);
is $res->{status}, 200, 'logout: 200';
my ($cookie) = grep { /^zigsaw_sid=/ } @{ $res->{headers}{'set-cookie'} || [] };
ok $cookie, 'logout: Set-Cookie が返る';
like $cookie, qr/zigsaw_sid=;/,      'logout: Cookie は空にクリア';
like $cookie, qr/Max-Age=0/,         'logout: Max-Age=0';
like $cookie, qr/HttpOnly/,          'logout: HttpOnly';
like $cookie, qr/Secure/,            'logout: Secure';
like $cookie, qr{Path=/zigsaw/},     'logout: Path は SCRIPT_NAME から導出';

$res = api_get(action => 'me', sid => $sid);
is $res->{status}, 401, 'logout 後: セッション無効';

# ---- アクセスログが記録される -------------------------------------------------
my $n = db_scalar("SELECT count(*) FROM access_log WHERE ip_addr = '127.0.0.1'");
ok $n > 0, "access_log にリクエストが記録されている ($n 件)";

# ---- ボディ上限（CONTENT_LENGTH で先に弾く） ----------------------------------
$res = api(method => 'POST', action => 'login', body => 'x' x (12 * 1024 * 1024 + 1));
is $res->{status}, 413, '12MB 超のボディ: 413';
is $res->{json}{error}, 'payload_too_large', '12MB 超のボディ: error=payload_too_large';

# ---- 壊れた JSON ボディは空ボディ扱い（500 にはならない） ----------------------
$res = api(method => 'POST', action => 'login', body => '{"broken');
is $res->{status}, 401, '壊れた JSON: 500 にならず通常の検証エラー系';

done_testing();
