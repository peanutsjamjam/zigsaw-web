#!/usr/local/bin/perl
# 認証まわり: サインアップ（メール確認）、ログイン、レート制限、
# パスワード変更、パスワード再設定、退会。
# PBKDF2 を実際に回すフローなので、他のファイルより時間がかかる（十数秒）。
use strict;
use warnings;
use utf8;
use FindBin;
use lib "$FindBin::Bin/lib";
use Test::More;
use ZigsawTest;

my $EMAIL = 'alice@test.invalid';
my $PW    = 'correct horse';

# ---- signup_request の入力検証 ------------------------------------------------
my $res = api_post(action => 'signup_request', body => {});
is $res->{status}, 400, 'signup_request: email なしは 400';
is $res->{json}{error}, 'email_required', 'signup_request: error=email_required';

$res = api_post(action => 'signup_request', body => { email => 'not-an-address' });
is $res->{json}{error}, 'email_invalid', 'signup_request: 形式外は email_invalid';

$res = api_post(action => 'signup_request', body => { email => ('x' x 250) . '@a.jp' });
is $res->{json}{error}, 'email_invalid', 'signup_request: 254 文字超は email_invalid';

# ---- サインアップ一式 ----------------------------------------------------------
clear_mails();
$res = api_post(action => 'signup_request', body => { email => $EMAIL });
is $res->{status}, 200, 'signup_request: 200';
ok $res->{json}{ok}, 'signup_request: {ok}';

my $token = db_scalar("SELECT token FROM signup_tokens WHERE email = " . q_lit($EMAIL));
ok $token, 'signup_request: トークンが DB に入る';

my @mail = mails();
is scalar(@mail), 1, 'signup_request: メールが1通送られる';
like $mail[0], qr/To: \Q$EMAIL\E/, 'メール: 宛先';
like $mail[0], qr/^From: Zigsaw <noreply\@test\.invalid>/m,
    'メール: 差出人は env.pl の ZIGSAW_MAIL_FROM';
