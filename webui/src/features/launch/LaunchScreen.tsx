import { useCallback, useRef, useState } from 'react'
import { useProject } from '../../state/ProjectContext'
import { useTheme } from '../../state/ThemeContext'
import { createProject, type ProjectItem, type ProjectKind } from '../../api/backend'
import { DirPickerDialog } from './DirPickerDialog'
import { Icon } from '../../components/Icon'
import './LaunchScreen.css'

const PROJECT_TYPES = [
  { id: 'novel', label: '小说', icon: 'book-open', hint: '章节写作、人物设定、长篇规划' },
  { id: 'screenplay', label: '剧本', icon: 'clapperboard', hint: '分场编排、对白动作、整稿导出' },
] as const

function projectSummary(p: ProjectItem) {
  return `${p.kind === 'screenplay' ? `剧本 · ${p.scenes_count ?? 0} 场` : `小说 · ${p.chapters_count} 章`} · ${p.total_words.toLocaleString()} 字`
}

/**
 * 启动页：继续上次工程 / 打开目录（服务端目录浏览器点选）/ 最近工程 / 新建标准工程。
 */
export function LaunchScreen() {
  const { state, openDir, opening, forget, setError } = useProject()
  const { theme, toggleTheme } = useTheme()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [kind, setKind] = useState<ProjectKind>('novel')
  const [newName, setNewName] = useState('')
  const [description, setDescription] = useState('')
  const [createError, setCreateError] = useState('')
  const [busy, setBusy] = useState(false)
  const createInFlight = useRef(false)
  const [query, setQuery] = useState('')

  const recent = [
    ...(state?.external_projects ?? []),
    ...(state?.default_projects ?? []),
  ].sort((a, b) => (b.last_opened_at ?? b.updated_at ?? 0) - (a.last_opened_at ?? a.updated_at ?? 0))

  const lastPath = state?.last_workspace ?? null
  const lastItem = lastPath ? recent.find((p) => p.path === lastPath) : undefined
  const lastName = lastPath?.split(/[/\\]/).filter(Boolean).pop() ?? ''
  const filteredRecent = recent
    .filter((p, i, arr) => arr.findIndex((x) => x.path === p.path) === i)
    .filter((p) => !query.trim() || `${p.name} ${p.path} ${p.kind === 'screenplay' ? '剧本' : '小说'}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  const open = (path: string) => { void openDir(path).catch(() => { /* error shown by ProjectContext */ }) }

  const handleCreate = useCallback(async () => {
    const name = newName.trim()
    if (!name || opening || createInFlight.current) return
    createInFlight.current = true
    setBusy(true)
    setCreateError('')
    setError(null)
    try {
      const p = await createProject(name, kind, description.trim())
      setCreating(false)
      setNewName('')
      setDescription('')
      await openDir(p.path).catch(() => { /* creation succeeded; opening is reported separately */ })
    } catch (error) {
      setCreateError(`新建作品失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      createInFlight.current = false
      setBusy(false)
    }
  }, [description, kind, newName, openDir, opening, setError])

  return (
    <div className="launch">
      <header className="launch-head">
        <h1>Iris-Creation</h1>
        <span className="launch-tagline">小说与剧本 · 本地创作工作台</span>
        <button className="launch-theme" onClick={toggleTheme} title="切换主题">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
      </header>

      <main className="launch-main">
        {lastPath ? (
          <button
            className="launch-resume glass-panel"
            disabled={busy || opening}
            onClick={() => open(lastPath)}
          >
            <span className="launch-resume-label"><Icon name="clock" size={13} />继续上次</span>
            <span className="launch-resume-name">{lastName}</span>
            <span className="launch-resume-meta">
              {lastItem ? `${projectSummary(lastItem)} · ` : ''}
              {lastPath}
            </span>
            <span className="launch-resume-go"><Icon name="arrow-right" size={20} /></span>
          </button>
        ) : null}

        <button className="launch-open glass-panel" disabled={busy || opening} onClick={() => setPickerOpen(true)}>
          <span className="launch-open-icon"><Icon name="folder-open" size={44} strokeWidth={1.5} /></span>
          <span className="launch-open-title">打开目录…</span>
          <span className="launch-open-desc">打开已有小说、剧本或 Markdown 资料目录</span>
        </button>

        <button className="launch-new" aria-expanded={creating} disabled={busy || opening} onClick={() => setCreating((value) => !value)}>
          <Icon name="plus" size={15} />
          新建作品工程
        </button>

        {creating ? (
          <form className="launch-create glass-panel" onSubmit={(e) => { e.preventDefault(); void handleCreate() }} onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Escape' && !createInFlight.current) setCreating(false)
          }}>
            <fieldset disabled={busy || opening}>
              <legend>作品类型</legend>
              <div className="launch-types">
                {PROJECT_TYPES.map((type) => <label key={type.id} className="launch-type">
                  <input type="radio" name="project-kind" value={type.id} checked={type.id === kind} onChange={() => setKind(type.id)} />
                  <span><Icon name={type.icon} size={20} /><strong>{type.label}</strong><small>{type.hint}</small></span>
                </label>)}
              </div>
              <label className="launch-field">作品名<input required maxLength={100} value={newName} placeholder={kind === 'screenplay' ? '如「夜航」' : '如「星海遗歌」'} onChange={(e) => setNewName(e.target.value)} autoFocus /></label>
              <label className="launch-field">一句话简介（可选）<input maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="主角想得到什么，又被什么挡住？" /></label>
              <div className="launch-create-actions">
                <button type="button" className="launch-create-cancel" onClick={() => setCreating(false)}>取消</button>
                <button type="submit" className="launch-create-go" disabled={!newName.trim() || busy}>{busy ? '创建中…' : '创建并打开'}</button>
              </div>
            </fieldset>
            {createError ? <p className="launch-create-error" role="alert">{createError}</p> : null}
          </form>
        ) : null}

        {recent.length > 0 ? (
          <section className="launch-recent">
            <div className="launch-recent-head">
              <div><h3>最近打开</h3><span>{filteredRecent.length} 个作品</span></div>
              <label className="launch-recent-search"><Icon name="search" size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索作品或路径" aria-label="搜索最近作品" /></label>
            </div>
            <div className="launch-recent-list">
              {filteredRecent
                .slice(0, query.trim() ? 500 : 8)
                .map((p) => (
                  <div key={p.path} className="launch-recent-item glass-panel">
                    <button className="lr-open" disabled={busy || opening} onClick={() => open(p.path)}>
                      <span className="lr-name">{p.name}</span>
                      <span className="lr-meta">
                        {projectSummary(p)}
                      </span>
                      <span className="lr-path">{p.path}</span>
                    </button>
                    {p.source !== 'default' ? <button
                      className="lr-remove"
                      title="从最近列表移除（不删除文件）"
                      onClick={() => void forget(p.path)}
                    >
                      <Icon name="x" size={13} />
                    </button> : null}
                  </div>
                ))}
            </div>
            {filteredRecent.length === 0 ? <div className="launch-recent-empty">没有匹配的作品。试试作品名或完整路径。</div> : null}
            {!query.trim() && filteredRecent.length > 8 ? <p className="launch-recent-more">显示最近 8 个作品 · 搜索可查看其他 {filteredRecent.length - 8} 个</p> : null}
          </section>
        ) : null}
      </main>

      {pickerOpen ? (
        <DirPickerDialog
          onPick={(path) => {
            setPickerOpen(false)
            open(path)
          }}
          onCancel={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  )
}
