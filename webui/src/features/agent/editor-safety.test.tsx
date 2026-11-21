// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentWorkspace } from './AgentWorkspace'
import { editorDraftKey } from '../../api/editorDraft'

const state = vi.hoisted(() => ({
  disk: '# 正文\n原稿',
  activePath: 'stories/one.md',
  readText: vi.fn(), write: vi.fn(), closeWork: vi.fn(), setError: vi.fn(),
  setActivePath: vi.fn(), events: new Map<string, (value: unknown) => void>(),
  chat: { messages: [], busy: false, send: vi.fn(), clear: vi.fn(), restore: vi.fn(), cancel: vi.fn(), resendFrom: vi.fn() },
}))

vi.mock('../../api/backend', async (original) => ({
  ...await original<typeof import('../../api/backend')>(),
  readText: state.readText, writeTextIfCurrent: state.write,
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
  workRoot: '/test-work', workName: '测试作品', activePath: state.activePath,
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
  state.activePath = 'stories/one.md'
  state.readText.mockImplementation(async () => state.disk)
  state.write.mockImplementation(async (_path: string, value: string, expected: string) => {
    if (expected !== state.disk) throw new Error('file changed on disk')
    state.disk = value
  })
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
  vi.restoreAllMocks()
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
    expect(state.write).toHaveBeenCalledWith('stories/one.md', '新的正文', '# 正文\n原稿', '/test-work')
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
    expect(state.disk).toBe('Agent 新版本')
    expect(container.textContent).toContain('磁盘内容已被其他操作修改')
    await click('仍覆盖')
    expect(state.write).toHaveBeenLastCalledWith('stories/one.md', '用户草稿', 'Agent 新版本', '/test-work')
    expect(state.disk).toBe('用户草稿')
  })

  it('keeps the original baseline after recovery and requires reconfirmation after a third disk edit', async () => {
    const key = editorDraftKey('/test-work', 'stories/one.md')
    localStorage.setItem(key, JSON.stringify({ baseContent: '旧原稿', draft: '待恢复的段落', savedAt: Date.now() }))
    state.disk = '外部新版'
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<AgentWorkspace />))
    await click('预览')
    await click('恢复草稿')
    expect(container.textContent).toContain('磁盘内容已被其他操作修改')
    await click('保存')
    expect(state.write).toHaveBeenLastCalledWith('stories/one.md', '待恢复的段落', '旧原稿', '/test-work')
    expect(state.disk).toBe('外部新版')
    state.disk = '第三版'
    await click('仍覆盖')
    expect(state.disk).toBe('第三版')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')?.value).toBe('待恢复的段落')
    await click('仍覆盖')
    expect(state.disk).toBe('待恢复的段落')
    expect(localStorage.getItem(key)).toBeNull()
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

  it('flushes the latest draft on unmount before the debounce runs', async () => {
    await edit('刚输入、尚未防抖暂存的草稿')
    const key = editorDraftKey('/test-work', 'stories/one.md')
    expect(localStorage.getItem(key)).toBeNull()
    await act(async () => root.unmount())
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      baseContent: '# 正文\n原稿', draft: '刚输入、尚未防抖暂存的草稿',
    })
    root = createRoot(container)
    await act(async () => root.render(<AgentWorkspace />))
    await click('预览')
    expect(container.textContent).toContain('找到未保存的本地草稿')
  })

  it('stashes same-event input on beforeunload and still warns before closing', async () => {
    const editor = await edit('上一帧草稿')
    const event = new Event('beforeunload', { cancelable: true })
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '最后一次输入')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    expect(JSON.parse(localStorage.getItem(editorDraftKey('/test-work', 'stories/one.md'))!).draft).toBe('最后一次输入')
    expect(state.write).not.toHaveBeenCalled()
  })

  it('stashes a draft on pagehide even when no unload confirmation is shown', async () => {
    await edit('页面隐藏前的草稿')
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    expect(JSON.parse(localStorage.getItem(editorDraftKey('/test-work', 'stories/one.md'))!).draft).toBe('页面隐藏前的草稿')
    expect(state.write).not.toHaveBeenCalled()
  })

  it('does not close the project after a failed save and keeps the draft available', async () => {
    await edit('写入失败仍要保留')
    state.write.mockRejectedValueOnce(new Error('permission denied'))
    await click('关闭工程')
    await click('保存并继续')
    expect(state.closeWork).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(state.disk).toBe('# 正文\n原稿')
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('permission denied'))
    await click('继续编辑')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')?.value).toBe('写入失败仍要保留')
  })

  it('does not resurrect an explicitly discarded draft during unmount', async () => {
    await edit('明确放弃的草稿')
    await act(async () => { await vi.advanceTimersByTimeAsync(750) })
    const key = editorDraftKey('/test-work', 'stories/one.md')
    expect(localStorage.getItem(key)).not.toBeNull()
    await click('关闭工程')
    await click('放弃修改')
    await act(async () => root.unmount())
    expect(localStorage.getItem(key)).toBeNull()
    expect(state.disk).toBe('# 正文\n原稿')
    root = createRoot(container)
    await act(async () => root.render(<AgentWorkspace />))
    expect(container.textContent).not.toContain('找到未保存的本地草稿')
  })

  it('does not recreate recovery data after a successful save and unmount', async () => {
    await edit('已保存的新正文')
    await click('保存')
    await act(async () => root.unmount())
    expect(localStorage.getItem(editorDraftKey('/test-work', 'stories/one.md'))).toBeNull()
    expect(state.disk).toBe('已保存的新正文')
    root = createRoot(container)
    await act(async () => root.render(<AgentWorkspace />))
    expect(container.textContent).not.toContain('找到未保存的本地草稿')
  })

  it('ignores a late read after switching rapidly back to the original file', async () => {
    let finishRead!: (text: string) => void
    state.readText.mockImplementation((path: string) => path === 'stories/two.md'
      ? new Promise<string>((resolve) => { finishRead = resolve }) : Promise.resolve(state.disk))
    state.activePath = 'stories/two.md'
    await act(async () => root.render(<AgentWorkspace />))
    state.activePath = 'stories/one.md'
    await act(async () => root.render(<AgentWorkspace />))
    await click('预览')
    await act(async () => finishRead('另一个文件的迟到响应'))
    expect(container.querySelector('.mdv')?.textContent).toContain('原稿')
    expect(container.querySelector('.mdv')?.textContent).not.toContain('迟到响应')
    await click('编辑')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')?.value).toBe(state.disk)
  })

  it('warns when recovery storage fails without losing the editable text', async () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('iris-editor-draft:')) throw new Error('quota exceeded')
      original.call(this, key, value)
    })
    const editor = await edit('缓存不可用也必须保留的正文')
    await act(async () => { await vi.advanceTimersByTimeAsync(750) })
    expect(state.setError).toHaveBeenCalledWith(expect.stringContaining('本机草稿暂存失败'))
    expect(editor.value).toBe('缓存不可用也必须保留的正文')
    const event = new Event('beforeunload', { cancelable: true })
    await act(async () => window.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    await click('保存')
    expect(state.disk).toBe('缓存不可用也必须保留的正文')
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

  /** 在挂载前设置磁盘内容并重新挂载（beforeEach 已用默认内容渲染过一次） */
  async function remountWith(disk: string) {
    state.disk = disk
    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(<AgentWorkspace />))
  }

  it('locates the second duplicate heading hit on its real source line, not the first', async () => {
    await remountWith('# 山巅\n开篇\n\n## 山巅\n尾声山巅处')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })))
    await click('全文检索')
    await typeInput(container.querySelector<HTMLInputElement>('[aria-label="全文检索关键词"]')!, '山巅')
    await click('搜索')
    const oneHits = [...container.querySelectorAll<HTMLButtonElement>('.srch-hit')].filter((n) => n.title.startsWith('stories/one.md:'))
    expect(oneHits.map((node) => node.title)).toEqual(['stories/one.md:1', 'stories/one.md:4', 'stories/one.md:5'])
    // 预览：第 4 行（第二个同名标题）获得 mdv-source-target，第一个标题没有
    await act(async () => oneHits[1].click())
    const target = container.querySelector('.mdv-source-target')
    expect(target?.getAttribute('data-source-line')).toBe('4')
    expect(target?.id).toBe('mdv-toc-山巅-1')
    expect(container.querySelector('#mdv-toc-山巅')?.classList.contains('mdv-source-target')).toBe(false)
    // 编辑此处：textarea 选中第 4 行的山巅，而不是第 1 行的
    await click('编辑此处')
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')!
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe('山巅')
    expect(editor.selectionStart).toBe(state.disk.indexOf('## 山巅') + 3)
  })

  it('selects fenced-code hits exactly for editing even when the query also appears in headings', async () => {
    await remountWith('# 钥匙\n\n```\n钥匙在围栏内\n```\n\n正文')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })))
    await click('全文检索')
    await typeInput(container.querySelector<HTMLInputElement>('[aria-label="全文检索关键词"]')!, '钥匙')
    await click('搜索')
    await act(async () => container.querySelector<HTMLButtonElement>('[title="stories/one.md:4"]')!.click())
    expect(container.querySelector('pre [data-source-line="4"] mark')?.textContent).toBe('钥匙')
    await click('编辑此处')
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')!
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe('钥匙')
    expect(editor.selectionStart).toBe(state.disk.indexOf('钥匙在围栏内'))
  })

  it('keeps CRLF source lines consistent from search hits into the editor selection', async () => {
    await remountWith('# 标题\r\n\r\n开篇钥匙在抽屉\r\n结尾')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })))
    await click('全文检索')
    await typeInput(container.querySelector<HTMLInputElement>('[aria-label="全文检索关键词"]')!, '钥匙')
    await click('搜索')
    // 命中行号按 CRLF 归一后的真实源行（第 3 行）
    await act(async () => container.querySelector<HTMLButtonElement>('[title="stories/one.md:3"]')!.click())
    expect(container.querySelector('.mdv-source-target[data-source-line="3"]')?.textContent).toContain('钥匙')
    await click('编辑此处')
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')!
    // jsdom 与浏览器一致把 textarea 的 CRLF 归一为 LF：偏移按 LF 文本计算
    expect(editor.value).toBe('# 标题\n\n开篇钥匙在抽屉\n结尾')
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe('钥匙')
  })

  it('moves only the caret to the located line when the stale query no longer exists', async () => {
    await remountWith('# 标题\n旧词位置\n结尾')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })))
    await click('全文检索')
    await typeInput(container.querySelector<HTMLInputElement>('[aria-label="全文检索关键词"]')!, '旧词')
    await click('搜索')
    // 文件在检索提交后被外部改写，旧词消失
    state.disk = '# 标题\n这句话已被改写\n结尾'
    await act(async () => {
      state.events.get('fs_changed')?.({ path: 'stories/one.md', kind: 'modify' })
      await vi.advanceTimersByTimeAsync(650)
    })
    await act(async () => container.querySelector<HTMLButtonElement>('[title="stories/one.md:2"]')!.click())
    expect(container.querySelector('.mdv-source-target[data-source-line="2"]')?.textContent).toContain('被改写')
    // 预览内不得高亮任何无关文字（检索弹层的命中列表不含 mdv 命中标记）
    expect(container.querySelectorAll('.mdv mark').length).toBe(0)
    await click('编辑此处')
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="正文编辑器"]')!
    // 过期命中：只把光标移到第 2 行行首，不选中任何无关文字
    expect(editor.selectionStart).toBe(editor.selectionEnd)
    expect(editor.value.indexOf('\n') + 1).toBe(editor.selectionStart)
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
