// パズル1回ぶんの進行状態。mac 版 Zigsaw の PuzzleGameState.swift の移植。
//
// React の state ではなくただのクラスとして持つ。ドラッグ中は毎フレーム位置が
// 変わるので、そのたびに React を再描画させると重い。盤面は canvas に直接描き、
// 変化は `visualRevision` の増加で伝える。HUD に出る値（経過時間・一時停止・
// 完成）が変わったときだけ `subscribe` したリスナーへ通知する。
import type { PuzzlePiece } from './generator'
import type { Point, Size } from './jigsaw'
import { playConnect } from './sound'

/** 中断・再開のために保存する、セッションを完全に復元できるだけの情報。 */
export type SavedGameState = {
  positions: Record<number, Point>
  placed: number[]
  rotations: Record<number, number>
  zOrder: number[]
  /** つながっているピースのかたまり。ピース id の配列で表す。 */
  groups: number[][]
  elapsedSeconds: number
  /** 保存時の拡大率とスクロール位置。無ければ新規と同じく画面に合わせて自動調整する。 */
  scale?: number
  panOffset?: Point
}

export class PuzzleGameState {
  readonly pieces: PuzzlePiece[]
  readonly boardSize: Size
  readonly canvasSize: Size
  /**
   * 論理座標（`PuzzlePiece.solvedOrigin` と同じ座標系）から表示座標へのずれ。
   * 盤面の外へドラッグしたピースも遊べる領域に収まるよう、周囲に余白を取る。
   */
  readonly playAreaOrigin: Point

  /** 盤面の周りに描く赤い（＝案内用の）枠は、盤面の何倍の大きさか。開始時のピースもこの帯の中に散らばる。 */
  readonly guideRatio = 1.4

  /** 位置は論理座標で持つ。表示時に `playAreaOrigin` を足す。 */
  positions = new Map<number, Point>()
  placed = new Set<number>()
  zOrder: number[] = []
  /**
   * 各ピースの現在の回転角（度）。開始時は 30 度刻みでランダムに回っていて、
   * つかんだ瞬間に 0 度へ戻る。連結・はめ込みの判定は 0 度のピースだけを見るので
   * （`connectToSingleClosestNeighbor` 参照）、まだ回ったままの隣は一度つかむまで相手にならない。
   */
  rotations = new Map<number, number>()

  /** 開始からの経過秒数。一時停止中と完成図の表示中は止まる。 */
  elapsedSeconds = 0
  isPaused = false
  isViewingSolution = false

  /** 保存された拡大率・スクロール位置から始めたか。盤面側が自動フィットするかの判断に使う。 */
  readonly hasRestoredViewState: boolean
  readonly restoredScale: number | null
  readonly restoredPanOffset: Point | null

  /** 見た目に関わる変化のたびに増える。盤面の再描画のきっかけに使う。 */
  visualRevision = 0
  /** HUD に出る状態が変わるたびに増える。React 側の購読（useSyncExternalStore）用。 */
  stateVersion = 0

  private readonly pieceByID = new Map<number, PuzzlePiece>()
  /** 正解の並びで隣り合うピース。この組み合わせだけがくっつける。 */
  private readonly neighborsOf = new Map<number, number[]>()

  /** つながったピースを1つのかたまりとして動かすための union-find。 */
  private rootOf = new Map<number, number>()
  private groupOf = new Map<number, Set<number>>()

  private listeners = new Set<() => void>()
  private timer: number | undefined
  private cachedSolvedCanvas: HTMLCanvasElement | null = null

