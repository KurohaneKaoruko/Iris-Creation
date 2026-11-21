import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MEDIA_KIND_LABELS, MEDIA_STATE_LABELS, formatBytes, generateCreativeMedia, importCreativeImage,
  listCreativeMedia, refreshCreativeMedia, creativeMediaUrl,
  getCreativeMediaSettings, saveCreativeMediaSettings,
  type GenerateMediaRequest, type MediaJob, type MediaLibrary, type MediaSettingsView,
} from '../../api/creative'
import { Icon } from '../../components/Icon'
import './MediaStudio.css'

type Props = { workspace: string; onClose: () => void }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

const KIND_OPTIONS: Array<{ id: GenerateMediaRequest['kind']; label: string; hint: string }> = [
  { id: 'image', label: '生成图片', hint: '文生图，无参考图' },
  { id: 'edit', label: '编辑图片', hint: '基于已导入图片修改' },
  { id: 'video', label: '生成视频', hint: '文生/图生视频，2–10 秒' },
]

/** 视频任务在供应商侧轮询；就绪后产物落本地，直接流式播放。 */
const isVideo = (job: MediaJob) => job.kind === 'video'

export function MediaStudio({ workspace, onClose }: Props) {
  const [library, setLibrary] = useState<MediaLibrary | null>(null)
  const [tab, setTab] = useState<'generate' | 'library'>('generate')
  const [kind, setKind] = useState<GenerateMediaRequest['kind']>('image')
  const [prompt, setPrompt] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [portrait, setPortrait] = useState(false)
  const [duration, setDuration] = useState(5)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  const polling = useRef<string | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const next = await listCreativeMedia(workspace)
      if (alive.current) setLibrary(next)
    } catch (e) { if (alive.current) setError(message(e)) }
  }, [workspace])

  useEffect(() => {
    alive.current = true
    void refreshList()
    return () => { alive.current = false }
  }, [refreshList])

  // 有 waiting 任务时每 5 秒拉一次刷新（refresh 对非 waiting 任务是本地幂等读）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const waiting = library?.jobs.find((job) => job.state === 'waiting')
      if (!waiting || polling.current) return
      polling.current = waiting.id
      void refreshCreativeMedia(workspace, waiting.id)
        .then(() => refreshList())
        .catch(() => { /* 下个周期重试；错误在手动刷新时呈现 */ })
        .finally(() => { polling.current = null })
    }, 5000)
    return () => { window.clearInterval(timer) }
  }, [library, workspace, refreshList])

  const imports = library?.jobs.filter((job) => job.kind === 'import' && job.state === 'ready') ?? []
  const canGenerate = !busy && prompt.trim().length > 0 && (kind !== 'edit' || !!sourceId)

  async function submit() {
    if (!canGenerate) return
    setBusy(true); setError(''); setNotice('')
    try {
      const job = await generateCreativeMedia(workspace, {
        kind, shotId: null, sourceId: sourceId || null,
        prompt: prompt.trim(), portrait, duration: kind === 'video' ? duration : undefined,
      })
      if (alive.current) { setNotice(`任务已提交（${MEDIA_KIND_LABELS[kind]}）；供应商处理中会自动查询。`); setPrompt('') }
      void refreshList()
      // 刚提交的视频任务在供应商侧排队；先拉一次状态。
      if (job.state === 'waiting') void refreshCreativeMedia(workspace, job.id).then(() => refreshList()).catch(() => {})
    } catch (e) { if (alive.current) setError(message(e)) }
    finally { if (alive.current) setBusy(false) }
  }

  async function importFile(file: File) {
    setBusy(true); setError(''); setNotice('')
    try {
      await importCreativeImage(workspace, file)
      if (alive.current) setNotice('图片已导入本作品素材库（未上传模型）。')
      void refreshList()
    } catch (e) { if (alive.current) setError(message(e)) }
    finally { if (alive.current) setBusy(false) }
  }

  const videoJobs = library?.jobs.filter(isVideo) ?? []
  const imageJobs = library?.jobs.filter((job) => !isVideo(job)) ?? []

  return <div className="storyboard-overlay" onClick={onClose}>
    <div className="storyboard-dialog media-studio" role="dialog" aria-modal="true" aria-label="媒体工作台" tabIndex={-1}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
      }}>
      <header className="storyboard-head"><div><h2><Icon name="sparkles" size={19} />媒体工作台</h2><p>生成图/视频 · 密钥仅存本机 · 产物保存在作品内</p></div>
        <button className="agw-iconbtn" disabled={busy} aria-label="关闭媒体工作台" onClick={onClose}><Icon name="x" size={18} /></button>
      </header>
      <nav className="storyboard-toolbar" aria-label="媒体工具">
        <button className="agw-btn" aria-pressed={tab === 'generate'} onClick={() => setTab('generate')}>生成</button>
        <button className="agw-btn" aria-pressed={tab === 'library'} onClick={() => setTab('library')}>素材库 {library?.jobs.length ?? 0}</button>
        <span className="storyboard-spacer" />
        <button className="agw-btn" disabled={busy} onClick={() => void refreshList()}><Icon name="refresh" size={13} />刷新列表</button>
      </nav>
      {error ? <p className="storyboard-notice error" role="alert">{error}</p> : null}
      {notice ? <p className="storyboard-notice" role="status">{notice}</p> : null}
      <div className="storyboard-content">
        {tab === 'generate' ? <div className="media-generate">
          <form className="storyboard-import" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <h3>新建媒体任务</h3>
            <div className="storyboard-field-row">
              {KIND_OPTIONS.map((option) => <label key={option.id} className="media-kind-option">
                <input type="radio" name="media-kind" checked={kind === option.id} onChange={() => { setKind(option.id); if (option.id !== 'edit') setSourceId('') }} />
                <span>{option.label}<small>{option.hint}</small></span>
              </label>)}
            </div>
            <label>提示词<textarea required maxLength={kind === 'video' ? 1000 : 4000} rows={3} value={prompt}
              onChange={(event) => setPrompt(event.target.value)} placeholder="描述画面、风格、镜头内容…" /></label>
            {kind === 'edit' ? <label>参考图片（已导入素材）<select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              <option value="">请选择…</option>
              {imports.map((job) => <option key={job.id} value={job.id}>{job.prompt || `导入图片 ${job.id.slice(0, 8)}`}</option>)}
            </select></label> : null}
            {kind === 'video' ? <div className="storyboard-field-row">
              <label>时长（秒）<input type="number" min={2} max={10} value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>
              <label className="media-portrait"><input type="checkbox" checked={portrait} onChange={(event) => setPortrait(event.target.checked)} />竖屏（720:1280）</label>
            </div> : null}
            <div className="storyboard-editor-actions">
              <button className="agw-btn primary" type="submit" disabled={!canGenerate}>{busy ? '提交中…' : '提交任务'}</button>
            </div>
            <p className="media-hint">生成任务发送到「媒体服务」设置的服务地址；密钥仅存本机 secrets，不会出现在浏览器。</p>
          </form>
          <div className="storyboard-import">
            <h3>导入参考图</h3>
            <p>PNG / JPEG / WebP，≤10 MiB、≤24 MP。复制进本作品 creative/assets/，作为编辑/图生视频的输入。</p>
            <label className="storyboard-file-label"><Icon name="upload" size={15} />选择本地图片
              <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} aria-label="导入本地参考图"
                onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file) }} /></label>
          </div>
          <MediaSettingsSection onError={setError} />
        </div> : <div className="media-library">
          {videoJobs.length ? <><h3>视频任务</h3><div className="media-grid">{videoJobs.map((job) => <MediaCard key={job.id} job={job} />)}</div></> : null}
          {imageJobs.length ? <><h3>图片任务</h3><div className="media-grid">{imageJobs.map((job) => <MediaCard key={job.id} job={job} />)}</div></> : null}
          {library && !library.jobs.length ? <p className="storyboard-empty">素材库为空。先导入图片或提交生成任务。</p> : null}
          {library?.skipped ? <p className="storyboard-notice warning">{library.skipped} 条任务记录损坏被跳过。</p> : null}
        </div>}
      </div>
    </div>
  </div>
}

