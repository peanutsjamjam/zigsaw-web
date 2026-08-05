#!/usr/local/bin/perl
# 管理者機能: dev_*（開発環境の管理者のみ。それ以外には存在ごと隠して 404）と
# 緊急退避（image_quarantine）。
use strict;
use warnings;
use utf8;
use FindBin;
use lib "$FindBin::Bin/lib";
use Test::More;
use ZigsawTest;

my ($adm_id,   $adm)   = make_user(username => 'boss', is_admin => 1);
my ($alice_id, $alice) = make_user(username => 'alice');

# alice が画像→パズル→進捗を一式作る。
my $res = api_post(action => 'image', sid => $alice, body => {
    display_name => '退避対象', original_name => 'q.png',
    width => 800, height => 600, ext => 'png',
    full => TINY_PNG_B64, thumb => TINY_PNG_B64,
});
is $res->{status}, 201, '準備: alice が画像をアップロード';
my $img_id   = $res->{json}{image}{id};
my ($basename) = $res->{json}{image}{full_url} =~ m{/([0-9a-f]{32})\.png$};
api_put(action => 'image', query => { id => $img_id }, sid => $alice,
    body => { display_name => '退避対象', tags => ['問題画像'] });

$res = api_post(action => 'puzzle', sid => $alice, body => { image_id => $img_id, columns => 3, rows => 3 });
my $puz_id = $res->{json}{puzzle}{id};
$res = api_put(action => 'progress', sid => $alice,
    body => { puzzle_id => $puz_id, state => { elapsed => 1 } });
is $res->{status}, 200, '準備: 進捗も保存';

# ---- dev_* は「開発環境かつ管理者」以外には 404 -----------------------------------
for my $a (qw(dev_storage dev_users dev_user_detail dev_access_log)) {
    $res = api_get(action => $a);
    is $res->{status}, 404, "$a: 未ログインは 404（存在を隠す）";
    is $res->{json}{error}, 'not_found', "$a: error=not_found（401/403 ではない）";
    $res = api_get(action => $a, sid => $alice);
    is $res->{status}, 404, "$a: 一般ユーザーも 404";
}

# ---- dev_users --------------------------------------------------------------------
$res = api_get(action => 'dev_users', sid => $adm);
is $res->{status}, 200, 'dev_users: 管理者は 200';
my ($alice_row) = grep { $_->{username} eq 'alice' } @{ $res->{json}{users} };
ok $alice_row, 'dev_users: alice が載る';
is $alice_row->{image_count}, 1, 'dev_users: image_count';
is $alice_row->{puzzle_count}, 1, 'dev_users: puzzle_count';
is $alice_row->{progress_count}, 1, 'dev_users: progress_count';
is $alice_row->{last_ip}, '127.0.0.1', 'dev_users: 最終アクセス IP';
ok $alice_row->{image_bytes} > 0, 'dev_users: 実ファイルの合計サイズ';
ok !exists $alice_row->{password_hash}, 'dev_users: password_hash は返さない';
ok !exists $alice_row->{salt}, 'dev_users: salt は返さない';

# ---- dev_storage ------------------------------------------------------------------
$res = api_get(action => 'dev_storage', sid => $adm);
is $res->{status}, 200, 'dev_storage: 管理者は 200';
is $res->{json}{image_count}, 1, 'dev_storage: full のファイル数';
ok $res->{json}{total_bytes} > 0, 'dev_storage: 合計サイズ';
ok $res->{json}{fs_total} > 0, 'dev_storage: ファイルシステムの総容量';

# ---- dev_user_detail --------------------------------------------------------------
$res = api_get(action => 'dev_user_detail', query => { id => 0 }, sid => $adm);
is $res->{json}{error}, 'bad_request', 'dev_user_detail: id なしは 400';
$res = api_get(action => 'dev_user_detail', query => { id => $alice_id }, sid => $adm);
is $res->{status}, 200, 'dev_user_detail: 200';
is scalar @{ $res->{json}{images} }, 1, 'dev_user_detail: 画像一覧';
is scalar @{ $res->{json}{puzzles} }, 1, 'dev_user_detail: パズル一覧';
is scalar @{ $res->{json}{progress} }, 1, 'dev_user_detail: 進捗一覧';
is $res->{json}{progress}[0]{puzzle}{id}, $puz_id, 'dev_user_detail: 進捗にパズル情報が付く';

# ---- dev_access_log ---------------------------------------------------------------
# ここまでのリクエストはすべて 127.0.0.1 からなので、ダイジェストは1行に畳まれる。
$res = api_get(action => 'dev_access_log', sid => $adm);
is $res->{status}, 200, 'dev_access_log: 管理者は 200';
is scalar @{ $res->{json}{entries} }, 1, 'dev_access_log: IP ごとに1行に畳まれる';
my $entry = $res->{json}{entries}[0];
is $entry->{ip_addr}, '127.0.0.1', 'dev_access_log: ip_addr';
is $entry->{username}, 'boss', 'dev_access_log: 最新行のユーザー（この呼び出し自身）';
is $entry->{user_id}, $adm_id, 'dev_access_log: 最新行の user_id';
ok $entry->{accessed_at}, 'dev_access_log: accessed_at が付く';
ok db_scalar('SELECT count(*) FROM access_log') > 1,
    'dev_access_log: 生ログには複数行ある（ダイジェストであることの裏取り）';

