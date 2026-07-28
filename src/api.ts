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
  original_name: string   // アップロード時の元の名前（当初は display_name と同じ）
  tags: string[]          // この画像に付いているタグ名（名前順。未設定なら空配列）
  width: number
  height: number
  owner: string | null   // 投稿者名。管理者が置いた画像は null
  upload_ip: string | null   // アップロード元 IP。不明なら null
  created_at: string     // 投稿日時
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
  mine: boolean            // ログイン中の自分が作成したパズルか
  play_count: number       // このパズルの進行状況の数（＝プレイ中／クリア済みの人数）
  tags: string[]           // もとの画像に付いているタグ（タグでの絞り込みに使う）
  display_name: string     // もとの画像の題名（タイトル）
  original_name: string    // もとの画像のファイル名
  width: number
  height: number
  full_url: string
  thumb_url: string
}

// 開発用の全ユーザー一覧（dev_users が返す。開発環境のみ）。認証情報は含まない。
export type DevUser = {
  id: number
  username: string
  email: string
  is_admin: boolean
  created_at: string
  image_count: number
  image_bytes: number   // その人の画像ファイル（full）の合計バイト数
  puzzle_count: number
  progress_count: number
  last_ip: string | null       // アクセスログ上の最新の送信元 IP。記録が無ければ null
  last_access: string | null   // 最終アクセス日時。記録が無ければ null
}

// 開発用: 指定ユーザーが登録した画像・作成したパズル・保存ゲーム（dev_user_detail が返す）。
export type DevUserDetail = {
  images: GalleryImage[]
  puzzles: Puzzle[]
  progress: ProgressItem[]
}

// 開発用: 画像ディレクトリの使用状況（dev_storage が返す）。
export type DevStorage = {
  image_count: number   // full/ 内のファイル数（＝画像数）
  total_bytes: number   // images ディレクトリ全体（full/thumb/incoming）の合計サイズ
  fs_type: string       // ファイルシステムの種類（例 ext4）
  fs_total: number      // ファイルシステムの総容量（バイト）
  fs_free: number       // ファイルシステムの空き容量（バイト）
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
  too_many_attempts: 'ログインの試行回数が多すぎます。しばらくしてからもう一度お試しください。',
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
  puzzle_in_use: 'このパズルは、すでにプレイしている人がいるため削除できません。',
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

// 一覧の絞り込み（タグ・自分の画像・ピース数の範囲）。サーバー側の SQL で効かせる。
export type ListFilter = {
  tag?: string
  mine?: boolean
  piecesMin?: number
  piecesMax?: number
}

function listQuery(page: number, perPage: number, filter?: ListFilter): string {
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) })
  if (filter?.tag) params.set('tag', filter.tag)
  if (filter?.mine) params.set('mine', '1')
  if (filter?.piecesMin !== undefined) params.set('pieces_min', String(filter.piecesMin))
  if (filter?.piecesMax !== undefined) params.set('pieces_max', String(filter.piecesMax))
  return params.toString()
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
  devStorage: () => request<DevStorage>('?action=dev_storage'),
  devUsers: () => request<{ users: DevUser[] }>('?action=dev_users').then((r) => r.users),
  devUserDetail: (id: number) => request<DevUserDetail>(`?action=dev_user_detail&id=${id}`),
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

  // 一覧はサーバー側でページングする。返り値の total は絞り込み後の総件数。
  images: (page: number, perPage: number, filter?: ListFilter) =>
    request<{ images: GalleryImage[]; total: number }>(`?action=images&${listQuery(page, perPage, filter)}`),
  // 一覧に無い1件（パズル情報画面から元画像へ移るときなど）。
  image: (id: number) => request<{ image: GalleryImage }>(`?action=image&id=${id}`).then((r) => r.image),
  // 使われているタグ名の一覧（絞り込みのタグ一覧に使う）。
  tags: () => request<{ tags: string[] }>('?action=tags').then((r) => r.tags),
  uploadImage: (payload: { display_name: string; original_name: string; ext: string; width: number; height: number; full: string; thumb: string }) =>
    postJson<{ image: GalleryImage }>('?action=image', payload).then((r) => r.image),
  // tags はタグ名の配列。サーバー側で正規化（trim・重複除去・上限）してから保存される。
  updateImage: (id: number, display_name: string, tags: string[]) =>
    request<{ image: GalleryImage }>(`?action=image&id=${id}`, { method: 'PUT', body: JSON.stringify({ display_name, tags }) }).then((r) => r.image),
  deleteImage: (id: number) => request<{ ok: true }>(`?action=image&id=${id}`, { method: 'DELETE' }),

  puzzles: (page: number, perPage: number, filter?: ListFilter) =>
    request<{ puzzles: Puzzle[]; total: number }>(`?action=puzzles&${listQuery(page, perPage, filter)}`),
  // その画像で作成済みのパズル（ページングなしで全件）。
  puzzlesForImage: (imageId: number) =>
    request<{ puzzles: Puzzle[] }>(`?action=puzzles&image_id=${imageId}`).then((r) => r.puzzles),
  createPuzzle: (image_id: number, columns: number, rows: number) =>
    postJson<{ puzzle: Puzzle }>('?action=puzzle', { image_id, columns, rows }).then((r) => r.puzzle),
  deletePuzzle: (id: number) => request<{ ok: true }>(`?action=puzzle&id=${id}`, { method: 'DELETE' }),

  progress: () => request<{ progress: ProgressItem[] }>('?action=progress').then((r) => r.progress),
  // 「現在の様子」スナップショットを1件だけ取得する（一覧は snapshot を含まないため、詳細で使う）。
  progressSnapshot: (id: number) =>
    request<{ snapshot: string | null }>(`?action=progress_snapshot&id=${id}`).then((r) => r.snapshot),
  saveProgress: (puzzle_id: number, state: SavedProgress) =>
    request<{ id: number }>('?action=progress', { method: 'PUT', body: JSON.stringify({ puzzle_id, state }) }),
  deleteProgress: (id: number) => request<{ ok: true }>(`?action=progress&id=${id}`, { method: 'DELETE' }),
}
