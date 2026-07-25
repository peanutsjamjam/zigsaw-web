// 画像を1枚ずつのピースに切り出す。mac 版 Zigsaw の PuzzleGenerator.swift の移植。
import { DEFAULT_JITTER, DEFAULT_SEED, DEFAULT_TAB_SIZE, PuzzleLayout, type Point, type Size } from './jigsaw'

/** 1ピース。盤面での正解位置と、タブ形に切り抜いた絵を持つ。 */
export type PuzzlePiece = {
  id: number
  row: number
  col: number
  /** 正解の位置に置いたときの、ピース画像の左上。 */
  solvedOrigin: Point
  /** ピース画像の大きさ（セル + 上下左右のタブ余白）。全ピース共通。 */
  size: Size
  /** 切り抜き済みの絵。canvas のまま持ち、drawImage でそのまま描く。 */
  canvas: HTMLCanvasElement
  /**
   * ピースのシルエット。`size` と同じローカル座標系（左上が (0,0)）。
   * 当たり判定を、透明な余白を含む長方形ではなく実際の形に限るために使う。
   */
  outline: Path2D
}

export type GeneratedPuzzle = { pieces: PuzzlePiece[]; boardSize: Size }

/** 画像を columns x rows のかみ合うピースに切り分ける。 */
export function generatePuzzle(
  image: CanvasImageSource,
  imageSize: Size,
  columns: number,
  rows: number,
  tabSize = DEFAULT_TAB_SIZE,
  jitter = DEFAULT_JITTER,
  seed = DEFAULT_SEED,
): GeneratedPuzzle {
  const layout = PuzzleLayout.generate(imageSize, columns, rows, tabSize, jitter, seed)

  const pieces: PuzzlePiece[] = []
  let id = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const paddedOrigin = { x: col * layout.cellWidth - layout.pad, y: row * layout.cellHeight - layout.pad }
      const size = { width: layout.cellWidth + 2 * layout.pad, height: layout.cellHeight + 2 * layout.pad }
      const outline = layout.piecePath(row, col, paddedOrigin)
      pieces.push({
        id, row, col, solvedOrigin: paddedOrigin, size, outline,
        canvas: renderPieceImage(image, paddedOrigin, size, outline),
      })
      id += 1
    }
  }
  return { pieces, boardSize: imageSize }
}

/** ピース1枚を、輪郭でクリップした canvas に描き出す。 */
function renderPieceImage(image: CanvasImageSource, paddedOrigin: Point, size: Size, outline: Path2D): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(size.width))
  canvas.height = Math.max(1, Math.ceil(size.height))
  const ctx = canvas.getContext('2d')!
  ctx.clip(outline)
  // 元画像を、このピースの余白付き左上が canvas の (0,0) に来るようずらして描く。
  ctx.drawImage(image, -paddedOrigin.x, -paddedOrigin.y)
  return canvas
}

/**
 * 画像ファイルを、EXIF の向きを反映した状態で読み込む。
 * `createImageBitmap` の `imageOrientation: 'from-image'` を使わないと、
 * 縦で撮った写真（センサー上は横向きで、回転は EXIF にしか書かれていない）が
 * 横倒しのまま切り分けられてしまう。
 */
export async function loadImage(blob: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(blob, { imageOrientation: 'from-image' })
}

/** 大きすぎる写真を縮小して、ピースが画面上で極端に小さくならないようにする。 */
export function downscaleIfNeeded(image: ImageBitmap, maxDimension = 1800): { image: CanvasImageSource; size: Size } {
  const longest = Math.max(image.width, image.height)
  if (longest <= maxDimension) return { image, size: { width: image.width, height: image.height } }

  const scale = maxDimension / longest
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  return { image: canvas, size: { width, height } }
}

/** 画像を読み込み、必要なら縮小してからピースに切り分ける、までの一連の処理。 */
export async function buildPuzzle(blob: Blob, columns: number, rows: number): Promise<GeneratedPuzzle> {
  const bitmap = await loadImage(blob)
  const { image, size } = downscaleIfNeeded(bitmap)
  const puzzle = generatePuzzle(image, size, columns, rows)
  bitmap.close()
  return puzzle
}

/** 画像を長辺 `maxDimension` 以内に収めた JPEG にする（縮小のみ。拡大はしない）。 */
async function toJpeg(bitmap: ImageBitmap, maxDimension: number, quality = 0.85): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('toBlob failed')
  return { blob, width: canvas.width, height: canvas.height }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * アップロード用のペイロードを、選んだファイルから作る。サーバーには画像処理系が
 * 無いので、遊ぶ用の縮小画像（長辺1800）とサムネイル（長辺600）を両方ここで作って
 * data URL で送る。EXIF の向きもここで畳んでおく。
 */
export async function prepareUpload(file: Blob): Promise<{
  display_name: string
  ext: 'jpg'
  width: number
  height: number
  full: string
  thumb: string
}> {
  const bitmap = await loadImage(file)
  try {
    const full = await toJpeg(bitmap, 1800, 0.85)
    const thumb = await toJpeg(bitmap, 600, 0.8)
    const name = (file instanceof File ? file.name : '') || 'untitled'
    return {
      display_name: name,
      ext: 'jpg',
      width: full.width,
      height: full.height,
      full: await blobToDataUrl(full.blob),
      thumb: await blobToDataUrl(thumb.blob),
    }
  } finally {
    bitmap.close()
  }
}
