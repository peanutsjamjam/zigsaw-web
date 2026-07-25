// 画面上端に貼り付く操作バー。mac 版 Zigsaw の GameHUDView.swift 相当。
// 盤面の拡大縮小とは切り離されているので、倍率が変わっても大きさは変わらない。
import { useState } from 'react'
import { ChevronLeft, Clock, Eye, Pause, Play, Palette, Save } from 'lucide-react'
import type { PuzzleGameState } from '../lib/game'
import { formatElapsed } from '../lib/format'
import { BACKGROUND_SWATCHES, HUE_STEPS } from '../lib/settings'

type Props = {
  game: PuzzleGameState
  showElapsedTime: boolean
  backgroundColor: string
  onBackgroundColorChange: (color: string) => void
  onToggleElapsedTime: () => void
  onExit: () => void
  /** 保存する。未ログインで保存できないときは null（ボタンを出さない）。 */
  onSave: (() => void) | null
}

export function GameHUD({
  game, showElapsedTime, backgroundColor, onBackgroundColorChange, onToggleElapsedTime, onExit, onSave,
}: Props) {
  const [showColorPicker, setShowColorPicker] = useState(false)
  // 見本を選ぶとその場で盤面に反映し、キャンセルならここへ戻す。
  const [colorBeforePicker, setColorBeforePicker] = useState(backgroundColor)

  return (
    <div className="hud">
      <button type="button" className="hud-btn" onClick={onExit} title="パズル選択画面に戻る">
        <ChevronLeft size={18} />
      </button>

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

      {onSave && (
        <button type="button" className="hud-btn" onClick={onSave}>
          <Save size={16} /> 保存する
        </button>
      )}
      <button type="button" className="hud-btn" onClick={() => game.showSolution()}>
        <Eye size={16} /> 完成図を見る
      </button>

      <div className="hud-popover-anchor">
        <button
          type="button"
          className="hud-btn"
          onClick={() => {
            setColorBeforePicker(backgroundColor)
            setShowColorPicker((v) => !v)
          }}
        >
          <Palette size={16} /> 背景色を変更
        </button>
        {showColorPicker && (
          <BackgroundColorSwatchGrid
            selectedColor={backgroundColor}
            onSelect={onBackgroundColorChange}
            onCancel={() => { onBackgroundColorChange(colorBeforePicker); setShowColorPicker(false) }}
            onConfirm={() => setShowColorPicker(false)}
          />
        )}
      </div>

      <button type="button" className="hud-btn" onClick={() => game.pause()} disabled={game.isPaused || game.isComplete}>
        <Pause size={16} /> 一時停止
      </button>
      <button type="button" className="hud-btn" onClick={() => game.resume()} disabled={!game.isPaused || game.isComplete}>
        <Play size={16} /> 再開
      </button>
    </div>
  )
}

/**
 * 背景色の見本。色相を一周ぶん並べた列を、淡い→濃いの階調ぶんの行に重ね、
 * 最後にグレースケールの行を足したもの。押すとその場で盤面に反映し、
 * キャンセル／OK で確定する。
 */
function BackgroundColorSwatchGrid({ selectedColor, onSelect, onCancel, onConfirm }: {
  selectedColor: string
  onSelect: (color: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="swatch-popover">
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