/** 服务设置：地址/模型名/密钥。保存成功只回显“已配置”布尔值，密钥不回传浏览器。 */
function MediaSettingsSection({ onError }: { onError: (message: string) => void }) {
  const [view, setView] = useState<MediaSettingsView | null>(null)
  const [imageBase, setImageBase] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [videoBase, setVideoBase] = useState('')
  const [imageKey, setImageKey] = useState('')
  const [videoKey, setVideoKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await getCreativeMediaSettings()
      setView(next); setImageBase(next.settings.imageBase); setImageModel(next.settings.imageModel)
      setVideoBase(next.settings.videoBase); setImageKey(''); setVideoKey(''); setSaved(false)
    } catch (e) { onError(message(e)) }
  }, [onError])

  useEffect(() => { void load() }, [load])

  async function save() {
    setSaving(true); setSaved(false)
    try {
      const next = await saveCreativeMediaSettings({
        settings: { imageBase, imageModel, videoBase },
        imageKey: imageKey.trim() || null,
        videoKey: videoKey.trim() || null,
      })
      setView(next); setImageBase(next.settings.imageBase); setImageModel(next.settings.imageModel)
      setVideoBase(next.settings.videoBase); setImageKey(''); setVideoKey(''); setSaved(true)
    } catch (e) { onError(message(e)) }
    finally { setSaving(false) }
  }

  if (!view) return null
  return <section className="media-settings" aria-label="媒体服务设置">
    <h3>媒体服务</h3>
    <p>图像与视频各走独立服务地址（OpenAI 兼容 /images 与 Runway 兼容 /v1）。密钥按「服务地址」分键存于本机 secrets；浏览器只看到“已配置”状态。</p>
    <div className="storyboard-field-row">
      <label>图像服务地址<input value={imageBase} onChange={(event) => setImageBase(event.target.value)} placeholder="https://api.openai.com/v1" /></label>
      <label>图像模型名<input value={imageModel} onChange={(event) => setImageModel(event.target.value)} placeholder="gpt-image-1" /></label>
    </div>
    <div className="storyboard-field-row">
      <label>图像 API Key<span className="media-key-row">
        <input type="password" value={imageKey} onChange={(event) => setImageKey(event.target.value)} placeholder={view.imageKeyConfigured ? '已配置，留空保持不变' : '未配置'} />
        <em className={view.imageKeyConfigured ? 'configured' : ''}>{view.imageKeyConfigured ? '已配置' : '未配置'}</em></span></label>
    </div>
    <div className="storyboard-field-row">
      <label>视频服务地址<input value={videoBase} onChange={(event) => setVideoBase(event.target.value)} placeholder="https://api.dev.runwayml.com" /></label>
      <label>视频 API Key<span className="media-key-row">
        <input type="password" value={videoKey} onChange={(event) => setVideoKey(event.target.value)} placeholder={view.videoKeyConfigured ? '已配置，留空保持不变' : '未配置'} />
        <em className={view.videoKeyConfigured ? 'configured' : ''}>{view.videoKeyConfigured ? '已配置' : '未配置'}</em></span></label>
    </div>
    <div className="storyboard-editor-actions">
      <button className="agw-btn" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存媒体服务设置'}</button>
      {saved ? <small className="media-state ready">已保存</small> : null}
    </div>
  </section>
}

