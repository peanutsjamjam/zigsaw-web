// 遊んでいる最中の画面。盤面・HUD・各種オーバーレイをまとめる。
// mac 版 Zigsaw の PuzzleBoardView.swift（オーバーレイ部分）と GameCoordinator.swift 相当。
// 途中経過はサーバー（progress API）へ保存する。未ログイン時は保存できない。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import { formatElapsed } from '../lib/format'
import type { PuzzleGameState } from '../lib/game'
import type { AppSettings } from '../lib/settings'
import { GameHUD } from './GameHUD'
import { PuzzleBoard, type ViewState } from './PuzzleBoard'

type Props = {
  game: PuzzleGameState
  puzzleId: number
  displayName: string
  /** ログイン中か。false のときは保存できない。 */
  canSave: boolean
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
  onExit: () => void
}

/** HUD に出る状態（経過時間・一時停止・完成）の変化を React へ伝える。 */
function useGameState(game: PuzzleGameState): number {
  return useSyncExternalStore(
    useCallback((listener: () => void) => game.subscribe(listener), [game]),
    useCallback(() => game.stateVersion, [game]),
  )
}

export function GameView({ game, puzzleId, displayName, canSave, settings, onSettingsChange, onExit }: Props) {
  useGameState(game)
  const viewProvider = useRef<(() => ViewState) | null>(null)
  const [dismissedCompletion, setDismissedCompletion] = useState(false)
  const [savedToast, setSavedToast] = useState(false)
  const [confirmingExit, setConfirmingExit] = useState(false)

  const save = useCallback(async () => {
    if (!canSave) return
    const viewState = viewProvider.current?.() ?? { scale: 1, panOffset: { x: 0, y: 0 } }
    const savedGame = game.exportSavedState(viewState.scale, viewState.panOffset)
    // 完成したパズルは常に完成図を出すので、途中経過の画像は付けない。
    const snapshot = game.isComplete ? undefined : (game.renderSnapshotDataUrl(settings.backgroundColor) ?? undefined)
    await api.saveProgress(puzzleId, { ...savedGame, snapshot })
  }, [canSave, game, puzzleId, settings.backgroundColor])

  const saveFromHUD = useCallback(() => {
    void save().then(() => {
      setSavedToast(true)
      window.setTimeout(() => setSavedToast(false), 1600)
    })
  }, [save])

  // 全ピースが1つにつながった瞬間に「クリア済み」として記録する（ログイン中のみ）。
  // mac 版と同じく、明示的な「保存する」は要らない。
  useEffect(() => {
    if (game.isComplete && canSave) void save()
  }, [game.isComplete, canSave, save])

  const requestExit = useCallback(() => {
    // 完成済みは失うものが無いのでそのまま戻る。
    // それ以外は、ログイン中なら保存/破棄を、未ログインなら「失われます」の注意を出す。
    if (game.isComplete) { onExit(); return }
    setConfirmingExit(true)
  }, [game.isComplete, onExit])

  const isViewingSolution = game.isViewingSolution
  const isBlurred = game.isPaused || isViewingSolution
  // 完成図の書き出しは重いので、開いているあいだは作り直さない。
  const solvedImageUrl = useMemo(
    () => (isViewingSolution ? game.solvedCanvas()?.toDataURL('image/jpeg', 0.85) : undefined),
    [game, isViewingSolution],
  )

  return (
    <div className="game">
      <div className={`board-wrap${isBlurred ? ' blurred' : ''}`}>
        <PuzzleBoard
          game={game}
          backgroundColor={settings.backgroundColor}
          onViewProviderReady={(provider) => { viewProvider.current = provider }}
        />
      </div>

      <GameHUD
        game={game}
        showElapsedTime={settings.showElapsedTime}
        backgroundColor={settings.backgroundColor}
        onBackgroundColorChange={(backgroundColor) => onSettingsChange({ ...settings, backgroundColor })}
        onToggleElapsedTime={() => onSettingsChange({ ...settings, showElapsedTime: !settings.showElapsedTime })}
        onExit={requestExit}
        onSave={canSave ? saveFromHUD : null}
      />

      <div className="game-title">{displayName}（{game.pieces.length}ピース）</div>

      {savedToast && <div className="toast">保存しました</div>}

      {game.isPaused && (
        <div className="overlay dim">
          <div className="panel">
            <h2>一時停止中</h2>
            <button type="button" className="btn primary large" onClick={() => game.resume()}>再開</button>
          </div>
        </div>
      )}

      {game.isViewingSolution && (
        <div className="overlay" onClick={() => game.hideSolution()}>
          {solvedImageUrl && <img className="solution" src={solvedImageUrl} alt="完成図" />}
        </div>
      )}

      {game.isComplete && !dismissedCompletion && (
        <div className="overlay" onClick={() => setDismissedCompletion(true)}>
          <div className="panel">
            <h2>完成しました！</h2>
            <p className="muted">所要時間: {formatElapsed(game.elapsedSeconds)}</p>
          </div>
        </div>
      )}

      {confirmingExit && (
        <div className="overlay dim">
          <div className="panel">
            {canSave ? (
              <>
                <h2>進行中のパズルがあります</h2>
                <p className="muted">選択画面に戻る前に保存しますか？保存しない場合、この進行状況は失われます。</p>
                <div className="row">
                  <button type="button" className="btn primary" onClick={() => { void save().then(onExit) }}>保存して戻る</button>
                  <button type="button" className="btn" onClick={onExit}>保存せず戻る</button>
                  <button type="button" className="btn" onClick={() => setConfirmingExit(false)}>キャンセル</button>
                </div>
              </>
            ) : (
              <>
                <h2>ログインしていません</h2>
                <p className="muted">
                  ログインしていないため、現在のパズルの状態は保存されません。
                  選択画面に戻ると、この進行状況は失われます。それでも戻りますか？
                </p>
                <div className="row">
                  <button type="button" className="btn danger" onClick={onExit}>戻る（保存しない）</button>
                  <button type="button" className="btn" onClick={() => setConfirmingExit(false)}>キャンセル</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
