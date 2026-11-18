import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import './CommandPalette.css'

export type Command = {
  id: string
  label: string
  hint?: string
  keywords?: string
  icon?: IconName
  run: () => void
}

type Props = {
  commands: Command[]
  onClose: () => void
}

/** Ctrl+K 命令面板：模糊过滤 + 上下键选择 + Enter 执行 */
export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const id = useId()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ''} ${c.hint ?? ''}`.toLowerCase().includes(q),
    )
  }, [commands, query])
  const selectedIndex = Math.max(0, Math.min(active, filtered.length - 1))

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    // 键盘选择跟随滚动
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex])

  const pick = (i: number) => {
    const cmd = filtered[i]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  return (
    <div className="cmdk-overlay" onClick={onClose} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      if (event.key === 'Tab') { event.preventDefault(); inputRef.current?.focus() }
    }}>
      <div className="cmdk glass-panel" role="dialog" aria-modal="true" aria-label="命令面板" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          role="combobox"
          aria-label="搜索命令"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={filtered[selectedIndex] ? `${id}-option-${selectedIndex}` : undefined}
          value={query}
          placeholder="输入命令或搜索…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive(filtered.length ? (selectedIndex + 1) % filtered.length : 0)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive(filtered.length ? (selectedIndex + filtered.length - 1) % filtered.length : 0)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(selectedIndex)
            }
          }}
        />
        <div className="cmdk-list" id={`${id}-list`} role="listbox" aria-label="匹配命令" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmdk-empty">无匹配命令</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                data-idx={i}
                id={`${id}-option-${i}`}
                role="option"
                aria-selected={i === selectedIndex}
                tabIndex={-1}
                className={`cmdk-item ${i === selectedIndex ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <span className="cmdk-icon">{c.icon ? <Icon name={c.icon} size={15} /> : <span className="cmdk-dot" />}</span>
                <span className="cmdk-label">{c.label}</span>
                {c.hint ? <span className="cmdk-hint">{c.hint}</span> : null}
              </button>
            ))
          )}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  )
}
