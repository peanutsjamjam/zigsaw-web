// 途中経過（SavedGameState）から、そのパズルの状態を判定する。
// mac 版 RecentPuzzle.status 相当。IndexedDB 版の store.ts を廃止したので、ここへ移した。
import type { SavedGameState } from './game'

export type PuzzleStatus = 'notStarted' | 'inProgress' | 'completed'

/** 全ピースが1つのかたまりになっていれば完成、そうでなければ途中。 */
export function statusFromState(state: SavedGameState | null | undefined, columns: number, rows: number): PuzzleStatus {
  if (!state) return 'notStarted'
  if (state.groups.length === 1 && state.groups[0]?.length === columns * rows) return 'completed'
  return 'inProgress'
}

export const STATUS_TEXT: Record<PuzzleStatus, string> = {
  notStarted: '未プレイ',
  inProgress: 'プレイ中',
  completed: 'クリア済み',
}

export const STATUS_PLAY_TEXT: Record<PuzzleStatus, string> = {
  notStarted: 'このパズルで遊ぶ',
  inProgress: 'このパズルを再開する',
  completed: 'このパズルで再度遊ぶ',
}
