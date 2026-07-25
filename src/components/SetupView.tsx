// パズルを選ぶ・作る画面。3つの欄で構成する。
//   「画像一覧」    … アップロードされた画像。選んでピース数を決め、パズルを作成する（要ログイン）。
//   「パズル一覧」  … 作成済みの共有パズル。誰でもプレイできる（未ログインはこの欄のみ）。
//   「プレイしたパズル」… ログイン中の自分が遊んだパズル（プレイ中／クリア済み）。再開・再挑戦する。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Upload, X } from 'lucide-react'
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
  onStart: (req: StartRequest) => void
  onRequestLogin: () => void
  onLoggedOut: () => void
  busy: boolean
}

// 選択中のもの。画像を選べばピース数を決めて作成、パズルを選べばプレイ/再開。
type Selection =
  | { kind: 'image'; image: GalleryImage }
  | { kind: 'puzzle'; puzzle: Puzzle }

export function SetupView({ account, onStart, onRequestLogin, onLoggedOut, busy }: Props) {
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
  const [confirmingRemoval, setConfirmingRemoval] = useState<GalleryImage | null>(null)

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

  const selectImage = (image: GalleryImage) => { setSelection({ kind: 'image', image }); setColumns(6); setRows(4) }
  const selectPuzzle = (puzzle: Puzzle) => setSelection({ kind: 'puzzle', puzzle })

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

  const upload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const image = await api.uploadImage(await prepareUpload(file))
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
        <AccountMenu account={account} onRequestLogin={onRequestLogin} onLoggedOut={onLoggedOut} />
      </div>

      {/* 何かを選んでいるあいだは、プレビュー＋操作ボタンをまとめて枠で囲み、
          右上の × で選択を解除して最初の画面（どの項目も未選択）に戻れるようにする。
          未選択のときは、歩くピースのプレースホルダーだけを枠なしで出す。 */}
      {selection ? (
        <div className="selection-box">
          <button type="button" className="selection-close" onClick={() => setSelection(null)} aria-label="閉じる" title="閉じる">
            <X size={18} />
          </button>

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

          {/* 選択パネル：画像ならピース数＋作成、パズルならプレイ/再開。 */}
          {selection.kind === 'image' && (
            <div className="selected-info">
              <div className="selected-name">{selection.image.display_name}</div>
              {selection.image.owner && <div className="muted">投稿: {selection.image.owner}</div>}
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
                <button type="button" className="btn primary large" onClick={() => void createSelectedImage()} disabled={creating}>
                  {creating ? '作成中…' : 'このピース数でパズルを作成'}
                </button>
                {selection.image.mine && (
                  <button type="button" className="btn large" onClick={() => setConfirmingRemoval(selection.image)} disabled={creating}>
                    <Trash2 size={16} /> 画像を削除
                  </button>
                )}
              </div>
              <div className="muted">作成すると「パズル一覧」に追加されます。</div>
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
            <UploadCard uploading={uploading} onFile={(f) => void upload(f)} />
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
            <h2>「{confirmingRemoval.display_name}」を削除しますか？</h2>
            <p className="muted">この画像と、この画像から作られたパズル・その途中経過もすべて消えます。この操作は取り消せません。</p>
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
