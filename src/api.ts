// Zigsaw API クライアント。api.cgi (Perl + PostgreSQL) と通信する。
// Cookie ベースのセッション認証なので credentials は same-origin（既定）。
import type { SavedGameState } from './lib/game'

// api.cgi の場所。index.html からの相対（dev の /~sugawara/zigsaw/ でも本番でも同じ）。
const API = 'api.cgi'

// ログイン中アカウントの基本情報（me / login / signup_complete が返す）。
export type Account = {
  username: string
  email: string
  is_admin: boolean
}

// 画像1枚（images / image が返す）。「画像一覧」で使う。
export type GalleryImage = {
  id: number
  display_name: string
  width: number
  height: number
  owner: string | null   // 投稿者名。管理者が置いた画像は null
  mine: boolean          // ログイン中の自分がアップロードした画像か
  full_url: string       // 遊ぶ用の（縮小済み）画像
  thumb_url: string      // 一覧・完成図プレビュー用サムネイル
}

// 作成済みパズル1つ（puzzles / puzzle が返す）。「パズル一覧」で使う。
// 画像＋グリッド(columns×rows)の組で、皆で共有して遊べる。
export type Puzzle = {
  id: number
  image_id: number
  columns: number
  rows: number
  creator: string | null   // 作成者名。退会済みは null
  display_name: string     // もとの画像の題名
  width: number
  height: number
  full_url: string
  thumb_url: string
}

// 途中経過として保存する状態。ゲーム本体の SavedGameState に、一覧の「現在の様子」に
// 出すためのスナップショット画像（data URL）を足したもの。snapshot はゲーム進行には使わない。
export type SavedProgress = SavedGameState & { snapshot?: string }

// 途中経過1件（progress が返す）。どのパズルの途中かを puzzle 情報つきで持つ。
export type ProgressItem = {
  id: number
  puzzle_id: number
  puzzle: Puzzle
  state: SavedProgress
  updated_at: string
}

// サーバーが返すエラーコードを持つ例外。表示メッセージは message に日本語で入れる。
export class ApiError extends Error {
  code: string
  fields?: string[]
  constructor(code: string, message: string, fields?: string[]) {
    super(message)
    this.code = code
    this.fields = fields
  }
}

// エラーコード -> 日本語メッセージ。未知のコードはコードそのものを出す。
const MESSAGES: Record<string, string> = {
  email_required: 'メールアドレスを入力してください。',
  email_invalid: 'メールアドレスの形式が正しくありません。',
  username_length: 'ユーザー名は1〜50文字で入力してください。',
  password_too_short: 'パスワードは4文字以上にしてください。',
  password_too_long: 'パスワードが長すぎます（128文字まで）。',
  invalid_credentials: 'メールアドレスまたはパスワードが違います。',
  current_password_wrong: '現在のパスワードが違います。',
  signup_token_invalid: 'この登録用リンクは無効か、期限切れです。',
  reset_token_invalid: 'この再設定用リンクは無効か、期限切れです。',
  not_authenticated: 'ログインが必要です。',
  duplicate: 'すでに使われています。',
  image_missing: '画像データがありません。',
  image_too_large: '画像が大きすぎます。',
  image_ext_invalid: '対応していない画像形式です。',
  image_dimensions_invalid: '画像の大きさが不正です。',
  image_write_failed: '画像の保存に失敗しました。',
  grid_invalid: 'ピース数の指定が正しくありません（縦横それぞれ2〜40）。',
  bad_request: 'リクエストが正しくありません。',
  mail_failed: 'メールの送信に失敗しました。時間をおいて試してください。',
  forbidden: 'この操作をする権限がありません。',
  not_found: '見つかりませんでした。',
  db_error: 'サーバーでエラーが発生しました。',
  server_error: 'サーバーでエラーが発生しました。',
}

function messageFor(code: string, fields?: string[]): string {
  if (code === 'duplicate' && fields?.length) {
    const which = fields.map((f) => (f === 'email' ? 'メールアドレス' : 'ユーザー名')).join('・')
    return `${which}はすでに使われています。`
  }
  return MESSAGES[code] ?? code
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  let data: unknown = null
  try { data = await res.json() } catch { /* JSON でない応答は data=null のまま */ }
  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; fields?: string[] }
    const code = body.error ?? `http_${res.status}`
    throw new ApiError(code, messageFor(code, body.fields), body.fields)
  }
  return data as T
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export const api = {
  env: () => request<{ env: string }>('?action=env'),

  me: () => request<Account>('?action=me'),
  login: (email: string, password: string) => postJson<Account>('?action=login', { email, password }),
  logout: () => postJson<{ ok: true }>('?action=logout', {}),

  signupRequest: (email: string) => postJson<{ ok: true }>('?action=signup_request', { email }),
  signupVerify: (token: string) => request<{ email: string }>(`?action=signup_verify&token=${encodeURIComponent(token)}`),
  signupComplete: (token: string, username: string, password: string) =>
    postJson<Account>('?action=signup_complete', { token, username, password }),

  resetRequest: (email: string) => postJson<{ ok: true }>('?action=reset_request', { email }),
  resetVerify: (token: string) => request<{ email: string }>(`?action=reset_verify&token=${encodeURIComponent(token)}`),
  resetComplete: (token: string, password: string) =>
    postJson<Account>('?action=reset_complete', { token, password }),

  changePassword: (current_password: string, new_password: string) =>
    postJson<{ ok: true }>('?action=change_password', { current_password, new_password }),
  deleteAccount: () => request<{ ok: true }>('?action=account', { method: 'DELETE' }),

  images: () => request<{ images: GalleryImage[] }>('?action=images').then((r) => r.images),
  uploadImage: (payload: { display_name: string; ext: string; width: number; height: number; full: string; thumb: string }) =>
    postJson<{ image: GalleryImage }>('?action=image', payload).then((r) => r.image),
  deleteImage: (id: number) => request<{ ok: true }>(`?action=image&id=${id}`, { method: 'DELETE' }),

  puzzles: () => request<{ puzzles: Puzzle[] }>('?action=puzzles').then((r) => r.puzzles),
  createPuzzle: (image_id: number, columns: number, rows: number) =>
    postJson<{ puzzle: Puzzle }>('?action=puzzle', { image_id, columns, rows }).then((r) => r.puzzle),

  progress: () => request<{ progress: ProgressItem[] }>('?action=progress').then((r) => r.progress),
  saveProgress: (puzzle_id: number, state: SavedProgress) =>
    request<{ id: number }>('?action=progress', { method: 'PUT', body: JSON.stringify({ puzzle_id, state }) }),
  deleteProgress: (id: number) => request<{ ok: true }>(`?action=progress&id=${id}`, { method: 'DELETE' }),
}
