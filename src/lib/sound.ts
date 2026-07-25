// ピースがつながったときの効果音。mac 版 Zigsaw の SoundEffects.swift 相当。
import connectSoundUrl from '../assets/se_katan01_cut.wav'

let context: AudioContext | null = null
let buffer: AudioBuffer | null = null
let loading: Promise<void> | null = null

/**
 * 効果音を鳴らせる状態にする。ブラウザは利用者の操作なしに音を出せないので、
 * 最初のクリック／タップのタイミングで呼ぶ。読み込みは1回だけ。
 */
export function primeSound(): void {
  context ??= new AudioContext()
  if (context.state === 'suspended') void context.resume()
  loading ??= (async () => {
    const response = await fetch(connectSoundUrl)
    buffer = await context!.decodeAudioData(await response.arrayBuffer())
  })().catch(() => { /* 音が出せなくても遊べるので黙って諦める */ })
}

/**
 * 効果音を1回鳴らす。ピースが続けざまにつながっても重なって鳴るよう、
 * 毎回新しい AudioBufferSourceNode を作る（使い捨てが Web Audio の作法）。
 */
export function playConnect(volume = 1): void {
  if (!context || !buffer) return
  const source = context.createBufferSource()
  source.buffer = buffer
  const gain = context.createGain()
  gain.gain.value = volume
  source.connect(gain).connect(context.destination)
  source.start()
}
