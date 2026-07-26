#!/usr/bin/perl
# 既存画像のサムネイル（images/thumb/<basename>.<ext>）を、full 画像から
# GraphicsMagick で作り直す保守スクリプト。
#
# 背景: 以前の seed_images.pl は full をそのまま thumb にコピーしていたため、
#   シード画像のサムネが巨大（一覧が重い）。gm 導入後に一括で縮小し直すための道具。
#
# 使い方:
#   /usr/bin/perl ddl/regen_thumbnails.pl            # シード画像(owner_id IS NULL)だけ
#   /usr/bin/perl ddl/regen_thumbnails.pl --all      # 全画像
#   /usr/bin/perl ddl/regen_thumbnails.pl --dry-run  # 変更せず対象と現状サイズだけ表示
use strict;
use warnings;
use DBI;
use File::Basename qw(dirname);
use Cwd qw(abs_path);

my $SCRIPT_DIR = dirname(abs_path(__FILE__));
my $ROOT       = dirname($SCRIPT_DIR);
my $IMAGE_DIR  = "$ROOT/images";

my $GM_BIN    = '/usr/bin/gm';
my $THUMB_MAX = 600;

my $ALL     = grep { $_ eq '--all' } @ARGV;
my $DRY_RUN = grep { $_ eq '--dry-run' } @ARGV;

die "gm が見つかりません（$GM_BIN）。先に GraphicsMagick を入れてください。\n"
    unless -x $GM_BIN;

my $dbh = DBI->connect('dbi:Pg:dbname=zigsaw', '', '',
    { RaiseError => 1, AutoCommit => 1, PrintError => 0, pg_enable_utf8 => 1 });

my $where = $ALL ? '' : 'WHERE owner_id IS NULL';
my $rows = $dbh->selectall_arrayref(
    "SELECT id, basename, ext FROM images $where ORDER BY id",
    { Slice => {} });

printf "対象 %d 件（%s）%s\n", scalar(@$rows),
    ($ALL ? '全画像' : 'シード画像 owner_id IS NULL'),
    ($DRY_RUN ? '  [DRY-RUN]' : '');

my ($ok, $skip, $fail, $before_total, $after_total) = (0, 0, 0, 0, 0);
for my $r (@$rows) {
    my $full  = "$IMAGE_DIR/full/$r->{basename}.$r->{ext}";
    # サムネは常に JPEG（.jpg）に統一する。full が png/webp/gif でも thumb は .jpg。
    my $thumb     = "$IMAGE_DIR/thumb/$r->{basename}.jpg";
    my $old_thumb = "$IMAGE_DIR/thumb/$r->{basename}.$r->{ext}";   # 旧命名（同じこともある）
    unless (-f $full) {
        print "  skip id=$r->{id}: full が無い ($full)\n";
        $skip++;
        next;
    }
    # 現状サイズは、既存の .jpg か旧拡張子 thumb のどちらかから拾う。
    my $cur = -f $thumb ? $thumb : (-f $old_thumb ? $old_thumb : undef);
    my $before = defined $cur ? -s $cur : 0;
    $before_total += $before;

    if ($DRY_RUN) {
        printf "  id=%-4d %-20s thumb現状 %6.1f KB\n",
            $r->{id}, "$r->{basename}.$r->{ext}", $before / 1024;
        next;
    }

    # いったん一時ファイルに作り、成功したら差し替える（失敗で既存を壊さない）。
    my $tmp = "$thumb.new.$$";
    # 出力形式は "jpg:" で明示する（一時ファイル名の拡張子からは推論できないため、
    # 付けないと入力がそのままの形式でコピーされてしまう）。
    my $rc  = system($GM_BIN, 'convert', $full,
                     '-resize', "${THUMB_MAX}x${THUMB_MAX}>", '-quality', '82', "jpg:$tmp");
    if ($rc != 0 || !-f $tmp) {
        unlink $tmp;
        print "  FAIL id=$r->{id}: gm convert 失敗\n";
        $fail++;
        next;
    }
    rename $tmp, $thumb or do {
        unlink $tmp;
        print "  FAIL id=$r->{id}: rename 失敗: $!\n";
        $fail++;
        next;
    };
    # 旧命名（.png など）の thumb が別ファイルとして残っていれば掃除する。
    unlink $old_thumb if $old_thumb ne $thumb && -f $old_thumb;
    my $after = -s $thumb;
    $after_total += $after;
    printf "  ok   id=%-4d %6.1f KB -> %6.1f KB\n",
        $r->{id}, $before / 1024, $after / 1024;
    $ok++;
}

$dbh->disconnect;

if ($DRY_RUN) {
    printf "\n合計 thumb 現状: %.1f MB\n", $before_total / 1024 / 1024;
} else {
    printf "\n完了: 成功 %d / スキップ %d / 失敗 %d\n", $ok, $skip, $fail;
    printf "thumb 合計: %.1f MB -> %.1f MB\n",
        $before_total / 1024 / 1024, $after_total / 1024 / 1024;
}
