import { useCallback, useEffect, useRef, useState } from 'react'
import { listScenes, type Scene } from '../../api/screenplay'
import {
  ASSET_ROLES, CAMERA_MOVES, FRAMINGS, blankShot, detachStoryboardAsset, exportStoryboard,
  imageFileToBase64, importStoryboardImage, loadStoryboard, parseStoryboardDraft, previewDataUrl,
  readCreativeImage, removeShot, reorderShots, saveShot, storyboardDraftKey,
  type AssetRole, type Shot, type ShotDraft, type Storyboard, type StoryboardAsset,
} from '../../api/storyboard'
import { Icon } from '../../components/Icon'
import './StoryboardDialog.css'

type Editor = { shot: ShotDraft; original: string; revision: string | null }
type Props = { workspace: string; initialScene?: string | null; onClose: () => void; onOpenScene: (path: string) => void }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function StoryboardDialog({ workspace, initialScene, onClose, onOpenScene }: Props) {
  const [board, setBoard] = useState<Storyboard | null>(null)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [tab, setTab] = useState<'shots' | 'assets'>('shots')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [recovery, setRecovery] = useState<ReturnType<typeof parseStoryboardDraft>>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState('')
  const [pending, setPending] = useState<{ action: () => void } | null>(null)
  const [removing, setRemoving] = useState<{ kind: 'shot' | 'asset'; id: string; name: string } | null>(null)
  const [role, setRole] = useState<AssetRole>('reference')
  const [importName, setImportName] = useState('')
  const [importTarget, setImportTarget] = useState('')
  const inFlight = useRef(false)
  const boardRef = useRef<Storyboard | null>(null)
  const alive = useRef(true)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const dirty = !!editor && JSON.stringify(editor.shot) !== editor.original
  const key = storyboardDraftKey(workspace)

  const retainDraft = useCallback(() => {
    if (!dirty || !editor) return
    try {
      localStorage.setItem(key, JSON.stringify({ revision: editor.revision, shot: editor.shot, savedAt: Date.now() }))
      setStorageError('')
    } catch { setStorageError('本机草稿暂存失败，请先复制镜头内容，再关闭窗口。') }
  }, [dirty, editor, key])

  const clearDraft = () => { try { localStorage.removeItem(key) } catch { /* preserve in-memory editing */ } }
  const guard = (action: () => void) => {
    if (inFlight.current) return
    if (dirty) { retainDraft(); setPending({ action }) }
    else action()
  }

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const [nextBoard, nextScenes] = await Promise.all([loadStoryboard(workspace), listScenes(workspace)])
      if (alive.current) { boardRef.current = nextBoard; setBoard(nextBoard); setScenes(nextScenes) }
    } catch (error) { if (alive.current) setError(message(error)) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }, [workspace])

  useEffect(() => {
    alive.current = true
    previousFocus.current = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    try { setRecovery(parseStoryboardDraft(localStorage.getItem(key))) } catch { /* storage unavailable */ }
    void refresh()
    return () => { alive.current = false; previousFocus.current?.isConnected && previousFocus.current.focus() }
  }, [key, refresh])

  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(retainDraft, 350)
    const warn = (event: BeforeUnloadEvent) => { retainDraft(); event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => { window.clearTimeout(timer); window.removeEventListener('beforeunload', warn) }
  }, [dirty, retainDraft])

  async function mutate(operation: () => Promise<Storyboard>, success: string) {
    if (inFlight.current) return false
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await operation()
      if (alive.current) { boardRef.current = result; setBoard(result); setNotice(success) }
      return true
    } catch (error) { if (alive.current) setError(message(error)); return false }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }

  async function save(asNew = false) {
    if (!editor || !board) return false
    if (!Number.isInteger(editor.shot.duration) || editor.shot.duration < 1 || editor.shot.duration > 60) {
      setError('镜头时长须为 1–60 的整数秒。'); return false
    }
    const shot = asNew ? { ...editor.shot, id: undefined } : editor.shot
    const revision = asNew ? board.revision : editor.revision
    const saved = await mutate(() => saveShot(workspace, revision, shot), '镜头已保存')
    if (saved) { setEditor(null); setRecovery(null); clearDraft() }
    return saved
  }

  function openEditor(shot?: Shot) {
    if (recovery) { setError('请先恢复或丢弃暂存草稿，再编辑其他镜头。'); return }
    guard(() => {
      const latest = shot ? boardRef.current?.shots.find(({ id }) => id === shot.id) : undefined
      if (shot && !latest) { setError('该镜头已移除，请重新读取分镜。'); return }
      const draft = latest ? { ...latest, assetIds: [...latest.assetIds] } : blankShot(scenes.find(({ path }) => path === initialScene)?.path ?? scenes[0]?.path ?? '')
      setEditor({ shot: draft, original: JSON.stringify(draft), revision: boardRef.current?.revision ?? null })
      setTab('shots'); setError(''); setNotice(''); setRemoving(null)
    })
  }

  async function move(index: number, offset: number) {
    if (!board || editor || recovery || index + offset < 0 || index + offset >= board.shots.length) return
    const ids = board.shots.map(({ id }) => id)
    const next = [...ids]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    await mutate(() => reorderShots(workspace, board.revision, ids, next), '镜头顺序已保存')
  }

  async function importFile(file: File) {
    if (!board || editor || recovery || inFlight.current) return
    // Read the explicit user-selected file only; never send an absolute local path.
    const saved = await mutate(async () => {
      const base64 = await imageFileToBase64(file)
      const name = importName.trim() || Array.from(file.name.replace(/\.[^.]+$/, '')).slice(0, 100).join('') || '参考图'
      return importStoryboardImage(workspace, board.revision, importTarget || null, role, name, file.name, base64)
    }, '参考图已复制到作品；未上传到模型服务')
    if (saved) setImportName('')
  }

  const sceneTitle = (path: string) => scenes.find((scene) => scene.path === path)?.title ?? `已失联：${path}`
  const change = (patch: Partial<ShotDraft>) => setEditor((current) => current ? { ...current, shot: { ...current.shot, ...patch } } : current)
  const locked = busy || !board

  return <div className="storyboard-overlay" onClick={() => guard(onClose)}>
    <div className="storyboard-dialog" role="dialog" aria-modal="true" aria-label="分镜与素材" tabIndex={-1} ref={dialogRef}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation()
          if (busy) return
          if (pending) setPending(null)
          else if (removing) setRemoving(null)
          else guard(onClose)
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (editor && !pending && !busy) void save() }
        if (event.key === 'Tab') {
          const scope = event.currentTarget.querySelector('.storyboard-confirm') ?? event.currentTarget
          const controls = [...scope.querySelectorAll<HTMLElement>('button,input,textarea,select,[tabindex="0"]')]
            .filter((node) => !node.matches(':disabled') && !!node.getClientRects().length)
          if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
            event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus()
          }
        }
      }}>
      <header className="storyboard-head"><div><h2><Icon name="clapperboard" size={19} />分镜与素材</h2><p>场次原稿不变 · 素材仅在本地 · 时长为规划值</p></div>
        <button className="agw-iconbtn" disabled={busy} aria-label="关闭分镜" onClick={() => guard(onClose)}><Icon name="x" size={18} /></button>
      </header>
      <nav className="storyboard-toolbar" aria-label="分镜工具">
        <button className="agw-btn" aria-pressed={tab === 'shots'} onClick={() => setTab('shots')}>镜头 {board?.shots.length ?? 0}</button>
        <button className="agw-btn" aria-pressed={tab === 'assets'} onClick={() => setTab('assets')}>素材 {board?.assets.length ?? 0}</button>
        <span className="storyboard-spacer" />
        <button className="agw-btn" disabled={busy} onClick={() => void refresh()} title="只刷新列表，不覆盖镜头草稿"><Icon name="refresh" size={13} />重新读取</button>
        <button className="agw-btn" disabled={locked || dirty || !board?.shots.length || !!recovery} onClick={async () => {
          if (!board || inFlight.current) return
          inFlight.current = true; setBusy(true); setError('')
          try { setNotice(`已导出：${await exportStoryboard(workspace, board.revision)}`) }
          catch (error) { setError(message(error)) }
          finally { inFlight.current = false; setBusy(false) }
        }}><Icon name="download" size={13} />导出清单</button>
      </nav>
      {error ? <p className="storyboard-notice error" role="alert">{error}</p> : null}
      {storageError ? <p className="storyboard-notice error" role="alert">{storageError}</p> : null}
      {notice ? <p className="storyboard-notice" role="status">{notice}</p> : null}
      {board?.unlinkedScenePaths.length ? <p className="storyboard-notice warning">有 {board.unlinkedScenePaths.length} 个场次文件失联；镜头仍保留，可编辑镜头重新关联场次。</p> : null}
      {recovery ? <div className="storyboard-recovery" role="status"><span>找到未保存的镜头草稿{recovery.revision !== board?.revision ? '；磁盘版本已变化，恢复不会自动覆盖。' : '。'}</span>
        <button className="agw-btn" disabled={locked} onClick={() => { setEditor({ shot: recovery.shot, original: '', revision: recovery.revision }); setRecovery(null); setTab('shots') }}>恢复镜头草稿</button>
        <button className="agw-btn" disabled={busy} onClick={() => { clearDraft(); setRecovery(null) }}>丢弃暂存草稿</button></div> : null}
      <div className="storyboard-content">
        {tab === 'shots' ? <div className={`storyboard-shots${editor ? ' has-editor' : ''}`}>
          <section className="storyboard-shot-list" aria-label="镜头列表"><div className="storyboard-section-head"><strong>{board?.shots.reduce((sum, shot) => sum + shot.duration, 0) ?? 0} 秒 · 总规划时长</strong>
            <button className="agw-btn primary" disabled={locked || !scenes.length || !!recovery} onClick={() => openEditor()}><Icon name="plus" size={14} />添加镜头</button></div>
            {!board ? <p className="storyboard-empty">{busy ? '正在读取分镜…' : '分镜读取失败，请重新读取。'}</p> : !board.shots.length ? <p className="storyboard-empty">从一个场次添加镜头，填写景别、动作、声音与预估时长。</p> : <ol>
              {board.shots.map((shot, index) => <li key={shot.id} className={editor?.shot.id === shot.id ? 'active' : ''}>
                <div className="storyboard-shot-title"><span>{String(index + 1).padStart(3, '0')}</span><button disabled={busy} onClick={() => openEditor(shot)}>{shot.title}</button><small>{shot.duration} 秒</small></div>
                <p>{sceneTitle(shot.scenePath)} · {FRAMINGS.find(({ id }) => id === shot.framing)?.label} · {CAMERA_MOVES.find(({ id }) => id === shot.cameraMove)?.label}</p>
                <div className="storyboard-shot-actions"><button className="agw-btn" disabled={busy || !scenes.some(({ path }) => path === shot.scenePath)} onClick={() => guard(() => { onClose(); onOpenScene(shot.scenePath) })}>打开原场次</button>
                  <span className="storyboard-spacer" /><small>{shot.assetIds.length} 项素材</small>
                  <button className="agw-iconbtn sm" disabled={locked || !!editor || !!recovery || index === 0} aria-label={`上移镜头 ${shot.title}`} onClick={() => void move(index, -1)}><Icon name="arrow-up" size={13} /></button>
                  <button className="agw-iconbtn sm" disabled={locked || !!editor || !!recovery || index === board.shots.length - 1} aria-label={`下移镜头 ${shot.title}`} onClick={() => void move(index, 1)}><Icon name="arrow-down" size={13} /></button>
                  <button className="agw-iconbtn sm" disabled={locked || !!editor || !!recovery} aria-label={`移除镜头 ${shot.title}`} onClick={() => setRemoving({ kind: 'shot', id: shot.id, name: shot.title })}><Icon name="trash" size={13} /></button>
                </div>
              </li>)}
            </ol>}
          </section>
          {editor ? <form className="storyboard-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <h3>{editor.shot.id ? '编辑镜头' : '新建镜头'}{dirty ? ' · 未保存' : ''}</h3>
            <fieldset disabled={busy || !!pending}>
              <label>关联场次<select value={editor.shot.scenePath} onChange={(event) => change({ scenePath: event.target.value })}>
                {!scenes.some(({ path }) => path === editor.shot.scenePath) ? <option value={editor.shot.scenePath}>原场次已失联，请重新选择</option> : null}
                {scenes.map((scene) => <option key={scene.path} value={scene.path}>{scene.title}</option>)}
              </select></label>
              <label>镜头标题<input required maxLength={120} value={editor.shot.title} onChange={(event) => change({ title: event.target.value })} autoFocus /></label>
              <div className="storyboard-field-row"><label>景别<select value={editor.shot.framing} onChange={(event) => change({ framing: event.target.value as ShotDraft['framing'] })}>{FRAMINGS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
                <label>运镜<select value={editor.shot.cameraMove} onChange={(event) => change({ cameraMove: event.target.value as ShotDraft['cameraMove'] })}>{CAMERA_MOVES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
                <label>时长（秒）<input type="number" min={1} max={60} required value={editor.shot.duration} onChange={(event) => change({ duration: Number(event.target.value) })} /></label></div>
              <label>画面／动作<textarea maxLength={8000} rows={4} value={editor.shot.action} onChange={(event) => change({ action: event.target.value })} /></label>
              <label>对白／声音<textarea maxLength={8000} rows={3} value={editor.shot.dialogue} onChange={(event) => change({ dialogue: event.target.value })} /></label>
              <div className="storyboard-reference-picker"><strong>关联素材（最多 8 项）</strong>{!board?.assets.length ? <p>先保存镜头，再到素材页导入参考图。</p> : board.assets.map((asset) => <label key={asset.id}>
                <input type="checkbox" checked={editor.shot.assetIds.includes(asset.id)} disabled={!editor.shot.assetIds.includes(asset.id) && editor.shot.assetIds.length >= 8}
                  onChange={(event) => change({ assetIds: event.target.checked ? [...editor.shot.assetIds, asset.id] : editor.shot.assetIds.filter((id) => id !== asset.id) })} />{asset.name}{asset.available ? '' : '（文件缺失）'}
              </label>)}</div>
            </fieldset>
            <div className="storyboard-editor-actions"><button className="agw-btn primary" type="submit" disabled={locked || !editor.shot.title.trim() || !scenes.some(({ path }) => path === editor.shot.scenePath)}>保存镜头</button>
              <button className="agw-btn" type="button" disabled={busy} onClick={() => guard(() => { setEditor(null); clearDraft() })}>取消编辑</button>
              <button className="agw-btn" type="button" onClick={() => {
                if (!navigator.clipboard) { setError('剪贴板不可用，请手动复制镜头文本。'); return }
                void navigator.clipboard.writeText(JSON.stringify(editor.shot, null, 2)).then(() => setNotice('镜头草稿已复制')).catch(() => setError('复制失败，请手动复制文本。'))
              }}>复制草稿</button>
              {editor.revision !== board?.revision ? <button className="agw-btn" type="button" disabled={locked || !editor.shot.title.trim()} onClick={() => void save(true)}>另存为新镜头</button> : null}
            </div>
          </form> : null}
        </div> : <section className="storyboard-assets" aria-label="本地素材库">
          <div className="storyboard-import"><h3>导入参考图</h3><p>复制进当前作品的 creative/references/；PNG、JPEG、WebP，最大 10 MiB / 24 MP。不上传模型，不改原文件。</p>
            <div className="storyboard-field-row"><label>素材名称（可选）<input maxLength={100} value={importName} disabled={locked || !!editor || !!recovery} onChange={(event) => setImportName(event.target.value)} /></label>
              <label>类型<select value={role} disabled={locked || !!editor || !!recovery} onChange={(event) => setRole(event.target.value as AssetRole)}>{ASSET_ROLES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
              <label>导入后关联<select value={importTarget} disabled={locked || !!editor || !!recovery} onChange={(event) => setImportTarget(event.target.value)}><option value="">仅加入素材库</option>{board?.shots.map((shot) => <option key={shot.id} value={shot.id}>{shot.title}</option>)}</select></label></div>
            <label className="storyboard-file-label"><Icon name="upload" size={15} />选择本地图片<input type="file" accept="image/png,image/jpeg,image/webp" disabled={locked || !!editor || !!recovery} aria-label="导入本地参考图" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file) }} /></label>
            {editor ? <p>请先保存或取消镜头编辑，再导入素材。</p> : null}
          </div>
          <div className="storyboard-asset-grid">{board?.assets.map((asset) => <article key={asset.id}>
            <AssetPreview key={`${asset.id}:${asset.hash}:${asset.previewHash}:${asset.available}`} workspace={workspace} asset={asset} />
            <strong>{asset.name}</strong><span>{ASSET_ROLES.find(({ id }) => id === asset.role)?.label} · {asset.width} × {asset.height}</span>
            <small title={asset.path}>{asset.originalName}</small>
            <button className="agw-btn" disabled={locked || !!editor || !!recovery} onClick={() => setRemoving({ kind: 'asset', id: asset.id, name: asset.name })}>移除关联</button>
          </article>)}</div>
          {board && !board.assets.length ? <p className="storyboard-empty">素材库为空。导入人物、场景或道具参考图，再在镜头中关联。</p> : null}
        </section>}
      </div>
      {pending ? <div className="storyboard-confirm" role="alertdialog" aria-modal="true" aria-label="镜头未保存"><h3>镜头还有修改没有保存</h3><p>先保存再继续？外部修改冲突时，不会强制覆盖。</p><div>
        <button className="agw-btn" autoFocus disabled={busy} onClick={() => setPending(null)}>继续编辑镜头</button>
        <button className="agw-btn" disabled={busy} onClick={() => { const action = pending.action; setPending(null); setEditor(null); clearDraft(); action() }}>放弃镜头修改</button>
        <button className="agw-btn primary" disabled={locked || !editor?.shot.title.trim()} onClick={() => { const action = pending.action; void save().then((saved) => { setPending(null); if (saved) action() }) }}>保存镜头并继续</button>
      </div></div> : null}
      {removing ? <div className="storyboard-confirm" role="alertdialog" aria-modal="true" aria-label="移除分镜关联"><h3>移除「{removing.name}」？</h3><p>{removing.kind === 'shot' ? '移除镜头记录，不删除场次正文和素材原图。' : '从素材库和所有镜头中解除关联，磁盘原图保留。'}</p><div>
        <button className="agw-btn" autoFocus disabled={busy} onClick={() => setRemoving(null)}>保留</button>
        <button className="agw-btn" disabled={locked} onClick={async () => { if (!board) return; const ok = await mutate(() => removing.kind === 'shot' ? removeShot(workspace, board.revision, removing.id) : detachStoryboardAsset(workspace, board.revision, removing.id), '关联已移除；原文件保留'); if (ok) setRemoving(null) }}>确认移除</button>
      </div></div> : null}
    </div>
  </div>
}

function AssetPreview({ workspace, asset }: { workspace: string; asset: StoryboardAsset }) {
  const [state, setState] = useState<{ url?: string; error?: string }>({})
  const [requested, setRequested] = useState(false)
  useEffect(() => {
    if (!requested) return
    let alive = true
    void readCreativeImage(workspace, asset.id).then((image) => { if (alive) setState({ url: previewDataUrl(image) }) })
      .catch((error) => { if (alive) setState({ error: message(error) }) })
    return () => { alive = false }
  }, [requested, workspace, asset.id, asset.hash])
  return <div className="storyboard-preview">{state.url ? <img src={state.url} alt={asset.name} loading="lazy" /> : state.error ? <p role="alert">{state.error}</p> : <button disabled={!asset.available || requested} onClick={() => setRequested(true)}><Icon name="image" size={25} />{!asset.available ? '文件缺失或已移动' : requested ? '读取预览…' : '查看参考图'}</button>}</div>
}
