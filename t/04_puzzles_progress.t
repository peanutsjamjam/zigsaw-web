#!/usr/local/bin/perl
# パズル（作成・束ね・一覧・絞り込み・削除）と途中経過（保存・一覧・snapshot・削除）。
use strict;
use warnings;
use utf8;
use FindBin;
use lib "$FindBin::Bin/lib";
use Test::More;
use ZigsawTest;

my ($alice_id, $alice) = make_user(username => 'alice');
my ($bob_id,   $bob)   = make_user(username => 'bob');

# 画像を2枚用意（alice がアップロード）。
sub upload {
    my (%over) = @_;
    my $res = api_post(action => 'image', sid => $alice, body => {
        display_name => 'パズル用', original_name => 'p.png',
        width => 800, height => 600, ext => 'png',
        full => TINY_PNG_B64, thumb => TINY_PNG_B64, %over,
    });
    die "upload failed: $res->{raw}" unless $res->{status} == 201;
    return $res->{json}{image}{id};
}
my $i1 = upload(display_name => '一枚目');
my $i2 = upload(display_name => '二枚目');

# ---- パズル作成の検証 -----------------------------------------------------------
my $res = api_post(action => 'puzzle', body => { image_id => $i1, columns => 4, rows => 5 });
is $res->{status}, 401, 'パズル作成: 未ログインは 401';

$res = api_post(action => 'puzzle', sid => $alice, body => { image_id => 0, columns => 4, rows => 5 });
is $res->{json}{error}, 'bad_request', 'パズル作成: image_id なしは 400';

$res = api_post(action => 'puzzle', sid => $alice, body => { image_id => 999999, columns => 4, rows => 5 });
is $res->{status}, 404, 'パズル作成: 無い画像は 404';

for my $grid ([1, 5], [5, 1], [41, 5], [5, 41]) {
    $res = api_post(action => 'puzzle', sid => $alice,
        body => { image_id => $i1, columns => $grid->[0], rows => $grid->[1] });
    is $res->{json}{error}, 'grid_invalid', "パズル作成: $grid->[0]x$grid->[1] は grid_invalid（2〜40）";
}

# ---- 作成と束ね -------------------------------------------------------------------
$res = api_post(action => 'puzzle', sid => $alice, body => { image_id => $i1, columns => 4, rows => 5 });
is $res->{status}, 201, 'パズル作成: 201';
my $p1 = $res->{json}{puzzle}{id};
is $res->{json}{puzzle}{columns}, 4, 'パズル作成: columns';
is $res->{json}{puzzle}{rows}, 5, 'パズル作成: rows';
is $res->{json}{puzzle}{creator}, 'alice', 'パズル作成: creator';
ok $res->{json}{puzzle}{mine}, 'パズル作成: mine=true';
is $res->{json}{puzzle}{play_count}, 0, 'パズル作成: play_count=0';

$res = api_post(action => 'puzzle', sid => $bob, body => { image_id => $i1, columns => 4, rows => 5 });
is $res->{status}, 201, 'パズル束ね: 同じ画像+グリッドでも 201';
is $res->{json}{puzzle}{id}, $p1, 'パズル束ね: 既存のパズルが返る（新規作成しない）';
is $res->{json}{puzzle}{creator}, 'alice', 'パズル束ね: 作成者は最初に作った人のまま';
ok !$res->{json}{puzzle}{mine}, 'パズル束ね: bob には mine=false';

$res = api_post(action => 'puzzle', sid => $alice, body => { image_id => $i1, columns => 2, rows => 2 });
my $p2 = $res->{json}{puzzle}{id};   # 4 ピース
$res = api_post(action => 'puzzle', sid => $bob, body => { image_id => $i2, columns => 6, rows => 6 });
my $p3 = $res->{json}{puzzle}{id};   # 36 ピース

# ---- 一覧と絞り込み ---------------------------------------------------------------
$res = api_get(action => 'puzzles');
is $res->{status}, 200, 'パズル一覧: 未ログインでも見られる';
is $res->{json}{total}, 3, 'パズル一覧: total=3';
is_deeply [ map { $_->{id} } @{ $res->{json}{puzzles} } ], [ $p2, $p1, $p3 ],
    'パズル一覧: 画像順→ピース数の少ない順';

