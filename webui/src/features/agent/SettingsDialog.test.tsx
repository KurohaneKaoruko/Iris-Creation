// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from './SettingsDialog'

const api = vi.hoisted(() => ({
  getAppSettings: vi.fn(), setAppSettings: vi.fn(), getApiKeyStatus: vi.fn(),
  setApiKey: vi.fn(), testProviderConnectivity: vi.fn(),
}))
vi.mock('../../api/backend', () => ({ ...api }))

const initial = () => ({
  active_provider_id: 'alpha', active_agent_id: '', active_writing_assistant_id: '', launch_mode: 'picker' as const,
  providers: [
    { id: 'alpha', name: 'Alpha', kind: 'OpenAICompatible' as const, api_key: '', base_url: 'https://alpha.test/v1', model_name: 'alpha-model' },
    { id: 'beta', name: 'Beta', kind: 'OpenAICompatible' as const, api_key: '', base_url: 'https://beta.test/v1', model_name: 'beta-model' },
  ],
})
let host: HTMLDivElement
let root: Root
const onClose = vi.fn()

async function click(name: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === name)
  if (!button) throw new Error(`Button not found: ${name}`)
  await act(async () => button.click())
}

beforeEach(async () => {
  vi.clearAllMocks()
  api.getAppSettings.mockResolvedValue(initial())
  api.getApiKeyStatus.mockResolvedValue(false)
  api.setApiKey.mockResolvedValue(undefined)
  api.setAppSettings.mockResolvedValue(undefined)
  api.testProviderConnectivity.mockResolvedValue({ ok: true })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<SettingsDialog onClose={onClose} />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('provider settings save and activation', () => {
  it('keeps edited fields and displays an actionable failure when persistence fails', async () => {
    api.setAppSettings.mockRejectedValueOnce(new Error('disk is full'))
    const input = host.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://new-alpha.test/v1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('保存')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('disk is full')
    expect(host.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')?.value).toBe('https://new-alpha.test/v1')
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0].checked).toBe(true)
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1].checked).toBe(false)
    expect(host.querySelector('[role="status"]')).toBeNull()
    await click('保存')
    expect(api.setAppSettings).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已保存')
  })

  it('does not show a Provider as active when activation persistence rejects', async () => {
    api.setAppSettings.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('activation failed'))
    const radios = host.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    expect(radios[0].checked).toBe(true)
    await act(async () => radios[1].click())
    expect(api.setAppSettings).toHaveBeenCalledTimes(2)
    expect(radios[0].checked).toBe(true)
    expect(radios[1].checked).toBe(false)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('activation failed')
  })

  it('allows only one save at a time and does not close while persistence is pending', async () => {
    let finish!: () => void
    api.setAppSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === '保存')!
    await act(async () => { save.click(); save.click() })
    expect(api.setAppSettings).toHaveBeenCalledOnce()
    expect(save.disabled).toBe(true)
    const close = host.querySelector<HTMLButtonElement>('[aria-label="关闭"], button[title="关闭"]')!
    await act(async () => close.click())
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('closes the nested Provider-name prompt before the outer settings dialog', async () => {
    await click('添加自定义 Provider')
    expect(host.querySelector('input[placeholder="例如：SiliconFlow"]')).not.toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(host.querySelector('input[placeholder="例如：SiliconFlow"]')).toBeNull()
    expect(host.querySelector('[aria-label="设置 · 模型服务"]')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})
