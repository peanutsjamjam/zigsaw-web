import { useCallback, useEffect, useState } from 'react'
import { api, type Account, type Puzzle } from './api'
import { buildPuzzle } from './lib/generator'
import { PuzzleGameState } from './lib/game'
import { loadSettings, saveSettings, type AppSettings } from './lib/settings'
import { primeSound } from './lib/sound'
import { AuthView } from './components/AuthView'
import { GameView } from './components/GameView'
import { ResetPasswordView } from './components/ResetPasswordView'
import { SetupView, type StartRequest } from './components/SetupView'
import { SignupCompleteView } from './components/SignupCompleteView'
import './App.css'

// アプリのルート。mac 版 Zigsaw の ContentView.swift / GameCoordinator.swift 相当だが、
// Web 版では認証（任意）とサーバーの共有ギャラリーが加わる。
//   - 起動時に me でログイン状態を確認する（未ログインでもギャラリーは見て遊べる）。
//   - ?signup=<token> / ?reset=<token> があれば、その画面を最優先で開く。
//   - 遊んでいる最中のパズルがあれば盤面を、無ければ選択画面（ギャラリー）を出す。
type Session = { id: number; game: PuzzleGameState; puzzleId: number; columns: number; rows: number; displayName: string }
let nextSessionId = 1

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [account, setAccount] = useState<Account | null>(null)
  // 実行環境が development のときだけ、開発用フラスコボタンを出す（env.pl 由来）。
  const [isDev, setIsDev] = useState(false)
  const [booted, setBooted] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [signupToken, setSignupToken] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('signup'),
  )
  const [resetToken, setResetToken] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('reset'),
  )

  useEffect(() => { saveSettings(settings) }, [settings])

  // 起動時にセッションを確認（未ログインなら account=null のまま先へ進む）。
  useEffect(() => {
    api.me().then(setAccount).catch(() => setAccount(null)).finally(() => setBooted(true))
  }, [])

  // 実行環境を取得して、開発環境のときだけフラスコボタンを表示する。
  useEffect(() => {
    api.env().then((r) => setIsDev(r.env === 'development')).catch(() => { /* 取得失敗時は非表示のまま */ })
  }, [])

  // ブラウザは利用者の操作なしに音を鳴らせないので、最初のクリックで用意する。
  useEffect(() => {
    const onFirstInput = () => primeSound()
    window.addEventListener('pointerdown', onFirstInput, { once: true })
    return () => window.removeEventListener('pointerdown', onFirstInput)
  }, [])

  // 遊んでいる途中でタブを閉じようとしたら引き止める（完成後・未ログインは黙って通す）。
  useEffect(() => {
    const game = session?.game
    if (!game) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!game.isComplete && account) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [session, account])

  const clearParam = (name: string, setter: (v: null) => void) => {
    setter(null)
    const url = new URL(window.location.href)
    url.searchParams.delete(name)
    window.history.replaceState({}, '', url.toString())
  }

  // パズル（画像＋グリッド）を、必要なら復元状態つきで開始する。
  const startPuzzle = useCallback(async (puzzle: Puzzle, resumeState: StartRequest['resumeState']) => {
    const res = await fetch(puzzle.full_url)
    const blob = await res.blob()
    const { pieces, boardSize } = await buildPuzzle(blob, puzzle.columns, puzzle.rows)
    setSession({
      id: nextSessionId++,
      game: new PuzzleGameState(pieces, boardSize, resumeState),
      puzzleId: puzzle.id,
      columns: puzzle.columns,
      rows: puzzle.rows,
      displayName: puzzle.display_name,
    })
  }, [])

  const start = useCallback(async (req: StartRequest) => {
    setBusy(true)
    try { await startPuzzle(req.puzzle, req.resumeState) }
    finally { setBusy(false) }
  }, [startPuzzle])

  const exit = useCallback(() => {
    setSession((current) => { current?.game.dispose(); return null })
  }, [])

  if (!booted) return <div className="splash">読み込み中…</div>

  // メール確認 / パスワード再設定リンクは最優先で開く。
  if (resetToken) {
    return (
      <ResetPasswordView
        token={resetToken}
        onAuthed={(a) => { clearParam('reset', setResetToken); setAccount(a) }}
        onRestart={() => clearParam('reset', setResetToken)}
      />
    )
  }
  if (signupToken && !account) {
    return (
      <SignupCompleteView
        token={signupToken}
        onAuthed={(a) => { clearParam('signup', setSignupToken); setAccount(a) }}
        onRestart={() => clearParam('signup', setSignupToken)}
      />
    )
  }

  if (session) {
    return (
      <GameView
        // 遊び始めるたびに作り直す（前回の「完成しました！」を閉じた状態などを持ち越さない）。
        key={session.id}
        game={session.game}
        puzzleId={session.puzzleId}
        displayName={session.displayName}
        canSave={account != null}
        settings={settings}
        onSettingsChange={setSettings}
        onExit={exit}
      />
    )
  }

  return (
    <>
      <SetupView
        // アカウントが替わったら作り直す（前のユーザーの途中経過を残さない）。
        key={account?.username ?? 'guest'}
        account={account}
        isDev={isDev}
        onStart={(req) => void start(req)}
        onRequestLogin={() => setShowAuth(true)}
        onLoggedOut={() => setAccount(null)}
        busy={busy}
      />
      {showAuth && !account && (
        <div className="auth-overlay" onClick={() => setShowAuth(false)}>
          <AuthView overlay onAuthed={(a) => { setAccount(a); setShowAuth(false) }} onCancel={() => setShowAuth(false)} />
        </div>
      )}
    </>
  )
}
