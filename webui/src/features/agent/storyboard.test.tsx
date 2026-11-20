// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoryboardDialog } from './StoryboardDialog'
import { blankShot, emptyStoryboard, imageFileToBase64, parseStoryboardDraft, previewDataUrl, storyboardDraftKey, type Storyboard } from '../../api/storyboard'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), close: vi.fn(), openScene: vi.fn() }))
vi.mock('../../api/rpc', () => ({ rpc: mocks.rpc }))
let container: HTMLDivElement
let root: Root
let disk: Storyboard
const workspace = '/screenplay/夜路'
const scenePath = 'scenes/opening.md'

const text = (query: string) => container.querySelector(query)?.textContent
function button(label: string) {
  const element = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
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
const mount = () => act(async () => root.render(<StoryboardDialog workspace={workspace} onClose={mocks.close} onOpenScene={mocks.openScene} />))

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  disk = emptyStoryboard()
  localStorage.clear()
  mocks.rpc.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'load_storyboard') return structuredClone(disk)
    if (command === 'list_screenplay_scenes') return [{ path: scenePath, title: '开场', setting: null }]
    if (command === 'save_storyboard_shot') {
      if (args.revision !== disk.revision) throw new Error('分镜已被其他窗口修改')
      disk = { ...disk, revision: 'saved', shots: [{ ...args.shot as object, id: 'shot-id' } as Storyboard['shots'][number]] }
      return structuredClone(disk)
    }
    throw new Error(`Unexpected RPC: ${command}`)
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('storyboard author safety', () => {
  it('does not discard a draft when closing and saves only against the original revision', async () => {
    await mount()
    await click('添加镜头')
    await input('镜头标题', '末班车远景')
    await input('画面／动作', '站台的灯渐渐熄灭。')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭分镜"]')!.click())
    expect(container.querySelector('[aria-label="镜头未保存"]')).not.toBeNull()
    expect(mocks.close).not.toHaveBeenCalled()
    const savedDraft = parseStoryboardDraft(localStorage.getItem(storyboardDraftKey(workspace)))!
    expect(savedDraft.shot.action).toBe('站台的灯渐渐熄灭。')
    await click('继续编辑镜头')
    await click('保存镜头')
    expect(mocks.rpc).toHaveBeenCalledWith('save_storyboard_shot', expect.objectContaining({ workspaceRoot: workspace, revision: null, shot: expect.objectContaining({ title: '末班车远景', scenePath }) }))
    expect(localStorage.getItem(storyboardDraftKey(workspace))).toBeNull()
    expect(text('[role="status"]')).toBe('镜头已保存')
  })

  it('keeps dirty text after a conflict and a list refresh, permitting an explicit new-shot save', async () => {
    await mount(); await click('添加镜头'); await input('镜头标题', '作者草稿')
    disk.revision = 'external-version'
    await click('保存镜头')
    expect(text('[role="alert"]')).toContain('其他窗口修改')
    await click('重新读取')
    expect(container.querySelector<HTMLInputElement>('.storyboard-editor input:not([type=number])')?.value).toBe('作者草稿')
    await click('保存镜头')
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_storyboard_shot', expect.objectContaining({ revision: null }))
    await click('另存为新镜头')
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_storyboard_shot', expect.objectContaining({ revision: 'external-version', shot: expect.objectContaining({ id: undefined, title: '作者草稿' }) }))
    expect(text('[role="status"]')).toBe('镜头已保存')
  })

  it('offers recovered drafts without treating their stale revision as the new baseline', async () => {
    const key = storyboardDraftKey(workspace)
    localStorage.setItem(key, JSON.stringify({ revision: 'old', shot: { ...blankShot(scenePath), title: '待恢复镜头' }, savedAt: Date.now() }))
    disk.revision = 'new'
    await mount(); await click('恢复镜头草稿'); await click('保存镜头')
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_storyboard_shot', expect.objectContaining({ revision: 'old' }))
    expect(container.querySelector('.storyboard-editor')?.textContent).toContain('未保存')
    expect(localStorage.getItem(key)).not.toBeNull()
  })

  it('requires confirmation before removing a shot and does not delete any file', async () => {
    disk = { ...disk, revision: 'one', shots: [{ ...blankShot(scenePath), id: 'id', title: '原镜头' }] }
    mocks.rpc.mockImplementationOnce(async () => structuredClone(disk))
    await mount()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除镜头 原镜头"]')!.click())
    expect(container.querySelector('[aria-label="移除分镜关联"]')?.textContent).toContain('不删除场次正文和素材原图')
    expect(mocks.rpc.mock.calls.some(([command]) => command === 'remove_storyboard_shot')).toBe(false)
    await click('保留')
    expect(container.querySelector('[aria-label="移除分镜关联"]')).toBeNull()
  })
})

describe('storyboard data boundaries', () => {
  it('rejects malformed recovered payloads and non-raster previews', () => {
    expect(parseStoryboardDraft('{')).toBeNull()
    expect(parseStoryboardDraft(JSON.stringify({ revision: null, savedAt: 1, shot: { ...blankShot(scenePath), duration: 'invalid' } }))).toBeNull()
    // Partially filled numeric inputs are recoverable; the save path validates them.
    expect(parseStoryboardDraft(JSON.stringify({ revision: null, savedAt: 1, shot: { ...blankShot(scenePath), duration: 0 } }))?.shot.duration).toBe(0)
    expect(() => previewDataUrl({ mime: 'image/svg+xml', base64: 'svg' })).toThrow()
    expect(() => previewDataUrl({ mime: 'image/png', base64: '<script>' })).toThrow()
    expect(previewDataUrl({ mime: 'image/png', base64: 'YWJj' })).toBe('data:image/png;base64,YWJj')
  })
  it('rejects oversized and disguised image files before upload', async () => {
    await expect(imageFileToBase64({ size: 10 * 1024 * 1024 + 1 } as File)).rejects.toThrow('10 MiB')
    const invalid = { size: 8, type: 'image/png', slice: () => ({ arrayBuffer: async () => new Uint8Array([60,115,118,103]).buffer }) } as unknown as File
    await expect(imageFileToBase64(invalid)).rejects.toThrow('PNG、JPEG 或 WebP')
  })
})
