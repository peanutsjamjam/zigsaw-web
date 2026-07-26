import { useEffect, useState } from 'react'
import { api, ApiError, type Account } from '../api'
import { AuthLogo } from './AuthLogo'

// メール確認リンク（?signup=<token>）から入る「新規登録の2段階目」。
// トークンを検証してメールアドレスを確かめ、ユーザー名とパスワードを設定して登録を完了する。
export function SignupCompleteView({ token, onAuthed, onRestart }: {
  token: string
  onAuthed: (acct: Account) => void
  onRestart: () => void
}) {
  const [email, setEmail] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ username?: string }>({})
  const [busy, setBusy] = useState(false)
  // いずれかのパスワード欄に入力があれば、一致=緑 / 不一致=赤 の枠を出す。
  const anyPwFilled = password !== '' || password2 !== ''
  const pwClass = anyPwFilled ? (password === password2 ? 'match' : 'mismatch') : ''

  useEffect(() => {
    api.signupVerify(token).then((r) => setEmail(r.email)).catch(() => setInvalid(true))
  }, [token])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setFieldErrors({})
    if (password !== password2) {
      setError('パスワードが一致しません。')
      return
    }
    setBusy(true)
    try {
      onAuthed(await api.signupComplete(token, username, password))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'duplicate' && err.fields?.includes('username')) {
        setFieldErrors({ username: 'このユーザー名はすでに使われています。' })
        return
      }
      if (err instanceof ApiError && (err.code === 'signup_token_invalid')) {
        setInvalid(true)
        return
      }
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
          <p className="auth-sub" style={{ margin: 0 }}>この登録用リンクは無効か、期限切れです。お手数ですが、もう一度新規登録からやり直してください。</p>
          <button type="button" className="auth-back" onClick={onRestart}>最初からやり直す</button>
        </>) : email === null ? (
          <p className="auth-sub">確認中…</p>
        ) : (<>
          <p className="auth-sub" style={{ fontWeight: 600 }}>登録を完了する</p>
          <p className="auth-sub" style={{ margin: 0 }}>{email}</p>
          <label>ユーザー名
            <input
              className={fieldErrors.username ? 'input-error' : ''}
              value={username} maxLength={50}
              onChange={(e) => { setUsername(e.target.value); if (fieldErrors.username) setFieldErrors({}) }}
              autoComplete="username" autoFocus
            />
            {fieldErrors.username && <span className="field-error">{fieldErrors.username}</span>}
          </label>
          <label>パスワード（4文字以上）
            <input type="password" className={pwClass} value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label>パスワード（確認）
            <input type="password" className={pwClass} value={password2} maxLength={128} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="auth-submit" disabled={busy}>{busy ? '…' : '登録して始める'}</button>
          <button type="button" className="auth-back" onClick={onRestart}>やめる</button>
        </>)}
      </form>
    </div>
  )
}