function MediaCard({ job }: { job: MediaJob }) {
  const [blob, setBlob] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [requested, setRequested] = useState(false)
  const ready = job.state === 'ready'

  useEffect(() => {
    if (!requested || !ready) return
    let alive = true
    let url: string | null = null
    void fetch(creativeMediaUrl(job.id))
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blobBody = await response.blob()
        url = URL.createObjectURL(blobBody)
        if (alive) { setBlob(url); setLoadError('') }
      })
      .catch((e: unknown) => { if (alive) setLoadError(message(e)) })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [requested, ready, job.id])

  return <article className={`media-card ${ready ? 'ready' : ''}`}>
    <div className="media-card-head"><strong>{MEDIA_KIND_LABELS[job.kind]}</strong>
      <span className={`media-state ${job.state}`}>{MEDIA_STATE_LABELS[job.state]}{job.state === 'waiting' && job.progress != null ? ` ${job.progress}%` : ''}</span></div>
    <p className="media-prompt" title={job.prompt}>{job.prompt || '（导入图片）'}</p>
    {job.state === 'waiting' ? <p className="media-hint">供应商处理中；列表会自动查询，也可手动刷新。</p> : null}
    {job.state === 'failed' || job.state === 'interrupted' ? <p className="media-error" role="alert">{job.error ?? '任务失败。'}</p> : null}
    {ready ? <div className="media-preview">
      {!requested ? <button onClick={() => setRequested(true)}><Icon name="image" size={25} />{isVideo(job) ? '播放视频' : '查看图片'}</button>
        : blob === null && !loadError ? <p>读取中…</p>
        : loadError ? <p className="media-error" role="alert">{loadError}</p>
        : isVideo(job) ? <video src={blob ?? undefined} controls preload="metadata" />
        : <img src={blob ?? undefined} alt={job.prompt || '生成图片'} loading="lazy" />}
    </div> : null}
    {job.asset ? <small>{job.asset.format.toUpperCase()} · {formatBytes(job.asset.bytes)} · {job.model}</small> : null}
  </article>
}
