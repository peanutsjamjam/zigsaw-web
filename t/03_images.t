#!/usr/local/bin/perl
# 画像: アップロード（検証・実ファイル）、一覧（ページング・絞り込み）、
# 1件取得、変更（タイトル・タグ・権限）、削除、タグの掃除。
use strict;
use warnings;
use utf8;
use FindBin;
use lib "$FindBin::Bin/lib";
use Test::More;
use ZigsawTest;
use MIME::Base64 ();

my ($alice_id, $alice) = make_user(username => 'alice');
my ($bob_id,   $bob)   = make_user(username => 'bob');
my ($adm_id,   $adm)   = make_user(username => 'boss', is_admin => 1);

# アップロード用ボディの雛形。
sub upload_body {
    my (%over) = @_;
    return {
        display_name  => 'テスト画像',
        original_name => 'test.png',
        width         => 800,
        height        => 600,
        ext           => 'png',
        full          => 'data:image/png;base64,' . TINY_PNG_B64,
        thumb         => TINY_PNG_B64,
        %over,
    };
}

# ---- アップロードの検証 --------------------------------------------------------
my $res = api_post(action => 'image', body => upload_body());
is $res->{status}, 401, 'アップロード: 未ログインは 401';

$res = api_post(action => 'image', sid => $alice, body => upload_body(ext => 'svg'));
is $res->{json}{error}, 'image_ext_invalid', 'アップロード: svg は拒否（保存型 XSS 対策）';

$res = api_post(action => 'image', sid => $alice, body => upload_body(ext => 'html'));
is $res->{json}{error}, 'image_ext_invalid', 'アップロード: html は拒否';

$res = api_post(action => 'image', sid => $alice, body => upload_body(width => 0));
is $res->{json}{error}, 'image_dimensions_invalid', 'アップロード: width=0 は拒否';

$res = api_post(action => 'image', sid => $alice, body => upload_body(height => 20001));
is $res->{json}{error}, 'image_dimensions_invalid', 'アップロード: height=20001 は拒否';

$res = api_post(action => 'image', sid => $alice, body => upload_body(full => ''));
is $res->{json}{error}, 'image_missing', 'アップロード: full なしは拒否';
is $res->{json}{params}{field}, 'full', 'アップロード: どのフィールドかを返す';

$res = api_post(action => 'image', sid => $alice, body => upload_body(thumb => undef));
is $res->{json}{error}, 'image_missing', 'アップロード: thumb なしは拒否';

# デコード後 8MB 超の full は 413。
my $big = MIME::Base64::encode_base64('A' x (8 * 1024 * 1024 + 1), '');
$res = api_post(action => 'image', sid => $alice, body => upload_body(full => $big));
is $res->{status}, 413, 'アップロード: 8MB 超の full は 413';
is $res->{json}{error}, 'image_too_large', 'アップロード: error=image_too_large';

