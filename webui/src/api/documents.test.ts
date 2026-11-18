import { describe, expect, it } from 'vitest'
import { collectDocuments, parseChapterTitles, parseRecentDocuments, rankDocuments, recentDocumentsKey, rememberDocument, resolveDocumentReference } from './documents'
import type { FsEntry } from './backend'

const files = [
  { name: 'chapter-0010.md', path: 'stories/chapter-0010.md' },
  { name: 'chapter-0002.md', path: 'stories/chapter-0002.md' },
  { name: '人物.md', path: 'concept/人物.md' },
  { name: '人物.md', path: 'outline/人物.md' },
]
const titles = new Map([['stories/chapter-0002.md', '第二章 星海遗歌']])

describe('quick-open document index', () => {
  it('does not index hidden or generated folders, but permits a hidden workspace root', () => {
    const tree: FsEntry = { name: '.my-work', kind: 'dir', path: '', children: [
      { name: 'chapter.MARKDOWN', kind: 'file', path: 'stories/chapter.MARKDOWN' },
      { name: 'cover.png', kind: 'file', path: 'cover.png' },
      { name: '.novel', kind: 'dir', path: '.novel', children: [{ name: 'state.md', kind: 'file', path: '.novel/state.md' }] },
      { name: 'node_modules', kind: 'dir', path: 'node_modules', children: [{ name: 'readme.md', kind: 'file', path: 'node_modules/readme.md' }] },
    ] }
    expect(collectDocuments(tree)).toEqual([{ name: 'chapter.MARKDOWN', path: 'stories/chapter.MARKDOWN' }])
    expect(collectDocuments(null)).toEqual([])
  })

  it('finds chapters by metadata title and supports space-separated path/title terms', () => {
    expect(rankDocuments(files, titles, [], '星海')[0].path).toBe('stories/chapter-0002.md')
    expect(rankDocuments(files, titles, [], 'stories 星海')).toHaveLength(1)
    expect(rankDocuments(files, titles, [], 'unmatched')).toHaveLength(0)
  })

  it('normalizes full-width Latin text, case and Windows paths', () => {
    expect(rankDocuments(files, titles, [], 'ＳＴＯＲＩＥＳ\\CHAPTER-0002.MD')[0].path).toBe('stories/chapter-0002.md')
  })

  it('prefers an exact path over recent or same-name files', () => {
    expect(rankDocuments(files, titles, ['outline/人物.md'], 'concept/人物.md')[0].path).toBe('concept/人物.md')
  })

  it('sorts empty-query results by recency then natural chapter order', () => {
    const ranked = rankDocuments(files.slice(0, 2), titles, [], '')
    expect(ranked.map((file) => file.path)).toEqual(['stories/chapter-0002.md', 'stories/chapter-0010.md'])
    expect(rankDocuments(files, titles, ['outline/人物.md'], '')[0].path).toBe('outline/人物.md')
  })

  it('validates metadata without breaking file search on malformed JSON', () => {
    for (const raw of ['null', '{}', '{', '{"chapters":{}}']) expect(parseChapterTitles(raw).size).toBe(0)
    const value = parseChapterTitles(JSON.stringify({ chapters: [null, {}, { filePath: 'stories\\one.md', title: ' 星海 ' }] }))
    expect(value.get('stories/one.md')).toBe('星海')
  })

  it('deduplicates and bounds recent files, with keys isolated by workspace', () => {
    expect(rememberDocument(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    const paths = ['a', 'b']
    expect(rememberDocument(paths, 'a')).toBe(paths)
    expect(rememberDocument(Array.from({ length: 20 }, (_, index) => `${index}`), 'new')).toHaveLength(12)
    expect(parseRecentDocuments('["a",7,"a",null,"b"]')).toEqual(['a', 'b'])
    expect(parseRecentDocuments('{broken')).toEqual([])
    expect(recentDocumentsKey('/one')).not.toBe(recentDocumentsKey('/two'))
  })

  it('does not arbitrarily choose the first of duplicate basenames', () => {
    expect(resolveDocumentReference(files, '人物.md')).toHaveLength(2)
    expect(resolveDocumentReference(files, '.\\concept\\人物.md')).toEqual([files[2]])
    expect(resolveDocumentReference(files, '')).toEqual([])
  })
})
