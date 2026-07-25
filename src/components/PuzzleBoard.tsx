// 盤面。mac 版 Zigsaw の PuzzleBoardView.swift + ZoomableScrollView.swift 相当。
//
// ピース1枚ずつを DOM 要素にすると数百枚で重くなるので、1枚の canvas に
// まとめて描く。React が関わるのは「何かが変わったら描き直す」ところまでで、
// ドラッグ中の座標計算と描画は canvas 側で完結させる。
import { useCallback, useEffect, useRef } from 'react'
import { drawPiece, type PuzzleGameState } from '../lib/game'
import type { Point } from '../lib/jigsaw'

/** 拡大率の下限・上限。mac 版と同じ。 */
const MIN_SCALE = 0.2
const MAX_SCALE = 4.0

export type ViewState = { scale: number; panOffset: Point }

type Props = {
  game: PuzzleGameState
  backgroundColor: string
  /**
   * 現在の拡大率・表示位置を後から読み出すための関数を渡す。「保存する」時にだけ
   * 呼ばれる。毎フレームの変化を React の state にすると盤面全体が再描画されるため。
   */
  onViewProviderReady: (provider: () => ViewState) => void
}

export function PuzzleBoard({ game, backgroundColor, onViewProviderReady }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 表示変換。canvas 座標 -> 画面座標 は `p * scale + offset`。 */
  const view = useRef({ scale: 1, offsetX: 0, offsetY: 0 })
  const backgroundRef = useRef(backgroundColor)
  const needsRedraw = useRef(true)
  const lastRevision = useRef(-1)
  /** ドラッグ中のピースと、つかんだ瞬間の位置・指の位置。 */
  const drag = useRef<{ pointerId: number; pieceId: number; basePos: Point; startCanvas: Point } | null>(null)
  /** 何もない所をつかんでの画面移動。 */
  const pan = useRef<{ pointerId: number; startX: number; startY: number; startOffsetX: number; startOffsetY: number } | null>(null)
  /** ピンチ操作のために、今触れている指をすべて覚えておく。 */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; centerX: number; centerY: number } | null>(null)
  /** 表示倍率・位置を一度でも決められたか（canvas の大きさが確定してから決まる）。 */
  const viewInitialized = useRef(false)

  backgroundRef.current = backgroundColor

  /** 画面（CSS ピクセル）座標を canvas 座標へ。 */
  const toCanvasPoint = useCallback((clientX: number, clientY: number): Point => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const { scale, offsetX, offsetY } = view.current
    return { x: (clientX - rect.left - offsetX) / scale, y: (clientY - rect.top - offsetY) / scale }
  }, [])

  /** その点にあるピースのうち、いちばん手前のものを探す。透明な余白は当たらない。 */
  const hitTest = useCallback((canvasPoint: Point): number | null => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return null
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    try {
      for (let i = game.zOrder.length - 1; i >= 0; i--) {
        const id = game.zOrder[i]
        const piece = game.piece(id)
        const pos = game.positions.get(id)
        if (!piece || !pos) continue
        const centerX = game.playAreaOrigin.x + pos.x + piece.size.width / 2
        const centerY = game.playAreaOrigin.y + pos.y + piece.size.height / 2
        const dx = canvasPoint.x - centerX
        const dy = canvasPoint.y - centerY
        // ピースは自分の中心まわりに回っているので、点の方を逆に回して
        // 回転前のローカル座標に直してから、輪郭に入っているか調べる。
        const angle = (-(game.rotations.get(id) ?? 0) * Math.PI) / 180
        const cos = Math.cos(angle), sin = Math.sin(angle)
        const localX = dx * cos - dy * sin + piece.size.width / 2
        const localY = dx * sin + dy * cos + piece.size.height / 2
        if (localX < 0 || localY < 0 || localX > piece.size.width || localY > piece.size.height) continue
        if (ctx.isPointInPath(piece.outline, localX, localY)) return id
      }
      return null
    } finally {
      ctx.restore()
    }
  }, [game])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }

    const { scale, offsetX, offsetY } = view.current
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = backgroundRef.current
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr)

    // 画面外のピースは描かない。拡大しているときほど効く。
    const visible = {
      minX: -offsetX / scale, minY: -offsetY / scale,
      maxX: (width - offsetX) / scale, maxY: (height - offsetY) / scale,
    }

    // 盤面（正解の絵が入る枠）。
    ctx.strokeStyle = 'rgba(140, 140, 140, 0.9)'
    ctx.lineWidth = 2 / scale
    ctx.strokeRect(game.playAreaOrigin.x, game.playAreaOrigin.y, game.boardSize.width, game.boardSize.height)

    // 破線の枠は、ピースを動かせる範囲そのもの（＝canvas 全体）を表す。
    // `PuzzleGameState.updatePosition` の制限とちょうど一致する。
    ctx.strokeStyle = 'rgba(140, 140, 140, 0.5)'
    ctx.lineWidth = 1.5 / scale
    ctx.setLineDash([6 / scale, 4 / scale])
    ctx.strokeRect(0, 0, game.canvasSize.width, game.canvasSize.height)
    ctx.setLineDash([])

    for (const id of game.zOrder) {
      const piece = game.piece(id)
      const pos = game.positions.get(id)
      if (!piece || !pos) continue
      const x = game.playAreaOrigin.x + pos.x
      const y = game.playAreaOrigin.y + pos.y
      // 回転していると外接矩形が広がるので、対角線ぶん余裕を見て判定する。
      const margin = Math.hypot(piece.size.width, piece.size.height) / 2
      if (x + piece.size.width + margin < visible.minX || x - margin > visible.maxX) continue
      if (y + piece.size.height + margin < visible.minY || y - margin > visible.maxY) continue

      // 盤面にはまっていないピースだけ影を付けて、浮いている感じを出す。
      if (!game.placed.has(id)) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
        ctx.shadowBlur = 3
        ctx.shadowOffsetX = 1
        ctx.shadowOffsetY = 2
      }
      drawPiece(ctx, piece, { x, y }, game.rotations.get(id) ?? 0)
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
    }
  }, [game])

  /** 表示倍率と位置の初期値。新しいパズルは散らばり全体が入るように合わせる。 */
  const resetView = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const viewportWidth = canvas.clientWidth
    const viewportHeight = canvas.clientHeight
    if (viewportWidth === 0 || viewportHeight === 0) return

    if (game.hasRestoredViewState && game.restoredScale && game.restoredPanOffset) {
      // 保存時に画面中央へ写っていた点を、また中央に持ってくる。画面の大きさが
      // 前回と違っても破綻しない。
      view.current.scale = game.restoredScale
      view.current.offsetX = viewportWidth / 2 - game.restoredPanOffset.x * game.restoredScale
      view.current.offsetY = viewportHeight / 2 - game.restoredPanOffset.y * game.restoredScale
    } else {
      // 散らばりの帯（盤面の guideRatio 倍）に、ピースの対角線ぶんの余裕を足した
      // 範囲が収まる倍率。斜めを向いたピースが画面の外にはみ出さないようにする。
      const pieceSize = game.pieces[0]?.size ?? { width: 0, height: 0 }
      const diagonal = Math.hypot(pieceSize.width, pieceSize.height)
      const ringWidth = game.boardSize.width * game.guideRatio + diagonal
      const ringHeight = game.boardSize.height * game.guideRatio + diagonal
      const fit = Math.min(viewportWidth / ringWidth, viewportHeight / ringHeight)
      const scale = Math.min(Math.max(fit, MIN_SCALE), MAX_SCALE)
      view.current.scale = scale
      view.current.offsetX = viewportWidth / 2 - (game.canvasSize.width / 2) * scale
      view.current.offsetY = viewportHeight / 2 - (game.canvasSize.height / 2) * scale
    }
    viewInitialized.current = true
    needsRedraw.current = true
  }, [game])

  // 初期表示・画面サイズ変更・描画ループ。
  useEffect(() => {
    resetView()
    const canvas = canvasRef.current
    if (!canvas) return

    // マウント直後は canvas の大きさがまだ 0 のことがある。その場合は倍率を
    // 決められないので、大きさが分かった最初のタイミングでやり直す。
    const observer = new ResizeObserver(() => {
      if (!viewInitialized.current) resetView()
      needsRedraw.current = true
    })
    observer.observe(canvas)

    let frame = 0
    const tick = () => {
      if (needsRedraw.current || lastRevision.current !== game.visualRevision) {
        lastRevision.current = game.visualRevision
        needsRedraw.current = false
        draw()
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [game, draw, resetView])

  useEffect(() => { needsRedraw.current = true }, [backgroundColor])

  useEffect(() => {
    onViewProviderReady(() => {
      const canvas = canvasRef.current
      const { scale, offsetX, offsetY } = view.current
      const centerX = ((canvas?.clientWidth ?? 0) / 2 - offsetX) / scale
      const centerY = ((canvas?.clientHeight ?? 0) / 2 - offsetY) / scale
      return { scale, panOffset: { x: centerX, y: centerY } }
    })
  }, [onViewProviderReady])

  /** カーソル位置を中心に拡大縮小する。 */
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const before = view.current.scale
    const after = Math.min(Math.max(before * factor, MIN_SCALE), MAX_SCALE)
    if (after === before) return
    // その点の canvas 座標が動かないように offset を調整する。
    view.current.offsetX = px - ((px - view.current.offsetX) / before) * after
    view.current.offsetY = py - ((py - view.current.offsetY) / before) * after
    view.current.scale = after
    needsRedraw.current = true
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      // 2本指はピンチ操作。始まった時点でピースのドラッグは打ち切る。
      const [a, b] = [...pointers.current.values()]
      pinch.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        centerX: (a.x + b.x) / 2,
        centerY: (a.y + b.y) / 2,
      }
      if (drag.current) { game.endDrag(drag.current.pieceId); drag.current = null }
      pan.current = null
      return
    }
    if (pointers.current.size > 2) return
    if (game.isPaused || game.isViewingSolution) return

    e.currentTarget.setPointerCapture(e.pointerId)
    const canvasPoint = toCanvasPoint(e.clientX, e.clientY)
    const pieceId = hitTest(canvasPoint)
    if (pieceId === null) {
      pan.current = {
        pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
        startOffsetX: view.current.offsetX, startOffsetY: view.current.offsetY,
      }
      return
    }
    game.bringToFront(pieceId)
    game.resetRotation(pieceId)
    game.unplaceGroup(pieceId)
    drag.current = {
      pointerId: e.pointerId, pieceId,
      basePos: game.positions.get(pieceId)!,
      startCanvas: canvasPoint,
    }
  }, [game, hitTest, toCanvasPoint])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      const centerX = (a.x + b.x) / 2
      const centerY = (a.y + b.y) / 2
      if (pinch.current.distance > 0) zoomAt(centerX, centerY, distance / pinch.current.distance)
      // 2本指の中心の移動ぶんは、そのまま画面移動にする。
      view.current.offsetX += centerX - pinch.current.centerX
      view.current.offsetY += centerY - pinch.current.centerY
      pinch.current = { distance, centerX, centerY }
      needsRedraw.current = true
      return
    }

    if (drag.current?.pointerId === e.pointerId) {
      const canvasPoint = toCanvasPoint(e.clientX, e.clientY)
      game.updatePosition(drag.current.pieceId, {
        x: drag.current.basePos.x + (canvasPoint.x - drag.current.startCanvas.x),
        y: drag.current.basePos.y + (canvasPoint.y - drag.current.startCanvas.y),
      })
      return
    }

    if (pan.current?.pointerId === e.pointerId) {
      view.current.offsetX = pan.current.startOffsetX + (e.clientX - pan.current.startX)
      view.current.offsetY = pan.current.startOffsetY + (e.clientY - pan.current.startY)
      needsRedraw.current = true
    }
  }, [game, toCanvasPoint, zoomAt])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (drag.current?.pointerId === e.pointerId) {
      game.endDrag(drag.current.pieceId)
      drag.current = null
    }
    if (pan.current?.pointerId === e.pointerId) pan.current = null
  }, [game])

  // mac 版と同じ割り当て: そのままのスクロールは移動、Ctrl+スクロールはカーソル位置を
  // 中心に拡大縮小（トラックパッドのピンチも ctrlKey 付きの wheel として届く）。
  // ブラウザのページズーム／スクロールに取られないよう passive: false で登録する。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01))
        return
      }
      view.current.offsetX -= e.deltaX
      view.current.offsetY -= e.deltaY
      needsRedraw.current = true
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  return (
    <canvas
      ref={canvasRef}
      className="board"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}
