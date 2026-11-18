// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownView } from './MarkdownView'
import { markdownBlocks, markdownToc } from '../../api/markdown'

const extractToc = (content: string) => markdownToc(markdownBlocks(content))

describe('extractToc', () => {
  it('提取 h1-h3 并生成去重锚点', () => {
    const toc = extractToc('# 第一章\n\n## 场景 A\n\n### 细节\n\n## 场景 A')
    expect(toc.map((t) => t.lvl)).toEqual([1, 2, 3, 2])
    expect(toc[0].id).toBe('mdv-toc-第一章')
    expect(toc[3].id).toBe('mdv-toc-场景 A-1') // 重复标题去重
  })

  it('跳过代码块内的 # 注释与 fence 标记', () => {
    const toc = extractToc('# 正文标题\n\n```bash\n# 这不是标题\n```\n\n## 第二章')
    expect(toc.map((t) => t.text)).toEqual(['正文标题', '第二章'])
  })

  it('剥离行内标记字符', () => {
    const toc = extractToc('## **加粗** 与 `码`')
    expect(toc[0].text).toBe('加粗 与 码')
  })

  it('does not reuse an anchor already occupied by a literally suffixed heading', () => {
    const toc = extractToc('# 标题\n# 标题-1\n# 标题')
    expect(toc.map((entry) => entry.id)).toEqual(['mdv-toc-标题', 'mdv-toc-标题-1', 'mdv-toc-标题-2'])
  })
})

describe('MarkdownView 锚点渲染', () => {
  it('标题带 id 供 TOC 跳转', () => {
    const html = renderToStaticMarkup(<MarkdownView content={'# 第一章\n\n正文'} />)
    expect(html).toContain('id="mdv-toc-第一章"')
    expect(html).toContain('mdv-h1')
  })

  it('preserves real source lines across paragraphs, lists, quotes, code and CRLF', () => {
    const content = '# 标题\r\n\r\n正文\r\n第二行\r\n\r\n- 列表\r\n\r\n> 引用\r\n\r\n```\r\n代码\r\n```'
    const holder = document.createElement('div')
    holder.innerHTML = renderToStaticMarkup(<MarkdownView content={content} />)
    for (const [line, text] of [[1, '标题'], [3, '正文'], [4, '第二行'], [6, '列表'], [8, '引用'], [11, '代码']]) {
      expect(holder.querySelector(`[data-source-line="${line}"]`)?.textContent).toContain(text)
    }
  })

  it('keeps headings inside long or tilde fences out of the TOC', () => {
    const content = '# 主标题\n~~~~\n# 不是标题\n~~~~\n````\n```\n# 仍在代码内\n````\n## 正文'
    expect(extractToc(content).map((entry) => entry.text)).toEqual(['主标题', '正文'])
  })

  it('uses matching duplicate anchors even after an h4 with the same title', () => {
    const content = '#### 同名\n\n## 同名 ###'
    const toc = extractToc(content)
    const html = renderToStaticMarkup(<MarkdownView content={content} />)
    expect(toc[0].id).toBe('mdv-toc-同名-1')
    expect(html).toContain(`id="${toc[0].id}"`)
  })

  it('highlights only the requested source line and safely escapes source HTML', () => {
    const html = renderToStaticMarkup(<MarkdownView content={'命中\n\n**命中** <script>alert(1)</script>'} location={{ line: 3, query: '命中', caseSensitive: false }} />)
    expect((html.match(/<mark/g) ?? [])).toHaveLength(1)
    expect(html).toContain('mdv-source-target')
    expect(html).not.toContain('<script>')
  })

  it('does not merge ordered and unordered lists or swallow a following horizontal rule', () => {
    expect(markdownBlocks('1. first\n- next\n\nparagraph\n---').map((block) => block.kind)).toEqual(['list', 'list', 'paragraph', 'rule'])
  })
})