$res = api_get(action => 'puzzles', query => { image_id => $i1 });
is $res->{json}{total}, 2, 'パズル一覧: image_id 指定でその画像のぶんだけ';

$res = api_get(action => 'puzzles', query => { pieces => '2-10' });
is_deeply [ map { $_->{id} } @{ $res->{json}{puzzles} } ], [$p2], '絞り込み: pieces=2-10 → 4 ピースのみ';
$res = api_get(action => 'puzzles', query => { pieces => '30-' });
is_deeply [ map { $_->{id} } @{ $res->{json}{puzzles} } ], [$p3], '絞り込み: pieces=30-（上限なし）→ 36 ピース';
$res = api_get(action => 'puzzles', query => { pieces => '2-10,30-' });
is $res->{json}{total}, 2, '絞り込み: カンマ区切りは OR';
$res = api_get(action => 'puzzles', query => { pieces => 'abc' });
is $res->{json}{total}, 3, '絞り込み: 数値でない pieces は無視';

# mine=1 は「自分がアップロードした画像のパズル」（作成者ではない）
$res = api_get(action => 'puzzles', sid => $alice, query => { mine => 1 });
is $res->{json}{total}, 3, '絞り込み: mine=1 (alice) → 自分の画像のパズル全部';
$res = api_get(action => 'puzzles', sid => $bob, query => { mine => 1 });
is $res->{json}{total}, 0, '絞り込み: mine=1 (bob) → 画像を持っていないので 0';

# タグ絞り込みは元画像のタグで効く
api_put(action => 'image', query => { id => $i2 }, sid => $alice,
    body => { display_name => '二枚目', tags => ['風景'] });
$res = api_get(action => 'puzzles', query => [ tag => '風景' ]);
is_deeply [ map { $_->{id} } @{ $res->{json}{puzzles} } ], [$p3], '絞り込み: tag は元画像のタグで効く';
is_deeply $res->{json}{puzzles}[0]{tags}, ['風景'], 'パズル一覧: 行に元画像のタグが載る';

# ---- 途中経過の保存（upsert） ------------------------------------------------------
my $state = { pieces => [1, 2, 3], elapsed => 12, snapshot => 'data:image/png;base64,SNAP' };
$res = api_put(action => 'progress', body => { puzzle_id => $p1, state => $state });
is $res->{status}, 401, '進捗保存: 未ログインは 401';

$res = api_put(action => 'progress', sid => $bob, body => { puzzle_id => 0, state => $state });
is $res->{json}{error}, 'bad_request', '進捗保存: puzzle_id なしは 400';
$res = api_put(action => 'progress', sid => $bob, body => { puzzle_id => $p1, state => 'not-a-hash' });
is $res->{json}{error}, 'bad_request', '進捗保存: state がオブジェクトでなければ 400';
$res = api_put(action => 'progress', sid => $bob, body => { puzzle_id => 999999, state => $state });
is $res->{status}, 404, '進捗保存: 無いパズルは 404';
is $res->{json}{error}, 'puzzle_removed', '進捗保存: error=puzzle_removed（フロントがゲームを終了させる）';

$res = api_put(action => 'progress', sid => $bob, body => { puzzle_id => $p1, state => $state });
is $res->{status}, 200, '進捗保存: 200';
my $prog1 = $res->{json}{id};
ok $prog1, '進捗保存: progress の id が返る';

$res = api_put(action => 'progress', sid => $bob,
    body => { puzzle_id => $p1, state => { %$state, elapsed => 99 } });
is $res->{json}{id}, $prog1, '進捗保存: 同じパズルへの保存は upsert（同じ id）';
is db_scalar("SELECT count(*) FROM progress WHERE user_id = $bob_id"), '1', '進捗保存: 行は増えない';

# state の上限（JSON で 1MB）
my $huge = { snapshot => 'x' x (1024 * 1024) };
$res = api_put(action => 'progress', sid => $bob, body => { puzzle_id => $p1, state => $huge });
is $res->{status}, 413, '進捗保存: 1MB 超の state は 413';
is $res->{json}{error}, 'payload_too_large', '進捗保存: error=payload_too_large';