  constructor(pieces: PuzzlePiece[], boardSize: Size, savedState?: SavedGameState | null) {
    this.pieces = pieces
    this.boardSize = boardSize
    for (const p of pieces) this.pieceByID.set(p.id, p)
    this.zOrder = pieces.map((p) => p.id)

    const pieceAt = new Map<string, number>()
    for (const p of pieces) pieceAt.set(`${p.row},${p.col}`, p.id)
    for (const p of pieces) {
      const candidates = [
        `${p.row - 1},${p.col}`, `${p.row + 1},${p.col}`,
        `${p.row},${p.col - 1}`, `${p.row},${p.col + 1}`,
      ]
      this.neighborsOf.set(p.id, candidates.map((k) => pieceAt.get(k)).filter((v): v is number => v !== undefined))
    }

    for (const p of pieces) {
      this.rootOf.set(p.id, p.id)
      this.groupOf.set(p.id, new Set([p.id]))
    }

    const pieceSize = pieces[0]?.size ?? { width: 80, height: 80 }

    // ドラッグできる範囲は盤面の縦横5倍。盤面はその中央に置く。
    this.canvasSize = { width: boardSize.width * 5, height: boardSize.height * 5 }
    this.playAreaOrigin = {
      x: (this.canvasSize.width - boardSize.width) / 2,
      y: (this.canvasSize.height - boardSize.height) / 2,
    }

    if (savedState) {
      for (const [id, pos] of Object.entries(savedState.positions)) this.positions.set(Number(id), pos)
      this.placed = new Set(savedState.placed)
      for (const [id, deg] of Object.entries(savedState.rotations)) this.rotations.set(Number(id), deg)
      this.zOrder = savedState.zOrder
      this.elapsedSeconds = savedState.elapsedSeconds
      for (const group of savedState.groups) {
        const root = group[0]
        if (root === undefined) continue
        this.groupOf.set(root, new Set(group))
        for (const member of group) {
          this.rootOf.set(member, root)
          // 全ピースは上で自分1人のかたまりとして登録済み。より大きなかたまりの
          // 一員として復元されたら、その1人ぶんの記録は消しておかないと、
          // 次の保存で幽霊のかたまりとして二重に書き出されてしまう。
          if (member !== root) this.groupOf.delete(member)
        }
      }
      this.restoredScale = savedState.scale ?? null
      this.restoredPanOffset = savedState.panOffset ?? null
      this.hasRestoredViewState = this.restoredScale !== null && this.restoredPanOffset !== null
    } else {
      this.restoredScale = null
      this.restoredPanOffset = null
      this.hasRestoredViewState = false
      this.scatter(pieceSize)
    }

    this.timer = window.setInterval(() => {
      if (this.isPaused || this.isViewingSolution || this.isComplete) return
      this.elapsedSeconds += 1
      this.emit()
    }, 1000)
  }

