// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isScenePath } from '../../api/documents'
import { splitSceneDraft, type Scene } from '../../api/screenplay'
import { ScenePanel } from './ScenePanel'
import { StudioDialog } from './StudioDialog'

const mock = vi.hoisted(() => ({
  rpc: vi.fn(), start: vi.fn(), cancel: vi.fn(),
  listener: undefined as ((event: string, payload: unknown) => void) | undefined,
}))
vi.mock('../../api/rpc', () => ({
  rpc: mock.rpc,
  subscribeStreamEvents: (handler: typeof mock.listener) => {
    mock.listener = handler
    return { waitReady: async () => {}, unlisten: () => { mock.listener = undefined } }
  },
}))
vi.mock('../../api/backend', async (original) => ({
  ...await original<typeof import('../../api/backend')>(),
  getAppSettings: async () => ({ providers: [] }),
  studioCompleteStream: mock.start,
  chatCancelStream: mock.cancel,
}))

const workspace = '/test-screenplay'
let container: HTMLDivElement
let root: Root

function button(text: string) {
  const node = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  if (!node) throw new Error(`Missing button: ${text}`)
  return node
}
const click = (text: string) => act(async () => button(text).click())

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mock.rpc.mockReset()
  mock.start.mockResolvedValue(undefined)
  mock.cancel.mockResolvedValue(undefined)
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('playwriting flow', () => {
  it('keeps dialogue line breaks when extracting a scene heading', () => {
    const body = '**外景 · 老车站 · 夜**\n\n**小秋：** 等等。\n**阿宇：** 车到了。'
    expect(splitSceneDraft(`~~~markdown\r\n# 末班车\r\n\r\n${body}\r\n~~~`)).toEqual({ title: '末班车', body })
    expect(splitSceneDraft('**小秋：** 原样保留')).toEqual({ title: '', body: '**小秋：** 原样保留' })
    expect(isScenePath('scenes/scene-003.md')).toBe(true)
    expect(isScenePath('scenes/notes/other.md')).toBe(false)
  })

  it('refreshes a stale scene order without claiming it was saved', async () => {
    const scenes: Scene[] = [
      { path: 'scenes/a.md', title: '开场', setting: null },
      { path: 'scenes/b.md', title: '雨夜', setting: '外景 · 车站 · 夜' },
    ]
    mock.rpc.mockRejectedValueOnce(new Error('场次列表已变化，请刷新后再调整顺序。'))
    const refresh = vi.fn(async () => {})
    await act(async () => root.render(<ScenePanel workspace={workspace} scenes={scenes} activePath={null} loading={false} loadError=""
      onOpen={vi.fn()} onNew={vi.fn()} onRefresh={refresh} onExport={vi.fn()} onOutline={vi.fn()} onCharacters={vi.fn()} />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="上移 雨夜"]')!.click())
    expect(mock.rpc).toHaveBeenCalledWith('reorder_screenplay_scenes', {
      workspaceRoot: workspace, expectedPaths: ['scenes/a.md', 'scenes/b.md'], paths: ['scenes/b.md', 'scenes/a.md'],
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('场次列表已变化')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps failed or stopped output out of scenes and saves a completed draft only on confirmation', async () => {
    const openSaved = vi.fn()
    await act(async () => root.render(<StudioDialog workKind="screenplay" workspaceRoot={workspace} initialText="给末班车场次写一段对白"
      activePath={null} activeContent="" onInsertToEditor={vi.fn()} onClose={vi.fn()} onOpenSavedScene={openSaved} />))
    expect(container.querySelector('[aria-label="剧本工坊"]')).not.toBeNull()
    expect(container.textContent).not.toContain('存为章节')

    await click('生成')
    let streamId = mock.start.mock.lastCall![0].streamId
    await act(async () => {
      mock.listener?.('ai_stream_token', { streamId, token: '# 半截\n草稿' })
      mock.listener?.('ai_error', { streamId, message: 'Provider 流提前关闭' })
    })
    expect(button('存为新场次').disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('提前关闭')

    await click('生成')
    streamId = mock.start.mock.lastCall![0].streamId
    await act(async () => mock.listener?.('ai_stream_token', { streamId, token: '残稿' }))
    await click('停止')
    expect(mock.cancel).toHaveBeenCalledWith(streamId)
    expect(button('存为新场次').disabled).toBe(true)
    expect(mock.rpc).not.toHaveBeenCalled()

    await click('生成')
    streamId = mock.start.mock.lastCall![0].streamId
    const body = '**外景 · 老车站 · 夜**\n\n**小秋：** 等等。'
    await act(async () => {
      mock.listener?.('ai_stream_token', { streamId, token: `# 末班车\n\n${body}` })
      mock.listener?.('ai_stream_done', { streamId })
    })
    await click('存为新场次')
    expect(mock.rpc).not.toHaveBeenCalled()
    mock.rpc.mockResolvedValueOnce({ path: 'scenes/final.md' })
    await click('写入')
    expect(mock.rpc).toHaveBeenCalledWith('create_screenplay_scene', { workspaceRoot: workspace, draft: { title: '末班车', body } })
    await click('打开新场次')
    expect(openSaved).toHaveBeenCalledWith('scenes/final.md')
  })
})