# ---- アップロード成功 ----------------------------------------------------------
$res = api_post(action => 'image', sid => $alice, body => upload_body());
is $res->{status}, 201, 'アップロード: 201 Created';
my $img = $res->{json}{image};
is $img->{display_name}, 'テスト画像', 'アップロード: display_name（日本語もそのまま）';
is $img->{original_name}, 'test.png', 'アップロード: original_name';
is $img->{width}, 800, 'アップロード: width は数値';
ok $img->{mine}, 'アップロード: mine=true';
is $img->{owner}, 'alice', 'アップロード: owner はユーザー名';
is $img->{upload_ip}, '127.0.0.1', 'アップロード: upload_ip が記録される';
like $img->{full_url},  qr{^https://test\.invalid/zigsaw/appdata/full/[0-9a-f]{32}\.png$},  'アップロード: full_url';
like $img->{thumb_url}, qr{^https://test\.invalid/zigsaw/appdata/thumb/[0-9a-f]{32}\.jpg$}, 'アップロード: thumb は常に .jpg';

my ($basename) = $img->{full_url} =~ m{/([0-9a-f]{32})\.png$};
ok -f appdata_dir() . "/full/$basename.png",  'アップロード: full の実ファイルが書かれる';
ok -f appdata_dir() . "/thumb/$basename.jpg", 'アップロード: thumb の実ファイルが書かれる';
my $img1 = $img->{id};

# jpeg は jpg に正規化。display_name 空は untitled。
$res = api_post(action => 'image', sid => $alice,
    body => upload_body(ext => 'jpeg', display_name => '   ', original_name => 'photo.jpeg'));
is $res->{status}, 201, 'アップロード: ext=jpeg も通る';
like $res->{json}{image}{full_url}, qr/\.jpg$/, 'アップロード: jpeg は jpg に正規化';
is $res->{json}{image}{display_name}, 'untitled', 'アップロード: 空タイトルは untitled';
my $img2 = $res->{json}{image}{id};

$res = api_post(action => 'image', sid => $alice, body => upload_body(display_name => 'Z' x 300));
is length($res->{json}{image}{display_name}), 200, 'アップロード: タイトルは 200 文字に切り詰め';
my $img3 = $res->{json}{image}{id};

# ---- 一覧とページング -----------------------------------------------------------
$res = api_get(action => 'images');
is $res->{status}, 200, '一覧: 未ログインでも見られる';
is $res->{json}{total}, 3, '一覧: total=3';
ok !$res->{json}{images}[0]{mine}, '一覧: 未ログインでは mine=false';
is $res->{json}{images}[0]{id}, $img3, '一覧: 新しい順';

$res = api_get(action => 'images', query => { per_page => 2, page => 1 });
is scalar @{ $res->{json}{images} }, 2, 'ページング: per_page=2 で 2 件';
is $res->{json}{total}, 3, 'ページング: total は全体の件数';
$res = api_get(action => 'images', query => { per_page => 2, page => 2 });
is scalar @{ $res->{json}{images} }, 1, 'ページング: 2 ページ目は残り 1 件';
is $res->{json}{images}[0]{id}, $img1, 'ページング: 2 ページ目は一番古い画像';

$res = api_get(action => 'images', query => { per_page => 0 });
is $res->{json}{per_page}, 30, 'ページング: per_page=0 は既定の 30 に丸め';
$res = api_get(action => 'images', query => { per_page => 999 });
is $res->{json}{per_page}, 200, 'ページング: per_page は 200 が上限';

$res = api_get(action => 'images', sid => $alice, query => { mine => 1 });
is $res->{json}{total}, 3, 'mine=1: alice は自分の 3 件';
$res = api_get(action => 'images', sid => $bob, query => { mine => 1 });
is $res->{json}{total}, 0, 'mine=1: bob は 0 件';

# ---- 1件取得 --------------------------------------------------------------------
$res = api_get(action => 'image', query => { id => $img1 }, sid => $alice);
is $res->{status}, 200, '1件取得: 200';
is $res->{json}{image}{id}, $img1, '1件取得: id が一致';
ok $res->{json}{image}{mine}, '1件取得: 本人なら mine=true';
$res = api_get(action => 'image', query => { id => 999999 });
is $res->{status}, 404, '1件取得: 無い id は 404';

# ---- 変更（タイトル・タグ・権限） -------------------------------------------------
$res = api_put(action => 'image', query => { id => $img1 }, body => { display_name => 'x' });
is $res->{status}, 401, '変更: 未ログインは 401';

$res = api_put(action => 'image', query => { id => $img1 }, sid => $bob, body => { display_name => '乗っ取り' });
is $res->{status}, 403, '変更: 他人の画像は 403';

$res = api_put(action => 'image', query => { id => $img1 }, sid => $alice, body => { display_name => '  ' });
is $res->{json}{error}, 'bad_request', '変更: 空タイトルは 400';

$res = api_put(action => 'image', query => { id => 999999 }, sid => $alice, body => { display_name => 'x' });
is $res->{status}, 404, '変更: 無い id は 404';

$res = api_put(action => 'image', query => { id => $img1 }, sid => $alice,
    body => { display_name => '新しい題名', tags => ['海', '山', '海', " 空\x{3000}", "bad\x01tag"] });
is $res->{status}, 200, '変更: 200';
is $res->{json}{image}{display_name}, '新しい題名', '変更: タイトルが変わる';
is_deeply [ sort @{ $res->{json}{image}{tags} } ], [ sort ('海', '山', '空', 'badtag') ],
    '変更: タグは trim・重複除去・制御文字除去されて付く';

$res = api_put(action => 'image', query => { id => $img1 }, sid => $alice, body => { display_name => '新しい題名' });
is_deeply [ sort @{ $res->{json}{image}{tags} } ], [ sort ('海', '山', '空', 'badtag') ],
    '変更: tags キーなしならタグは据え置き';

# タグ絞り込み（AND）
$res = api_put(action => 'image', query => { id => $img2 }, sid => $alice,
    body => { display_name => '二枚目', tags => ['海'] });
is $res->{status}, 200, '変更: 二枚目に海タグ';

$res = api_get(action => 'images', query => [ tag => '海' ]);
is $res->{json}{total}, 2, 'タグ絞り込み: 海 → 2 件';
$res = api_get(action => 'images', query => [ tag => '海', tag => '山' ]);
is $res->{json}{total}, 1, 'タグ絞り込み: 海∧山 → 1 件（複数タグは AND）';
$res = api_get(action => 'images', query => [ tag => '無いタグ' ]);
is $res->{json}{total}, 0, 'タグ絞り込み: 存在しないタグ → 0 件';

$res = api_get(action => 'tags');
is_deeply [ sort @{ $res->{json}{tags} } ], [ sort ('海', '山', '空', 'badtag') ],
    'tags: 使われているタグの一覧';

# 空配列で全部外すと、使われなくなったタグ行は掃除される
$res = api_put(action => 'image', query => { id => $img1 }, sid => $alice,
    body => { display_name => '新しい題名', tags => [] });
is_deeply $res->{json}{image}{tags}, [], '変更: tags=[] で全部外れる';
$res = api_get(action => 'tags');
is_deeply $res->{json}{tags}, ['海'], 'tags: どの画像からも使われないタグ行は消える';

# 管理者は他人の画像を変更できる
$res = api_put(action => 'image', query => { id => $img1 }, sid => $adm,
    body => { display_name => '管理者が改名' });
is $res->{status}, 200, '変更: 管理者は他人の画像も変更できる';

# ---- 削除 -------------------------------------------------------------------------
$res = api_delete(action => 'image', query => { id => $img3 });
is $res->{status}, 401, '削除: 未ログインは 401';
$res = api_delete(action => 'image', query => { id => $img3 }, sid => $bob);
is $res->{status}, 403, '削除: 他人の画像は 403';
$res = api_delete(action => 'image', query => { id => 999999 }, sid => $alice);
is $res->{status}, 404, '削除: 無い id は 404';

my $base3 = db_scalar("SELECT basename FROM images WHERE id = $img3");
$res = api_delete(action => 'image', query => { id => $img3 }, sid => $alice);
is $res->{status}, 200, '削除: 本人は削除できる';
is db_scalar("SELECT count(*) FROM images WHERE id = $img3"), '0', '削除: DB の行が消える';
ok !-f appdata_dir() . "/full/$base3.png", '削除: full の実ファイルが消える';
ok !-f appdata_dir() . "/thumb/$base3.jpg", '削除: thumb の実ファイルが消える';

$res = api_delete(action => 'image', query => { id => $img2 }, sid => $adm);
is $res->{status}, 200, '削除: 管理者は他人の画像も削除できる';
$res = api_get(action => 'tags');
is_deeply $res->{json}{tags}, [], '削除: 画像が消えれば残っていたタグも掃除される';

# ---- 退会すると画像は owner_id=NULL で残る -----------------------------------------
my ($carol_id, $carol) = make_user(username => 'carol');
$res = api_post(action => 'image', sid => $carol, body => upload_body(display_name => 'carol の画像'));
my $cimg = $res->{json}{image}{id};
$res = api_delete(action => 'account', sid => $carol);
is $res->{status}, 200, '退会: 200';
$res = api_get(action => 'image', query => { id => $cimg });
is $res->{status}, 200, '退会: 画像はギャラリーに残る';
is $res->{json}{image}{owner}, undef, '退会: owner は null になる';

done_testing();
