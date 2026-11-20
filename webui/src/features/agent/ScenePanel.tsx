import { useId, useRef, useState } from 'react'
import { createScene, reorderScenes, saveScreenplayExport, type Scene, type SceneInterior } from '../../api/screenplay'
import { Icon } from '../../components/Icon'
import './ScenePanel.css'

type Props = {
  workspace: string
  scenes: Scene[]
  activePath: string | null
  loading: boolean
  loadError: string
  onOpen: (path: string) => void
  onNew: () => void
  onRefresh: () => Promise<void>
  onExport: () => void
  onOutline: () => void
  onCharacters: () => void
  onStoryboard?: () => void
}

export function ScenePanel({ workspace, scenes, activePath, loading, loadError, onOpen, onNew, onRefresh, onExport, onOutline, onCharacters, onStoryboard }: Props) {
  const [moving, setMoving] = useState(false)
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null)
  const inFlight = useRef(false)

  async function move(index: number, offset: -1 | 1) {
    const destination = index + offset
    if (inFlight.current || loading || loadError || destination < 0 || destination >= scenes.length) return
    inFlight.current = true
    setMoving(true)
    setNotice(null)
    const expected = scenes.map((scene) => scene.path)
    const next = [...expected]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    try {
      await reorderScenes(workspace, expected, next)
      setNotice({ message: `已移至第 ${destination + 1} 场` })
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      await onRefresh()
      inFlight.current = false
      setMoving(false)
    }
  }

  return <section className="scene-panel" aria-label="剧本场次">
    <div className="scene-panel-head">
      <div><strong>{scenes.length} 场</strong><small>按这里的顺序导出整稿</small></div>
      <button className="agw-btn primary" onClick={onNew} disabled={moving}><Icon name="plus" size={14} />新建场次</button>
    </div>
    <div className="scene-panel-links">
      <button className="agw-btn" onClick={onOutline}><Icon name="list-checks" size={14} />分场大纲</button>
      <button className="agw-btn" onClick={onCharacters}><Icon name="user" size={14} />人物表</button>
      <button className="agw-btn" onClick={onExport}><Icon name="download" size={14} />导出剧本</button>
      {onStoryboard ? <button className="agw-btn" onClick={onStoryboard}><Icon name="clapperboard" size={14} />分镜与素材</button> : null}
    </div>
    {loadError ? <div className="scene-notice error" role="alert">{loadError} <button className="agw-btn" onClick={() => void onRefresh()}>重试</button></div> : null}
    {notice ? <div className={`scene-notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.message}</div> : null}
    {scenes.length ? <ol className="scene-list" aria-busy={loading || moving}>
      {scenes.map((scene, index) => <li className={`scene-row${scene.path === activePath ? ' active' : ''}`} key={scene.path}>
        <button className="scene-row-main" aria-current={scene.path === activePath ? 'true' : undefined} title={scene.path} onClick={() => onOpen(scene.path)}>
          <span className="scene-num">{String(index + 1).padStart(2, '0')}</span>
          <span className="scene-row-text"><strong>{scene.title}</strong>{scene.setting ? <small>{scene.setting}</small> : null}</span>
        </button>
        <div className="scene-order-actions">
          <button className="agw-iconbtn sm" disabled={moving || loading || !!loadError || index === 0} aria-label={`上移 ${scene.title}`} title="上移一场" onClick={() => void move(index, -1)}><Icon name="arrow-up" size={13} /></button>
          <button className="agw-iconbtn sm" disabled={moving || loading || !!loadError || index === scenes.length - 1} aria-label={`下移 ${scene.title}`} title="下移一场" onClick={() => void move(index, 1)}><Icon name="arrow-down" size={13} /></button>
        </div>
      </li>)}
    </ol> : !loadError ? <div className="agw-empty">{loading ? '正在读取场次…' : '还没有场次。可以先添加一个，再在预览中写作。'}</div> : null}
  </section>
}

export function NewSceneDialog({ workspace, onClose, onCreated }: { workspace: string; onClose: () => void; onCreated: (scene: Scene) => void }) {
  const [title, setTitle] = useState('')
  const [interior, setInterior] = useState<SceneInterior>('interior')
  const [location, setLocation] = useState('')
  const [time, setTime] = useState('日')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const focusLabel = useId()
  const inFlight = useRef(false)

  async function submit() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const scene = await createScene(workspace, { title: title.trim(), interior, location: location.trim(), time: time.trim() })
      onCreated(scene)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const close = () => { if (!inFlight.current) onClose() }
  return <div className="modal-overlay" onClick={close}>
    <form className="dialog-box glass-panel scene-dialog" role="dialog" aria-modal="true" aria-labelledby={focusLabel}
      onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submit() }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Escape') { event.stopPropagation(); close() }
        if (event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input, select, button')].filter((control) => !control.matches(':disabled'))
        if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
          event.preventDefault()
          ;(event.shiftKey ? controls.at(-1) : controls[0])?.focus()
        }
      }}>
      <h3 className="dialog-title" id={focusLabel}>新建场次</h3>
      <p className="dialog-message">标题和场景信息将写入 Markdown，之后可在正文中修改。</p>
      <fieldset className="scene-fields" disabled={busy}>
        <label className="scene-wide">场次标题<input value={title} maxLength={100} placeholder="留空则按场次编号命名" onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label>内外景<select value={interior} onChange={(e) => setInterior(e.target.value as SceneInterior)}><option value="interior">内景</option><option value="exterior">外景</option><option value="both">内/外景</option></select></label>
        <label>时间<input value={time} maxLength={32} onChange={(e) => setTime(e.target.value)} placeholder="如：黎明" /></label>
        <label className="scene-wide">地点<input value={location} maxLength={80} onChange={(e) => setLocation(e.target.value)} placeholder="如：码头" /></label>
      </fieldset>
      {error ? <p className="scene-notice error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" className="dialog-btn" onClick={close} disabled={busy}>取消</button><button type="submit" className="dialog-btn primary" disabled={busy}>{busy ? '创建中…' : '创建场次'}</button></div>
    </form>
  </div>
}

export function ScreenplayExport({ workspace, sceneCount }: { workspace: string; sceneCount: number }) {
  const [state, setState] = useState<{ busy?: boolean; path?: string; error?: string }>({})
  const inFlight = useRef(false)

  async function run(format: 'md' | 'txt') {
    if (inFlight.current || !sceneCount) return
    inFlight.current = true
    setState({ busy: true })
    try { setState({ path: await saveScreenplayExport(workspace, format) }) }
    catch (error) { setState({ error: error instanceof Error ? error.message : String(error) }) }
    finally { inFlight.current = false }
  }

  return <section className="scene-export" aria-label="导出剧本">
    <h3>合并整稿</h3>
    <p>按当前场次顺序合并已保存的 {sceneCount} 场至 <code>exports/</code>，保留场景信息、动作与对白段落；不会更改原文件。未保存的草稿不纳入。</p>
    <div className="scene-panel-links">
      <button className="tools-run primary" disabled={!sceneCount || state.busy} onClick={() => void run('md')}><Icon name="download" size={14} />导出剧本 Markdown</button>
      <button className="tools-run" disabled={!sceneCount || state.busy} onClick={() => void run('txt')}><Icon name="file-text" size={14} />导出剧本 TXT</button>
    </div>
    {state.busy ? <p role="status">导出中…</p> : null}
    {state.path ? <p className="tools-ok" role="status">已导出：<code>{state.path}</code></p> : null}
    {state.error ? <p className="tools-err" role="alert">{state.error}</p> : null}
  </section>
}
