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
  listWorkspaceTree: async () => ({ name: 'test', kind: 'dir', path: '', children: [{ name: 'stories', kind: 'dir', path: 'stories', children: [
    { name: 'one.md', kind: 'file', path: 'stories/one.md' }, { name: 'two.md', kind: 'file', path: 'stories/two.md' },
  ] }] }),
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
async function typeInput(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
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

  it('guards a quick-open navigation instead of losing the current draft', async () => {
    const editor = await edit('未保存草稿')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('[aria-label="文件名、章节标题或路径"]')!
    expect(input).not.toBeNull()
    await typeInput(input, 'two')
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(document.activeElement).toBe(button('继续编辑'))
    expect(state.setActivePath).not.toHaveBeenCalled()
    await click('继续编辑')
    expect(editor.value).toBe('未保存草稿')
    expect(document.activeElement).toBe(editor)
  })

  it('opens a hit in the already loaded file and selects its exact text for editing', async () => {
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })))
    await click('全文检索')
    await typeInput(container.querySelector<HTMLInputElement>('[aria-label="全文检索关键词"]')!, '原稿')
    await click('搜索')
    await act(async () => container.querySelector<HTMLButtonElement>('[title="stories/one.md:2"]')!.click())
    expect(container.querySelector('[data-source-line="2"] mark')?.textContent).toBe('原稿')
    await click('编辑此处')
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')!
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe('原稿')
  })

  it('retains results and jumps within a dirty draft without discarding it', async () => {
    state.disk = '# 正文\n原稿一\n\n原稿二'
    const editor = await edit(`${state.disk}\n还未保存`)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })))
    await click('全文检索')
    await typeInput(container.querySelector<HTMLInputElement>('[aria-label="全文检索关键词"]')!, '原稿')
    await click('搜索')
    await act(async () => container.querySelector<HTMLButtonElement>('[title="stories/one.md:2"]')!.click())
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(editor.selectionStart).toBe(editor.value.indexOf('原稿一'))
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })))
    await click('全文检索')
    await act(async () => container.querySelector<HTMLButtonElement>('[title="stories/one.md:4"]')!.click())
    expect(editor.selectionStart).toBe(editor.value.indexOf('原稿二'))
    expect(editor.value).toContain('还未保存')
    expect(state.write).not.toHaveBeenCalled()
  })

  it('ignores read-only watcher notifications and notices writes in a mixed batch', async () => {
    await click('预览')
    state.readText.mockClear()
    await act(async () => {
      state.events.get('fs_changed')?.({ path: 'stories/one.md', kind: 'access' })
      await vi.advanceTimersByTimeAsync(650)
    })
    expect(state.readText).not.toHaveBeenCalled()
    state.disk = '新的磁盘内容'
    await act(async () => {
      state.events.get('fs_changed')?.({ path: 'stories/one.md', kind: 'modify' })
      state.events.get('fs_changed')?.({ path: 'stories/two.md', kind: 'modify' })
      await vi.advanceTimersByTimeAsync(650)
    })
    expect(container.querySelector('.mdv')?.textContent).toBe('新的磁盘内容')
  })

  it('keeps keyboard find focused and advances through overlapping matches', async () => {
    const editor = await edit('aaaa')
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('[aria-label="在正文中查找"]')!
    await typeInput(input, 'aa')
    expect(document.activeElement).toBe(input)
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, 2])
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 3])
    expect(container.querySelector('.agw-find-count')?.textContent).toBe('2/3')
  })

  it('recounts matches without moving the caret while writing', async () => {
    const editor = await edit('钥匙在左边。')
    const find = () => act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })))
    await find()
    const input = container.querySelector<HTMLInputElement>('[aria-label="在正文中查找"]')!
    await typeInput(input, '钥匙')
    const draft = '钥匙在左边。钥匙不见了。'
    await act(async () => {
      editor.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, draft)
      editor.setSelectionRange(draft.length, draft.length)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.activeElement).toBe(editor)
    expect(editor.selectionStart).toBe(draft.length)
    expect(container.querySelector('.agw-find-count')?.textContent).toBe('2 处')
    await find()
    expect(document.activeElement).toBe(input)
  })

  it('closes the command dialog with Escape without leaving focus mode', async () => {
    await click('专注写作')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('[aria-label="搜索命令"]')!
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[aria-label="命令面板"]')).toBeNull()
    expect(container.querySelector('.agw-focus-mode')).not.toBeNull()
  })
})
