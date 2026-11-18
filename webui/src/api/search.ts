/**
 * 作品级全文检索：纯函数核心 + 分批调度。
 * 搜索范围限定 stories/（正文）、concept/（设定）、outline/（大纲）三个作品目录，
 * 不含 .novel/ 等工程内部目录。千章级工程按批搜索、批间让出主线程，避免 UI 冻结。
 * 文件读取由调用方注入（RPC read_text），本模块保持零 IO 可单测。
 */
import { isHiddenWorkspaceEntry, isTextDocument } from './documents'

/** collectScopeFiles 的宽松输入类型（测试可用普通对象模拟 FsEntry） */
export type FsEntryLike = {
  name: string
  path: string
  kind: string
  children?: FsEntryLike[]
}

export type SearchScope = 'stories' | 'concept' | 'outline'

export const SEARCH_SCOPES: Array<{ id: SearchScope; zh: string }> = [
  { id: 'stories', zh: '正文' },
  { id: 'concept', zh: '设定' },
  { id: 'outline', zh: '大纲' },
]

/** 每批搜索的文件数：批间让出主线程 */
export const SEARCH_BATCH_SIZE = 8

/** 单文件命中行数上限（防单文件刷屏） */
export const MAX_HITS_PER_FILE = 20

/** 全部命中总数上限（防 DOM 爆炸），超出截断并提示 */
export const MAX_TOTAL_HITS = 300

/** 命中行上下文行数（前/后各 N 行） */
export const CONTEXT_LINES = 1

/** 命中行展示最大长度（超长行截断为命中词周围窗口） */
export const MAX_LINE_LEN = 200

export type SearchHit = {
  path: string
  /** 1-based 行号 */
  line: number
  /** 命中行文本（超长行已截断，含省略号） */
  text: string
  /** 命中行前上下文（最多 CONTEXT_LINES 行） */
  before: string[]
  /** 命中行后上下文（最多 CONTEXT_LINES 行） */
  after: string[]
}

export type SearchOptions = {
  /** 默认 false（大小写不敏感） */
  caseSensitive?: boolean
}

/** 检索结果保留提交时的关键词和规则，不使用后来输入的新词。 */
export type SearchLocation = { line: number; query: string; caseSensitive: boolean }

/** 按当前文本定位命中；命中已失效时只定位该行，不再选中无关文字。偏移使用 textarea 的 LF 文本。 */
export function locateSearchMatch(content: string, target: SearchLocation) {
  const text = content.replace(/\r\n?/g, '\n')
  const requested = Math.max(1, Math.trunc(target.line))
  let start = 0
  let line = 1
  let next = text.indexOf('\n')
  while (line < requested && next !== -1) {
    start = next + 1
    line += 1
    next = text.indexOf('\n', start)
  }
  const current = text.slice(start, next === -1 ? undefined : next)
  const match = line === requested && isValidQuery(target.query)
    ? new RegExp(escapeRegExp(target.query.trim()), target.caseSensitive ? '' : 'i').exec(current)
    : null
  if (!match) return { line, start, end: start, matched: false }
  return { line, start: start + match.index, end: start + match.index + match[0].length, matched: true }
}

/** 正则元字符转义：用户输入一律按字面量搜索 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 空查询 / 纯空白查询视为无效 */
export function isValidQuery(q: string): boolean {
  return q.trim().length > 0
}

/** 从工作区树收集范围内的 .md/.markdown/.txt 文件（相对路径，已排序） */
export function collectScopeFiles(tree: FsEntryLike, scopes: SearchScope[]): string[] {
  const prefixes = scopes.map((s) => `${s}/`)
  const out: string[] = []
  const walk = (e: FsEntryLike) => {
    if (isHiddenWorkspaceEntry(e.name)) return
    if (e.kind === 'file') {
      if (isTextDocument(e.path) && prefixes.some((p) => e.path.startsWith(p))) out.push(e.path)
    }
    for (const c of e.children ?? []) walk(c)
  }
  for (const child of tree.children ?? []) walk(child)
  out.sort()
  return out
}

