import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { rankDocuments, type DocumentFile } from '../../api/documents'
import { Icon } from '../../components/Icon'
import './CommandPalette.css'
import './QuickOpen.css'

const RESULT_LIMIT = 80

type Props = {
  files: DocumentFile[]
  titles: ReadonlyMap<string, string>
  recentPaths: string[]
  activePath: string | null
  loading: boolean
  initialQuery?: string
  onOpen: (path: string) => void
  onClose: () => void
}

/** 文件名、章节标题与路径的统一入口；不读取正文，不抢占 Ctrl/Cmd+K 命令面板。 */
export function QuickOpen({ files, titles, recentPaths, activePath, loading, initialQuery = '', onOpen, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const results = useMemo(() => rankDocuments(files, titles, recentPaths, query), [files, titles, recentPaths, query])
  const visible = results.slice(0, RESULT_LIMIT)
  const index = Math.max(0, Math.min(active, visible.length - 1))
  const selected = visible[index]
  const recent = useMemo(() => new Set(recentPaths), [recentPaths])

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${index}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [index, query])

  function pick(path: string) {
    onClose()
    onOpen(path)
  }

  return (
    <div className="cmdk-overlay" onClick={onClose} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        event.preventDefault()
        const target = document.activeElement === inputRef.current ? closeRef.current : inputRef.current
        target?.focus()
      }
    }}>
      <section className="cmdk quick-open" role="dialog" aria-modal="true" aria-label="快速打开文件" onClick={(event) => event.stopPropagation()}>
        <div className="quick-open-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="cmdk-input"
            role="combobox"
            aria-label="文件名、章节标题或路径"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={selected ? `${id}-option-${index}` : undefined}
            value={query}
            placeholder="搜索文件名、章节标题或路径…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive(visible.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length : 0)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (selected) pick(selected.path)
              }
            }}
          />
          <button ref={closeRef} className="agw-iconbtn" onClick={onClose} aria-label="关闭快速打开"><Icon name="x" size={16} /></button>
        </div>
        <div className="cmdk-list" id={`${id}-list`} role="listbox" aria-label="匹配文件" ref={listRef} aria-busy={loading}>
          {visible.length === 0 ? <div className="cmdk-empty">{loading ? '正在更新文件索引…' : query.trim() ? '没有匹配文件，试试部分标题或目录名。' : '尚无可打开的文档，请先新建章节或导入作品。'}</div> : visible.map((file, position) => (
            <button
              key={file.path}
              id={`${id}-option-${position}`}
              role="option"
              aria-selected={position === index}
              tabIndex={-1}
              data-idx={position}
              className={`cmdk-item ${position === index ? 'active' : ''}`}
              onMouseEnter={() => setActive(position)}
              onClick={() => pick(file.path)}
              title={file.path}
            >
              <Icon name="file-text" size={16} />
              <span className="quick-open-file"><strong>{file.title}</strong><span>{file.path}</span></span>
              {file.path === activePath ? <span className="quick-open-state">当前</span> : recent.has(file.path) ? <Icon name="clock" size={13} /> : null}
            </button>
          ))}
        </div>
        <div className="cmdk-foot quick-open-foot" role="status">
          <span>{results.length > RESULT_LIMIT ? `显示前 ${RESULT_LIMIT} / ${results.length} 个，请继续筛选` : `${results.length} 个文档${query.trim() ? '' : ' · 最近打开优先'}`}</span>
          <span><kbd>↑↓</kbd>选择 <kbd>Enter</kbd>打开 <kbd>Esc</kbd>关闭</span>
        </div>
      </section>
    </div>
  )
}
