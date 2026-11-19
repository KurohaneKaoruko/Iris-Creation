import type { FsEntry } from './backend'

export type DocumentFile = Pick<FsEntry, 'name' | 'path'>

export const CHAPTER_METADATA_PATH = '.novel/.settings/chapters.json'

export function isHiddenWorkspaceEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === 'target'
}

export function isTextDocument(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path)
}

export const isScenePath = (path: string | null) => !!path && /^scenes\/[^./\\:][^/\\:]*\.(?:md|markdown)$/i.test(path)

export function collectDocuments(tree: FsEntry | null): DocumentFile[] {
  const result: DocumentFile[] = []
  function walk(entry: FsEntry) {
    if (isHiddenWorkspaceEntry(entry.name)) return
    if (entry.kind === 'file' && isTextDocument(entry.path)) result.push({ name: entry.name, path: entry.path })
    for (const child of entry.children ?? []) walk(child)
  }
  for (const child of tree?.children ?? []) walk(child)
  return result
}

export function parseChapterTitles(raw: string): Map<string, string> {
  const titles = new Map<string, string>()
  try {
    const parsed = JSON.parse(raw) as { chapters?: unknown[] } | null
    if (!Array.isArray(parsed?.chapters)) return titles
    for (const item of parsed.chapters) {
      const record = item as { filePath?: unknown; title?: unknown } | null
      if (typeof record?.filePath === 'string' && typeof record.title === 'string' && record.title.trim()) {
        titles.set(record.filePath.replace(/\\/g, '/'), record.title.trim())
      }
    }
  } catch { /* 标题元数据不可读时仍可按路径查找 */ }
  return titles
}

export const RECENT_DOCUMENT_LIMIT = 12

export function rememberDocument(paths: string[], path: string): string[] {
  if (paths[0] === path) return paths
  return [path, ...paths.filter((previous) => previous !== path)].slice(0, RECENT_DOCUMENT_LIMIT)
}

export function recentDocumentsKey(workRoot: string): string {
  return `iris-recent-documents:${workRoot}`
}

export function parseRecentDocuments(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (Array.isArray(value)) return [...new Set(value.filter((path): path is string => typeof path === 'string' && !!path))].slice(0, RECENT_DOCUMENT_LIMIT)
  } catch { /* 暂存损坏时从空列表开始 */ }
  return []
}

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\\/g, '/')
const basename = (file: DocumentFile) => file.name.replace(/\.(md|markdown|txt)$/i, '')
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function rankDocuments(files: DocumentFile[], titles: ReadonlyMap<string, string>, recentPaths: string[], query: string) {
  const term = normalize(query.trim()).replace(/^\.\//, '')
  const words = term ? term.split(/\s+/) : []
  const recent = new Map(recentPaths.map((path, index) => [path, index]))
  return files.flatMap((file) => {
    const title = titles.get(file.path) ?? basename(file)
    const name = normalize(file.name)
    const label = normalize(title)
    const path = normalize(file.path)
    const haystack = `${label} ${name} ${path}`
    if (words.some((word) => !haystack.includes(word))) return []
    const score = !term ? 0 :
      path === term ? 5 :
        label === term || name === term || normalize(basename(file)) === term ? 4 :
          label.startsWith(term) || name.startsWith(term) ? 3 :
            label.includes(term) || name.includes(term) ? 2 : path.includes(term) ? 1 : 0
    return [{ ...file, title, score, recent: recent.get(file.path) ?? Infinity }]
  }).sort((a, b) => b.score - a.score || a.recent - b.recent || collator.compare(a.path, b.path))
}

/** 完整路径优先；同名引用有歧义时交给用户选择，不打开第一个碰巧匹配的文件。 */
export function resolveDocumentReference(files: DocumentFile[], reference: string): DocumentFile[] {
  const path = reference.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path) return []
  const exact = files.find((file) => file.path === path)
  return exact ? [exact] : files.filter((file) => file.path.endsWith(`/${path}`))
}