# ---- dev_access_log: whois の Organization とキャッシュ -----------------------------
# 偽 whois（t/lib/ZigsawTest.pm が用意）は「その IPv4 の /24 が NetRange」という応答を返す。
is $entry->{organization}, 'Test Org 127.0.0 (TEST)', 'whois: Organization が表に付く';
is scalar(whois_log()), 1, 'whois: 初見の IP で1回だけ呼ばれる';
ok -f appdata_dir() . '/whois/127.0.0.0-127.0.0.255.json',
    'whois: NetRange 名のキャッシュファイルが作られる';

# 2回目はキャッシュに当たるので whois コマンドは呼ばれない。
$res = api_get(action => 'dev_access_log', sid => $adm);
is $res->{json}{entries}[0]{organization}, 'Test Org 127.0.0 (TEST)', 'whois: キャッシュからも同じ値';
is scalar(whois_log()), 1, 'whois: 2回目は叩かれない（キャッシュヒット）';

# 初見の NetRange の IP は whois される。同じ NetRange 内の別 IP はキャッシュで済む。
api_get(action => 'me', sid => $alice, ip => '203.0.113.5');
$res = api_get(action => 'dev_access_log', sid => $adm);
is scalar @{ $res->{json}{entries} }, 2, 'whois: 別 IP からのアクセスで2行になる';
my ($e2) = grep { $_->{ip_addr} eq '203.0.113.5' } @{ $res->{json}{entries} };
is $e2->{organization}, 'Test Org 203.0.113 (TEST)', 'whois: 初見の NetRange の Organization';
is scalar(whois_log()), 2, 'whois: 初見の NetRange の分だけ叩かれる';

api_get(action => 'me', sid => $alice, ip => '203.0.113.77');
$res = api_get(action => 'dev_access_log', sid => $adm);
is scalar @{ $res->{json}{entries} }, 3, 'whois: 同じ NetRange 内の別 IP も行としては増える';
my ($e3) = grep { $_->{ip_addr} eq '203.0.113.77' } @{ $res->{json}{entries} };
is $e3->{organization}, 'Test Org 203.0.113 (TEST)', 'whois: 同じ NetRange はキャッシュから引ける';
is scalar(whois_log()), 2, 'whois: 同じ NetRange では whois を叩き直さない';

# ---- 緊急退避（image_quarantine） ---------------------------------------------------
$res = api_post(action => 'image_quarantine', query => { id => $img_id });
is $res->{status}, 401, '退避: 未ログインは 401';
$res = api_post(action => 'image_quarantine', query => { id => $img_id }, sid => $alice);
is $res->{status}, 403, '退避: 一般ユーザーは 403（本人の画像でも不可）';
$res = api_post(action => 'image_quarantine', query => { id => 999999 }, sid => $adm);
is $res->{status}, 404, '退避: 無い id は 404';

$res = api_post(action => 'image_quarantine', query => { id => $img_id }, sid => $adm);
is $res->{status}, 200, '退避: 管理者は実行できる';
is $res->{json}{puzzles}, 1, '退避: 巻き添えのパズル数を返す';
is $res->{json}{progress}, 1, '退避: 巻き添えの進捗数を返す';
my $qdir = $res->{json}{dir};
like $qdir, qr/^\Q@{[quarantine_dir()]}\E\/\d{8}-\d{6}-image$img_id$/, '退避: 退避先はサンドボックス内の日時付きディレクトリ';

ok -d $qdir, '退避: ディレクトリが作られる';
ok -f "$qdir/meta.json", '退避: meta.json が書かれる';
ok -f "$qdir/full-$basename.png", '退避: full の実ファイルが移される';
ok -f "$qdir/thumb-$basename.jpg", '退避: thumb の実ファイルが移される';
ok !-f appdata_dir() . "/full/$basename.png", '退避: 配信ディレクトリからは消える';

my $meta = do { open my $fh, '<:raw', "$qdir/meta.json" or die $!; local $/; <$fh> };
require JSON::PP;
my $m = JSON::PP->new->utf8->decode($meta);
is $m->{removed_by}, 'boss', 'meta.json: 誰が消したか';
is $m->{image}{id}, $img_id, 'meta.json: 画像の行';
is scalar @{ $m->{puzzles} }, 1, 'meta.json: パズルの行';
is $m->{progress}[0]{player}, 'alice', 'meta.json: 誰がプレイ中だったか';
is_deeply $m->{tags}, ['問題画像'], 'meta.json: 付いていたタグ';

is db_scalar("SELECT count(*) FROM images WHERE id = $img_id"), '0', '退避: images から消える';
is db_scalar("SELECT count(*) FROM puzzles WHERE image_id = $img_id"), '0', '退避: パズルも消える';
is db_scalar("SELECT count(*) FROM progress WHERE puzzle_id = $puz_id"), '0', '退避: 進捗も消える';
is db_scalar("SELECT count(*) FROM tags"), '0', '退避: 使われなくなったタグも掃除される';

# プレイ中だった人の次の保存は puzzle_removed になる（フロントがゲームを終了させる）
$res = api_put(action => 'progress', sid => $alice,
    body => { puzzle_id => $puz_id, state => { elapsed => 2 } });
is $res->{json}{error}, 'puzzle_removed', '退避後: プレイしていた人の保存は puzzle_removed';

done_testing();