# ---- 途中経過の一覧と snapshot -----------------------------------------------------
$res = api_get(action => 'progress', sid => $bob);
is $res->{status}, 200, '進捗一覧: 200';
is scalar @{ $res->{json}{progress} }, 1, '進捗一覧: 1 件';
my $row = $res->{json}{progress}[0];
is $row->{id}, $prog1, '進捗一覧: progress の id';
is $row->{state}{elapsed}, 99, '進捗一覧: state は最後に保存した内容';
ok !exists $row->{state}{snapshot}, '進捗一覧: 重い snapshot は省かれる';
is $row->{puzzle}{id}, $p1, '進捗一覧: パズル情報が付く（id はパズルの id）';
# 進捗一覧の SQL は play_count を引いていないので、この画面では常に 0（現状の仕様）。
is $row->{puzzle}{play_count}, 0, '進捗一覧: play_count はこの一覧では載らない（常に 0）';
is db_scalar("SELECT count(*) FROM progress WHERE puzzle_id = $p1"), '1',
    '進捗一覧: 実際のプレイ数は DB では 1';

$res = api_get(action => 'progress_snapshot', query => { id => $prog1 }, sid => $bob);
is $res->{json}{snapshot}, 'data:image/png;base64,SNAP', 'snapshot: 本人は取得できる';
$res = api_get(action => 'progress_snapshot', query => { id => $prog1 }, sid => $alice);
is $res->{json}{snapshot}, undef, 'snapshot: 他人の progress は null';

# ---- パズル削除 --------------------------------------------------------------------
$res = api_delete(action => 'puzzle', query => { id => $p1 });
is $res->{status}, 401, 'パズル削除: 未ログインは 401';
$res = api_delete(action => 'puzzle', query => { id => 999999 }, sid => $alice);
is $res->{status}, 404, 'パズル削除: 無い id は 404';
$res = api_delete(action => 'puzzle', query => { id => $p1 }, sid => $bob);
is $res->{status}, 403, 'パズル削除: 作成者でない bob は 403';
$res = api_delete(action => 'puzzle', query => { id => $p1 }, sid => $alice);
is $res->{status}, 409, 'パズル削除: プレイ中の人がいると 409';
is $res->{json}{error}, 'puzzle_in_use', 'パズル削除: error=puzzle_in_use';

# ---- 進捗削除（本人のもの以外は消えない） ------------------------------------------
$res = api_delete(action => 'progress', query => { id => $prog1 }, sid => $alice);
is $res->{status}, 200, '進捗削除: 他人の id を指定しても応答は ok';
is db_scalar("SELECT count(*) FROM progress WHERE id = $prog1"), '1', '進捗削除: 他人の progress は消えない';
$res = api_delete(action => 'progress', query => { id => $prog1 }, sid => $bob);
is $res->{status}, 200, '進捗削除: 本人は消せる';
is db_scalar("SELECT count(*) FROM progress WHERE id = $prog1"), '0', '進捗削除: DB から消える';

# 進捗が消えればパズルを削除できる
$res = api_delete(action => 'puzzle', query => { id => $p1 }, sid => $alice);
is $res->{status}, 200, 'パズル削除: 進捗が無くなれば作成者が消せる';
$res = api_put(action => 'progress', sid => $bob, body => { puzzle_id => $p1, state => $state });
is $res->{json}{error}, 'puzzle_removed', 'パズル削除後: 進捗保存は puzzle_removed';

# 画像を消すとパズルも進捗も道連れ（CASCADE）
$res = api_put(action => 'progress', sid => $bob, body => { puzzle_id => $p3, state => $state });
is $res->{status}, 200, 'CASCADE 準備: p3 に進捗を作る';
$res = api_delete(action => 'image', query => { id => $i2 }, sid => $alice);
is $res->{status}, 200, 'CASCADE: 画像削除は progress があっても成功する';
is db_scalar("SELECT count(*) FROM puzzles WHERE id = $p3"), '0', 'CASCADE: パズルも消える';
is db_scalar("SELECT count(*) FROM progress WHERE puzzle_id = $p3"), '0', 'CASCADE: 進捗も消える';

done_testing();
