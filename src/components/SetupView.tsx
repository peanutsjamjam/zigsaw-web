// パズルを選ぶ・作る画面。3つの欄で構成する。
//   「画像一覧」    … アップロードされた画像。選んでピース数を決め、パズルを作成する（要ログイン）。
//   「パズル一覧」  … 作成済みの共有パズル。誰でもプレイできる（未ログインはこの欄のみ）。
//   「プレイしたパズル」… ログイン中の自分が遊んだパズル（プレイ中／クリア済み）。再開・再挑戦する。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlaskConical, Plus, Trash2, Upload, X } from 'lucide-react'
import { api, type Account, type GalleryImage, type ProgressItem, type Puzzle } from '../api'
import { prepareUpload } from '../lib/generator'
import type { SavedProgress } from '../api'
import { PLACEHOLDER_WALK_FRAMES, SHAPE_IMAGES } from '../lib/shapes'
import { statusFromState, STATUS_TEXT, type PuzzleStatus } from '../lib/status'
import { AccountMenu } from './AccountMenu'

export type StartRequest = {
  puzzle: Puzzle
  /** 続きから始めるなら復元する状態。最初から始めるなら null。 */
  resumeState: SavedProgress | null
}

type Props = {
  account: Account | null
  /** 実行環境が development か。true のときだけ開発用フラスコボタンを出す。 */
  isDev: boolean
  onStart: (req: StartRequest) => void
  /** フラスコボタン: 画面全体を開発用ビューへ切り替える。 */
  onOpenDev: () => void
  onRequestLogin: () => void
  onLoggedOut: () => void
  busy: boolean
}

// 選択中のもの。
//   画像を選ぶと、まず画像情報の修正画面（mode:'edit'）を出し、そこから
//   「この画像でパズルを作成する」で従来のピース数決定画面（mode:'create'）へ進む。
//   パズルを選べばプレイ/再開。
type Selection =
  | { kind: 'image'; image: GalleryImage; mode: 'edit' | 'create' }
  | { kind: 'puzzle'; puzzle: Puzzle }