  dispose(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  /** HUD に出る状態（経過時間・一時停止・完成）の変化を受け取る。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    this.stateVersion += 1
    for (const listener of this.listeners) listener()
  }

  /** 盤面の描き直しが必要な変化があった。 */
  private touch(): void {
    this.visualRevision += 1
  }

  get columns(): number { return Math.max(...this.pieces.map((p) => p.col)) + 1 }
  get rows(): number { return Math.max(...this.pieces.map((p) => p.row)) + 1 }

  /** 全ピースが1つのかたまりになったら完成。盤面に置いたかどうかは問わない。 */
  get isComplete(): boolean {
    const first = this.pieces[0]
    if (!first) return false
    return this.groupMembers(first.id).size === this.pieces.length
  }

  /**
   * 開始時の散らばり。盤面と案内枠（盤面の `guideRatio` 倍、盤面と同心）の
   * あいだの帯の中に置く。重なってよいので、四方の帯のどれかを選んで一様乱数で置くだけ。
   */
  private scatter(pieceSize: Size): void {
    const guideWidth = this.boardSize.width * this.guideRatio
    const guideHeight = this.boardSize.height * this.guideRatio
    const guideLeft = (this.boardSize.width - guideWidth) / 2
    const guideTop = (this.boardSize.height - guideHeight) / 2
    const guideRight = guideLeft + guideWidth
    const guideBottom = guideTop + guideHeight

    const bands: { origin: Point; size: Size }[] = [
      { origin: { x: guideLeft, y: guideTop }, size: { width: guideWidth, height: -guideTop } },
      { origin: { x: guideLeft, y: this.boardSize.height }, size: { width: guideWidth, height: guideBottom - this.boardSize.height } },
      { origin: { x: guideLeft, y: 0 }, size: { width: -guideLeft, height: this.boardSize.height } },
      { origin: { x: this.boardSize.width, y: 0 }, size: { width: guideRight - this.boardSize.width, height: this.boardSize.height } },
    ]

    for (const piece of this.pieces) {
      const band = bands[Math.floor(Math.random() * bands.length)]
      this.positions.set(piece.id, {
        x: band.origin.x + Math.random() * Math.max(0, band.size.width - pieceSize.width),
        y: band.origin.y + Math.random() * Math.max(0, band.size.height - pieceSize.height),
      })
    }

    const steps = 360 / 30
    for (const piece of this.pieces) {
      this.rotations.set(piece.id, Math.floor(Math.random() * steps) * 30)
    }
  }

  pause(): void { this.isPaused = true; this.emit(); this.touch() }
  resume(): void { this.isPaused = false; this.emit(); this.touch() }
  showSolution(): void { this.isViewingSolution = true; this.emit(); this.touch() }
  hideSolution(): void { this.isViewingSolution = false; this.emit(); this.touch() }

  piece(id: number): PuzzlePiece | undefined { return this.pieceByID.get(id) }

  /**
   * 完成した絵。各ピースの画像はすでに自分のシルエットで切り抜かれているので、
   * 正解位置に並べて描くだけで元画像に戻る（元ファイルを開き直す必要がない）。
   */
  solvedCanvas(): HTMLCanvasElement | null {
    if (this.cachedSolvedCanvas) return this.cachedSolvedCanvas
    const width = Math.ceil(this.boardSize.width)
    const height = Math.ceil(this.boardSize.height)
    if (width <= 0 || height <= 0) return null

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    for (const piece of this.pieces) {
      drawPiece(ctx, piece, piece.solvedOrigin, 0)
    }
    this.cachedSolvedCanvas = canvas
    return canvas
  }

  /** つかむと必ず、散らばったときの回転が取れてまっすぐになる。 */
  resetRotation(id: number): void {
    this.rotations.set(id, 0)
    this.touch()
  }

  /**
   * つかみ直すと、盤面にはまっていたかたまりごと「未配置」に戻す。
   * 一度正解位置に触れたきり動かせなくなるのを避けるため。
   */
  unplaceGroup(id: number): void {
    for (const member of this.groupMembers(id)) this.placed.delete(member)
  }

  /** `id` と今つながっている全ピース（自分を含む）。 */
  groupMembers(id: number): Set<number> {
    const root = this.rootOf.get(id)
    if (root === undefined) return new Set([id])
    return this.groupOf.get(root) ?? new Set([id])
  }

  private union(a: number, b: number): void {
    const ra = this.rootOf.get(a)
    const rb = this.rootOf.get(b)
    if (ra === undefined || rb === undefined || ra === rb) return
    const membersA = this.groupOf.get(ra)
    const membersB = this.groupOf.get(rb)
    if (!membersA || !membersB) return
    const [bigRoot, smallRoot, smallMembers] = membersA.size >= membersB.size
      ? [ra, rb, membersB] : [rb, ra, membersA]
    for (const member of smallMembers) {
      this.rootOf.set(member, bigRoot)
      this.groupOf.get(bigRoot)!.add(member)
    }
    this.groupOf.delete(smallRoot)
  }

  private snapThreshold(piece: PuzzlePiece): number {
    return Math.max(16, Math.min(piece.size.width, piece.size.height) * 0.2)
  }

  bringToFront(id: number): void {
    const group = this.groupMembers(id)
    if (group.size === 1 && this.zOrder[this.zOrder.length - 1] === id) return
    const groupOrdered = this.zOrder.filter((x) => group.has(x))
    const remaining = this.zOrder.filter((x) => !group.has(x))
    this.zOrder = [...remaining, ...groupOrdered]
    this.touch()
  }

  /** `id` を `point` へ動かす。同じかたまりのピースも同じだけ動き、遊べる範囲からははみ出さない。 */
  updatePosition(id: number, point: Point): void {
    const oldPos = this.positions.get(id)
    if (!oldPos) return
    const delta = { x: point.x - oldPos.x, y: point.y - oldPos.y }
    const group = this.groupMembers(id)

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const memberID of group) {
      const memberPos = this.positions.get(memberID)
      const memberPiece = this.pieceByID.get(memberID)
      if (!memberPos || !memberPiece) continue
      minX = Math.min(minX, memberPos.x)
      minY = Math.min(minY, memberPos.y)
      maxX = Math.max(maxX, memberPos.x + memberPiece.size.width)
      maxY = Math.max(maxY, memberPos.y + memberPiece.size.height)
    }
    const allowedMinX = -this.playAreaOrigin.x
    const allowedMinY = -this.playAreaOrigin.y
    const allowedMaxX = this.canvasSize.width - this.playAreaOrigin.x
    const allowedMaxY = this.canvasSize.height - this.playAreaOrigin.y
    if (minX + delta.x < allowedMinX) delta.x = allowedMinX - minX
    if (maxX + delta.x > allowedMaxX) delta.x = allowedMaxX - maxX
    if (minY + delta.y < allowedMinY) delta.y = allowedMinY - minY
    if (maxY + delta.y > allowedMaxY) delta.y = allowedMaxY - maxY

    for (const memberID of group) {
      const memberPos = this.positions.get(memberID)
      if (memberPos) this.positions.set(memberID, { x: memberPos.x + delta.x, y: memberPos.y + delta.y })
    }
    this.touch()
  }

  /** ドラッグ終了。隣とつなぐ・盤面にはめる を順に試す。 */
  endDrag(id: number): void {
    const wasComplete = this.isComplete
    this.connectToSingleClosestNeighbor(id)
    this.snapGroupOntoBoardIfClose(id)
    this.touch()
    if (!wasComplete && this.isComplete) this.emit()
  }

