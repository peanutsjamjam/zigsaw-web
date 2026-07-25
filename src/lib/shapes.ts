// プレビューが空のときに歩き回るピースの絵と、そのコマ割り。
// mac 版 Zigsaw の SetupView.swift の placeholderWalkFrames をそのまま持ってきたもの。
import shape002 from '../assets/shapes/shape_002.png'
import shape003 from '../assets/shapes/shape_003.png'
import shape004 from '../assets/shapes/shape_004.png'
import shape005 from '../assets/shapes/shape_005.png'
import shape006 from '../assets/shapes/shape_006.png'
import shape007 from '../assets/shapes/shape_007.png'
import shape008 from '../assets/shapes/shape_008.png'

export const SHAPE_IMAGES: Record<string, string> = {
  PlaceholderShape002: shape002,
  PlaceholderShape003: shape003,
  PlaceholderShape004: shape004,
  PlaceholderShape005: shape005,
  PlaceholderShape006: shape006,
  PlaceholderShape007: shape007,
  PlaceholderShape008: shape008,
}

export type WalkFrame = { offset: number; imageName: string }

/**
 * 1コマぶんの「どこに、どの形で」。0.5 秒ごとに1つ進み、最後まで行ったら先頭へ戻る。
 * ±305 はプレビュー枠（幅460）の外へ完全に出きる位置。並べ替え・追加・削除は
 * この配列を直接いじればよい。
 */
export const PLACEHOLDER_WALK_FRAMES: WalkFrame[] = [
  { offset: -305, imageName: 'PlaceholderShape002' },
  { offset: -275, imageName: 'PlaceholderShape003' },
  { offset: -245, imageName: 'PlaceholderShape002' },
  { offset: -215, imageName: 'PlaceholderShape003' },
  { offset: -185, imageName: 'PlaceholderShape002' },
  { offset: -155, imageName: 'PlaceholderShape003' },
  { offset: -125, imageName: 'PlaceholderShape002' },
  { offset: -95, imageName: 'PlaceholderShape003' },
  { offset: -65, imageName: 'PlaceholderShape002' },
  { offset: -35, imageName: 'PlaceholderShape003' },
  { offset: -5, imageName: 'PlaceholderShape002' },

  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },

  { offset: 0, imageName: 'PlaceholderShape008' },
  { offset: 0, imageName: 'PlaceholderShape008' },
  { offset: 0, imageName: 'PlaceholderShape008' },
  { offset: 0, imageName: 'PlaceholderShape008' },

  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },

  { offset: 0, imageName: 'PlaceholderShape007' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape007' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape007' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape007' },
  { offset: 0, imageName: 'PlaceholderShape006' },

  { offset: 0, imageName: 'PlaceholderShape005' },
  { offset: 0, imageName: 'PlaceholderShape004' },
  { offset: 0, imageName: 'PlaceholderShape005' },
  { offset: 0, imageName: 'PlaceholderShape004' },

  { offset: 0, imageName: 'PlaceholderShape003' },
  { offset: 0, imageName: 'PlaceholderShape002' },
  { offset: 0, imageName: 'PlaceholderShape003' },
  { offset: 0, imageName: 'PlaceholderShape002' },

  { offset: -8, imageName: 'PlaceholderShape005' },
  { offset: -16, imageName: 'PlaceholderShape004' },
  { offset: -24, imageName: 'PlaceholderShape005' },
  { offset: -32, imageName: 'PlaceholderShape004' },

  { offset: -24, imageName: 'PlaceholderShape003' },
  { offset: -16, imageName: 'PlaceholderShape002' },
  { offset: -8, imageName: 'PlaceholderShape003' },
  { offset: 0, imageName: 'PlaceholderShape002' },

  { offset: 8, imageName: 'PlaceholderShape003' },
  { offset: 16, imageName: 'PlaceholderShape002' },
  { offset: 24, imageName: 'PlaceholderShape003' },
  { offset: 32, imageName: 'PlaceholderShape002' },

  { offset: 24, imageName: 'PlaceholderShape005' },
  { offset: 16, imageName: 'PlaceholderShape004' },
  { offset: 8, imageName: 'PlaceholderShape005' },
  { offset: 0, imageName: 'PlaceholderShape004' },

  { offset: -15, imageName: 'PlaceholderShape006' },
  { offset: -30, imageName: 'PlaceholderShape007' },
  { offset: -45, imageName: 'PlaceholderShape006' },
  { offset: -60, imageName: 'PlaceholderShape007' },

  { offset: -45, imageName: 'PlaceholderShape006' },
  { offset: -30, imageName: 'PlaceholderShape007' },
  { offset: -15, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape007' },

  { offset: 15, imageName: 'PlaceholderShape006' },
  { offset: 30, imageName: 'PlaceholderShape007' },
  { offset: 45, imageName: 'PlaceholderShape006' },
  { offset: 60, imageName: 'PlaceholderShape007' },

  { offset: 45, imageName: 'PlaceholderShape006' },
  { offset: 30, imageName: 'PlaceholderShape007' },
  { offset: 15, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape007' },

  { offset: -15, imageName: 'PlaceholderShape005' },
  { offset: -30, imageName: 'PlaceholderShape003' },
  { offset: -45, imageName: 'PlaceholderShape005' },
  { offset: -60, imageName: 'PlaceholderShape003' },

  { offset: -45, imageName: 'PlaceholderShape004' },
  { offset: -30, imageName: 'PlaceholderShape002' },
  { offset: -15, imageName: 'PlaceholderShape004' },
  { offset: 0, imageName: 'PlaceholderShape002' },

  { offset: 15, imageName: 'PlaceholderShape004' },
  { offset: 30, imageName: 'PlaceholderShape002' },
  { offset: 45, imageName: 'PlaceholderShape004' },
  { offset: 60, imageName: 'PlaceholderShape002' },

  { offset: 45, imageName: 'PlaceholderShape005' },
  { offset: 30, imageName: 'PlaceholderShape003' },
  { offset: 15, imageName: 'PlaceholderShape005' },
  { offset: 0, imageName: 'PlaceholderShape003' },

  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },

  { offset: 0, imageName: 'PlaceholderShape008' },
  { offset: 0, imageName: 'PlaceholderShape008' },
  { offset: 0, imageName: 'PlaceholderShape008' },
  { offset: 0, imageName: 'PlaceholderShape008' },

  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },
  { offset: 0, imageName: 'PlaceholderShape006' },

  { offset: 5, imageName: 'PlaceholderShape002' },
  { offset: 35, imageName: 'PlaceholderShape003' },
  { offset: 65, imageName: 'PlaceholderShape002' },
  { offset: 95, imageName: 'PlaceholderShape003' },
  { offset: 125, imageName: 'PlaceholderShape002' },
  { offset: 155, imageName: 'PlaceholderShape003' },
  { offset: 185, imageName: 'PlaceholderShape002' },
  { offset: 215, imageName: 'PlaceholderShape003' },
  { offset: 245, imageName: 'PlaceholderShape002' },
  { offset: 275, imageName: 'PlaceholderShape003' },
  { offset: 305, imageName: 'PlaceholderShape002' },
]
