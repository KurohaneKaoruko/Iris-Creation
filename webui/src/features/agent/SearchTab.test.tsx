// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchTab } from './SearchTab'

const api = vi.hoisted(() => ({ tree: vi.fn(), read: vi.fn() }))
vi.mock('../../api/backend', () => ({ listWorkspaceTree: api.tree, readText: api.read }))
let root: Root
let host: HTMLDivElement
const onOpen = vi.fn()
const tree = { name: 'work', path: '', kind: 'dir', children: [{ name: 'stories', path: 'stories', kind: 'dir', children: [{ name: 'one.md', path: 'stories/one.md', kind: 'file' }] }] }

async function type(value: string) {
  const input = host.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label || node.title === label)
  if (!button) throw new Error(`Button not found: ${label}`)
  await act(async () => button.click())
}
beforeEach(async () => {
  vi.clearAllMocks()
  api.tree.mockResolvedValue(tree)
  api.read.mockResolvedValue('前文\n钥匙出现在门口\n后文')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<SearchTab onOpenFile={onOpen} />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('full-workspace search interactions', () => {
  it('keeps a submitted-query snapshot and passes the original source location', async () => {
    await type('钥匙'); await click('搜索')
    await type('门口')
    expect(host.querySelector('mark')?.textContent).toBe('钥匙')
    expect(host.textContent).toContain('输入已修改')
    await act(async () => host.querySelector<HTMLButtonElement>('.srch-hit')!.click())
    expect(onOpen).toHaveBeenCalledWith('stories/one.md', { line: 2, query: '钥匙', caseSensitive: false })
    expect(host.textContent).toContain('前：前文')
    expect(host.textContent).toContain('后：后文')
  })

  it('stops and clears outstanding HTTP reads, without resurrecting results', async () => {
    let signal: AbortSignal | undefined
    api.read.mockImplementation((_path, incoming?: AbortSignal) => {
      signal = incoming
      return new Promise<string>((_resolve, reject) => incoming?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError'))))
    })
    await type('钥匙'); await click('搜索')
    expect(signal?.aborted).toBe(false)
    await click('停止')
    expect(signal?.aborted).toBe(true)
    expect(host.textContent).toContain('已停止')
    expect(host.querySelectorAll('.srch-hit')).toHaveLength(0)
    await click('清空搜索')
    expect(host.querySelector('input')?.value).toBe('')
    expect(host.textContent).not.toContain('保留已完成')
  })

  it('aborts an obsolete request before starting a replacement search with Enter', async () => {
    let oldSignal: AbortSignal | undefined
    api.read.mockImplementationOnce((_path, signal?: AbortSignal) => {
      oldSignal = signal
      return new Promise<string>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError'))))
    }).mockResolvedValue('新的结果')
    await type('旧词'); await click('搜索')
    await type('新的')
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(oldSignal?.aborted).toBe(true)
    expect(host.querySelector('mark')?.textContent).toBe('新的')
  })

  it('reports unreadable files instead of claiming complete results', async () => {
    api.read.mockRejectedValueOnce(new Error('permission denied'))
    await type('钥匙'); await click('搜索')
    expect(host.textContent).toContain('1 个文件读取失败')
  })

  it('aborts a pending directory request on unmount', async () => {
    api.tree.mockImplementationOnce((_depth, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
    }))
    await type('钥匙'); await click('搜索')
    await act(async () => root.render(<div />))
    expect(api.tree.mock.calls[0][1].aborted).toBe(true)
    expect(api.read).not.toHaveBeenCalled()
  })

  it('cancels when the dialog closes, without losing the submitted query', async () => {
    api.read.mockImplementationOnce((_path, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true })
    }))
    await type('钥匙'); await click('搜索')
    await act(async () => root.render(<SearchTab onOpenFile={onOpen} dialogOpen={false} visible={false} />))
    expect(api.read.mock.calls[0][1].aborted).toBe(true)
    await act(async () => root.render(<SearchTab onOpenFile={onOpen} />))
    expect(host.querySelector('input')?.value).toBe('钥匙')
    expect(host.textContent).toContain('已停止')
  })
})
