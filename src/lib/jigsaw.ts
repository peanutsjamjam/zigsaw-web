// ジグソーのピース形状を作る。mac 版 Zigsaw の JigsawShape.swift の移植。
//
// 同じシードからは必ず同じ形のパズルができる（＝画像とグリッドさえ分かれば
// ピース形状を保存しなくても再現できる）ので、途中状態の保存はピースの位置や
// つながり具合だけを持てばよい。

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }

/** 決定的な xorshift64。同じシードなら常に同じ並びの乱数を返す。 */
export class SeededGenerator {
  private state: bigint
  private static readonly MASK = (1n << 64n) - 1n

  constructor(seed: bigint) {
    this.state = seed !== 0n ? seed : 0x9e3779b97f4a7c15n
  }

  next(): bigint {
    let s = this.state
    s = (s ^ (s << 13n)) & SeededGenerator.MASK
    s = s ^ (s >> 7n)
    s = (s ^ (s << 17n)) & SeededGenerator.MASK
    this.state = s
    return s
  }

  /** [0, 1) の実数。上位 53bit を使う（double の仮数部に収まる範囲）。 */
  nextDouble(): number {
    return Number(this.next() >> 11n) / 2 ** 53
  }

  /** [min, max] の実数。 */
  random(min: number, max: number): number {
    return min + (max - min) * this.nextDouble()
  }

  nextBool(): boolean {
    return (this.next() & 1n) === 1n
  }
}

/** 3次ベジェ1本ぶん。始点は直前のセグメントの `end`（先頭は辺の `start`）。 */
type BezierSegment = { c1: Point; c2: Point; end: Point }

/**
 * 隣り合う2つのピースが共有する境界線。両方のピースが同じ曲線を参照して、
 * 片方は順方向・もう片方は逆方向にたどるので、必ずぴったりかみ合う。
 */
export class EdgeCurve {
  readonly start: Point
  readonly segments: BezierSegment[]

  constructor(start: Point, segments: BezierSegment[]) {
    this.start = start
    this.segments = segments
  }

  appendForward(path: Path2D, t: (p: Point) => Point): void {
    for (const seg of this.segments) {
      const c1 = t(seg.c1), c2 = t(seg.c2), end = t(seg.end)
      path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y)
    }
  }

  appendReversed(path: Path2D, t: (p: Point) => Point): void {
    const starts: Point[] = [this.start, ...this.segments.map((s) => s.end)]
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i]
      const c1 = t(seg.c2), c2 = t(seg.c1), end = t(starts[i])
      path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y)
    }
  }
}

/**
 * `start` から `end` へ向かう、出っ張り（タブ）1つぶんの曲線を作る。
 * `perp` は `flip` していないときにタブが膨らむ向きの単位ベクトル、
 * `perpSize` はその向きの隣のセルの大きさで、膨らみの深さの基準になる。
 *
 * よく知られた Draradech/jigsaw ジェネレータ（https://github.com/Draradech/jigsaw）の
 * 式をそのまま移植したもの。p0...p9 を通る3本の3次ベジェで、`tabSize` と小さな
 * `jitter` が膨らみの高さと各点の位置を少しずつずらす。これが、左右対称のきれいな
 * 円弧ではない「手で切ったような」くびれのあるシルエットを生む。
 */
export function generateEdgeCurve(
  start: Point,
  end: Point,
  perp: Point,
  perpSize: number,
  tabSize: number,
  jitter: number,
  rng: SeededGenerator,
): EdgeCurve {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const dir = { x: (end.x - start.x) / length, y: (end.y - start.y) / length }

  const t = tabSize
  const j = jitter
  const rj = () => rng.random(-j, j)
  const a = rj(), b = rj(), c = rj(), d = rj(), e = rj()
  const sign = rng.nextBool() ? -1 : 1

  // `l` は辺自身の長さに対する割合、`w` は隣のセルの垂直方向の大きさ（perpSize）に対する割合。
  const point = (l: number, w: number): Point => ({
    x: start.x + dir.x * (l * length) + perp.x * (w * perpSize * sign),
    y: start.y + dir.y * (l * length) + perp.y * (w * perpSize * sign),
  })

  const p1 = point(0.2, a)
  const p2 = point(0.5 + b + d, -t + c)
  const p3 = point(0.5 - t + b, t + c)
  const p4 = point(0.5 - 2 * t + b - d, 3 * t + c)
  const p5 = point(0.5 + 2 * t + b - d, 3 * t + c)
  const p6 = point(0.5 + t + b, t + c)
  const p7 = point(0.5 + b + d, -t + c)
  const p8 = point(0.8, e)

  return new EdgeCurve(start, [
    { c1: p1, c2: p2, end: p3 },
    { c1: p4, c2: p5, end: p6 },
    { c1: p7, c2: p8, end: end },
  ])
}