# 本文は base64 なのでデコードして確認する。
require MIME::Base64;
my ($b64) = $mail[0] =~ /\r?\n\r?\n(.*)\z/s;
my $mail_body = MIME::Base64::decode_base64($b64 // '');
like $mail_body, qr{https://test\.invalid/zigsaw/\?signup=\Q$token\E},
    'メール: ZIGSAW_BASE_URL 起点のサインアップリンクを含む';

$res = api_get(action => 'signup_verify', query => { token => 'deadbeef' });
is $res->{status}, 400, 'signup_verify: 無効トークンは 400';
is $res->{json}{error}, 'signup_token_invalid', 'signup_verify: error=signup_token_invalid';

$res = api_get(action => 'signup_verify', query => { token => $token });
is $res->{status}, 200, 'signup_verify: 200';
is $res->{json}{email}, $EMAIL, 'signup_verify: email が返る';

$res = api_post(action => 'signup_complete', body => { token => 'deadbeef', username => 'alice', password => $PW });
is $res->{json}{error}, 'signup_token_invalid', 'signup_complete: 無効トークンは弾く';

$res = api_post(action => 'signup_complete', body => { token => $token, username => 'alice', password => 'abc' });
is $res->{json}{error}, 'password_too_short', 'signup_complete: 3文字パスワードは短すぎ';

$res = api_post(action => 'signup_complete', body => { token => $token, username => 'alice', password => 'x' x 129 });
is $res->{json}{error}, 'password_too_long', 'signup_complete: 129文字パスワードは長すぎ';

$res = api_post(action => 'signup_complete', body => { token => $token, username => '   ', password => $PW });
is $res->{json}{error}, 'username_length', 'signup_complete: 空白だけのユーザー名は不可';

$res = api_post(action => 'signup_complete', body => { token => $token, username => 'y' x 51, password => $PW });
is $res->{json}{error}, 'username_length', 'signup_complete: 51文字のユーザー名は不可';

$res = api_post(action => 'signup_complete', body => { token => $token, username => 'alice', password => $PW });
is $res->{status}, 200, 'signup_complete: 200';
is $res->{json}{username}, 'alice', 'signup_complete: username';
ok !$res->{json}{is_admin}, 'signup_complete: is_admin=false';
ok $res->{sid}, 'signup_complete: セッション Cookie が張られる';
my $sid = $res->{sid};

is db_scalar("SELECT count(*) FROM signup_tokens WHERE email = " . q_lit($EMAIL)), '0',
    'signup_complete: 使い終わったトークンは消える';

$res = api_get(action => 'me', sid => $sid);
is $res->{json}{email}, $EMAIL, 'me: サインアップ直後からログイン状態';

# ---- 登録済みメールへの signup_request は「既存アカウント」メール ---------------
clear_mails();
$res = api_post(action => 'signup_request', body => { email => uc($EMAIL) });   # 大文字でも同一視
is $res->{status}, 200, '登録済み email: 応答は普通の {ok}（存在を秘匿）';
@mail = mails();
is scalar(@mail), 1, '登録済み email: メールは送られる';
($b64) = $mail[0] =~ /\r?\n\r?\n(.*)\z/s;
like MIME::Base64::decode_base64($b64 // ''), qr/already exists/,
    '登録済み email: 「既にアカウントがあります」の案内';
is db_scalar("SELECT count(*) FROM signup_tokens WHERE lower(email) = lower(" . q_lit($EMAIL) . ")"), '0',
    '登録済み email: サインアップトークンは作られない';

# ---- ユーザー名の重複は 409 ----------------------------------------------------
api_post(action => 'signup_request', body => { email => 'dup@test.invalid' });
my $token2 = db_scalar("SELECT token FROM signup_tokens WHERE email = 'dup\@test.invalid'");
$res = api_post(action => 'signup_complete', body => { token => $token2, username => 'alice', password => $PW });
is $res->{status}, 409, 'signup_complete: ユーザー名重複は 409';
is $res->{json}{error}, 'duplicate', 'signup_complete: error=duplicate';
is_deeply $res->{json}{fields}, ['username'], 'signup_complete: fields=[username]';

# ---- メール送信のレート制限（同一宛先 3通/時） ---------------------------------
clear_mails();
db_do("DELETE FROM rate_events");
my $bomb = 'bomb@test.invalid';
api_post(action => 'signup_request', body => { email => $bomb }) for 1 .. 3;
is scalar(mails()), 3, 'メール爆撃対策: 3通目までは送られる';
$res = api_post(action => 'signup_request', body => { email => $bomb });
is $res->{status}, 200, 'メール爆撃対策: 4通目も応答は {ok}（スロットル秘匿）';
is scalar(mails()), 3, 'メール爆撃対策: 4通目は送られない';
db_do("DELETE FROM rate_events");

# ---- ログイン -----------------------------------------------------------------
$res = api_post(action => 'login', body => { email => $EMAIL, password => 'wrong' });
is $res->{status}, 401, 'login: パスワード違いは 401';
is $res->{json}{error}, 'invalid_credentials', 'login: error=invalid_credentials';

$res = api_post(action => 'login', body => { email => 'ghost@test.invalid', password => 'wrong' });
is $res->{status}, 401, 'login: 未登録メールも同じ 401（存在を秘匿）';
is $res->{json}{error}, 'invalid_credentials', 'login: 未登録メールも同じエラーコード';

$res = api_post(action => 'login', body => { email => uc($EMAIL), password => $PW });
is $res->{status}, 200, 'login: メールは大文字小文字を無視';
is $res->{json}{username}, 'alice', 'login: username が返る';
ok $res->{sid}, 'login: セッション Cookie';
my $sid2 = $res->{sid};

# ---- ログインのレート制限（同一メール 5回/15分） --------------------------------
db_do("DELETE FROM rate_events");
api_post(action => 'login', body => { email => $EMAIL, password => 'wrong' }) for 1 .. 5;
$res = api_post(action => 'login', body => { email => $EMAIL, password => $PW });
is $res->{status}, 429, 'login: 5回失敗の後は正しいパスワードでも 429';
is $res->{json}{error}, 'too_many_attempts', 'login: error=too_many_attempts';
db_do("DELETE FROM rate_events");
$res = api_post(action => 'login', body => { email => $EMAIL, password => $PW });
is $res->{status}, 200, 'login: 失敗記録が消えれば再びログインできる';

# 成功でそのメールの失敗記録がクリアされる
db_do("DELETE FROM rate_events");
api_post(action => 'login', body => { email => $EMAIL, password => 'wrong' }) for 1 .. 4;
$res = api_post(action => 'login', body => { email => $EMAIL, password => $PW });
is $res->{status}, 200, 'login: 4回失敗まではログインできる';
is db_scalar("SELECT count(*) FROM rate_events WHERE action = 'login_fail' AND subject = 'email:" . lc($EMAIL) . "'"),
    '0', 'login: 成功したらそのメールの失敗記録はクリア';
db_do("DELETE FROM rate_events");

# ---- パスワード変更 -------------------------------------------------------------
$res = api_post(action => 'change_password', sid => $sid2,
                body => { current_password => 'wrong', new_password => 'new password' });
is $res->{status}, 403, 'change_password: 現在のパスワード違いは 403';
is $res->{json}{error}, 'current_password_wrong', 'change_password: error=current_password_wrong';

$res = api_post(action => 'change_password', sid => $sid2,
                body => { current_password => $PW, new_password => 'abc' });
is $res->{json}{error}, 'password_too_short', 'change_password: 短すぎる新パスワードは不可';

$res = api_post(action => 'change_password', sid => $sid2,
                body => { current_password => $PW, new_password => 'new password' });
is $res->{status}, 200, 'change_password: 200';

$res = api_post(action => 'login', body => { email => $EMAIL, password => $PW });
is $res->{status}, 401, 'change_password: 旧パスワードではログインできない';
$res = api_post(action => 'login', body => { email => $EMAIL, password => 'new password' });
is $res->{status}, 200, 'change_password: 新パスワードでログインできる';
$PW = 'new password';
db_do("DELETE FROM rate_events");

# ---- パスワード再設定 -----------------------------------------------------------
$res = api_post(action => 'reset_request', body => {});
is $res->{json}{error}, 'email_required', 'reset_request: email なしは 400';

clear_mails();
$res = api_post(action => 'reset_request', body => { email => 'ghost@test.invalid' });
is $res->{status}, 200, 'reset_request: 未登録メールも {ok}（存在を秘匿）';
is scalar(mails()), 0, 'reset_request: 未登録メールには送らない';

$res = api_post(action => 'reset_request', body => { email => $EMAIL });
is $res->{status}, 200, 'reset_request: 200';
my $rtoken = db_scalar("SELECT token FROM reset_tokens r JOIN users u ON u.id = r.user_id WHERE u.email = " . q_lit($EMAIL));
ok $rtoken, 'reset_request: トークンが DB に入る';
@mail = mails();
is scalar(@mail), 1, 'reset_request: メールが1通送られる';
($b64) = $mail[0] =~ /\r?\n\r?\n(.*)\z/s;
like MIME::Base64::decode_base64($b64 // ''), qr{\?reset=\Q$rtoken\E}, 'メール: 再設定リンクを含む';

$res = api_get(action => 'reset_verify', query => { token => 'deadbeef' });
is $res->{json}{error}, 'reset_token_invalid', 'reset_verify: 無効トークンは弾く';
$res = api_get(action => 'reset_verify', query => { token => $rtoken });
is $res->{json}{email}, $EMAIL, 'reset_verify: email が返る';

$res = api_post(action => 'reset_complete', body => { token => $rtoken, password => 'abc' });
is $res->{json}{error}, 'password_too_short', 'reset_complete: 短すぎるパスワードは不可';

$res = api_post(action => 'reset_complete', body => { token => $rtoken, password => 'reset pw' });
is $res->{status}, 200, 'reset_complete: 200';
ok $res->{sid}, 'reset_complete: ログイン状態になる';
my $sid3 = $res->{sid};

is db_scalar("SELECT count(*) FROM reset_tokens r JOIN users u ON u.id = r.user_id WHERE u.email = " . q_lit($EMAIL)),
    '0', 'reset_complete: トークンは消える';
$res = api_get(action => 'me', sid => $sid2);
is $res->{status}, 401, 'reset_complete: 既存の全セッションは無効化される';
$res = api_get(action => 'me', sid => $sid3);
is $res->{status}, 200, 'reset_complete: 新しいセッションは有効';
$res = api_post(action => 'login', body => { email => $EMAIL, password => 'reset pw' });
is $res->{status}, 200, 'reset_complete: 新パスワードでログインできる';

# ---- 退会 -----------------------------------------------------------------------
$res = api_delete(action => 'account', sid => $sid3);
is $res->{status}, 200, 'account 削除: 200';
$res = api_get(action => 'me', sid => $sid3);
is $res->{status}, 401, 'account 削除: セッションは使えなくなる';
is db_scalar("SELECT count(*) FROM users WHERE email = " . q_lit($EMAIL)), '0', 'account 削除: users から消える';

done_testing();
