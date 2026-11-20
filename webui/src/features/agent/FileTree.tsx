import { useState, type MouseEvent } from 'react'
import type { FsEntry } from '../../api/backend'
import { isHiddenWorkspaceEntry, isTextDocument } from '../../api/documents'
import { Icon } from '../../components/Icon'
import './FileTree.css'

type FileTreeProps = {
  entry: FsEntry
  activePath: string | null
  onOpen: (path: string) => void
  onRename: (path: string) => void
  canManage?: (path: string) => boolean
  onDelete: (path: string) => void
  /** 点击回复/树中的文件路径（用于面板跳转） */
  onJumpFile?: (path: string) => void
}

/** 递归文件树：目录可折叠；文件 hover 显示操作；仅 Markdown/文本可打开 */
export function FileTree({ entry, activePath, onOpen, onRename, canManage, onDelete }: FileTreeProps) {
  return <NodeView entry={entry} depth={0} activePath={activePath} onOpen={onOpen} onRename={onRename} canManage={canManage} onDelete={onDelete} />
}

function NodeView({
  entry,
  depth,
  activePath,
  onOpen,
  onRename,
  canManage,
  onDelete,
}: FileTreeProps & { depth: number }) {
  const [open, setOpen] = useState(depth < 2)
  const isDir = entry.kind === 'dir'
  if (depth > 0 && isHiddenWorkspaceEntry(entry.name)) return null
  if (isDir && entry.path.toLowerCase() === 'creative' && canManage && !canManage(entry.path)) return null

  const openable = !isDir && isTextDocument(entry.name)
  const stop = (e: MouseEvent, fn: () => void) => {
    e.stopPropagation()
    fn()
  }

  const children = isDir
    ? [...(entry.children ?? [])].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    : []

  return (
    <div className="ft-node">
      {isDir ? (
        <button
          className={`ft-row ft-dir ${open ? 'open' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ft-caret"><Icon name="chevron-right" size={12} /></span>
          <span className="ft-name">{entry.name}</span>
        </button>
      ) : (
        <div
          className={`ft-row ft-file ${activePath === entry.path ? 'active' : ''} ${openable ? '' : 'disabled'}`}
          style={{ paddingLeft: 8 + depth * 14 + 16 }}
          onClick={() => openable && onOpen(entry.path)}
          title={openable ? entry.path : '非文本文件，不可预览'}
        >
          <span className="ft-name">{entry.name}</span>
          {(!canManage || canManage(entry.path)) ? <span className="ft-actions">
            <button title="重命名" onClick={(e) => stop(e, () => onRename(entry.path))}><Icon name="pencil" size={13} /></button>
            <button title="删除" onClick={(e) => stop(e, () => onDelete(entry.path))}><Icon name="trash" size={13} /></button>
          </span> : null}
        </div>
      )}
      {isDir && open
        ? children.map((c) => (
            <NodeView
              key={c.path}
              entry={c}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
              onRename={onRename}
              canManage={canManage}
              onDelete={onDelete}
            />
          ))
        : null}
    </div>
  )
}