/** タブの見た目のパラメータ。UI 表示の % とは tabSize=%/200・jitter=%/100 の関係。 */
export const DEFAULT_TAB_SIZE = 0.105
export const DEFAULT_JITTER = 0.02
export const DEFAULT_SEED = 453n

/** パズル1つぶんの、あらかじめ計算した幾何情報。 */
export class PuzzleLayout {
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  /** タブがはみ出すぶんの余白。ピース画像はセルの上下左右にこれだけ広い。 */
  readonly pad: number
  /** horizontalEdges[r][c]: ピース(r,c) と (r+1,c) の境界。(rows-1) x columns。 */
  readonly horizontalEdges: EdgeCurve[][]
  /** verticalEdges[r][c]: ピース(r,c) と (r,c+1) の境界。rows x (columns-1)。 */
  readonly verticalEdges: EdgeCurve[][]

  private constructor(
    columns: number, rows: number, cellWidth: number, cellHeight: number, pad: number,
    horizontalEdges: EdgeCurve[][], verticalEdges: EdgeCurve[][],
  ) {
    this.columns = columns
    this.rows = rows
    this.cellWidth = cellWidth
    this.cellHeight = cellHeight
    this.pad = pad
    this.horizontalEdges = horizontalEdges
    this.verticalEdges = verticalEdges
  }

  static generate(
    imageSize: Size,
    columns: number,
    rows: number,
    tabSize = DEFAULT_TAB_SIZE,
    jitter = DEFAULT_JITTER,
    seed = DEFAULT_SEED,
  ): PuzzleLayout {
    const rng = new SeededGenerator(seed)
    const cellWidth = imageSize.width / columns
    const cellHeight = imageSize.height / rows
    // タブの制御点は垂直方向のセルサイズの 3*tabSize+jitter まで届くので、
    // 膨らみが切れないよう、それより十分大きめに余白を取る。
    const pad = Math.ceil((3 * tabSize + jitter) * 1.15 * Math.max(cellWidth, cellHeight))

    const horizontal: EdgeCurve[][] = []
    if (rows > 1) {
      for (let r = 0; r < rows - 1; r++) {
        const rowEdges: EdgeCurve[] = []
        const y = (r + 1) * cellHeight
        for (let c = 0; c < columns; c++) {
          rowEdges.push(generateEdgeCurve(
            { x: c * cellWidth, y },
            { x: (c + 1) * cellWidth, y },
            { x: 0, y: 1 }, cellHeight, tabSize, jitter, rng,
          ))
        }
        horizontal.push(rowEdges)
      }
    }

    const vertical: EdgeCurve[][] = []
    for (let r = 0; r < rows; r++) {
      const rowEdges: EdgeCurve[] = []
      for (let c = 0; c < columns - 1; c++) {
        const x = (c + 1) * cellWidth
        rowEdges.push(generateEdgeCurve(
          { x, y: r * cellHeight },
          { x, y: (r + 1) * cellHeight },
          { x: 1, y: 0 }, cellWidth, tabSize, jitter, rng,
        ))
      }
      vertical.push(rowEdges)
    }

    return new PuzzleLayout(columns, rows, cellWidth, cellHeight, pad, horizontal, vertical)
  }

  /**
   * ピース (row, col) の閉じた輪郭を、`paddedOrigin` が (0,0) になるよう
   * 平行移動したローカル座標で作る。
   */
  piecePath(row: number, col: number, paddedOrigin: Point): Path2D {
    const path = new Path2D()
    const left = col * this.cellWidth
    const right = left + this.cellWidth
    const top = row * this.cellHeight
    const bottom = top + this.cellHeight

    const L = (p: Point): Point => ({ x: p.x - paddedOrigin.x, y: p.y - paddedOrigin.y })
    const lineTo = (p: Point) => { const q = L(p); path.lineTo(q.x, q.y) }

    const startPoint = L({ x: left, y: top })
    path.moveTo(startPoint.x, startPoint.y)

    // 上辺: 左 -> 右
    if (row === 0) lineTo({ x: right, y: top })
    else this.horizontalEdges[row - 1][col].appendForward(path, L)

    // 右辺: 上 -> 下
    if (col === this.columns - 1) lineTo({ x: right, y: bottom })
    else this.verticalEdges[row][col].appendForward(path, L)

    // 下辺: 右 -> 左
    if (row === this.rows - 1) lineTo({ x: left, y: bottom })
    else this.horizontalEdges[row][col].appendReversed(path, L)

    // 左辺: 下 -> 上
    if (col === 0) lineTo({ x: left, y: top })
    else this.verticalEdges[row][col - 1].appendReversed(path, L)

    path.closePath()
    return path
  }
}
