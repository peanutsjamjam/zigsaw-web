import { useState } from 'react'
import { MailCheck, ArrowLeft } from 'lucide-react'
import { api, ApiError, type Account } from '../api'
import { AuthLogo } from './AuthLogo'

// ログイン / 新規登録（サインアップは「メール入力→確認リンク送信」まで）/ パスワード再設定申請。
// mac 版には無い、Web 版で「途中経過を保存するため」に足した認証画面。nenpyo の AuthView を移植。
//
// onCancel はこの画面を閉じて背後（ギャラリー）へ戻るためのもの。overlay=true のときは
// ギャラリーの上にモーダルとして重ねる（背景クリックで閉じられるよう伝播を止める）。
export function AuthView({ onAuthed, onCancel, overlay = false }: {
  onAuthed: (acct: Account) => void
  onCancel: () => void
  overlay?: boolean
}) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ email?: string }>({})
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false) // 確認 / 再設定リンクを送信済みか

  const switchMode = (m: 'login' | 'register' | 'forgot') => {
    setMode(m)
    setError('')
    setFieldErrors({})
    setSent(false)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setFieldErrors({})
    setBusy(true)
    try {
      if (mode === 'login') {
        onAuthed(await api.login(email, password))
      } else if (mode === 'forgot') {
        await api.resetRequest(email)  // 存在秘匿のため常に {ok}
        setSent(true)
      } else {
        await api.signupRequest(email)
        setSent(true)
      }
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'email_required' || err.code === 'email_invalid')) {
        setFieldErrors({ email: err.message })
        return
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const card = (
    <form className="auth-card" onSubmit={submit} onClick={overlay ? (e) => e.stopPropagation() : undefined}>
      <AuthLogo />
      <p className="auth-sub">ログインすると、パズルの途中経過を保存して続きから遊べます。</p>

      {mode === 'forgot' ? (
        <p className="auth-sub" style={{ fontWeight: 600 }}>パスワードの再設定</p>
      ) : (
        <div className="auth-tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>ログイン</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>新規登録</button>
        </div>
      )}

      {mode === 'login' ? (<>
        <label>メールアドレス
          <input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
        </label>
        <label>パスワード
          <input type="password" value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="auth-submit" disabled={busy}>{busy ? '…' : 'ログイン'}</button>
        <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>パスワードをお忘れですか？</button>
      </>) : mode === 'forgot' ? (sent ? (<>
        <div className="auth-success"><MailCheck size={32} /><span>メールを送信しました</span></div>
        <p className="auth-sub" style={{ margin: 0 }}>そのメールアドレスで登録があれば、再設定用のリンクを送りました。メールをご確認ください。</p>
        <button type="button" className="auth-back" onClick={() => switchMode('login')}>ログインへ戻る</button>
      </>) : (<>
        <label>メールアドレス
          <input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="auth-submit" disabled={busy}>{busy ? '…' : '再設定リンクを送る'}</button>
        <button type="button" className="auth-back" onClick={() => switchMode('login')}>ログインへ戻る</button>
      </>)) : sent ? (<>
        <div className="auth-success"><MailCheck size={32} /><span>確認メールを送信しました</span></div>
        <p className="auth-sub" style={{ margin: 0 }}>{email} 宛に登録用リンクを送りました。リンクを開いてユーザー名とパスワードを設定してください。</p>
        <button type="button" className="auth-back" onClick={() => { setSent(false); setEmail('') }}>別のメールで送り直す</button>
      </>) : (<>
        <label>メールアドレス
          <input
            type="email"
            className={fieldErrors.email ? 'input-error' : ''}
            value={email}
            maxLength={254}
            onChange={(e) => { setEmail(e.target.value); if (fieldErrors.email) setFieldErrors({}) }}
            autoComplete="email"
            autoFocus
          />
          {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="auth-submit" disabled={busy}>{busy ? '…' : '確認メールを送る'}</button>
      </>)}

      <button type="button" className="auth-back" onClick={onCancel}><ArrowLeft size={14} /> 戻る</button>
    </form>
  )

  return overlay ? card : <div className="auth-wrap">{card}</div>
}