export function SetupView({ account, isDev, onStart, onOpenDev, onRequestLogin, onLoggedOut, busy }: Props) {
  const [images, setImages] = useState<GalleryImage[]>([])
  const [puzzles, setPuzzles] = useState<Puzzle[]>([])
  const [progress, setProgress] = useState<ProgressItem[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [columns, setColumns] = useState(6)
  const [rows, setRows] = useState(4)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdNotice, setCreatedNotice] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // アップロード確認中の画像（未登録）。null なら確認画面は出ていない。
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [confirmingRemoval, setConfirmingRemoval] = useState<GalleryImage | null>(null)
  // 画像情報修正画面での display_name の編集値と、保存中フラグ・完了通知。
  const [editName, setEditName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [nameSavedNotice, setNameSavedNotice] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [imgs, puz, prog] = await Promise.all([
        account ? api.images() : Promise.resolve([] as GalleryImage[]),
        api.puzzles(),
        account ? api.progress() : Promise.resolve([] as ProgressItem[]),
      ])
      setImages(imgs)
      setPuzzles(puz)
      setProgress(prog)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [account])

  useEffect(() => { void reload() }, [reload])

  // puzzle_id ごとの途中経過（状態バッジ・再開に使う）。
  const progressByPuzzle = useMemo(() => {
    const map = new Map<number, ProgressItem>()
    for (const p of progress) map.set(p.puzzle_id, p)
    return map
  }, [progress])

  // 画像を選んだら、まず画像情報の修正画面（mode:'edit'）を出す。
  const selectImage = (image: GalleryImage) => {
    setSelection({ kind: 'image', image, mode: 'edit' })
    setEditName(image.display_name)
    setColumns(6)
    setRows(4)
    setError(null)
  }
  const selectPuzzle = (puzzle: Puzzle) => setSelection({ kind: 'puzzle', puzzle })

  // ログイン中の自分の画像（または管理者）のみ display_name を変更できる。
  const canEditName = selection?.kind === 'image' && (selection.image.mine || account?.is_admin === true)

  // 「OK」: display_name の変更を反映する。
  const saveImageName = async () => {
    if (selection?.kind !== 'image') return
    const name = editName.trim()
    if (name === '' || name === selection.image.display_name) return
    setSavingName(true)
    setError(null)
    try {
      const updated = await api.updateImage(selection.image.id, name)
      setSelection({ kind: 'image', image: updated, mode: 'edit' })
      await reload()   // 一覧・パズル名（画像名を参照）にも反映する
      setNameSavedNotice(true)
      window.setTimeout(() => setNameSavedNotice(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingName(false)
    }
  }

  // 「この画像でパズルを作成する」: 従来のピース数決定画面（mode:'create'）へ進む。
  const goToCreate = () => {
    if (selection?.kind !== 'image') return
    setSelection({ kind: 'image', image: selection.image, mode: 'create' })
    setError(null)
  }

  // いま選んでいる画像で、すでに作成済みのパズル（ピース数の少ない順）。
  const puzzlesForSelectedImage = useMemo(() => {
    if (selection?.kind !== 'image') return []
    const imageId = selection.image.id
    return puzzles
      .filter((p) => p.image_id === imageId)
      .sort((a, b) => a.columns * a.rows - b.columns * b.rows)
  }, [puzzles, selection])
  // 上のうちピース数の組（"列x行"）の集合。既存の組が選ばれているときは作成を止めるのに使う。
  const existingGridsForSelectedImage = useMemo(
    () => new Set(puzzlesForSelectedImage.map((p) => `${p.columns}x${p.rows}`)),
    [puzzlesForSelectedImage],
  )
  // 選択中のピース数のパズルがすでに存在するか。
  const pieceCountExists = existingGridsForSelectedImage.has(`${columns}x${rows}`)

  // 選択中パズルの途中経過と状態。
  const selectedProgress = selection?.kind === 'puzzle' ? progressByPuzzle.get(selection.puzzle.id) ?? null : null
  const selectedStatus: PuzzleStatus = selection?.kind === 'puzzle'
    ? statusFromState(selectedProgress?.state, selection.puzzle.columns, selection.puzzle.rows)
    : 'notStarted'

  const playSelectedPuzzle = () => {
    if (selection?.kind !== 'puzzle') return
    // プレイ中なら続きから、クリア済み/未プレイなら最初から。
    const resume = selectedStatus === 'inProgress' ? selectedProgress?.state ?? null : null
    onStart({ puzzle: selection.puzzle, resumeState: resume })
  }

  // 「このピース数でパズルを作成」: ゲームは始めず、パズル一覧に追加するだけ。
  // 作成後は一覧を更新し、その新しいパズルを選択状態にして「作成しました」と知らせる。
  const createSelectedImage = async () => {
    if (selection?.kind !== 'image') return
    // 同じ画像・同じピース数のパズルが既にあれば作らない（サーバー側も UNIQUE で束ねるが二重の防御）。
    if (pieceCountExists) return
    setCreating(true)
    setError(null)
    try {
      const puzzle = await api.createPuzzle(selection.image.id, columns, rows)
      await reload()
      setSelection({ kind: 'puzzle', puzzle })
      setCreatedNotice(true)
      window.setTimeout(() => setCreatedNotice(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  // 画像を選んだら、すぐには登録せず確認画面（pending）を出す。名前は編集できる。
  const pickFile = (file: File) => {
    if (pending) URL.revokeObjectURL(pending.url)
    setPending({ file, url: URL.createObjectURL(file) })
    setPendingName(file.name)
    setError(null)
  }
  const cancelUpload = () => {
    if (pending) URL.revokeObjectURL(pending.url)
    setPending(null)
  }
  // 確認画面で「この画像を登録」を押したときに、編集後の名前を display_name として送る。
  const confirmUpload = async () => {
    if (!pending) return
    setUploading(true)
    setError(null)
    try {
      const payload = await prepareUpload(pending.file)
      payload.display_name = pendingName.trim() || pending.file.name
      const image = await api.uploadImage(payload)
      URL.revokeObjectURL(pending.url)
      setPending(null)
      await reload()
      selectImage(image)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  const previewUrl = selection?.kind === 'image' ? selection.image.thumb_url
    : selection?.kind === 'puzzle' ? selection.puzzle.thumb_url
    : undefined

  return (
    <div className="setup">
      {createdNotice && <div className="toast">パズルを作成しました</div>}
      <div className="setup-top">
        <h1 className="setup-title">
          {selection && <img className="title-shape" src={SHAPE_IMAGES.PlaceholderShape002} alt="" />}
          Zigsaw
          {selection && <img className="title-shape" src={SHAPE_IMAGES.PlaceholderShape004} alt="" />}
        </h1>
        <div className="setup-top-right">
          {isDev && (
            <button
              type="button"
              className="icon-btn dev-btn"
              title="開発メニュー（開発環境のみ）"
              aria-label="開発メニュー"
              onClick={onOpenDev}
            >
              <FlaskConical size={18} />
            </button>
          )}
          <AccountMenu account={account} onRequestLogin={onRequestLogin} onLoggedOut={onLoggedOut} />
        </div>
      </div>

      {/* 何かを選んでいるあいだは、プレビュー＋操作ボタンをまとめて枠で囲み、
          右上の × で選択を解除して最初の画面（どの項目も未選択）に戻れるようにする。
          未選択のときは、歩くピースのプレースホルダーだけを枠なしで出す。 */}
      {selection ? (
        <div className="selection-box">
          <button type="button" className="selection-close" onClick={() => setSelection(null)} aria-label="閉じる" title="閉じる">
            <X size={18} />
          </button>

          {/* 画像の修正画面（mode:'edit'）は左に画像・右に情報の2カラム。それ以外は上にプレビュー。 */}
          {!(selection.kind === 'image' && selection.mode === 'edit') && (
            <div className="preview-row">
              {selection.kind === 'puzzle' && selectedStatus === 'inProgress' ? (
                <>
                  <div className="preview-slot">
                    <span className="preview-caption">完成図</span>
                    <PreviewBox url={selection.puzzle.thumb_url} />
                  </div>
                  <div className="preview-slot">
                    <span className="preview-caption">現在の様子</span>
                    <PreviewBox url={selectedProgress?.state.snapshot} />
                  </div>
                </>
              ) : (
                <PreviewBox url={previewUrl} />
              )}
            </div>
          )}

          {/* 画像を選んだとき（mode:'edit'）: 左に画像、右にファイル名・タイトル編集・サイズ・各ボタン。 */}
          {selection.kind === 'image' && selection.mode === 'edit' && (
            <div className="edit-layout">
              <div className="edit-image">
                <img src={selection.image.thumb_url} alt="" />
              </div>
              <div className="edit-fields">
                <div className="edit-item">
                  <span className="edit-label">ファイル名</span>
                  <span className="edit-filename">{selection.image.original_name}</span>
                </div>
                <div className="edit-item">
                  <span className="edit-label">タイトル</span>
                  {canEditName ? (
                    <textarea
                      className="edit-title"
                      value={editName}
                      maxLength={200}
                      rows={2}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  ) : (
                    <span>{selection.image.display_name}</span>
                  )}
                </div>
                <div className="edit-item">
                  <span className="edit-label">画像のサイズ</span>
                  <span>{selection.image.width} x {selection.image.height}</span>
                </div>
                {nameSavedNotice && <div className="muted">変更しました。</div>}
                {error && <div className="error">{error}</div>}
                <div className="row edit-buttons">
                  {canEditName && (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void saveImageName()}
                      disabled={savingName || editName.trim() === '' || editName.trim() === selection.image.display_name}
                    >
                      {savingName ? '保存中…' : 'OK'}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => setSelection(null)} disabled={savingName}>キャンセル</button>
                </div>
                <div className="edit-item">
                  <span className="edit-label">この画像で作成済みのパズル</span>
                  {puzzlesForSelectedImage.length === 0 ? (
                    <span className="muted">まだありません</span>
                  ) : (
                    <div className="grid-chips">
                      {puzzlesForSelectedImage.map((p) => (
                        <span key={p.id} className="grid-chip">{p.columns} x {p.rows}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="row edit-buttons">
                  <button type="button" className="btn primary large" onClick={goToCreate} disabled={savingName}>
                    この画像でパズルを作成する
                  </button>
                </div>
                {/* 作成済みパズルが無く、自分がアップロードした画像のときだけ削除できる
                    （パズルがあると連鎖削除になるため、0個のときに限る）。 */}
                {selection.image.mine && puzzlesForSelectedImage.length === 0 && (
                  <div className="row edit-buttons">
                    <button type="button" className="btn danger" onClick={() => setConfirmingRemoval(selection.image)} disabled={savingName}>
                      <Trash2 size={16} /> この画像を削除する
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 「この画像でパズルを作成する」を押したとき（mode:'create'）: 従来のピース数決定画面。 */}
          {selection.kind === 'image' && selection.mode === 'create' && (
            <div className="selected-info">
              <div className="selected-name">{selection.image.display_name}</div>
              <div className="row steppers">
                <label>列 (横)
                  <input type="number" min={2} max={40} value={columns} onChange={(e) => setColumns(clampGrid(e.target.valueAsNumber))} />
                </label>
                <label>行 (縦)
                  <input type="number" min={2} max={40} value={rows} onChange={(e) => setRows(clampGrid(e.target.valueAsNumber))} />
                </label>
                <span className="muted">{columns * rows}ピース</span>
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn primary large"
                  onClick={() => void createSelectedImage()}
                  disabled={creating || pieceCountExists}
                >
                  {creating ? '作成中…' : 'このピース数でパズルを作成'}
                </button>
              </div>
              {pieceCountExists && <div className="muted">このピース数のパズルはすでに作成されています。</div>}
            </div>
          )}

          {selection.kind === 'puzzle' && (
            <div className="selected-info">
              <div className="selected-name">{selection.puzzle.display_name}</div>
              <div className="muted">
                {selection.puzzle.columns} x {selection.puzzle.rows}（{selection.puzzle.columns * selection.puzzle.rows}ピース）
              </div>
              {selectedStatus !== 'notStarted' && <div className={`status ${selectedStatus}`}>{STATUS_TEXT[selectedStatus]}</div>}
              {!account && <div className="muted">※ ログインすると途中経過を保存できます</div>}
              <div className="row">
                <button type="button" className="btn primary large" onClick={playSelectedPuzzle} disabled={busy}>
                  {busy ? '準備中…'
                    : selectedStatus === 'inProgress' ? 'このパズルを再開する'
                    : selectedStatus === 'completed' ? 'このパズルで再度遊ぶ'
                    : 'このパズルをプレイする'}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="preview-row">
          <PreviewBox url={undefined} />
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {/* 画像一覧（要ログイン） */}
      {account && (
        <Section title="画像一覧" empty={!loading && images.length === 0} emptyText="まだ画像がありません。右のカードから画像をアップロードできます。">
          <div className="card-grid">
            {images.map((image) => (
              <button
                key={image.id}
                type="button"
                className={`card${selection?.kind === 'image' && selection.image.id === image.id ? ' selected' : ''}`}
                onClick={() => selectImage(image)}
              >
                <div className="card-thumb"><img src={image.thumb_url} alt="" /></div>
                <div className="card-name">{image.display_name}</div>
                {image.owner && <div className="muted card-owner">{image.owner}</div>}
              </button>
            ))}
            <UploadCard uploading={uploading} onFile={pickFile} />
          </div>
        </Section>
      )}

      {/* パズル一覧（常に表示） */}
      <Section title="パズル一覧" empty={!loading && puzzles.length === 0}
        emptyText={account ? '「画像一覧」から画像を選び、ピース数を決めてパズルを作成できます。' : 'まだパズルがありません。'}>
        <div className="card-grid">
          {puzzles.map((puzzle) => (
            <button
              key={puzzle.id}
              type="button"
              className={`card${selection?.kind === 'puzzle' && selection.puzzle.id === puzzle.id ? ' selected' : ''}`}
              onClick={() => selectPuzzle(puzzle)}
            >
              <div className="card-thumb"><img src={puzzle.thumb_url} alt="" /></div>
              <div className="card-name">{puzzle.display_name}</div>
              <div className="muted card-owner">{puzzle.columns} x {puzzle.rows}（{puzzle.columns * puzzle.rows}ピース）</div>
              {account && badgeFor(progressByPuzzle.get(puzzle.id), puzzle)}
            </button>
          ))}
        </div>
      </Section>

      {/* プレイしたパズル（要ログイン） */}
      {account && (
        <Section title="プレイしたパズル" empty={!loading && progress.length === 0} emptyText="まだ遊んだパズルがありません。">
          <div className="card-grid">
            {progress.map((item) => {
              const status = statusFromState(item.state, item.puzzle.columns, item.puzzle.rows)
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`card${selection?.kind === 'puzzle' && selection.puzzle.id === item.puzzle_id ? ' selected' : ''}`}
                  onClick={() => selectPuzzle(item.puzzle)}
                >
                  <div className="card-thumb"><img src={item.puzzle.thumb_url} alt="" /></div>
                  <div className="card-name">{item.puzzle.display_name}</div>
                  <div className="muted card-owner">{item.puzzle.columns} x {item.puzzle.rows}（{item.puzzle.columns * item.puzzle.rows}ピース）</div>
                  <div className={`status ${status}`}>{STATUS_TEXT[status]}</div>
                </button>
              )
            })}
          </div>
        </Section>
      )}

      {confirmingRemoval && (
        <div className="overlay dim">
          <div className="panel">
            <h2>この画像を削除しますか？</h2>
            <p className="muted">
              「{confirmingRemoval.display_name}」をギャラリーから削除します。この操作は取り消せません。
            </p>
            <div className="row">
              <button
                type="button" className="btn danger"
                onClick={async () => {
                  await api.deleteImage(confirmingRemoval.id)
                  setSelection(null)
                  setConfirmingRemoval(null)
                  await reload()
                }}
              >
                削除
              </button>
              <button type="button" className="btn" onClick={() => setConfirmingRemoval(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {/* 画像アップロードの確認画面。プレビューを見て、名前（display_name）を編集して登録する。 */}
      {pending && (
        <div className="overlay dim" onClick={uploading ? undefined : cancelUpload}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <h2>この画像を登録しますか？</h2>
            <img className="upload-preview" src={pending.url} alt="" />
            <label className="field">名前（この画像の題名になります）
              <input
                type="text"
                value={pendingName}
                maxLength={200}
                onChange={(e) => setPendingName(e.target.value)}
                autoFocus
              />
            </label>
            {error && <div className="error">{error}</div>}
            <div className="row">
              <button type="button" className="btn primary" onClick={() => void confirmUpload()} disabled={uploading}>
                {uploading ? '登録中…' : 'この画像を登録'}
              </button>
              <button type="button" className="btn" onClick={cancelUpload} disabled={uploading}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, empty, emptyText, children }: {
  title: string
  empty: boolean
  emptyText: string
  children: React.ReactNode
}) {
  return (
    <div className="section">
      <h2 className="section-title">{title}</h2>
      {empty ? <div className="muted">{emptyText}</div> : children}
    </div>
  )
}

/** パズル一覧カードの状態バッジ（プレイ中／クリア済みのときだけ出す）。 */
function badgeFor(item: ProgressItem | undefined, puzzle: Puzzle) {
  const status = statusFromState(item?.state, puzzle.columns, puzzle.rows)
  if (status === 'notStarted') return null
  return <div className={`status ${status}`}>{STATUS_TEXT[status]}</div>
}

/** プレビュー1枠。画像が無いときは破線の枠の中をピースが歩く（mac 版と同じ演出）。 */
function PreviewBox({ url }: { url: string | undefined }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (url) return
    const timer = window.setInterval(() => setTick((t) => t + 1), 500)
    return () => window.clearInterval(timer)
  }, [url])

  if (url) return <img className="preview-box" src={url} alt="" />

  const frame = PLACEHOLDER_WALK_FRAMES[tick % PLACEHOLDER_WALK_FRAMES.length]
  return (
    <div className="preview-box placeholder">
      <img className="walker" src={SHAPE_IMAGES[frame.imageName]} alt="" style={{ transform: `translateX(${frame.offset}px)` }} />
    </div>
  )
}

function UploadCard({ uploading, onFile }: { uploading: boolean; onFile: (file: File) => void }) {
  return (
    <label className="card add-card">
      <div className="card-thumb add-thumb">{uploading ? <Upload size={26} /> : <Plus size={26} />}</div>
      <div className="card-name">画像をアップロード</div>
      <div className="muted">{uploading ? '送信中…' : 'みんなで遊べる画像を追加'}</div>
      <input
        type="file" accept="image/*" hidden disabled={uploading}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }}
      />
    </label>
  )
}

function clampGrid(value: number): number {
  if (!Number.isFinite(value)) return 2
  return Math.min(40, Math.max(2, Math.round(value)))
}
