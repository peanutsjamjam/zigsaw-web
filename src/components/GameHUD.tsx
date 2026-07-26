// 画面上端に貼り付く操作バー。mac 版 Zigsaw の GameHUDView.swift 相当。
// 盤面の拡大縮小とは切り離されているので、倍率が変わっても大きさは変わらない。
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, Clock, Eye, Pause, Play, Palette, Save } from 'lucide-react'
import type { PuzzleGameState } from '../lib/game'
import { formatElapsed } from '../lib/format'
import { BACKGROUND_SWATCHES, HUE_STEPS } from '../lib/settings'

type Props = {
  game: PuzzleGameState
  /** パズルの題名（ファイル名/タイトル）。「＜」の右に表示する。 */
  displayName: string
  showElapsedTime: boolean
  backgroundColor: string
  onBackgroundColorChange: (color: string) => void
  onToggleElapsedTime: () => void
  onExit: () => void
  /** 保存する。未ログインで保存できないときは null（ボタンを出さない）。 */
  onSave: (() => void) | null
  /** 自動保存の現在のON/OFF。 */
  autoSave: boolean
  /** 自動保存が実行された瞬間に true。ボタンを一瞬光らせる。 */
  autoSaveFlash: boolean
  /** 自動保存の切り替え。未ログインで保存できないときは null（ボタンを出さない）。 */
  onToggleAutoSave: (() => void) | null
}

export function GameHUD({
  game, displayName, showElapsedTime, backgroundColor, onBackgroundColorChange, onToggleElapsedTime,
  onExit, onSave, autoSave, autoSaveFlash, onToggleAutoSave,
}: Props) {
  const [showColorPicker, setShowColorPicker] = useState(false)
  // 見本を選ぶとその場で盤面に反映し、キャンセルならここへ戻す。
  const [colorBeforePicker, setColorBeforePicker] = useState(backgroundColor)
  // パレットの表示位置（背景色ボタンの真下・中央）。HUD は overflow-x:auto を持つため、
  // バー内に絶対配置するとはみ出したパレットが切り取られてしまう。そこで body 直下へ
  // ポータルで出し、ボタンの画面座標を基準に固定配置する。
  const colorButtonRef = useRef<HTMLButtonElement>(null)
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null)

  const toggleColorPicker = () => {
    if (showColorPicker) { setShowColorPicker(false); return }
    setColorBeforePicker(backgroundColor)
    const r = colorButtonRef.current?.getBoundingClientRect()
    if (r) setPickerPos({ top: r.bottom + 8, left: r.left + r.width / 2 })
    setShowColorPicker(true)
  }
  const closeColorPicker = () => setShowColorPicker(false)
  const cancelColorPicker = () => { onBackgroundColorChange(colorBeforePicker); closeColorPicker() }

  return (
    <div className="hud">
      <button type="button" className="hud-btn" onClick={onExit} title="パズル選択画面に戻る">
        <ChevronLeft size={18} />
      </button>

      <span className="hud-title">{displayName}（{game.pieces.length}ピース）</span>

      <button
        type="button"
        className="hud-btn"
        onClick={onToggleElapsedTime}
        title={showElapsedTime ? '経過時間を隠す' : '経過時間を表示する'}
      >
        {showElapsedTime
          ? <span className="hud-time">{formatElapsed(game.elapsedSeconds)}</span>
          : <Clock size={16} />}
      </button>

      {onToggleAutoSave && (
        <button
          type="button"
          className={`hud-btn autosave-btn${autoSaveFlash ? ' flash' : ''}`}
          onClick={onToggleAutoSave}
          title="60秒ごとの自動保存を切り替える"
        >
          {/* 自動保存された瞬間、各文字が左から順に黄色く光って戻る（文字ごとに遅延をずらす）。 */}
          <span className="autosave-label">{[...`自動保存 (${autoSave ? 'ON' : 'OFF'})`].map((c, i) => (
            <span key={i} className="ch" style={{ animationDelay: `${i * 55}ms` }}>{c === ' ' ? ' ' : c}</span>
          ))}</span>
        </button>
      )}
      {onSave && (
        <button type="button" className="hud-btn" onClick={onSave}>
          <Save size={16} /> 保存する
        </button>
      )}
      <button type="button" className="hud-btn" onClick={() => game.showSolution()}>
        <Eye size={16} /> 完成図を見る
      </button>

      <button ref={colorButtonRef} type="button" className="hud-btn" onClick={toggleColorPicker}>
        <Palette size={16} /> 背景色を変更
      </button>

      {/* 一時停止／再開は1つのトグルボタン。状態に応じてキャプションとアイコンが変わる。 */}
      <button
        type="button"
        className="hud-btn"
        onClick={() => (game.isPaused ? game.resume() : game.pause())}
        disabled={game.isComplete}
      >
        {game.isPaused ? <><Play size={16} /> 再開</> : <><Pause size={16} /> 一時停止</>}
      </button>

      {showColorPicker && pickerPos && createPortal(
        <>
          {/* 外側クリックで（選択をキャンセルして）閉じる。 */}
          <div className="menu-backdrop" onClick={cancelColorPicker} />
          <BackgroundColorSwatchGrid
            pos={pickerPos}
            selectedColor={backgroundColor}
            onSelect={onBackgroundColorChange}
            onCancel={cancelColorPicker}
            onConfirm={closeColorPicker}
          />
        </>,
        document.body,
      )}
    </div>
  )
}

/**
 * 背景色の見本。色相を一周ぶん並べた列を、淡い→濃いの階調ぶんの行に重ね、
 * 最後にグレースケールの行を足したもの。押すとその場で盤面に反映し、
 * キャンセル／OK で確定する。body 直下にポータルで出すので固定配置する。
 */
function BackgroundColorSwatchGrid({ pos, selectedColor, onSelect, onCancel, onConfirm }: {
  pos: { top: number; left: number }
  selectedColor: string
  onSelect: (color: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="swatch-popover" style={{ top: pos.top, left: pos.left }}>
      <div className="swatch-grid" style={{ gridTemplateColumns: `repeat(${HUE_STEPS}, 28px)` }}>
        {BACKGROUND_SWATCHES.map((color, i) => (
          <button
            key={i}
            type="button"
            className={`swatch${color === selectedColor ? ' selected' : ''}`}
            style={{ background: color }}
            onClick={() => onSelect(color)}
            aria-label={color}
          />
        ))}
      </div>
      <div className="swatch-actions">
        <button type="button" className="btn" onClick={onCancel}>キャンセル</button>
        <button type="button" className="btn primary" onClick={onConfirm}>OK</button>
      </div>
    </div>
  )
}
