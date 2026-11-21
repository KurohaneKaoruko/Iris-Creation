// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaStudio } from './MediaStudio'
import type { MediaJob, MediaLibrary, MediaSettingsView } from '../../api/creative'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), close: vi.fn() }))
vi.mock('../../api/rpc', () => ({ rpc: mocks.rpc }))
let container: HTMLDivElement
let root: Root
const workspace = '/books/夜航'

const text = (query: string) => container.querySelector(query)?.textContent
function button(label: string) {
  const element = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label))
  if (!element) throw new Error(`Missing button: ${label}`)
  return element
}
const click = (label: string) => act(async () => button(label).click())
async function input(label: string, value: string) {
  const element = [...container.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))?.querySelector('input,textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const mount = () => act(async () => root.render(<MediaStudio workspace={workspace} onClose={mocks.close} />))

const library = (): MediaLibrary => ({ jobs: [], skipped: 0 })
const settingsView = (): MediaSettingsView => ({
  settings: { imageBase: 'https://api.openai.com/v1', imageModel: 'gpt-image-1', videoBase: 'https://api.dev.runwayml.com' },
  imageKeyConfigured: true, videoKeyConfigured: false,
})
const job = (patch: Partial<MediaJob> = {}): MediaJob => ({
  id: 'job-1', shotId: null, sourceId: null, kind: 'image', state: 'ready', prompt: '雨夜站台', model: 'gpt-image-1',
  createdAt: 0, asset: { format: 'png', bytes: 2048 }, ...patch,
})

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  mocks.rpc.mockImplementation(async (command: string) => {
    if (command === 'list_creative_media') return library()
    if (command === 'get_creative_media_settings') return settingsView()
    throw new Error(`Unexpected RPC: ${command}`)
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('media studio', () => {
  it('renders an empty library and provider settings without leaking keys', async () => {
    await mount()
    await click('素材库 0')
    expect(text('.storyboard-empty')).toContain('素材库为空')
    await click('生成')
    // 设置区显示“已配置/未配置”，绝不回显密钥本体
    expect(container.querySelectorAll('.media-settings em')[0].textContent).toBe('已配置')
    expect(container.querySelectorAll('.media-settings em')[1].textContent).toBe('未配置')
    const keyInput = container.querySelector<HTMLInputElement>('input[type=password]')
    expect(keyInput?.value ?? '').toBe('')
  })

  it('blocks image edit without a reference and submits well-formed generate requests', async () => {
    await mount()
    await input('提示词', '霓虹灯下的站台')
    // 切到“编辑图片”：没有参考图时提交被禁用
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[name=media-kind]')]
    await act(async () => radios[1].click())
    expect(button('提交任务').hasAttribute('disabled')).toBe(true)
    // 切回“生成图片”提交
    await act(async () => radios[0].click())
    await click('提交任务')
    const call = mocks.rpc.mock.calls.find(([command]) => command === 'generate_creative_media')
    expect(call).toBeDefined()
    expect(call![1]).toMatchObject({ workspaceRoot: workspace, request: { kind: 'image', prompt: '霓虹灯下的站台', sourceId: null } })
  })

  it('surfaces provider errors verbatim and keeps the form editable', async () => {
    mocks.rpc.mockImplementation(async (command: string) => {
      if (command === 'list_creative_media') return library()
      if (command === 'get_creative_media_settings') return settingsView()
      if (command === 'generate_creative_media') throw new Error('HTTP 401：请检查媒体服务密钥。')
      throw new Error(`Unexpected RPC: ${command}`)
    })
    await mount()
    await input('提示词', 'x')
    await click('提交任务')
    expect(text('[role=alert]')).toContain('HTTP 401')
    expect(button('提交任务').hasAttribute('disabled')).toBe(false)
  })

  it('shows waiting jobs with progress and failed jobs with their error', async () => {
    mocks.rpc.mockImplementation(async (command: string) => {
      if (command === 'list_creative_media') return { jobs: [
        job({ id: 'w1', kind: 'video', state: 'waiting', progress: 42, asset: undefined }),
        job({ id: 'f1', state: 'failed', error: '视频超过 128 MB。', asset: undefined }),
      ], skipped: 1 } satisfies MediaLibrary
      if (command === 'get_creative_media_settings') return settingsView()
      throw new Error(`Unexpected RPC: ${command}`)
    })
    await mount()
    await click('素材库 2')
    expect(text('.media-state.waiting')).toContain('42%')
    expect(text('.media-error')).toContain('128 MB')
    expect(text('.storyboard-notice.warning')).toContain('1 条任务记录损坏')
  })

  it('saves settings through the secrets channel and never echoes keys back', async () => {
    const saved: unknown[] = []
    mocks.rpc.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === 'list_creative_media') return library()
      if (command === 'get_creative_media_settings') return settingsView()
      if (command === 'save_creative_media_settings') {
        saved.push(args)
        return { ...settingsView(), videoKeyConfigured: true }
      }
      throw new Error(`Unexpected RPC: ${command}`)
    })
    await mount()
    await input('视频服务地址', 'https://relay.example/tenant')
    const keyInputs = [...container.querySelectorAll<HTMLInputElement>('input[type=password]')]
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(keyInputs[1]), 'value')!.set!.call(keyInputs[1], 'sk-secret')
      keyInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('保存媒体服务设置')
    expect(saved[0]).toMatchObject({
      request: { settings: { videoBase: 'https://relay.example/tenant' }, videoKey: 'sk-secret' },
    })
    // 保存成功后输入框清空；仅显示新的“已配置”状态
    expect([...container.querySelectorAll<HTMLInputElement>('input[type=password]')].every((node) => node.value === '')).toBe(true)
    expect(container.querySelectorAll('.media-settings em')[1].textContent).toBe('已配置')
  })
})
