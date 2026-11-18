import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { markdownBlocks, markdownToc } from '../../api/markdown'
import type { SearchLocation } from '../../api/search'
import { Icon } from '../../components/Icon'
import { MarkdownBlocksView } from './MarkdownView'

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** 在当前预览内按真实源行定位，已打开文件再次跳转也生效；不读写编辑草稿。 */
export const FilePreview = memo(function FilePreview({ content, location }: { content: string; location?: SearchLocation }) {
  const [tocOpen, setTocOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const blocks = useMemo(() => markdownBlocks(content), [content])
  const toc = useMemo(() => markdownToc(blocks), [blocks])
  useEffect(() => {
    if (!location) return
    const exact = root.current?.querySelector(`[data-source-line="${location.line}"]`)
    const rendered = exact ? [] : [...(root.current?.querySelectorAll<HTMLElement>('[data-source-start]') ?? [])]
    const target = exact?.querySelector('mark') ?? exact ?? rendered.find((block) => Number(block.dataset.sourceEnd) >= location.line) ?? rendered.at(-1)
    target?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'center' })
  }, [location, blocks])
  return <div ref={root} className="mdv-with-toc">
    {toc.length >= 2 ? <>
      <button className="mdv-toc-toggle" aria-expanded={tocOpen} onClick={() => setTocOpen((value) => !value)}>
        <span className={`mdv-toc-arrow ${tocOpen ? 'open' : ''}`}><Icon name="chevron-right" size={12} /></span>目录（{toc.length}）
      </button>
      {tocOpen ? <nav className="mdv-toc" aria-label="文档目录">{toc.map((item) => <button key={item.id} className={`mdv-toc-item lvl${item.lvl}`} onClick={() => {
        const heading = [...(root.current?.querySelectorAll<HTMLElement>('.mdv-h') ?? [])].find((node) => node.id === item.id)
        heading?.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() })
      }}>{item.text}</button>)}</nav> : null}
    </> : null}
    <MarkdownBlocksView blocks={blocks} location={location} />
  </div>
})