  /**
   * つながる範囲にある「正しい隣」のうち、いちばん近い1組だけを探してつなぐ。
   * 動かすのはドラッグしていたかたまりの側だけで、相手は動かない。
   * 同時に複数の隣が範囲内にあっても、選ぶのは1組だけ。
   */
  private connectToSingleClosestNeighbor(id: number): void {
    const group = this.groupMembers(id)
    let best: { memberID: number; neighborID: number; distance: number; delta: Point } | null = null

    for (const memberID of group) {
      const memberPiece = this.pieceByID.get(memberID)
      const memberPos = this.positions.get(memberID)
      if (!memberPiece || !memberPos) continue
      for (const neighborID of this.neighborsOf.get(memberID) ?? []) {
        if (this.rootOf.get(neighborID) === this.rootOf.get(memberID)) continue
        if (this.placed.has(neighborID)) continue
        // 散らばったときの回転が残っている隣とは、まだつなげない（一度つかんで
        // まっすぐにする必要がある）。
        if ((this.rotations.get(neighborID) ?? 0) !== 0) continue
        const neighborPiece = this.pieceByID.get(neighborID)
        const neighborPos = this.positions.get(neighborID)
        if (!neighborPiece || !neighborPos) continue

        const expected = {
          x: neighborPiece.solvedOrigin.x - memberPiece.solvedOrigin.x,
          y: neighborPiece.solvedOrigin.y - memberPiece.solvedOrigin.y,
        }
        const actual = { x: neighborPos.x - memberPos.x, y: neighborPos.y - memberPos.y }
        const distance = Math.hypot(actual.x - expected.x, actual.y - expected.y)
        if (distance >= this.snapThreshold(memberPiece)) continue
        if (best && distance >= best.distance) continue

        // 相手はそのまま、ドラッグしていた側が寄る。
        best = {
          memberID, neighborID, distance,
          delta: { x: neighborPos.x - expected.x - memberPos.x, y: neighborPos.y - expected.y - memberPos.y },
        }
      }
    }

    if (!best) return
    for (const memberID of group) {
      const memberPos = this.positions.get(memberID)
      if (memberPos) this.positions.set(memberID, { x: memberPos.x + best.delta.x, y: memberPos.y + best.delta.y })
    }
    this.union(best.memberID, best.neighborID)
    playConnect()
  }

  /**
   * ピース（＝かたまり全体。メンバーは常に正解どおりの相対位置を保つ）が
   * 正解位置の近くにあれば、かたまりごとぴったりはめて配置済みにする。
   */
  private snapGroupOntoBoardIfClose(id: number): void {
    const piece = this.pieceByID.get(id)
    const pos = this.positions.get(id)
    if (!piece || !pos) return
    const target = piece.solvedOrigin
    if (Math.hypot(pos.x - target.x, pos.y - target.y) >= this.snapThreshold(piece)) return

    const snapDelta = { x: target.x - pos.x, y: target.y - pos.y }
    const group = this.groupMembers(id)
    for (const memberID of group) {
      const memberPos = this.positions.get(memberID)
      if (!memberPos) continue
      this.positions.set(memberID, { x: memberPos.x + snapDelta.x, y: memberPos.y + snapDelta.y })
      this.placed.add(memberID)
    }

    // すでに置かれている正しい隣は、この時点で必ず辺を接している。かたまりに
    // 統合しておかないと、盤面に直接置いていくだけの遊び方では最後まで
    // 1つのかたまりにならず、完成と判定されない。
    let didMerge = false
    for (const memberID of [...group]) {
      for (const neighborID of this.neighborsOf.get(memberID) ?? []) {
        if (!this.placed.has(neighborID)) continue
        if (this.rootOf.get(neighborID) === this.rootOf.get(memberID)) continue
        this.union(memberID, neighborID)
        didMerge = true
      }
    }
    if (didMerge) playConnect()
  }

