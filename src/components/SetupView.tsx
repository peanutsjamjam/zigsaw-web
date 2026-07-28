// パズルを選ぶ・作る画面。3つの欄で構成する。
//   「画像一覧」    … アップロードされた画像。選んでピース数を決め、パズルを作成する（要ログイン）。
//   「パズル一覧」  … 作成済みの共有パズル。誰でもプレイできる（未ログインはこの欄のみ）。
//   「プレイしたパズル」… ログイン中の自分が遊んだパズル（プレイ中／クリア済み）。再開・再挑戦する。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical, Plus, Trash2, Triangle, Upload, X } from 'lucide-react'
import { api, type Account, type GalleryImage, type ListFilter, type ProgressItem, type Puzzle } from '../api'
import { prepareUpload } from '../lib/generator'
import type { SavedProgress } from '../api'
import { PLACEHOLDER_WALK_FRAMES, SHAPE_IMAGES } from '../lib/shapes'
import { statusFromState, STATUS_TEXT, type PuzzleStatus } from '../lib/status'
import { formatElapsed } from '../lib/format'
import { AccountMenu } from './AccountMenu'

// 画像一覧・パズル一覧の1ページあたりの件数。これを超えるぶんはページを分けて出す。
const LIST_PER_PAGE = 30

// タグの上限（api.cgi の $MAX_TAG_LENGTH / $MAX_TAGS_PER_IMAGE と揃える）。
const MAX_TAG_LENGTH = 30
const MAX_TAGS_PER_IMAGE = 20

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
//   パズルは、パズル一覧から選ぶと編集画面（mode:'edit'。ピース数変更不可＋削除）、
//   プレイしたパズルから選ぶとプレイ画面（mode:'play'。完成図/現在の様子タブ＋再開）。
type Selection =
  | { kind: 'image'; image: GalleryImage; mode: 'edit' | 'create' }
  | { kind: 'puzzle'; puzzle: Puzzle; mode: 'edit' | 'play' }

// 一覧の絞り込み。実際のタグのほかに、タグではない切り口（仮想タグ）でも絞り込める。
//   tag    … その名前のタグが付いた画像／パズル
//   mine   … 自分がアップロードした画像／その画像から作られたパズル
//   pieces … ピース数がその範囲のパズル／そのパズルを持つ画像
type Filter =
  | { kind: 'tag'; name: string }
  | { kind: 'mine' }
  | { kind: 'pieces'; label: string; min: number; max: number | null }

// ピース数の仮想タグ（列×行の合計で分ける）。
const PIECE_RANGES: { label: string; min: number; max: number | null }[] = [
  { label: '〜50ピース',  min: 0,   max: 50 },
  { label: '〜100ピース', min: 51,  max: 100 },
  { label: '〜200ピース', min: 101, max: 200 },
  { label: '〜300ピース', min: 201, max: 300 },
  { label: '〜400ピース', min: 301, max: 400 },
  { label: '401〜ピース', min: 401, max: null },
]

/** 絞り込みを見分けるための文字列（チップの選択状態の比較に使う）。 */
function filterKey(filter: Filter): string {
  return filter.kind === 'tag' ? `tag:${filter.name}` : filter.kind === 'mine' ? 'mine' : `pieces:${filter.label}`
}

/** 見出しに出す絞り込みの名前。 */
function filterLabel(filter: Filter): string {
  return filter.kind === 'tag' ? filter.name : filter.kind === 'mine' ? '自分の画像' : filter.label
}

