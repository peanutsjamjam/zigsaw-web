import { useEffect, useState } from 'react'
import { api, ApiError, type Account } from '../api'
import { AuthLogo } from './AuthLogo'

// パスワード再設定リンク（?reset=<token>）から入る画面。トークンを検証して
// メールアドレスを確かめ、新しいパスワードを設定してそのままログインする。
export function ResetPasswordView({ token, onAuthed, onRestart }: {
  token: string
  onAuthed: (acct: Account) => void
  onRestart: () => void
}) {
  const [email, setEmail] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // いずれかのパスワード欄に入力があれば、一致=緑 / 不一致=赤 の枠を出す。
  const anyPwFilled = password !== '' || password2 !== ''
  const pwClass = anyPwFilled ? (password === password2 ? 'match' : 'mismatch') : ''

  useEffect(() => {
    api.resetVerify(token).then((r) => setEmail(r.email)).catch(() => setInvalid(true))
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password !== password2) {
      setError('パスワードが一致しません。')
      return
    }
    setBusy(true)
    try {
      onAuthed(await api.resetComplete(token, password))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reset_token_invalid') { setInvalid(true); return }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <AuthLogo />
        {invalid ? (<>
          <p className="auth-sub" style={{ fontWeight: 600 }}>リンクが無効です</p>
          <p className="auth-sub" style={{ margin: 0 }}>この再設定用リンクは無効か、期限切れです。もう一度「パスワードをお忘れですか？」からやり直してください。</p>
          <button type="button" className="auth-back" onClick={onRestart}>閉じる</button>
        </>) : email === null ? (
          <p className="auth-sub">確認中…</p>
        ) : (<>
          <p className="auth-sub" style={{ fontWeight: 600 }}>新しいパスワードの設定</p>
          <p className="auth-sub" style={{ margin: 0 }}>{email}</p>
          <label>新しいパスワード（4文字以上）
            <input type="password" className={pwClass} value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
          </label>
          <label>新しいパスワード（確認）
            <input type="password" className={pwClass} value={password2} maxLength={128} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-submit" disabled={busy}>{busy ? '…' : 'パスワードを設定してログイン'}</button>
          <button type="button" className="auth-back" onClick={onRestart}>やめる</button>
        </>)}
      </form>
    </div>
  )
}
