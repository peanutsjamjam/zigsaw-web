import { useState } from 'react'
import { UserRound } from 'lucide-react'
import { api, ApiError, type Account } from '../api'

// ギャラリー右上のアカウントメニュー。ログイン中の表示名と、ログアウト・パスワード変更・
// アカウント削除を出す。未ログインのときは「ログイン」ボタン（onRequestLogin）を出す。
export function AccountMenu({ account, onRequestLogin, onLoggedOut }: {
  account: Account | null
  onRequestLogin: () => void
  onLoggedOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'password' | 'delete' | null>(null)

  if (!account) {
    return <button type="button" className="btn" onClick={onRequestLogin}><UserRound size={16} /> ログイン</button>
  }

  return (
    <div className="account">
      <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
        <UserRound size={16} /> {account.username}
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="account-menu">
            <div className="account-email">{account.email}</div>
            <button type="button" onClick={() => { setOpen(false); setDialog('password') }}>パスワードを変更</button>
            {/* 楽観的ログアウト: サーバー応答を待たず先に画面を切り替え、logout は裏で投げる
                （どのみちログアウトするので失敗は無視。セッションはサーバー側で消える）。 */}
            <button type="button" onClick={() => { setOpen(false); void api.logout().catch(() => {}); onLoggedOut() }}>ログアウト</button>
            <button type="button" className="danger-text" onClick={() => { setOpen(false); setDialog('delete') }}>アカウントを削除</button>
          </div>
        </>
      )}
      {dialog === 'password' && <ChangePasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteAccountDialog onClose={() => setDialog(null)} onDeleted={onLoggedOut} />}
    </div>
  )
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [next2, setNext2] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  // 新しいパスワード2欄の一致状態。いずれかに入力があれば 一致=緑 / 不一致=赤 の枠を出す。
  const anyPwFilled = next !== '' || next2 !== ''
  const pwClass = anyPwFilled ? (next === next2 ? 'match' : 'mismatch') : ''

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (next !== next2) {
      setError('新しいパスワードが一致しません。')
      return
    }
    setBusy(true)
    try {
      await api.changePassword(current, next)
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay dim" onClick={onClose}>
      <form className="panel" onClick={(e) => { e.stopPropagation(); }} onSubmit={submit}>
        {done ? (<>
          <h2>変更しました</h2>
          <button type="button" className="btn primary" onClick={onClose}>閉じる</button>
        </>) : (<>
          <h2>パスワードを変更</h2>
          <label className="field">現在のパスワード
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
          </label>
          <label className="field">新しいパスワード（4文字以上）
            <input type="password" className={pwClass} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="field">新しいパスワード（確認）
            <input type="password" className={pwClass} value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy}>変更する</button>
            <button type="button" className="btn" onClick={onClose}>キャンセル</button>
          </div>
        </>)}
      </form>
    </div>
  )
}

function DeleteAccountDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="overlay dim" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>アカウントを削除しますか？</h2>
        <p className="muted">
          あなたの途中経過はすべて削除されます。アップロードした画像はギャラリーに残ります（投稿者の表示は消えます）。この操作は取り消せません。
        </p>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button
            type="button" className="btn danger" disabled={busy}
            onClick={async () => {
              setBusy(true)
              try { await api.deleteAccount(); onDeleted() }
              catch (err) { setError(err instanceof ApiError ? err.message : String(err)); setBusy(false) }
            }}
          >
            削除する
          </button>
          <button type="button" className="btn" onClick={onClose}>キャンセル</button>
        </div>
      </div>
    </div>
  )
}
