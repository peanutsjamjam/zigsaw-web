// 開発環境（env.pl の $main::ZIGSAW_ENV = 'development'）でだけ使える画面。
// 選択画面のフラスコアイコンから、画面全体を切り替えて開く。nenpyo のフラスコ相当。
// users テーブルの一覧を出し、行をクリックするとその下に、そのユーザーが登録した
// 画像・作成したパズル・保存したゲームをカードで表示する。
import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { api, type DevStorage, type DevUser, type DevUserDetail } from '../api'
import { statusFromState, STATUS_TEXT } from '../lib/status'

export function DevView({ onBack }: { onBack: () => void }) {
  const [storage, setStorage] = useState<DevStorage | null>(null)
  const [users, setUsers] = useState<DevUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<DevUserDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    api.devStorage().then(setStorage).catch(() => { /* 取得失敗時は非表示のまま */ })
    api.devUsers().then(setUsers).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const selectUser = (id: number) => {
    // 同じ行をもう一度押したら閉じる。
    if (selectedId === id) { setSelectedId(null); setDetail(null); return }
    setSelectedId(id)
    setDetail(null)
    setDetailError(null)
    api.devUserDetail(id)
      .then(setDetail)
      .catch((err) => setDetailError(err instanceof Error ? err.message : String(err)))
  }

  const selectedUser = users?.find((u) => u.id === selectedId) ?? null

  return (
    <div className="dev-view">
      <div className="dev-view-head">
        <button type="button" className="btn" onClick={onBack}><ArrowLeft size={16} /> 戻る</button>
        <h1>開発メニュー</h1>
        <span className="muted">開発環境専用</span>
      </div>

      <h2 className="section-title">画像ディレクトリの使用状況</h2>
      {storage === null ? (
        <div className="muted">読み込み中…</div>
      ) : (
        <div className="stat-row">
          <Stat label="画像数" value={`${storage.image_count}`} />
          <Stat label="画像の合計サイズ" value={formatBytes(storage.total_bytes)} />
          <Stat label="空き容量" value={formatBytes(storage.fs_free)} />
          <Stat label="総容量" value={`${formatBytes(storage.fs_total)}${storage.fs_type ? `（${storage.fs_type}）` : ''}`} />
        </div>
      )}

      <h2 className="section-title">ユーザー一覧（users）</h2>
      {error ? (
        <div className="error">{error}</div>
      ) : users === null ? (
        <div className="muted">読み込み中…</div>
      ) : (
        <div className="table-wrap">
          <table className="dev-table">
            <thead>
              <tr>
                <th>id</th><th>username</th><th>email</th><th>created_at</th>
                <th>画像</th><th>パズル</th><th>保存ゲーム</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  className={`dev-row${u.id === selectedId ? ' selected' : ''}`}
                  onClick={() => selectUser(u.id)}
                >
                  <td>{u.id}</td>
                  <td>{u.username}</td>
                  <td>{u.email}</td>
                  <td>{formatTimestamp(u.created_at)}</td>
                  <td className="num">{u.image_count} <span className="muted">（{formatBytes(u.image_bytes)}）</span></td>
                  <td className="num">{u.puzzle_count}</td>
                  <td className="num">{u.progress_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && <div className="muted">ユーザーはいません。</div>}
        </div>
      )}

      {/* 選択したユーザーの詳細（画像・パズル・保存ゲーム）。 */}
      {selectedUser && (
        <div className="dev-detail">
          <h2 className="section-title">
            {selectedUser.username}（id {selectedUser.id}）の登録内容
          </h2>
          {detailError ? (
            <div className="error">{detailError}</div>
          ) : detail === null ? (
            <div className="muted">読み込み中…</div>
          ) : (
            <>
              <DetailSection title="画像" count={detail.images.length} empty="登録した画像はありません。">
                {detail.images.map((img) => (
                  <div key={img.id} className="card">
                    <div className="card-thumb"><img src={img.thumb_url} alt="" /></div>
                    <div className="card-name">{img.display_name}</div>
                  </div>
                ))}
              </DetailSection>

              <DetailSection title="パズル" count={detail.puzzles.length} empty="作成したパズルはありません。">
                {detail.puzzles.map((p) => (
                  <div key={p.id} className="card">
                    <div className="card-thumb"><img src={p.thumb_url} alt="" /></div>
                    <div className="card-name">{p.display_name}</div>
                    <div className="muted card-owner">{p.columns} x {p.rows}（{p.columns * p.rows}ピース）</div>
                  </div>
                ))}
              </DetailSection>

              <DetailSection title="保存されたゲーム" count={detail.progress.length} empty="保存されたゲームはありません。">
                {detail.progress.map((item) => {
                  const status = statusFromState(item.state, item.puzzle.columns, item.puzzle.rows)
                  return (
                    <div key={item.id} className="card">
                      <div className="card-thumb"><img src={item.state.snapshot ?? item.puzzle.thumb_url} alt="" /></div>
                      <div className="card-name">{item.puzzle.display_name}</div>
                      <div className="muted card-owner">{item.puzzle.columns} x {item.puzzle.rows}</div>
                      <div className={`status ${status}`}>{STATUS_TEXT[status]}</div>
                      <div className="muted card-owner">{formatTimestamp(item.updated_at)}</div>
                    </div>
                  )
                })}
              </DetailSection>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  )
}

function DetailSection({ title, count, empty, children }: {
  title: string
  count: number
  empty: string
  children: React.ReactNode
}) {
  return (
    <div className="section">
      <h3 className="dev-subtitle">{title}（{count}）</h3>
      {count === 0 ? <div className="muted">{empty}</div> : <div className="card-grid">{children}</div>}
    </div>
  )
}

/** PostgreSQL の timestamptz 文字列（例 "2026-07-25 08:08:14.005+09"）を秒までに整える。 */
function formatTimestamp(ts: string): string {
  return ts.replace('T', ' ').slice(0, 19)
}

/** バイト数を人が読みやすい単位にする。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}
