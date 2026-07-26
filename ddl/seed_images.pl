#!/usr/bin/perl
# 管理者が置いた画像を、みんなで遊べるギャラリー（images テーブル）に登録する。
#
# 使い方:
#   1. 画像ファイルを  ~/public_html/zigsaw/images/incoming/  に置く（jpg/jpeg/png/webp/gif）。
#   2. このスクリプトを実行する:
#        /usr/bin/perl ddl/seed_images.pl
#   すると incoming/ の各画像を images/full と images/thumb にコピーし、DB に owner_id=NULL
#   （＝管理者設置）で登録して、incoming/ からは取り除く。
#
# ※ サーバーに画像処理系が無いので、縮小もサムネ生成もしない（full と thumb には同じ
#    元画像をそのまま置く）。遊ぶときはブラウザ側で縮小するので、大きすぎる画像は
#    あらかじめ手元で適当な大きさ（長辺 1800px 程度）に縮小してから置くのが望ましい。
use strict;
use warnings;
use DBI;
use File::Basename qw(dirname);
use File::Spec;
use Cwd qw(abs_path);

# スクリプトのあるディレクトリ（ddl/）の親（zigsaw/）を基準にする。
my $SCRIPT_DIR = dirname(abs_path(__FILE__));
my $ROOT       = dirname($SCRIPT_DIR);
my $IMAGE_DIR  = "$ROOT/images";
my $INCOMING   = "$IMAGE_DIR/incoming";

my %EXT_OK = map { $_ => 1 } qw(jpg jpeg png webp gif);

# ---- 画像の寸法を読む（PNG / JPEG のみ。それ以外は 0x0） --------------------
sub image_size {
    my ($path) = @_;
    open my $fh, '<:raw', $path or return (0, 0);
    my $head = '';
    read($fh, $head, 32);
    # PNG: 8バイトのシグネチャの後、IHDR に幅(4)・高さ(4) がビッグエンディアンで入る。
    if (substr($head, 0, 8) eq "\x89PNG\r\n\x1a\n") {
        my ($w, $h) = unpack('N N', substr($head, 16, 8));
        return ($w, $h);
    }
    # JPEG: SOF0..SOF15（0xC0..0xCF、ただし 0xC4/0xC8/0xCC を除く）マーカーから読む。
    if (substr($head, 0, 2) eq "\xFF\xD8") {
        seek($fh, 2, 0);
        my $buf;
        while (read($fh, $buf, 2) == 2) {
            my ($marker, $code) = unpack('C C', $buf);
            last if $marker != 0xFF;
            # スタンドアロンマーカー（長さを持たない）を飛ばす。
            next if $code == 0xD8 || $code == 0xD9 || ($code >= 0xD0 && $code <= 0xD7) || $code == 0x01;
            read($fh, $buf, 2) == 2 or last;
            my $len = unpack('n', $buf);
            if ($code >= 0xC0 && $code <= 0xCF && $code != 0xC4 && $code != 0xC8 && $code != 0xCC) {
                read($fh, $buf, 5) == 5 or last;
                my ($prec, $h, $w) = unpack('C n n', $buf);
                return ($w, $h);
            }
            seek($fh, $len - 2, 1);   # このセグメントを読み飛ばす
        }
    }
    return (0, 0);
}

sub random_hex {
    my ($bytes) = @_;
    open my $fh, '<:raw', '/dev/urandom' or die "urandom: $!";
    read($fh, my $buf, $bytes);
    close $fh;
    return unpack('H*', $buf);
}

sub copy_file {
    my ($src, $dst) = @_;
    open my $in,  '<:raw', $src or die "open $src: $!";
    local $/;
    my $data = <$in>;
    close $in;
    open my $out, '>:raw', $dst or die "open $dst: $!";
    print $out $data;
    close $out;
}

# ---- 本体 ------------------------------------------------------------------
mkdir $IMAGE_DIR unless -d $IMAGE_DIR;
mkdir "$IMAGE_DIR/full"  unless -d "$IMAGE_DIR/full";
mkdir "$IMAGE_DIR/thumb" unless -d "$IMAGE_DIR/thumb";
mkdir $INCOMING unless -d $INCOMING;

opendir my $dh, $INCOMING or die "opendir $INCOMING: $!";
my @files = sort grep { -f "$INCOMING/$_" } readdir $dh;
closedir $dh;

if (!@files) {
    print "登録する画像がありません（$INCOMING に画像を置いてください）。\n";
    exit 0;
}

my $dbh = DBI->connect('dbi:Pg:dbname=zigsaw', '', '',
    { RaiseError => 1, AutoCommit => 1, PrintError => 0, pg_enable_utf8 => 1 });

my $added = 0;
for my $name (@files) {
    my $src = "$INCOMING/$name";
    my ($base, $ext) = ($name =~ /^(.*?)\.([^.]+)$/) ? ($1, lc $2) : ($name, '');
    $ext = 'jpg' if $ext eq 'jpeg';
    unless ($EXT_OK{$ext}) {
        print "skip（対応形式外）: $name\n";
        next;
    }
    my ($w, $h) = image_size($src);
    if ($w < 1 || $h < 1) {
        print "skip（寸法を読めない）: $name\n";
        next;
    }
    my $basename = random_hex(16);
    eval {
        copy_file($src, "$IMAGE_DIR/full/$basename.$ext");
        copy_file($src, "$IMAGE_DIR/thumb/$basename.$ext");
        # display_name と original_name にはファイル名（拡張子抜き）を入れる。upload_ip は NULL。
        $dbh->do(
            'INSERT INTO images (owner_id, basename, ext, display_name, original_name, width, height)
             VALUES (NULL, ?, ?, ?, ?, ?, ?)',
            undef, $basename, $ext, $base, $base, $w, $h
        );
        unlink $src;
        1;
    } or do {
        warn "登録失敗: $name: $@\n";
        unlink "$IMAGE_DIR/full/$basename.$ext", "$IMAGE_DIR/thumb/$basename.$ext";
        next;
    };
    print "登録: $name  (${w}x${h})\n";
    $added++;
}

$dbh->disconnect;
print "\n$added 件を登録しました。\n";
