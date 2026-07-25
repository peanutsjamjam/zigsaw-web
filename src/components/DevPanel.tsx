// 開発環境（env.pl の $main::ZIGSAW_ENV = 'development'）でだけ使える機能の受け皿。
// 上部バーのフラスコアイコンから開く。nenpyo のフラスコ相当。
// いまは雛形で、ここに開発用の機能（全ユーザー一覧・テストデータ投入など）を足していく。
import { X } from 'lucide-react'
import type { Account } from '../api'

export function DevPanel({ account, onClose }: { account: Account | null; onClose: () => void }) {
  return (
    <div className="overlay dim" onClick={onClose}>
      <div className="panel dev-panel" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="selection-close" onClick={onClose} aria-label="閉じる" title="閉じる">
          <X size={18} />
        </button>
        <h2>開発メニュー</h2>
        <p className="muted">
          この画面は開発環境（development）でのみ表示されます。開発用の機能をここに追加していきます。
        </p>
        <p className="muted">
          現在のログイン: {account ? `${account.username}（${account.email}）` : '未ログイン'}
        </p>
      </div>
    </div>
  )
}
