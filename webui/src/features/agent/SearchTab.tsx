import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SEARCH_SCOPES,
  MAX_TOTAL_HITS,
  collectScopeFiles,
  isValidQuery,
  searchFiles,
  splitHighlight,
  type SearchHit,
  type SearchScope,
  type SearchLocation,
} from '../../api/search'
import { listWorkspaceTree, readText } from '../../api/backend'
import { Icon } from '../../components/Icon'

type Props = {
  onOpenFile: (path: string, location: SearchLocation) => void
  dialogOpen?: boolean
  visible?: boolean
}

/**
 * 「检索」页签：作品级全文检索（stories/concept/outline）。
 * 千章级工程分批扫描（批间让出主线程），可随时取消或改词。
 */
export function SearchTab({ onOpenFile, dialogOpen = true, visible = true }: Props) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [scopes, setScopes] = useState<SearchScope[]>([...SEARCH_SCOPES.map((s) => s.id)])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [running, setRunning] = useState(false)
  const [scanned, setScanned] = useState(0)
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [err, setErr] = useState('')
  const [failed, setFailed] = useState(0)
  const [stopped, setStopped] = useState(false)
  const [submitted, setSubmitted] = useState<{ query: string; caseSensitive: boolean; scopes: SearchScope[] } | null>(null)
  const runIdRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible])

  const abortRun = useCallback(() => {
    runIdRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const run = useCallback(async () => {
    const q = query.trim()
    if (!isValidQuery(q) || scopes.length === 0) return
    controllerRef.current?.abort()
    const runId = ++runIdRef.current
    const controller = new AbortController()
    controllerRef.current = controller
    const signal = controller.signal
    setRunning(true)
    setStopped(false)
    setFailed(0)
    setSubmitted({ query: q, caseSensitive, scopes: [...scopes] })
    setErr('')
    setHits([])
    setScanned(0)
    setTotal(0)
    setTruncated(false)
    try {
      const tree = await listWorkspaceTree(8, signal)
      if (runId !== runIdRef.current) return
      const files = collectScopeFiles(tree, scopes)
      setTotal(files.length)
      const r = await searchFiles(files, readText, q, {
        caseSensitive,
        signal,
        onProgress: (p) => {
          if (runId === runIdRef.current) {
            setScanned(p.scanned)
            setFailed(p.failed)
            setHits(p.hits)
          }
        },
      })
      if (runId !== runIdRef.current) return
      setHits(r.hits)
      setScanned(r.scanned)
      setTruncated(r.truncated)
      setFailed(r.failed)
    } catch (e) {
      if (runId === runIdRef.current && !signal.aborted) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (runId === runIdRef.current) {
        controllerRef.current = null
        setRunning(false)
      }
    }
  }, [caseSensitive, query, scopes])

  const cancel = useCallback(() => {
    abortRun()
    setRunning(false)
    setStopped(true)
  }, [abortRun])

  useEffect(() => abortRun, [abortRun])
  useEffect(() => {
    if (!dialogOpen && controllerRef.current) cancel()
  }, [dialogOpen, cancel])

  const toggleScope = useCallback((s: SearchScope) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  }, [])

  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>()
    for (const h of hits) {
      const arr = m.get(h.path) ?? []
      arr.push(h)
      m.set(h.path, arr)
    }
    return [...m.entries()]
  }, [hits])
  const resultQuery = submitted?.query ?? ''
  const resultCase = submitted?.caseSensitive ?? false
  const filtersChanged = submitted && (query.trim() !== resultQuery || caseSensitive !== resultCase ||
    SEARCH_SCOPES.some(({ id }) => submitted.scopes.includes(id) !== scopes.includes(id)))

  return (
    <div className="srch">
      <div className="tools-runbar">
        <div className="srch-inputwrap">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            className="srch-input"
            aria-label="全文检索关键词"
            value={query}
            placeholder="搜索全作品正文、设定、大纲…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void run()
              }
            }}
          />
          {query ? (
            <button className="srch-clear" title="清空搜索" onClick={() => {
              cancel(); setQuery(''); setHits([]); setScanned(0); setTotal(0); setFailed(0); setErr(''); setSubmitted(null); setStopped(false); setTruncated(false)
              inputRef.current?.focus()
            }}>
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </div>
        {running ? (
          <button className="tools-run" onClick={cancel}>停止</button>
        ) : (
          <button className="tools-run primary" disabled={!isValidQuery(query) || scopes.length === 0} onClick={() => void run()}>
            <Icon name="search" size={14} />搜索
          </button>
        )}
      </div>

      <div className="srch-filters">
        <span className="srch-filter-label">范围</span>
        {SEARCH_SCOPES.map((s) => (
          <button
            key={s.id}
            className={`srch-chip ${scopes.includes(s.id) ? 'on' : ''}`}
            aria-pressed={scopes.includes(s.id)}
            onClick={() => toggleScope(s.id)}
            title={`${s.id}/`}
          >
            {s.zh}
          </button>
        ))}
        <label className="srch-case" title="区分大小写">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          Aa
        </label>
        <span className="srch-progress" role="status" aria-live="polite">
          {running
            ? total > 0 ? `扫描中 ${scanned}/${total}…` : '正在读取文件列表…'
            : hits.length > 0
              ? `${hits.length} 处命中 · ${grouped.length} 个文件${stopped ? ` · 已扫描 ${scanned}/${total}` : ''}${truncated ? `（已达 ${MAX_TOTAL_HITS} 上限，请细化关键词）` : ''}`
              : stopped ? `已停止 · 已扫描 ${scanned}/${total}` : ''}
        </span>
      </div>

      {submitted ? <div className="srch-result-info">
        {running ? '正在检索' : stopped ? '保留已完成的检索结果' : '检索结果'}：<strong>{resultQuery}</strong>
        {' · '}{SEARCH_SCOPES.filter(({ id }) => submitted.scopes.includes(id)).map(({ zh }) => zh).join(' / ')}
        {resultCase ? ' · 区分大小写' : ''}{filtersChanged ? ' · 输入已修改，按 Enter 重新检索' : ''}
      </div> : null}
      {failed > 0 ? <div className="srch-warning" role="status">{failed} 个文件读取失败，结果可能不完整；请检查文件权限后重试。</div> : null}
      {!running && !submitted ? <div className="tools-hint">按 Enter 搜索正文、设定与大纲。结果按文件分组，点击即可定位原文。</div> : null}

      {err ? <div className="tools-err">{err}</div> : null}

      {grouped.length > 0 ? (
        <div className="srch-results">
          {grouped.map(([path, fileHits]) => (
            <div key={path} className="srch-file">
              <div className="srch-file-head">
                <Icon name="file-text" size={13} />
                <span className="srch-path" title={path}>{path}</span>
                <span className="srch-count">{fileHits.length}</span>
              </div>
              {fileHits.map((h) => (
                <button key={h.line} className="srch-hit" onClick={() => onOpenFile(h.path, { line: h.line, query: resultQuery, caseSensitive: resultCase })} title={`${path}:${h.line}`}>
                  <span className="srch-line-no">{h.line}</span>
                  <span className="srch-line-text">
                    <span className="srch-main">
                      {splitHighlight(h.text, resultQuery, resultCase).map((p, j) =>
                        p.hit ? <mark key={j} className="srch-mark">{p.text}</mark> : <span key={j}>{p.text}</span>,
                      )}
                    </span>
                    {h.before.length ? <span className="srch-context">前：{h.before.join(' ')}</span> : null}
                    {h.after.length ? <span className="srch-context">后：{h.after.join(' ')}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : !running && !err && submitted ? (
        <div className="tools-hint">{stopped ? '已停止，可修改关键词后重新检索' : `无匹配结果（已扫描 ${scanned} 个文件）`}</div>
      ) : null}
    </div>
  )
}
