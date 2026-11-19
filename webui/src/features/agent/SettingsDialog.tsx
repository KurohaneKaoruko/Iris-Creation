import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAppSettings,
  setAppSettings,
  getApiKeyStatus,
  setApiKey,
  testProviderConnectivity,
  type AppSettings,
  type Provider,
  type ProviderConnectivityResult,
} from '../../api/backend'
import { PromptDialog } from '../workspace/Dialogs'
import { Icon } from '../../components/Icon'
import './SettingsDialog.css'

type Props = { onClose: () => void }

/** 应用设置：模型 Provider 管理（Key/地址/模型/连通性）+ 激活选择 */
export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Provider>>({})
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, ProviderConnectivityResult & { err?: string }>>({})
  const [saved, setSaved] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [saveErr, setSaveErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [newProviderName, setNewProviderName] = useState<{ open: boolean } | null>(null)
  const mutationInFlight = useRef(false)
  const savedTimer = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const s = await getAppSettings()
        if (!active) return
        setSettings(s)
        setDrafts(Object.fromEntries(s.providers.map((p) => [p.id, { ...p }])))
        const statuses = await Promise.all(s.providers.map(async (p) => [p.id, await getApiKeyStatus(p.id).catch(() => false)] as const))
        if (!active) return
        setKeyStatus(Object.fromEntries(statuses))
      } catch (e) {
        if (!active) return
        setLoadErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current)
  }, [])

  const patch = useCallback((id: string, field: keyof Provider, value: string) => {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], [field]: value } }))
  }, [])

  const persistDrafts = useCallback(async (): Promise<boolean> => {
    if (!settings) return false
    setSaveErr('')
    setSaved(false)
    try {
      // 先存独立 key 输入（secrets 通道），再存整体设置（其中 api_key 空则不动已存 key）
      for (const [pid, key] of Object.entries(keyInputs)) {
        if (key.trim()) await setApiKey(pid, key.trim())
      }
      const providers = Object.values(drafts).map((p) => ({ ...p, api_key: '' }))
      const next: AppSettings = { ...settings, providers }
      await setAppSettings(next)
      setSettings(next)
      setDrafts(Object.fromEntries(providers.map((p) => [p.id, { ...p }])))
      setKeyStatus((status) => ({ ...status, ...Object.fromEntries(Object.keys(keyInputs).filter((id) => keyInputs[id].trim()).map((id) => [id, true])) }))
      setKeyInputs({})
      setSaved(true)
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => setSaved(false), 1800)
      return true
    } catch (e) {
      setSaveErr(`保存失败：${e instanceof Error ? e.message : String(e)}。修改仍保留在表单中，请重试。`)
      return false
    }
  }, [drafts, keyInputs, settings])

  const save = useCallback(async (): Promise<boolean> => {
    if (!settings || mutationInFlight.current) return false
    mutationInFlight.current = true
    setSaving(true)
    try { return await persistDrafts() }
    finally {
      mutationInFlight.current = false
      setSaving(false)
    }
  }, [persistDrafts, settings])

  const test = useCallback(async (id: string) => {
    const p = drafts[id]
    if (!p) return
    setTesting(id)
    try {
      const r = await testProviderConnectivity({ ...p, api_key: '' }, keyInputs[id]?.trim() || undefined)
      setResults((rs) => ({ ...rs, [id]: r }))
    } catch (e) {
      setResults((rs) => ({ ...rs, [id]: { ok: false, err: e instanceof Error ? e.message : String(e) } as never }))
    } finally {
      setTesting(null)
    }
  }, [drafts, keyInputs])

  const activate = useCallback(async (id: string) => {
    if (!settings || id === settings.active_provider_id || mutationInFlight.current) return
    // 先确认 Provider 配置确实保存；随后只在激活写盘成功后更新单选 UI。
    mutationInFlight.current = true
    setSaving(true)
    try {
      if (!await persistDrafts()) return
      const cur = await getAppSettings()
      await setAppSettings({ ...cur, active_provider_id: id })
      setSettings((current) => current ? { ...current, active_provider_id: id } : current)
      setSaveErr('')
    } catch (e) {
      setSaveErr(`配置已保存，但切换激活模型失败：${e instanceof Error ? e.message : String(e)}。原激活模型保持不变。`)
    } finally {
      mutationInFlight.current = false
      setSaving(false)
    }
  }, [persistDrafts, settings])

  const addProvider = useCallback(async (name: string) => {
    if (!settings || mutationInFlight.current) return
    const id = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || `custom-${Date.now()}`
    if (settings.providers.some((p) => p.id === id)) {
      setSaveErr(`已存在 ID 为“${id}”的 Provider，请使用不同名称。`)
      return
    }
    const p: Provider = { id, name: name.trim(), kind: 'OpenAICompatible', api_key: '', base_url: '', model_name: '' }
    const next = { ...settings, providers: [...settings.providers, p] }
    mutationInFlight.current = true
    setSaving(true)
    setSaveErr('')
    try {
      await setAppSettings(next)
      setSettings(next)
      setDrafts((d) => ({ ...d, [id]: p }))
    } catch (e) {
      setSaveErr(`添加 Provider 失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      mutationInFlight.current = false
      setSaving(false)
    }
  }, [settings])

  const close = useCallback(() => {
    if (!saving) onClose()
  }, [onClose, saving])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 内层「新 Provider」对话框先处理 Escape，不能同时关闭外层设置。
      if (newProviderName || event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, newProviderName])

  if (loadErr) {
    return (
      <div className="set-overlay" onClick={close}>
        <div className="set-dialog glass-panel" role="dialog" aria-modal="true" aria-label="设置" onClick={(e) => e.stopPropagation()}>
          <div className="set-head"><b>设置</b><button className="set-x" disabled={saving} onClick={close} title="关闭"><Icon name="x" size={15} /></button></div>
          <p className="set-err" role="alert">加载失败：{loadErr}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="set-overlay" onClick={close}>
      <div className="set-dialog glass-panel" role="dialog" aria-modal="true" aria-label="设置 · 模型服务" aria-busy={!settings || saving} onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <b>设置 · 模型服务</b>
          <span className="set-head-actions">
            {saved ? <span className="set-saved" role="status"><Icon name="check" size={13} />已保存</span> : null}
            <button className="set-save" disabled={saving || !settings} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
            <button className="set-x" disabled={saving} onClick={close} title="关闭"><Icon name="x" size={15} /></button>
          </span>
        </div>

        <div className="set-body">
          {saveErr ? <p className="set-err" role="alert">{saveErr}</p> : null}
          {settings?.providers.map((p) => {
            const d = drafts[p.id] ?? p
            const r = results[p.id]
            const hasKey = keyStatus[p.id]
            return (
              <div key={p.id} className={`set-card ${settings.active_provider_id === p.id ? 'active' : ''}`}>
                <div className="set-card-head">
                  <label className="set-radio">
                    <input type="radio" name="active-provider" checked={settings.active_provider_id === p.id} disabled={saving || testing !== null} onChange={() => void activate(p.id)} />
                    <b>{d.name || p.id}</b>
                    <code className="set-pid">{p.id}</code>
                    {hasKey ? <span className="set-keyok">Key 已存</span> : <span className="set-keynone">未配 Key</span>}
                  </label>
                  <button className="set-test" disabled={saving || testing !== null} onClick={() => void test(p.id)}>
                    {testing === p.id ? '测试中…' : '测试连接'}
                  </button>
                </div>

                <div className="set-grid">
                  <label>名称<input disabled={saving} value={d.name} onChange={(e) => patch(p.id, 'name', e.target.value)} /></label>
                  <label>类型
                    <select disabled={saving} value={d.kind} onChange={(e) => patch(p.id, 'kind', e.target.value)}>
                      <option value="OpenAI">OpenAI</option>
                      <option value="Anthropic">Anthropic</option>
                      <option value="OpenAICompatible">OpenAI 兼容（DeepSeek/Ollama 等）</option>
                    </select>
                  </label>
                  <label>Base URL<input disabled={saving} value={d.base_url} placeholder="https://api.example.com/v1" onChange={(e) => patch(p.id, 'base_url', e.target.value)} /></label>
                  <label>模型名<input disabled={saving} value={d.model_name} placeholder="gpt-4o-mini" onChange={(e) => patch(p.id, 'model_name', e.target.value)} /></label>
                  <label className="set-key-row">API Key
                    <input
                      type="password"
                      disabled={saving}
                      value={keyInputs[p.id] ?? ''}
                      placeholder={hasKey ? '已保存（输入可更换）' : 'sk-…'}
                      onChange={(e) => setKeyInputs((k) => ({ ...k, [p.id]: e.target.value }))}
                    />
                  </label>
                </div>

                {r ? (
                  <div className={`set-result ${r.err || !r.ok ? 'bad' : 'good'}`}>
                    {r.err ? `测试失败：${r.err}` : r.ok ? `连接正常${typeof r.latency_ms === 'number' ? `（${r.latency_ms}ms）` : ''}：${r.message ?? ''}` : `连接失败：${r.message ?? '未知错误'}`}
                  </div>
                ) : null}
              </div>
            )
          })}

          <button className="set-add" disabled={saving} onClick={() => setNewProviderName({ open: true })}><Icon name="plus" size={14} /> 添加自定义 Provider</button>
        </div>
      </div>

      {newProviderName ? (
        <PromptDialog
          title="新 Provider 名称"
          placeholder="例如：SiliconFlow"
          onConfirm={(v: string) => { setNewProviderName(null); void addProvider(v) }}
          onCancel={() => setNewProviderName(null)}
        />
      ) : null}
    </div>
  )
}
