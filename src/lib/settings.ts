// アプリ全体の設定（ブラウザの localStorage に保存。端末ごと）。
// mac 版 Zigsaw の AppSettings.swift 相当。

export type AppSettings = {
  /** 盤面の背景色（#rrggbb）。 */
  backgroundColor: string
  /** HUD に経過時間を出すか。 */
  showElapsedTime: boolean
}

export const SETTINGS_KEY = 'zigsaw-settings'

/** 初回の既定背景色。OS の配色に合わせて、明るい/暗い灰色のどちらかにする。 */
function defaultBackgroundColor(): string {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? '#2b2f36' : '#ececec'
}

export function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    backgroundColor: defaultBackgroundColor(),
    showElapsedTime: true,
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch { /* 壊れていたら既定値 */ }
  return defaults
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch { /* 保存できなくても遊べる */ }
}

/**
 * 背景色を選ぶ見本の一覧。色相を一周ぶん並べた列を、淡い→濃いの階調で
 * 何段か重ね、最後にグレースケールの1段を足す。
 */
export const HUE_STEPS = 12
const TONE_ROWS = 10

export const BACKGROUND_SWATCHES: string[] = (() => {
  const result: string[] = []
  for (let row = 0; row < TONE_ROWS; row++) {
    const t = row / (TONE_ROWS - 1)
    const saturation = 0.3 + 0.35 * t
    const brightness = 0.95 - 0.6 * t
    for (let step = 0; step < HUE_STEPS; step++) {
      result.push(hsbToHex(step / HUE_STEPS, saturation, brightness))
    }
  }
  // グレースケールの段。列数は同じで、白から黒まで等間隔。
  for (let step = 0; step < HUE_STEPS; step++) {
    result.push(hsbToHex(0, 0, 1 - step / (HUE_STEPS - 1)))
  }
  return result
})()

/** SwiftUI の Color(hue:saturation:brightness:) と同じ HSB を #rrggbb にする。 */
function hsbToHex(hue: number, saturation: number, brightness: number): string {
  const i = Math.floor(hue * 6)
  const f = hue * 6 - i
  const p = brightness * (1 - saturation)
  const q = brightness * (1 - f * saturation)
  const t = brightness * (1 - (1 - f) * saturation)
  const [r, g, b] = [
    [brightness, t, p], [q, brightness, p], [p, brightness, t],
    [p, q, brightness], [t, p, brightness], [brightness, p, q],
  ][i % 6]
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}
