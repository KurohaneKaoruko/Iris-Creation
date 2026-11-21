// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreview } from './FilePreview'

let host: HTMLDivElement
let root: Root
let calls: Element[]

/** jsdom 无布局：记录 scrollIntoView 的接收者与参数，验证定位依据真实源行而非渲染高度。 */
async function open(content: string, location?: { line: number; query: string; caseSensitive: boolean }) {
  await act(async () => root.render(<FilePreview content={content} location={location} />))
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) { calls.push(this) })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('FilePreview source-line targeting', () => {
  it('scrolls to the element owning the exact source line (duplicate headings resolve by line, not anchor order)', async () => {
    const content = '# 山巅\n\n一\n\n## 山巅\n\n- 甲\n- 乙\n\n```\n代码行\n```'
    await open(content, { line: 7, query: '甲', caseSensitive: false })
    expect(calls).toHaveLength(1)
    const owner = calls[0].closest('[data-source-line]')
    expect(owner?.getAttribute('data-source-line')).toBe('7')
    expect(owner?.tagName).toBe('LI')
  })

  it('falls back to the enclosing block, not the document top, when the requested line no longer renders (blank/deleted line)', async () => {
    const content = '# 标题\n\n长段落第一行\n\n第二段'
    await open(content, { line: 2, query: '钥匙', caseSensitive: false })
    expect(calls).toHaveLength(1)
    // 第 2 行是空行：定位到其后第一个块（段落），绝不是文首标题
    expect(calls[0].tagName).toBe('P')
    expect(calls[0].getAttribute('data-source-start')).toBe('3')
  })

  it('never targets an earlier block: a request past the last block lands on the final one', async () => {
    const content = '# 标题\n\n第一段\n\n第二段'
    await open(content, { line: 99, query: '不存在', caseSensitive: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].getAttribute('data-source-end')).toBe('5')
    expect(calls[0].querySelector('[data-source-line]')?.getAttribute('data-source-line')).toBe('5')
  })
})