  /**
   * 途中経過の画像に写し取るべき範囲（`positions` や `boardSize` と同じ論理座標）。
   * 盤面の中心を中心に、盤面と同じ縦横比で、全ピースの（回転後の）footprint を
   * ちょうど包む最小の長方形。
   */
  snapshotCaptureRect(): { x: number; y: number; width: number; height: number } {
    const boardCenter = { x: this.boardSize.width / 2, y: this.boardSize.height / 2 }
    const fallback = { x: 0, y: 0, width: this.boardSize.width, height: this.boardSize.height }
    if (this.boardSize.width <= 0 || this.boardSize.height <= 0) return fallback
    const aspectRatio = this.boardSize.width / this.boardSize.height

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const piece of this.pieces) {
      const pos = this.positions.get(piece.id)
      if (!pos) continue
      const center = { x: pos.x + piece.size.width / 2, y: pos.y + piece.size.height / 2 }
      const angle = ((this.rotations.get(piece.id) ?? 0) * Math.PI) / 180
      const halfW = piece.size.width / 2
      const halfH = piece.size.height / 2
      // 自分の中心まわりに `angle` だけ回したときの、軸に平行な外接矩形の半分の大きさ。
      const cosA = Math.abs(Math.cos(angle))
      const sinA = Math.abs(Math.sin(angle))
      const rotatedHalfW = halfW * cosA + halfH * sinA
      const rotatedHalfH = halfW * sinA + halfH * cosA
      minX = Math.min(minX, center.x - rotatedHalfW)
      minY = Math.min(minY, center.y - rotatedHalfH)
      maxX = Math.max(maxX, center.x + rotatedHalfW)
      maxY = Math.max(maxY, center.y + rotatedHalfH)
    }
    if (!(minX <= maxX && minY <= maxY)) return fallback

    // 盤面の中心から各方向へ、内容がどこまではみ出しているか。
    const neededHalfWidth = Math.max(boardCenter.x - minX, maxX - boardCenter.x)
    const neededHalfHeight = Math.max(boardCenter.y - minY, maxY - boardCenter.y)

    // アスペクト比を合わせるために広げるだけ（縮めることはない）。
    const halfWidth = Math.max(neededHalfWidth, neededHalfHeight * aspectRatio)
    const halfHeight = halfWidth / aspectRatio

    return {
      x: boardCenter.x - halfWidth,
      y: boardCenter.y - halfHeight,
      width: halfWidth * 2,
      height: halfHeight * 2,
    }
  }

  /**
   * 今の並びをそのまま写した canvas を作る（プレイヤーの拡大・スクロールとは無関係）。
   * 「現在の様子」プレビュー用。盤面の中心を中心に、全ピースを含む最小の長方形で切り取る。
   */
  private renderSnapshotCanvas(backgroundColor: string, maxDimension: number): HTMLCanvasElement | null {
    const rect = this.snapshotCaptureRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const scale = maxDimension / Math.max(rect.width, rect.height)

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(rect.width * scale))
    canvas.height = Math.max(1, Math.round(rect.height * scale))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(scale, scale)
    ctx.translate(-rect.x, -rect.y)
    for (const id of this.zOrder) {
      const piece = this.pieceByID.get(id)
      const pos = this.positions.get(id)
      if (!piece || !pos) continue
      drawPiece(ctx, piece, pos, this.rotations.get(id) ?? 0)
    }
    return canvas
  }

  /** 「現在の様子」を JPEG の data URL にする。サーバーの途中経過に同梱して保存する。 */
  renderSnapshotDataUrl(backgroundColor: string, maxDimension = 600): string | null {
    const canvas = this.renderSnapshotCanvas(backgroundColor, maxDimension)
    return canvas ? canvas.toDataURL('image/jpeg', 0.8) : null
  }

  /** 「保存する」用。このセッションをそのまま再現できるだけの情報を書き出す。 */
  exportSavedState(scale: number, panOffset: Point): SavedGameState {
    const positions: Record<number, Point> = {}
    for (const [id, pos] of this.positions) positions[id] = pos
    const rotations: Record<number, number> = {}
    for (const [id, deg] of this.rotations) rotations[id] = deg
    return {
      positions,
      placed: [...this.placed],
      rotations,
      zOrder: [...this.zOrder],
      groups: [...this.groupOf.values()].map((g) => [...g]),
      elapsedSeconds: this.elapsedSeconds,
      scale,
      panOffset,
    }
  }
}

/**
 * ピース1枚を、回転を考慮して論理座標のまま描く。
 * ピースの canvas はピクセル単位に切り上げてあるので、大きさは常に明示して
 * 本来の `size`（小数を含む）ちょうどに合わせる。
 */
export function drawPiece(ctx: CanvasRenderingContext2D, piece: PuzzlePiece, pos: Point, rotationDegrees: number): void {
  const { width, height } = piece.size
  if (rotationDegrees === 0) {
    ctx.drawImage(piece.canvas, pos.x, pos.y, width, height)
    return
  }
  ctx.save()
  ctx.translate(pos.x + width / 2, pos.y + height / 2)
  ctx.rotate((rotationDegrees * Math.PI) / 180)
  ctx.drawImage(piece.canvas, -width / 2, -height / 2, width, height)
  ctx.restore()
}
