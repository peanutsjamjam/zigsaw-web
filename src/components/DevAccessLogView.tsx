// 開発環境（env.pl の $main::ZIGSAW_ENV = 'development'）でだけ使える画面。
// 選択画面の2つ目のフラスコアイコンから、画面全体を切り替えて開く。
// access_log のダイジェストとして、IP アドレスごとに最新の1行だけを新しい順で表示する。
// 各 IP には、サーバー側が whois で調べた Organization が付く（キャッシュされる）。
import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { api, type DevAccessLogEntry } from '../api'

export function DevAccessLogView({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<DevAccessLogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.devAccessLog()
      .then(setEntries)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  return (
    <div className="dev-view">
      <div className="dev-view-head">
        <button type="button" className="btn" onClick={onBack}><ArrowLeft size={16} /> 戻る</button>
        <h1>アクセスログ</h1>
        <span className="muted">開発環境専用・IP ごとに最新の1行</span>
      </div>

      {error ? (
        <div className="error">{error}</div>
      ) : entries === null ? (
        <div className="muted">読み込み中…</div>
      ) : (
        <div className="table-wrap">
          <table className="dev-table">
            <thead>
              <tr>
                <th>ip_addr</th><th>Organization</th><th>ユーザー</th><th>accessed_at</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.ip_addr ?? '—'}</td>
                  <td>{e.organization ?? '—'}</td>
                  <td>{e.username ?? <span className="muted">（未ログイン）</span>}</td>
                  <td>{formatTimestamp(e.accessed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && <div className="muted">アクセスログはありません。</div>}
        </div>
      )}
    </div>
  )
}

/** PostgreSQL の timestamptz 文字列（例 "2026-07-25 08:08:14.005+09"）を秒までに整える。 */
function formatTimestamp(ts: string): string {
  return ts.replace('T', ' ').slice(0, 19)
}
