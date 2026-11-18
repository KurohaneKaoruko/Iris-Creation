// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkspace } from './AgentWorkspace'
import { editorDraftKey } from '../../api/editorDraft'

const state = vi.hoisted(() => ({
  disk: '# 正文\n原稿',
  readText: vi.fn(), write: vi.fn(), forceWrite: vi.fn(), closeWork: vi.fn(), setError: vi.fn(),
  setActivePath: vi.fn(), events: new Map<string, (value: unknown) => void>(),
  chat: { messages: [], busy: false, send: vi.fn(), clear: vi.fn(), restore: vi.fn(), cancel: vi.fn(), resendFrom: vi.fn() },
}))

vi.mock('../../api/backend', async (original) => ({
  ...await original<typeof import('../../api/backend')>(),
  readText: state.readText, writeTextIfCurrent: state.write, writeText: state.forceWrite,
  getSkills: async () => [], getAppSettings: async () => ({ providers: [] }),
  listChatSessions: async () => [],
  listWorkspaceTree: async () => ({ name: 'test', kind: 'dir', path: '', children: [] }),
}))
vi.mock('../../api/rpc', async (original) => ({
  ...await original<typeof import('../../api/rpc')>(),
  subscribeEvent: (name: string, handler: (value: unknown) => void) => {
    state.events.set(name, handler)
    return () => { state.events.delete(name) }
  },
}))
vi.mock('../../hooks/useChat', () => ({ useChat: () => state.chat }))
vi.mock('../../state/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }))
vi.mock('../../state/ProjectContext', () => ({ useProject: () => ({
  workRoot: '/test-work', workName: '测试作品', activePath: 'stories/one.md',
  setActivePath: state.setActivePath, setError: state.setError, closeWork: state.closeWork,
}) }))

let container: HTMLDivElement
let root: Root
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
  if (!result) throw new Error(`Button not found: ${text}`)
  return result
}
async function click(text: string) { await act(async () => button(text).click()) }
async function edit(text: string) {
  await click('预览')
  await click('编辑')
  const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text)
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return editor
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  state.disk = '# 正文\n原稿'
  state.readText.mockImplementation(async () => state.disk)
  state.write.mockImplementation(async (_path: string, value: string) => { state.disk = value })
  state.forceWrite.mockImplementation(async (_path: string, value: string) => { state.disk = value })
  localStorage.clear()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<AgentWorkspace />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('editor safety interactions', () => {
  it('shows one unsaved dialog and saves before closing the project', async () => {
    await edit('新的正文')
    await click('关闭工程')
    expect(container.querySelectorAll('[role="alertdialog"]')).toHaveLength(1)
    expect(state.closeWork).not.toHaveBeenCalled()
    await click('继续编辑')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')?.value).toBe('新的正文')
    await click('关闭工程')
    await click('保存并继续')
    expect(state.write).toHaveBeenCalledWith('stories/one.md', '新的正文', '# 正文\n原稿')
    expect(state.closeWork).toHaveBeenCalledOnce()
  })

  it('does not overwrite an in-memory draft when a watcher reports unchanged disk content', async () => {
    const editor = await edit('尚未保存的草稿')
    await act(async () => {
      state.events.get('fs_changed')?.({ path: 'stories/one.md' })
      await vi.advanceTimersByTimeAsync(650)
    })
    expect(editor.value).toBe('尚未保存的草稿')
  })

  it('blocks a stale save and only overwrites after explicit confirmation', async () => {
    await edit('用户草稿')
    state.disk = 'Agent 新版本'
    await click('保存')
    expect(state.write).not.toHaveBeenCalled()
    expect(state.forceWrite).not.toHaveBeenCalled()
    expect(container.textContent).toContain('磁盘内容已被其他操作修改')
    await click('仍覆盖')
    expect(state.forceWrite).toHaveBeenCalledWith('stories/one.md', '用户草稿')
  })

  it('persists a recovery draft and clears it when edits are reverted', async () => {
    await edit('待恢复草稿')
    await act(async () => { await vi.advanceTimersByTimeAsync(750) })
    const key = editorDraftKey('/test-work', 'stories/one.md')
    expect(JSON.parse(localStorage.getItem(key)!).draft).toBe('待恢复草稿')
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '# 正文\n原稿')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('keeps an on-screen exit button in focus mode', async () => {
    await click('专注写作')
    expect(container.querySelector('.agw-focus-mode')).not.toBeNull()
    await click('退出专注')
    expect(container.querySelector('.agw-focus-mode')).toBeNull()
  })
})