/** 超长行截断：以 [index, index+len) 命中窗口为中心取 max 长度，两端加省略号 */
export function truncateAround(text: string, index: number, len: number, max = MAX_LINE_LEN): string {
  if (text.length <= max) return text
  const half = Math.max(0, Math.floor((max - len) / 2))
  const start = Math.max(0, Math.min(index - half, text.length - max))
  const end = start + max
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

export type HighlightPart = { text: string; hit: boolean }

/** 命中词高亮切分：返回原文分段（hit 标记是否命中），匹配行为与搜索一致（字面量 + 大小写开关） */
export function splitHighlight(text: string, query: string, caseSensitive = false): HighlightPart[] {
  if (!isValidQuery(query)) return [{ text, hit: false }]
  const re = new RegExp(escapeRegExp(query.trim()), caseSensitive ? 'g' : 'gi')
  const parts: HighlightPart[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false })
    parts.push({ text: m[0], hit: true })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false })
  return parts
}

/** 在单文件内容中查找全部命中（行号 1-based，带前后上下文，单文件上限 maxHits） */
export function matchInContent(
  path: string,
  content: string,
  query: string,
  opts: SearchOptions & { maxHits?: number; contextLines?: number } = {},
): SearchHit[] {
  if (!isValidQuery(query)) return []
  const word = query.trim()
  const caseSensitive = opts.caseSensitive ?? false
  const maxHits = opts.maxHits ?? MAX_HITS_PER_FILE
  const ctx = opts.contextLines ?? CONTEXT_LINES
  const lines = content.split(/\r\n?|\n/)
  const re = new RegExp(escapeRegExp(word), caseSensitive ? '' : 'i')
  const hits: SearchHit[] = []
  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    const idx = lines[i].search(re)
    if (idx < 0) continue
    hits.push({
      path,
      line: i + 1,
      text: truncateAround(lines[i], idx, word.length),
      before: lines.slice(Math.max(0, i - ctx), i).map((line) => truncateAround(line, 0, 0)),
      after: lines.slice(i + 1, i + 1 + ctx).map((line) => truncateAround(line, 0, 0)),
    })
  }
  return hits
}

export type SearchProgress = {
  /** 扫描的文件总数 */
  total: number
  /** 已完成扫描数 */
  scanned: number
  failed: number
  hits: SearchHit[]
}

export type SearchRunResult = {
  hits: SearchHit[]
  scanned: number
  failed: number
  /** 因达到 MAX_TOTAL_HITS 截断 */
  truncated: boolean
  /** 因取消信号中止 */
  cancelled: boolean
}

/**
 * 分批搜索一批文件：readFile 由调用方注入（RPC read_text），
 * 每批之间让出主线程；终止信号传给所有读取，取消后不再开始下一批。
 */
export async function searchFiles(
  files: string[],
  readFile: (path: string, signal?: AbortSignal) => Promise<string>,
  query: string,
  opts: SearchOptions & {
    batchSize?: number
    /** 读取失败时继续扫描并统计跳过数（默认 true） */
    ignoreErrors?: boolean
    signal?: AbortSignal
    onProgress?: (p: SearchProgress) => void
  } = {},
): Promise<SearchRunResult> {
  const batchSize = Math.max(1, Math.trunc(opts.batchSize ?? SEARCH_BATCH_SIZE) || 1)
  const hits: SearchHit[] = []
  let scanned = 0
  let failed = 0
  let truncated = false
  if (!isValidQuery(query)) return { hits, scanned, failed, truncated, cancelled: false }
  for (let i = 0; i < files.length && !opts.signal?.aborted; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    const contents = await Promise.all(batch.map(async (path) => {
      if (opts.signal?.aborted) return null
      try {
        return await readFile(path, opts.signal)
      } catch (error) {
        if (!opts.signal?.aborted && opts.ignoreErrors === false) throw error
        return null
      }
    }))
    if (opts.signal?.aborted) break
    for (let j = 0; j < batch.length; j++) {
      scanned += 1
      const content = contents[j]
      if (content === null) {
        failed += 1
        continue
      }
      hits.push(...matchInContent(batch[j], content, query, opts))
      if (hits.length >= MAX_TOTAL_HITS) {
        truncated = hits.length > MAX_TOTAL_HITS || scanned < files.length
        hits.length = MAX_TOTAL_HITS
        break
      }
    }
    opts.onProgress?.({ total: files.length, scanned, failed, hits: [...hits] })
    if (hits.length === MAX_TOTAL_HITS) break
    // 让出主线程：批间延迟一次宏任务，UI 可响应输入与渲染
    if (i + batchSize < files.length) await new Promise((r) => setTimeout(r, 0))
  }
  return { hits, scanned, failed, truncated, cancelled: opts.signal?.aborted ?? false }
}