export function SetupView({ account, isDev, onStart, onOpenDev, onRequestLogin, onLoggedOut, busy }: Props) {
  // images / puzzles は「いま表示しているページのぶんだけ」。総件数は total で持つ。
  const [images, setImages] = useState<GalleryImage[]>([])
  const [imagesTotal, setImagesTotal] = useState(0)
  const [puzzles, setPuzzles] = useState<Puzzle[]>([])
  const [puzzlesTotal, setPuzzlesTotal] = useState(0)
  const [progress, setProgress] = useState<ProgressItem[]>([])
  // 絞り込みに使うタグ名の一覧（サーバーから。一覧のページに依らず全部）。
  const [allTags, setAllTags] = useState<string[]>([])
  // 選択中の画像で作成済みのパズル（一覧のページに関係なく、その画像ぶんを取得する）。
  const [puzzlesForSelectedImage, setPuzzlesForSelectedImage] = useState<Puzzle[]>([])
  // 一覧を取り直すたびに増やす印。これが変わったら上のパズルも引き直す
  // （絞り込み中はパズルを作っても総数が動かないことがあるため、総数では足りない）。
  const [listVersion, setListVersion] = useState(0)
  // 選択中パズルの元画像（画像一覧の今のページに無くても引けるよう、id で取得する）。
  const [imageForSelectedPuzzle, setImageForSelectedPuzzle] = useState<GalleryImage | null>(null)
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
  const [confirmingPuzzleRemoval, setConfirmingPuzzleRemoval] = useState<Puzzle | null>(null)
  const [confirmingProgressRemoval, setConfirmingProgressRemoval] = useState<ProgressItem | null>(null)
  // 画像情報修正画面での display_name・tags の編集値と、保存中フラグ・完了通知。
  // タイトルは普段ただの文字列で、クリックしたときだけ入力欄になる（editingTitle）。
  const [editName, setEditName] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  // Enter の直後に blur が走っても二重に保存しないための印（state だと同じ tick では古い値を見る）。
  const committingTitleRef = useRef(false)
  // タグの入力欄。Enter で1つのタグとして保存し、そのつど空に戻す（保存済みタグはチップで出す）。
  const [editTags, setEditTags] = useState('')
  // 入力欄は普段出さない。タグの並びの末尾の「＋」を押したときだけ出す。
  const [addingTag, setAddingTag] = useState(false)
  const [savingTags, setSavingTags] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [nameSavedNotice, setNameSavedNotice] = useState(false)
  // 一覧の絞り込み。null なら絞り込まない（「すべて」）。
  const [filter, setFilter] = useState<Filter | null>(null)
  // 画像一覧・パズル一覧のページ（1始まり）。
  const [imagePage, setImagePage] = useState(1)
  const [puzzlePage, setPuzzlePage] = useState(1)
  // 上段（タイトル下の詳細・プレビュー）を畳んでいるか。畳むと区切り線がタイトルのすぐ下に来る。
  const [headCollapsed, setHeadCollapsed] = useState(false)
  // プレイ中パズルの画像エリアのタブ（完成図 / 現在の様子）。既定は「現在の様子」。
  const [puzzleTab, setPuzzleTab] = useState<'finished' | 'current'>('current')
  // 「現在の様子」スナップショットは一覧に含まれないので、詳細を開いたとき progress id ごとに
  // 個別取得してここにキャッシュする。値 undefined=未取得, null=保存なし, string=data URL。
  const [snapshotById, setSnapshotById] = useState<Record<number, string | null>>({})

  // 絞り込みを、サーバーに渡す形（クエリパラメータのもと）に直す。
  const listFilter = useMemo<ListFilter | undefined>(() => {
    if (filter === null) return undefined
    if (filter.kind === 'tag') return { tag: filter.name }
    if (filter.kind === 'mine') return { mine: true }
    return { piecesMin: filter.min, ...(filter.max === null ? {} : { piecesMax: filter.max }) }
  }, [filter])

  // 一覧（画像・パズル）。ページと絞り込みが変わるたびに、そのページぶんだけ取り直す。
  const loadLists = useCallback(async () => {
    setLoading(true)
    try {
      const [imgs, puz] = await Promise.all([
        account
          ? api.images(imagePage, LIST_PER_PAGE, listFilter)
          : Promise.resolve({ images: [] as GalleryImage[], total: 0 }),
        api.puzzles(puzzlePage, LIST_PER_PAGE, listFilter),
      ])
      setImages(imgs.images)
      setImagesTotal(imgs.total)
      setPuzzles(puz.puzzles)
      setPuzzlesTotal(puz.total)
      setListVersion((v) => v + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [account, imagePage, puzzlePage, listFilter])

  // ページに依らないもの（タグ一覧と自分の途中経過）。
  const loadMeta = useCallback(async () => {
    try {
      const [tags, prog] = await Promise.all([
        api.tags(),
        account ? api.progress() : Promise.resolve([] as ProgressItem[]),
      ])
      setAllTags(tags)
      setProgress(prog)
      setSnapshotById({})   // progress を読み直したら snapshot キャッシュは破棄する
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [account])

  // 何かを作った・消したあとに、全部まとめて取り直す。
  const reload = useCallback(async () => {
    await Promise.all([loadLists(), loadMeta()])
  }, [loadLists, loadMeta])

  useEffect(() => { void loadLists() }, [loadLists])
  useEffect(() => { void loadMeta() }, [loadMeta])

  // 何かを選んだら（＝上段に詳細が出るとき）、畳んでいても開く。
  useEffect(() => { if (selection) setHeadCollapsed(false) }, [selection])

  // puzzle_id ごとの途中経過（状態バッジ・再開に使う）。
  const progressByPuzzle = useMemo(() => {
    const map = new Map<number, ProgressItem>()
    for (const p of progress) map.set(p.puzzle_id, p)
    return map
  }, [progress])

  // 仮想タグの並び。「自分の画像」はログイン中だけ出す。
  const virtualFilters = useMemo<Filter[]>(
    () => [
      ...(account ? [{ kind: 'mine' } as const] : []),
      ...PIECE_RANGES.map((r) => ({ kind: 'pieces' as const, ...r })),
    ],
    [account],
  )

  // 絞り込み（タグ・仮想タグ）はサーバー側の SQL で行うので、ここでは絞り込まない。
  // 「プレイしたパズル」は絞り込みの対象外で、常に自分のぶんを全部出す。

  // プレースホルダーのスライドショーに映せる画像（サムネ）。未ログインだと画像一覧は
  // 取れないので、パズル側の画像も合わせて拾う（同じ画像は1つにまとめる）。
  const previewPhotos = useMemo(() => {
    const byImage = new Map<number, string>()
    for (const image of images) byImage.set(image.id, image.thumb_url)
    for (const puzzle of puzzles) if (!byImage.has(puzzle.image_id)) byImage.set(puzzle.image_id, puzzle.thumb_url)
    return [...byImage.values()]
  }, [images, puzzles])

  // ページ数はサーバーが返す総件数から出す。絞り込みを変えたら1ページ目に戻し、
  // 件数が減ってページ数を超えたら最後のページに寄せる。
  const imagePageCount = Math.max(1, Math.ceil(imagesTotal / LIST_PER_PAGE))
  const puzzlePageCount = Math.max(1, Math.ceil(puzzlesTotal / LIST_PER_PAGE))
  useEffect(() => { setImagePage(1); setPuzzlePage(1) }, [filter])
  useEffect(() => {
    setImagePage((cur) => Math.min(cur, imagePageCount))
  }, [imagePageCount])
  useEffect(() => {
    setPuzzlePage((cur) => Math.min(cur, puzzlePageCount))
  }, [puzzlePageCount])

  // 画像を選んだら、まず画像情報の修正画面（mode:'edit'）を出す。
  const selectImage = (image: GalleryImage) => {
    setSelection({ kind: 'image', image, mode: 'edit' })
    setEditName(image.display_name)
    setEditingTitle(false)
    setEditTags('')
    setAddingTag(false)
    setColumns(6)
    setRows(4)
    setError(null)
  }
  // パズル一覧から選ぶと編集画面、プレイしたパズルから選ぶとプレイ画面。
  const selectPuzzleForEdit = (puzzle: Puzzle) => { setSelection({ kind: 'puzzle', puzzle, mode: 'edit' }); setError(null) }
  const selectPuzzleForPlay = (puzzle: Puzzle) => { setSelection({ kind: 'puzzle', puzzle, mode: 'play' }); setPuzzleTab('current') }

  // ログイン中の自分の画像（または管理者）のみ display_name・tags を変更できる。
  const canEditName = selection?.kind === 'image' && (selection.image.mine || account?.is_admin === true)
  // タイトルは普段ただの文字列で、クリックすると入力欄になる（Enter で変更、Esc で取りやめ）。
  const startEditingTitle = () => {
    if (!canEditName || selection?.kind !== 'image' || savingName) return
    setEditName(selection.image.display_name)
    setEditingTitle(true)
    setError(null)
  }
  const cancelEditingTitle = () => {
    setEditingTitle(false)
    if (selection?.kind === 'image') setEditName(selection.image.display_name)
  }

  // タイトルの編集を確定する。空・変更なしなら何も送らず、ただ表示に戻す。
  const commitTitle = async () => {
    if (selection?.kind !== 'image' || !editingTitle || committingTitleRef.current) return
    committingTitleRef.current = true
    const name = editName.trim()
    setEditingTitle(false)
    if (name === '' || name === selection.image.display_name) {
      setEditName(selection.image.display_name)
      committingTitleRef.current = false
      return
    }
    setSavingName(true)
    setError(null)
    try {
      const updated = await api.updateImage(selection.image.id, name, selection.image.tags)
      setSelection({ kind: 'image', image: updated, mode: 'edit' })
      setEditName(updated.display_name)
      await reload()   // 一覧・パズル名（画像名を参照）にも反映する
      setNameSavedNotice(true)
      window.setTimeout(() => setNameSavedNotice(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingName(false)
      committingTitleRef.current = false
    }
  }

  // タグを保存する（追加・削除のどちらも、置き換え後の一覧をそのまま送る）。
  // タイトルは保存済みの値を送るので、編集中のタイトルを巻き込まない。
  const saveTags = async (image: GalleryImage, tags: string[]) => {
    setSavingTags(true)
    setError(null)
    try {
      const updated = await api.updateImage(image.id, image.display_name, tags)
      setSelection({ kind: 'image', image: updated, mode: 'edit' })
      // 一覧の該当画像も差し替える（一覧ぜんぶを読み直すほどの変更ではない）。
      setImages((prev) => prev.map((i) => (i.id === updated.id ? updated : i)))
      void loadMeta()   // タグ一覧に新しい名前が増える／使われなくなることがある
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingTags(false)
    }
  }

  // 入力欄の文字列を1つのタグとして追加する（Enter）。追加できたら入力欄は空に戻す。
  const addTag = async () => {
    if (selection?.kind !== 'image' || savingTags) return
    const name = normalizeTagName(editTags)
    if (name === '') { setEditTags(''); return }
    const tags = selection.image.tags
    if (tags.includes(name)) { setEditTags(''); return }   // すでに付いている
    if (tags.length >= MAX_TAGS_PER_IMAGE) {
      setError(`タグは1枚につき${MAX_TAGS_PER_IMAGE}個までです。`)
      return
    }
    setEditTags('')
    await saveTags(selection.image, [...tags, name])
  }

  // チップの × を押したとき: そのタグをこの画像から外す。
  const removeTag = async (name: string) => {
    if (selection?.kind !== 'image' || savingTags) return
    await saveTags(selection.image, selection.image.tags.filter((t) => t !== name))
  }

  // 「この画像でパズルを作成する」: 従来のピース数決定画面（mode:'create'）へ進む。
  const goToCreate = () => {
    if (selection?.kind !== 'image') return
    setSelection({ kind: 'image', image: selection.image, mode: 'create' })
    setError(null)
  }

  // いま選んでいる画像で、すでに作成済みのパズル（ピース数の少ない順）。
  // 一覧はページ分けされていて全部は手元に無いので、その画像ぶんを個別に取得する。
  const selectedImageId = selection?.kind === 'image' ? selection.image.id : null
  useEffect(() => {
    if (selectedImageId === null) { setPuzzlesForSelectedImage([]); return }
    let cancelled = false
    api.puzzlesForImage(selectedImageId)
      .then((list) => {
        if (cancelled) return
        setPuzzlesForSelectedImage([...list].sort((a, b) => a.columns * a.rows - b.columns * b.rows))
      })
      .catch(() => { if (!cancelled) setPuzzlesForSelectedImage([]) })
    return () => { cancelled = true }
  }, [selectedImageId, listVersion])   // 一覧を取り直したら、この画像のパズルも引き直す
  // 上のうちピース数の組（"列x行"）の集合。既存の組が選ばれているときは作成を止めるのに使う。
  const existingGridsForSelectedImage = useMemo(
    () => new Set(puzzlesForSelectedImage.map((p) => `${p.columns}x${p.rows}`)),
    [puzzlesForSelectedImage],
  )
  // 選択中のピース数のパズルがすでに存在するか。
  const pieceCountExists = existingGridsForSelectedImage.has(`${columns}x${rows}`)

  // 選択中パズルの元画像。一覧の今のページに無いこともあるので id で引く
  // （画像情報画面はログイン中だけなので、未ログインなら引かない）。
  const selectedPuzzleImageId = selection?.kind === 'puzzle' && account ? selection.puzzle.image_id : null
  useEffect(() => {
    if (selectedPuzzleImageId === null) { setImageForSelectedPuzzle(null); return }
    let cancelled = false
    api.image(selectedPuzzleImageId)
      .then((image) => { if (!cancelled) setImageForSelectedPuzzle(image) })
      .catch(() => { if (!cancelled) setImageForSelectedPuzzle(null) })
    return () => { cancelled = true }
  }, [selectedPuzzleImageId])

  // 選択中パズルの途中経過と状態。
  const selectedProgress = selection?.kind === 'puzzle' ? progressByPuzzle.get(selection.puzzle.id) ?? null : null
  const selectedStatus: PuzzleStatus = selection?.kind === 'puzzle'
    ? statusFromState(selectedProgress?.state, selection.puzzle.columns, selection.puzzle.rows)
    : 'notStarted'

  // 「現在の様子」タブを表示していて、まだ snapshot を取得していなければ個別に取得する。
  const currentSnapshotId =
    selection?.kind === 'puzzle' && selection.mode === 'play'
    && puzzleTab === 'current' && selectedStatus === 'inProgress' && selectedProgress
      ? selectedProgress.id : null
  useEffect(() => {
    if (currentSnapshotId == null || snapshotById[currentSnapshotId] !== undefined) return
    let cancelled = false
    api.progressSnapshot(currentSnapshotId)
      .then((snap) => { if (!cancelled) setSnapshotById((m) => ({ ...m, [currentSnapshotId]: snap })) })
      .catch(() => { if (!cancelled) setSnapshotById((m) => ({ ...m, [currentSnapshotId]: null })) })
    return () => { cancelled = true }
  }, [currentSnapshotId, snapshotById])

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
      setSelection({ kind: 'puzzle', puzzle, mode: 'edit' })
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
  // 確認画面で「この画像を登録」を押したとき。ファイル名は original_name（変更不可）、
  // 編集した「タイトル」は display_name として送る。
  const confirmUpload = async () => {
    if (!pending) return
    setUploading(true)
    setError(null)
    try {
      const prepared = await prepareUpload(pending.file)
      const image = await api.uploadImage({
        ...prepared,
        original_name: pending.file.name,
        display_name: pendingName.trim() || pending.file.name,
      })
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

  return (
    <div className="setup">
      {createdNotice && <div className="toast">パズルを作成しました</div>}

      {/* 上段: タイトル＋選択中の詳細（常に見える。スクロールしない）。 */}
      <div className={`setup-head${headCollapsed ? ' collapsed' : ''}`}>
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
      {!headCollapsed && (selection ? (
        <div className="selection-box">
          <button type="button" className="selection-close" onClick={() => setSelection(null)} aria-label="閉じる" title="閉じる">
            <X size={18} />
          </button>
          {/* 画面名（カード左上に小さく）。画像一覧から開いた画像情報編集画面のときだけ出す。 */}
          {selection.kind === 'image' && selection.mode === 'edit' && (
            <div className="selection-name">画像情報</div>
          )}
          {/* パズル一覧から開いたパズル情報編集画面のとき。
              左の「＜」で、そのパズルの元画像の画像情報画面へ戻れる。 */}
          {selection.kind === 'puzzle' && selection.mode === 'edit' && (
            <div className="selection-name">
              {imageForSelectedPuzzle && (
                <button
                  type="button"
                  className="selection-back"
                  onClick={() => selectImage(imageForSelectedPuzzle)}
                  title="この画像の画像情報へ"
                  aria-label="この画像の画像情報へ"
                >
                  ＜
                </button>
              )}
              パズル情報
            </div>
          )}
          {/* 画像からピース数を決めるパズル作成画面のとき。
              左の「＜」で、その画像の画像情報画面へ戻れる。 */}
          {selection.kind === 'image' && selection.mode === 'create' && (
            <div className="selection-name">
              <button
                type="button"
                className="selection-back"
                onClick={() => selectImage(selection.image)}
                title="この画像の画像情報へ"
                aria-label="この画像の画像情報へ"
              >
                ＜
              </button>
              パズル作成
            </div>
          )}
          {/* プレイしたパズルから開いた進捗情報画面のとき。 */}
          {selection.kind === 'puzzle' && selection.mode === 'play' && (
            <div className="selection-name">進捗情報</div>
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
                  {!canEditName ? (
                    <span>{selection.image.display_name}</span>
                  ) : editingTitle ? (
                    // 編集中。Enter で変更、Esc で取りやめ、他をクリックしても（＝blur）変更する。
                    <textarea
                      className="edit-title"
                      value={editName}
                      maxLength={200}
                      rows={2}
                      autoFocus
                      onFocus={(e) => e.currentTarget.setSelectionRange(editName.length, editName.length)}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => void commitTitle()}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.preventDefault(); cancelEditingTitle(); return }
                        // 日本語入力の変換確定 Enter は拾わない。
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                        e.preventDefault()
                        void commitTitle()
                      }}
                    />
                  ) : (
                    // 普段はただの文字列。クリックすると編集できる。
                    <span
                      className="edit-title-text"
                      role="button"
                      tabIndex={0}
                      title="クリックして変更"
                      onClick={startEditingTitle}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); startEditingTitle() } }}
                    >
                      {savingName ? '保存中…' : selection.image.display_name}
                    </span>
                  )}
                </div>
                <div className="edit-item">
                  <span className="edit-label">画像のサイズ</span>
                  <span>{selection.image.width} x {selection.image.height}</span>
                </div>
                <div className="edit-item">
                  <span className="edit-label">投稿者（投稿元）</span>
                  <span>
                    {selection.image.owner ?? '（管理者設置）'}
                    {selection.image.upload_ip && `（${selection.image.upload_ip}）`}
                  </span>
                </div>
                <div className="edit-item">
                  <span className="edit-label">投稿日時</span>
                  <span>{formatTimestamp(selection.image.created_at)}</span>
                </div>
                {/* タグ。タイトルと同じ textarea に、区切って並べて入力する。 */}
                <div className="edit-item">
                  <span className="edit-label">タグ</span>
                  {canEditName ? (
                    <>
                      {/* いまこの画像に実際に付いている（保存済みの）タグ。× で1つずつ外せる。
                          末尾の「＋」を押すと入力欄が出る。 */}
                      <div className="grid-chips">
                        {selection.image.tags.map((t) => (
                          <span key={t} className="grid-chip tag-chip">
                            {t}
                            <button
                              type="button"
                              className="tag-remove"
                              onClick={() => void removeTag(t)}
                              disabled={savingTags}
                              title="このタグを外す"
                              aria-label={`タグ「${t}」を外す`}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                        {!addingTag && (
                          <button
                            type="button"
                            className="grid-chip chip-add"
                            onClick={() => { setEditTags(''); setAddingTag(true) }}
                            title="タグを追加"
                            aria-label="タグを追加"
                          >
                            +
                          </button>
                        )}
                      </div>
                      {/* 入力して Enter で1つのタグとして付ける（入力欄は空に戻り、続けて入力できる）。
                          Esc か、他をクリックして外れたときは入力欄を閉じる。 */}
                      {addingTag && (
                        <textarea
                          className="edit-title"
                          value={editTags}
                          maxLength={MAX_TAG_LENGTH}
                          rows={2}
                          autoFocus
                          placeholder="タグ名を入力して Enter"
                          onChange={(e) => setEditTags(e.target.value)}
                          onBlur={() => { setAddingTag(false); setEditTags('') }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              setAddingTag(false)
                              setEditTags('')
                              return
                            }
                            // 日本語入力の変換確定 Enter は拾わない。
                            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                            e.preventDefault()
                            void addTag()
                          }}
                        />
                      )}
                    </>
                  ) : selection.image.tags.length > 0 ? (
                    <div className="grid-chips">
                      {selection.image.tags.map((t) => <span key={t} className="grid-chip">{t}</span>)}
                    </div>
                  ) : null}
                </div>
                {nameSavedNotice && <div className="muted">変更しました。</div>}
                {error && <div className="error">{error}</div>}
                <div className="edit-item">
                  <span className="edit-label">この画像で作成済みのパズル</span>
                  {/* 末尾の「＋」でパズル作成画面へ進む。 */}
                  <div className="grid-chips">
                    {puzzlesForSelectedImage.length === 0 && <span className="muted">まだありません</span>}
                    {/* 押すと、そのパズルの情報画面（パズル一覧から開いたのと同じ画面）へ移る。 */}
                    {puzzlesForSelectedImage.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="grid-chip chip-link"
                        onClick={() => selectPuzzleForEdit(p)}
                        title={`${p.columns} x ${p.rows} のパズル情報へ`}
                      >
                        {p.columns} x {p.rows}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="grid-chip chip-add"
                      onClick={goToCreate}
                      disabled={savingName}
                      title="この画像でパズルを作成する"
                      aria-label="この画像でパズルを作成する"
                    >
                      +
                    </button>
                  </div>
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

          {/* 「この画像でパズルを作成する」を押したとき（mode:'create'）: 左に画像・右にピース数決定。 */}
          {selection.kind === 'image' && selection.mode === 'create' && (
            <div className="edit-layout">
              {/* 画像の上に、選んだ列×行のぶんだけ分割線を重ねて、どう切り分けられるかを示す。 */}
              <div
                className="piece-grid"
                style={{
                  width: `min(640px, calc(60vh * ${selection.image.width} / ${selection.image.height}))`,
                  aspectRatio: `${selection.image.width} / ${selection.image.height}`,
                }}
              >
                <img src={selection.image.thumb_url} alt="" />
                <div
                  className="piece-grid-lines"
                  style={{ backgroundSize: `calc(100% / ${columns}) calc(100% / ${rows})` }}
                />
              </div>
              <div className="edit-fields">
                <div className="edit-item">
                  <span className="edit-label">ファイル名</span>
                  <span className="edit-filename">{selection.image.original_name}</span>
                </div>
                <div className="edit-item">
                  <span className="edit-label">タイトル</span>
                  <span>{selection.image.display_name}</span>
                </div>
                <div className="edit-item">
                  <span className="edit-label">画像のサイズ</span>
                  <span>{selection.image.width} x {selection.image.height}</span>
                </div>
                <div className="edit-item">
                  <span className="edit-label">この画像で作成済みのパズル</span>
                  {puzzlesForSelectedImage.length === 0 ? (
                    <span className="muted">まだありません</span>
                  ) : (
                    <div className="grid-chips">
                      {puzzlesForSelectedImage.map((p) => (
                        <span
                          key={p.id}
                          className={`grid-chip${p.columns === columns && p.rows === rows ? ' current' : ''}`}
                        >
                          {p.columns} x {p.rows}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="row steppers">
                  <label>列 (横)
                    <input type="number" min={2} max={40} value={columns} onChange={(e) => setColumns(clampGrid(e.target.valueAsNumber))} />
                  </label>
                  <label>行 (縦)
                    <input type="number" min={2} max={40} value={rows} onChange={(e) => setRows(clampGrid(e.target.valueAsNumber))} />
                  </label>
                  <span className="muted">{columns * rows}ピース</span>
                </div>
                <div className="row edit-buttons">
                  <button
                    type="button"
                    className="btn primary large"
                    onClick={() => void createSelectedImage()}
                    disabled={creating || pieceCountExists}
                  >
                    {creating ? '作成中…' : 'このピース数でパズルを作成'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* プレイしたパズルから選んだとき（mode:'play'）: 左に画像（プレイ中は完成図／現在の様子の
              タブ切替）、右に情報＋再開ボタン。 */}
          {selection.kind === 'puzzle' && selection.mode === 'play' && (() => {
            // プレイ中なら（スナップショット画像の有無に関わらず）必ずタブを出す。
            const showTabs = selectedStatus === 'inProgress'
            // snapshot は一覧に含まれないので、詳細で個別取得したキャッシュを見る。
            // undefined=取得中, null=保存なし, string=data URL。
            const snap = selectedProgress ? snapshotById[selectedProgress.id] : undefined
            const showCurrent = showTabs && puzzleTab === 'current'
            return (
              <div className="edit-layout">
                <div className={`puzzle-image${showTabs ? ' has-tabs' : ''}`}>
                  {showTabs && (
                    <div className="image-tabs">
                      <button type="button" className={puzzleTab === 'finished' ? 'active' : ''} onClick={() => setPuzzleTab('finished')}>完成図</button>
                      <button type="button" className={puzzleTab === 'current' ? 'active' : ''} onClick={() => setPuzzleTab('current')}>現在の様子</button>
                    </div>
                  )}
                  <div className="edit-image">
                    {showCurrent
                      ? (snap === undefined
                          ? <div className="no-snapshot muted">読み込み中…</div>
                          : snap
                            ? <img src={snap} alt="" />
                            : <div className="no-snapshot muted">現在の様子はまだ保存されていません</div>)
                      : <img src={selection.puzzle.thumb_url} alt="" />}
                  </div>
                </div>
                <div className="edit-fields">
                  <div className="edit-item">
                    <span className="edit-label">ファイル名</span>
                    <span className="edit-filename">{selection.puzzle.original_name}</span>
                  </div>
                  <div className="edit-item">
                    <span className="edit-label">タイトル</span>
                    <span>{selection.puzzle.display_name}</span>
                  </div>
                  <div className="edit-item">
                    <span className="edit-label">画像のサイズ</span>
                    <span>{selection.puzzle.width} x {selection.puzzle.height}</span>
                  </div>
                  <div className="edit-item">
                    <span className="edit-label">ピース数</span>
                    <span>{selection.puzzle.columns} x {selection.puzzle.rows}（{selection.puzzle.columns * selection.puzzle.rows}ピース）</span>
                  </div>
                  {selectedStatus !== 'notStarted' && (
                    <div className={`status ${selectedStatus}`}>
                      {STATUS_TEXT[selectedStatus]}
                      {/* クリア済み＝クリア時間、プレイ中＝保存時点までの累積プレイ時間。 */}
                      {selectedProgress && ` (${formatElapsed(selectedProgress.state.elapsedSeconds ?? 0)})`}
                    </div>
                  )}
                  {!account && <div className="muted">※ ログインすると途中経過を保存できます</div>}
                  <div className="row edit-buttons">
                    <button type="button" className="btn primary large" onClick={playSelectedPuzzle} disabled={busy}>
                      {busy ? '準備中…'
                        : selectedStatus === 'inProgress' ? 'このパズルを再開する'
                        : selectedStatus === 'completed' ? 'このパズルで再度遊ぶ'
                        : 'このパズルをプレイする'}
                    </button>
                  </div>
                  {selectedProgress && (
                    <div className="row edit-buttons">
                      <button type="button" className="btn danger" onClick={() => setConfirmingProgressRemoval(selectedProgress)} disabled={busy}>
                        <Trash2 size={16} /> {selectedStatus === 'completed' ? 'クリア記録を削除する' : 'この記録を削除する'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

          {/* パズル一覧から選んだとき（mode:'edit'）: 作成画面と同様（画像＋分割線＋情報）だが、
              ピース数は変更不可・作成ボタン無し。プレイと削除のボタンを置く。 */}
          {selection.kind === 'puzzle' && selection.mode === 'edit' && (() => {
            const p = selection.puzzle
            const canDelete = p.mine || account?.is_admin === true
            const inUse = p.play_count > 0
            return (
              <div className="edit-layout">
                <div
                  className="piece-grid"
                  style={{
                    width: `min(640px, calc(60vh * ${p.width} / ${p.height}))`,
                    aspectRatio: `${p.width} / ${p.height}`,
                  }}
                >
                  <img src={p.thumb_url} alt="" />
                  <div className="piece-grid-lines" style={{ backgroundSize: `calc(100% / ${p.columns}) calc(100% / ${p.rows})` }} />
                </div>
                <div className="edit-fields">
                  <div className="edit-item">
                    <span className="edit-label">ファイル名</span>
                    <span className="edit-filename">{p.original_name}</span>
                  </div>
                  <div className="edit-item">
                    <span className="edit-label">タイトル</span>
                    <span>{p.display_name}</span>
                  </div>
                  <div className="edit-item">
                    <span className="edit-label">画像のサイズ</span>
                    <span>{p.width} x {p.height}</span>
                  </div>
                  <div className="edit-item">
                    <span className="edit-label">ピース数</span>
                    <span>{p.columns} x {p.rows}（{p.columns * p.rows}ピース）</span>
                  </div>
                  {selectedStatus !== 'notStarted' && <div className={`status ${selectedStatus}`}>{STATUS_TEXT[selectedStatus]}</div>}
                  <div className="row edit-buttons">
                    <button type="button" className="btn primary large" onClick={playSelectedPuzzle} disabled={busy}>
                      {busy ? '準備中…'
                        : selectedStatus === 'inProgress' ? 'このパズルを再開する'
                        : selectedStatus === 'completed' ? 'このパズルで再度遊ぶ'
                        : 'このパズルをプレイする'}
                    </button>
                  </div>
                  {canDelete && (
                    <div className="row edit-buttons">
                      {/* 非活性の理由は下の文ではなく、ボタン上のツールチップで示す。無効ボタンは
                          自身が hover を拾わないので、title はラッパー span に付ける。 */}
                      <span style={{ display: 'inline-flex' }} title={inUse ? 'すでにプレイしている人がいるため削除できません。' : undefined}>
                        <button type="button" className="btn danger" onClick={() => setConfirmingPuzzleRemoval(p)} disabled={busy || inUse}>
                          <Trash2 size={16} /> このパズルを削除する
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}
        </div>
      ) : (
        <div className="preview-row">
          <PreviewBox url={undefined} photos={previewPhotos} />
        </div>
      ))}

      {/* 上段を畳むボタン。区切り線のすぐ上・右端に置く。 */}
      {!headCollapsed && (
        <button
          type="button"
          className="icon-btn head-toggle"
          onClick={() => setHeadCollapsed(true)}
          title="上の領域を畳む"
          aria-label="上の領域を畳む"
          aria-expanded={true}
        >
          <Triangle size={14} fill="currentColor" />
        </button>
      )}
      </div>

      {/* 下段: 各一覧。ここだけを縦スクロールさせ、上段の詳細が常に見えるようにする。 */}
      <div className={`setup-lists${headCollapsed ? ' collapsed' : ''}`}>
      {/* 畳んでいるときの戻すボタン。区切り線のすぐ下・右端に置く。 */}
      {headCollapsed && (
        <button
          type="button"
          className="icon-btn head-toggle lists-toggle"
          onClick={() => setHeadCollapsed(false)}
          title="上の領域を開く"
          aria-label="上の領域を開く"
          aria-expanded={false}
        >
          <Triangle size={14} fill="currentColor" className="flip" />
        </button>
      )}
      {error && <div className="error">{error}</div>}

      {/* タグ一覧。押すと、そのタグが付いた画像と、その画像から作られたパズルだけを出す。
          もう一度押すか「すべて」で絞り込みを解除する（「プレイしたパズル」は絞り込まない）。 */}
      <Section title="タグ一覧" empty={false} emptyText="">
        <div className="tag-filters">
          <button
            type="button"
            className={`tag-filter${filter === null ? ' selected' : ''}`}
            onClick={() => setFilter(null)}
          >
            すべて
          </button>
          {/* 仮想タグ（実際のタグではない切り口）。破線の枠で見分けられるようにする。 */}
          {virtualFilters.map((f) => (
            <FilterChip key={filterKey(f)} filter={f} current={filter} onSelect={setFilter} virtual />
          ))}
          {/* 仮想タグと実タグのあいだで行を分ける（flex の折り返しを強制する空要素）。 */}
          {allTags.length > 0 && <div className="tag-filters-break" />}
          {allTags.map((t) => (
            <FilterChip key={`tag:${t}`} filter={{ kind: 'tag', name: t }} current={filter} onSelect={setFilter} />
          ))}
        </div>
      </Section>

      {/* 画像一覧（要ログイン） */}
      {account && (
        <Section
          title={filter === null ? '画像一覧' : `画像一覧（${filterLabel(filter)}）`}
          empty={!loading && images.length === 0}
          emptyText={filter === null
            ? 'まだ画像がありません。右のカードから画像をアップロードできます。'
            : 'この絞り込みに合う画像はありません。'}
        >
          <div className="card-grid">
            {images.map((image) => (
              <button
                key={image.id}
                type="button"
                className={`card${selection?.kind === 'image' && selection.image.id === image.id ? ' selected' : ''}`}
                onClick={() => selectImage(image)}
              >
                <div className="card-thumb"><img src={image.thumb_url} alt="" loading="lazy" /></div>
                <div className="card-name">{image.display_name}</div>
                {image.owner && <div className="muted card-owner">{image.owner}</div>}
              </button>
            ))}
            <UploadCard uploading={uploading} onFile={pickFile} />
          </div>
          {/* 一覧の下のページ送り。1ページ = IMAGES_PER_PAGE 枚。 */}
          <Pager
            page={imagePage}
            pageCount={imagePageCount}
            total={imagesTotal}
            perPage={LIST_PER_PAGE}
            unit="枚"
            onChange={setImagePage}
          />
        </Section>
      )}

      {/* パズル一覧（常に表示） */}
      <Section
        title={filter === null ? 'パズル一覧' : `パズル一覧（${filterLabel(filter)}）`}
        empty={!loading && puzzles.length === 0}
        emptyText={filter !== null
          ? 'この絞り込みに合うパズルはありません。'
          : account ? '「画像一覧」から画像を選び、ピース数を決めてパズルを作成できます。' : 'まだパズルがありません。'}>
        <div className="card-grid">
          {puzzles.map((puzzle) => (
            <button
              key={puzzle.id}
              type="button"
              className={`card${selection?.kind === 'puzzle' && selection.puzzle.id === puzzle.id ? ' selected' : ''}`}
              onClick={() => selectPuzzleForEdit(puzzle)}
            >
              <div className="card-thumb"><img src={puzzle.thumb_url} alt="" loading="lazy" /></div>
              <div className="card-name">{puzzle.display_name}</div>
              <div className="muted card-owner">{puzzle.columns} x {puzzle.rows}（{puzzle.columns * puzzle.rows}ピース）</div>
              {account && badgeFor(progressByPuzzle.get(puzzle.id), puzzle)}
            </button>
          ))}
        </div>
        {/* 一覧の下のページ送り。1ページ = LIST_PER_PAGE 件。 */}
        <Pager
          page={puzzlePage}
          pageCount={puzzlePageCount}
          total={puzzlesTotal}
          perPage={LIST_PER_PAGE}
          unit="件"
          onChange={setPuzzlePage}
        />
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
                  onClick={() => selectPuzzleForPlay(item.puzzle)}
                >
                  <div className="card-thumb"><img src={item.puzzle.thumb_url} alt="" loading="lazy" /></div>
                  <div className="card-name">{item.puzzle.display_name}</div>
                  <div className="muted card-owner">{item.puzzle.columns} x {item.puzzle.rows}（{item.puzzle.columns * item.puzzle.rows}ピース）</div>
                  <div className={`status ${status}`}>
                    {STATUS_TEXT[status]}
                    {/* クリア済み＝クリア時間、プレイ中＝保存時点までの累積プレイ時間。 */}
                    {status !== 'notStarted' && ` (${formatElapsed(item.state.elapsedSeconds ?? 0)})`}
                  </div>
                </button>
              )
            })}
          </div>
        </Section>
      )}
      </div>

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

      {confirmingPuzzleRemoval && (
        <div className="overlay dim">
          <div className="panel">
            <h2>このパズルを削除しますか？</h2>
            <p className="muted">
              「{confirmingPuzzleRemoval.display_name}」（{confirmingPuzzleRemoval.columns} x {confirmingPuzzleRemoval.rows}）を削除します。この操作は取り消せません。
            </p>
            {error && <div className="error">{error}</div>}
            <div className="row">
              <button
                type="button" className="btn danger"
                onClick={async () => {
                  try {
                    await api.deletePuzzle(confirmingPuzzleRemoval.id)
                    setSelection(null)
                    setConfirmingPuzzleRemoval(null)
                    await reload()
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err))
                    setConfirmingPuzzleRemoval(null)
                  }
                }}
              >
                削除
              </button>
              <button type="button" className="btn" onClick={() => setConfirmingPuzzleRemoval(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {confirmingProgressRemoval && (() => {
        const item = confirmingProgressRemoval
        const cleared = statusFromState(item.state, item.puzzle.columns, item.puzzle.rows) === 'completed'
        return (
          <div className="overlay dim">
            <div className="panel">
              <h2>{cleared ? 'クリア記録を削除しますか？' : 'この記録を削除しますか？'}</h2>
              <p className="muted">
                「{item.puzzle.display_name}」（{item.puzzle.columns} x {item.puzzle.rows}）の
                {cleared ? 'クリア記録' : '途中経過'}を削除します。この操作は取り消せません。
              </p>
              {error && <div className="error">{error}</div>}
              <div className="row">
                <button
                  type="button" className="btn danger"
                  onClick={async () => {
                    try {
                      await api.deleteProgress(item.id)
                      setSelection(null)
                      setConfirmingProgressRemoval(null)
                      await reload()
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err))
                      setConfirmingProgressRemoval(null)
                    }
                  }}
                >
                  削除
                </button>
                <button type="button" className="btn" onClick={() => setConfirmingProgressRemoval(null)}>キャンセル</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 画像アップロードの確認画面。ファイル名（変更不可＝original_name）を見せつつ、
          「タイトル」（＝display_name）を編集して登録する。 */}
      {pending && (
        <div className="overlay dim" onClick={uploading ? undefined : cancelUpload}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <h2>この画像を登録しますか？</h2>
            <img className="upload-preview" src={pending.url} alt="" />
            <label className="field">ファイル名
              <input type="text" value={pending.file.name} readOnly />
            </label>
            <label className="field">タイトル（この画像の題名になります）
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

/** 一覧のページ送り。«（最初）‹（前）ページ番号 ›（次）»（最後）。1ページのときは出さない。 */
function Pager({ page, pageCount, total, perPage, unit, onChange }: {
  page: number
  pageCount: number
  total: number
  perPage: number
  /** 件数の数え方（画像なら「枚」、パズルなら「件」）。 */
  unit: string
  onChange: (next: number) => void
}) {
  if (pageCount <= 1) return null
  // 番号は現在のページの前後2つ（最大5つ）だけ出し、ページが増えても横に伸びすぎないようにする。
  const start = Math.max(1, Math.min(page - 2, pageCount - 4))
  const end = Math.min(pageCount, start + 4)
  const numbers: number[] = []
  for (let i = start; i <= end; i++) numbers.push(i)
  const from = (page - 1) * perPage + 1
  const to = Math.min(total, page * perPage)
  return (
    <div className="pager">
      <div className="pager-buttons">
      <button type="button" className="pager-btn" disabled={page === 1}
        onClick={() => onChange(1)} title="最初のページ" aria-label="最初のページ">«</button>
      <button type="button" className="pager-btn" disabled={page === 1}
        onClick={() => onChange(page - 1)} title="前のページ" aria-label="前のページ">‹</button>
      {numbers.map((n) => (
        <button
          key={n}
          type="button"
          className={`pager-btn${n === page ? ' current' : ''}`}
          aria-current={n === page ? 'page' : undefined}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
      <button type="button" className="pager-btn" disabled={page === pageCount}
        onClick={() => onChange(page + 1)} title="次のページ" aria-label="次のページ">›</button>
      <button type="button" className="pager-btn" disabled={page === pageCount}
        onClick={() => onChange(pageCount)} title="最後のページ" aria-label="最後のページ">»</button>
      </div>
      <span className="muted pager-range">{total}{unit}中 {from}〜{to}{unit}</span>
    </div>
  )
}

/** タグ一覧の1つ。押すとその絞り込みにし、選択中のものをもう一度押すと解除する。 */
function FilterChip({ filter, current, onSelect, virtual }: {
  filter: Filter
  current: Filter | null
  onSelect: (next: Filter | null) => void
  virtual?: boolean
}) {
  const selected = current !== null && filterKey(current) === filterKey(filter)
  return (
    <button
      type="button"
      className={`tag-filter${virtual ? ' virtual' : ''}${selected ? ' selected' : ''}`}
      onClick={() => onSelect(selected ? null : filter)}
    >
      {filterLabel(filter)}
    </button>
  )
}

/** パズル一覧カードの状態バッジ（プレイ中／クリア済みのときだけ出す）。 */
function badgeFor(item: ProgressItem | undefined, puzzle: Puzzle) {
  const status = statusFromState(item?.state, puzzle.columns, puzzle.rows)
  if (status === 'notStarted') return null
  return <div className={`status ${status}`}>{STATUS_TEXT[status]}</div>
}

/** 配列から重複なく最大 n 個を無作為に選ぶ。 */
function pickRandom<T>(items: T[], n: number): T[] {
  const rest = [...items]
  const picked: T[] = []
  while (picked.length < n && rest.length > 0) {
    picked.push(...rest.splice(Math.floor(Math.random() * rest.length), 1))
  }
  return picked
}

/** スライドショーで1枚を映す秒数。 */
const SLIDE_SECONDS = 7
/** 歩くアニメーションが1周したあとに見せる枚数。 */
const SLIDE_COUNT = 3
/**
 * 1枚ごとの動き方（App.css の同名クラス）。寄り／引きに左右・上下・斜めの
 * 移動を組み合わせてある。1回のスライドショーでは重複しないように選ぶ。
 */
const SLIDE_MOTIONS = ['kb-in-right', 'kb-out-left', 'kb-in-down', 'kb-out-up', 'kb-in-diag', 'kb-out-diag']

/**
 * プレビュー1枠。画像が無いときは破線の枠の中をピースが歩き（mac 版と同じ演出）、
 * ひと回りしたら登録画像から無作為に SLIDE_COUNT 枚を SLIDE_SECONDS 秒ずつ、
 * ゆっくり寄り／引き・上下左右に動かしながら映す。映し終えたらまた歩くところへ戻る。
 * 枠の中をクリックすると、待たずに次の段階（歩き→1枚目、1枚目→2枚目…）へ進む。
 * 見せられる画像が無ければ、これまでどおり歩き続ける。
 */
function PreviewBox({ url, photos }: { url: string | undefined; photos: string[] }) {
  const [tick, setTick] = useState(0)
  // スライドショー中に映す画像と、その1枚ごとの動き方。null なら「歩いている」状態。
  const [slides, setSlides] = useState<{ url: string; motion: string }[] | null>(null)
  const [slideIndex, setSlideIndex] = useState(0)

  // 歩くコマ送り（0.5 秒ごと）。
  useEffect(() => {
    if (url || slides) return
    const timer = window.setInterval(() => setTick((t) => t + 1), 500)
    return () => window.clearInterval(timer)
  }, [url, slides])

  // 無作為に選んだ画像でスライドショーを始める。
  const startSlides = useCallback(() => {
    const motions = pickRandom(SLIDE_MOTIONS, SLIDE_COUNT)
    setSlides(pickRandom(photos, SLIDE_COUNT).map((photo, i) => ({ url: photo, motion: motions[i % motions.length] })))
    setSlideIndex(0)
  }, [photos])

  // 次の段階へ。歩いている→1枚目、n枚目→n+1枚目、最後の1枚→また歩くところへ。
  // 時間で進むときも、枠をクリックしたときも、ここを通る。
  const advance = useCallback(() => {
    if (url) return
    if (!slides) {
      if (photos.length > 0) startSlides()
      else setTick(0)                       // 映せる画像が無ければ歩きをやり直す
    } else if (slideIndex + 1 < slides.length) {
      setSlideIndex((i) => i + 1)
    } else {
      setSlides(null)
      setTick(0)
    }
  }, [url, slides, slideIndex, photos, startSlides])

  // ひと回りしたら、スライドショーへ移る。
  useEffect(() => {
    if (url || slides || photos.length === 0) return
    if (tick < PLACEHOLDER_WALK_FRAMES.length) return
    startSlides()
  }, [tick, url, slides, photos, startSlides])

  // SLIDE_SECONDS 秒ごとに次の1枚へ。最後まで映したら歩くところへ戻る。
  useEffect(() => {
    if (url || !slides) return
    const timer = window.setTimeout(advance, SLIDE_SECONDS * 1000)
    return () => window.clearTimeout(timer)
  }, [url, slides, advance])

  if (url) return <img className="preview-box" src={url} alt="" />

  // 枠自体をクリック（またはキーボードの Enter/Space）で次の段階へ進める。
  const boxProps = {
    className: 'preview-box placeholder',
    role: 'button',
    tabIndex: 0,
    title: '次へ',
    'aria-label': '次の画像へ',
    onClick: advance,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      advance()
    },
  }

  if (slides) {
    return (
      <div {...boxProps}>
        {/* key を変えてアニメーションをやり直す。動き方は1枚ごとに変える。 */}
        <img
          key={slideIndex}
          className={`preview-photo ${slides[slideIndex].motion}`}
          style={{ animationDuration: `${SLIDE_SECONDS}s` }}
          src={slides[slideIndex].url}
          alt=""
        />
      </div>
    )
  }

  const frame = PLACEHOLDER_WALK_FRAMES[tick % PLACEHOLDER_WALK_FRAMES.length]
  return (
    <div {...boxProps}>
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

/**
 * タグ入力欄の文字列を、1つのタグ名に整える。改行・制御文字と前後の空白（全角含む）を
 * 落とし、長さの上限で切る。サーバー側（api.cgi の normalize_tags）でも同じ整形が走る。
 */
function normalizeTagName(input: string): string {
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
    .slice(0, MAX_TAG_LENGTH)
}

/** PostgreSQL の timestamptz 文字列を「YYYY-MM-DD HH:MM:SS」に整える。 */
function formatTimestamp(ts: string): string {
  return ts.replace('T', ' ').slice(0, 19)
}
