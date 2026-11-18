/** 只读预览与目录共用源行解析，避免按页面高度估算检索位置。行号从 1 开始。 */
type SourceLine = { text: string; line: number }
export type MarkdownBlock = { start: number; end: number } & (
  | { kind: 'heading'; level: number; id: string; text: string }
  | { kind: 'list'; ordered: boolean; lines: SourceLine[] }
  | { kind: 'paragraph' | 'quote' | 'code'; lines: SourceLine[] }
  | { kind: 'rule' }
)

const heading = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const fence = /^\s{0,3}(`{3,}|~{3,})/
const rule = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const list = /^\s*(?:([-*+])|\d+\.)\s+/
const quote = /^\s*>\s?/

export function markdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split(/\r\n?|\n/)
  const blocks: MarkdownBlock[] = []
  const seen = new Map<string, number>()
  const usedIds = new Set<string>()
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) { i += 1; continue }
    const start = i + 1
    const opening = lines[i].match(fence)
    if (opening) {
      const closing = new RegExp(`^\\s{0,3}${opening[1][0]}{${opening[1].length},}\\s*$`)
      const code: SourceLine[] = []
      i += 1
      while (i < lines.length && !closing.test(lines[i])) { code.push({ text: lines[i], line: i + 1 }); i += 1 }
      if (i < lines.length) i += 1
      blocks.push({ kind: 'code', start, end: i, lines: code })
      continue
    }
    const title = lines[i].match(heading)
    if (title) {
      const text = title[2].trim()
      const base = `mdv-toc-${text.replace(/[*`_]/g, '').trim()}`
      let count = seen.get(base) ?? 0
      let id = count ? `${base}-${count}` : base
      while (usedIds.has(id)) id = `${base}-${++count}`
      seen.set(base, count + 1)
      usedIds.add(id)
      blocks.push({ kind: 'heading', start, end: start, text, level: title[1].length, id })
      i += 1
      continue
    }
    if (rule.test(lines[i])) { blocks.push({ kind: 'rule', start, end: start }); i += 1; continue }
    if (quote.test(lines[i])) {
      const quoted: SourceLine[] = []
      while (i < lines.length && quote.test(lines[i])) { quoted.push({ text: lines[i].replace(quote, ''), line: i + 1 }); i += 1 }
      blocks.push({ kind: 'quote', start, end: i, lines: quoted })
      continue
    }
    const item = lines[i].match(list)
    if (item) {
      const ordered = !item[1]
      const items: SourceLine[] = []
      while (i < lines.length) {
        const next = lines[i].match(list)
        if (!next || (!next[1]) !== ordered || rule.test(lines[i])) break
        items.push({ text: lines[i].slice(next[0].length), line: i + 1 })
        i += 1
      }
      blocks.push({ kind: 'list', start, end: i, lines: items, ordered })
      continue
    }
    const paragraph: SourceLine[] = [{ text: lines[i], line: i + 1 }]
    i += 1
    while (i < lines.length && lines[i].trim() && !heading.test(lines[i]) && !fence.test(lines[i]) && !rule.test(lines[i]) && !quote.test(lines[i]) && !list.test(lines[i])) {
      paragraph.push({ text: lines[i], line: i + 1 })
      i += 1
    }
    blocks.push({ kind: 'paragraph', start, end: i, lines: paragraph })
  }
  return blocks
}

export function markdownToc(blocks: MarkdownBlock[]) {
  return blocks.flatMap((block) => block.kind === 'heading' && block.level <= 3
    ? [{ lvl: block.level, text: block.text.replace(/[*`_]/g, '').trim(), id: block.id }]
    : [])
}
