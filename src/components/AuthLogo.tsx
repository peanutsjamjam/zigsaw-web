// ログイン・新規登録・パスワード再設定の各画面で共通に使う「Zigsaw」ロゴ。
// 選択画面のタイトル（SetupView）と同じジグソーピースの画像を、タイトルの左右に1つずつ置く。
import { SHAPE_IMAGES } from '../lib/shapes'

export function AuthLogo() {
  return (
    <div className="auth-logo">
      <img className="auth-logo-shape" src={SHAPE_IMAGES.PlaceholderShape002} alt="" />
      <span>Zigsaw</span>
      <img className="auth-logo-shape" src={SHAPE_IMAGES.PlaceholderShape004} alt="" />
    </div>
  )
}
