// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickOpen } from './QuickOpen'

let root: Root
let host: HTMLDivElement
const onOpen = vi.fn()
const onClose = vi.fn()
const files = [
  { name: 'chapter-01.md', path: 'stories/chapter-01.md' },
  { name: '人物.md', path: 'concept/人物.md' },
]
const props = { files, titles: new Map([['stories/chapter-01.md', '星海遗歌']]), recentPaths: [], activePath: null, loading: false, onOpen, onClose }

async function key(key: string, composing = false) {
  await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: composing, bubbles: true })))
}
async function type(value: string) {
  const input = host.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<QuickOpen {...props} />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('QuickOpen', () => {
  it('searches chapter titles and opens the exact file path with Enter', async () => {
    await type('星海')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1)
    await key('Enter')
    expect(onOpen).toHaveBeenCalledWith('stories/chapter-01.md')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not execute an IME confirmation or an empty result', async () => {
    await key('Enter', true)
    expect(onOpen).not.toHaveBeenCalled()
    await type('missing')
    await key('ArrowDown')
    expect(host.querySelector('[role="combobox"]')?.getAttribute('aria-activedescendant')).toBeNull()
    await key('Enter')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('supports cycling keyboard navigation and contains Escape', async () => {
    const escaped = vi.fn()
    window.addEventListener('keydown', escaped)
    await key('ArrowUp')
    expect(host.querySelectorAll('[role="option"]')[1].getAttribute('aria-selected')).toBe('true')
    escaped.mockClear()
    await key('Escape')
    expect(onClose).toHaveBeenCalledOnce()
    expect(escaped).not.toHaveBeenCalled()
    window.removeEventListener('keydown', escaped)
  })

  it('keeps a bounded result list for a large chapter collection', async () => {
    await act(async () => root.render(<QuickOpen {...props} files={Array.from({ length: 1000 }, (_, index) => ({ name: `${index}.md`, path: `stories/${index}.md` }))} />))
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(80)
    expect(host.textContent).toContain('80 / 1000')
  })
})
