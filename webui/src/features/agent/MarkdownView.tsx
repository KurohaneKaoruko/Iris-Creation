import { useMemo, type ReactNode } from 'react'
import { markdownBlocks, type MarkdownBlock } from '../../api/markdown'
import { splitHighlight, type SearchLocation } from '../../api/search'

export function MarkdownView({ content, location }: { content: string; location?: SearchLocation }) {
  const blocks = useMemo(() => markdownBlocks(content), [content])
  return <MarkdownBlocksView blocks={blocks} location={location} />
}

export function MarkdownBlocksView({ blocks, location }: { blocks: MarkdownBlock[]; location?: SearchLocation }) {
  const focus = location?.line
  const text = (value: string, line: number) => line !== focus ? value : splitHighlight(value, location?.query ?? '', location?.caseSensitive)
    .map((part, index) => part.hit ? <mark key={index} className="mdv-search-mark">{part.text}</mark> : part.text)

  function inline(value: string, line: number) {
    const result: ReactNode[] = []
    const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(value))) {
      if (match.index > last) result.push(text(value.slice(last, match.index), line))
      if (match[2]) result.push(<strong key={match.index}>{text(match[2], line)}</strong>)
      else if (match[3]) result.push(<em key={match.index}>{text(match[3], line)}</em>)
      else result.push(<code key={match.index} className="mdv-inline-code">{text(match[4], line)}</code>)
      last = match.index + match[0].length
    }
    if (last < value.length) result.push(text(value.slice(last), line))
    return result
  }

  return <div className="mdv">{blocks.map((block) => {
    const source = { 'data-source-start': block.start, 'data-source-end': block.end }
    const lineClass = (line: number) => line === focus ? 'mdv-source-target' : undefined
    if (block.kind === 'heading') {
      const Tag = `h${block.level}` as 'h1'
      return <Tag key={block.start} {...source} data-source-line={block.start} id={block.id} className={`mdv-h mdv-h${block.level} ${lineClass(block.start) ?? ''}`}>{inline(block.text, block.start)}</Tag>
    }
    if (block.kind === 'rule') return <hr key={block.start} {...source} data-source-line={block.start} className={`mdv-hr ${lineClass(block.start) ?? ''}`} />
    if (block.kind === 'list') {
      const List = block.ordered ? 'ol' : 'ul'
      return <List key={block.start} {...source} className="mdv-list">{block.lines.map((line) => <li key={line.line} data-source-line={line.line} className={lineClass(line.line)}>{inline(line.text, line.line)}</li>)}</List>
    }
    if (block.kind === 'code') return <pre key={block.start} {...source} className="mdv-code"><code>{block.lines.map((line, index) => <span key={line.line} data-source-line={line.line} className={lineClass(line.line)}>{text(line.text, line.line)}{index < block.lines.length - 1 ? '\n' : ''}</span>)}</code></pre>
    const children = block.lines.map((line, index) => <span key={line.line} data-source-line={line.line} className={lineClass(line.line)}>{inline(line.text, line.line)}{index < block.lines.length - 1 ? '\n' : ''}</span>)
    return block.kind === 'quote'
      ? <blockquote key={block.start} {...source} className="mdv-quote">{children}</blockquote>
      : <p key={block.start} {...source} className="mdv-p">{children}</p>
  })}</div>
}
