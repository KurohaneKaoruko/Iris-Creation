import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { BookshelfState, ProjectKind } from '../api/backend'
import {
  forgetWork,
  getBookshelfState,
  rememberExternalProject,
  setWorkspace,
} from '../api/backend'

type ProjectContextValue = {
  /** 书架全量状态（default_projects / external_projects / last_workspace） */
  state: BookshelfState | null
  /** 刷新书架 */
  refresh: () => Promise<void>
  /** 打开任意目录为工程 */
  openDir: (path: string) => Promise<void>
  /** 把目录登记到书架（外部工程） */
  remember: (path: string) => Promise<void>
  /** 从书架移除登记 */
  forget: (path: string) => Promise<void>
  /** 当前打开的工程根目录 */
  workRoot: string | null
  /** 当前工程名（路径末段） */
  workName: string
  workKind: ProjectKind
  opening: boolean
  /** 错误（toast 显示） */
  error: string | null
  setError: (msg: string | null) => void
  /** 当前编辑中的文件（Agent 与文件树共享） */
  activePath: string | null
  setActivePath: (p: string | null) => void
  /** 关闭工程回到启动页 */
  closeWork: () => void
}

const Ctx = createContext<ProjectContextValue | null>(null)

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BookshelfState | null>(null)
  const [work, setWork] = useState<{ root: string; kind: ProjectKind } | null>(null)
  const [opening, setOpening] = useState(false)
  const switchInFlight = useRef(false)
  const shelfRequest = useRef(0)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const request = ++shelfRequest.current
    try {
      const next = await getBookshelfState()
      if (request === shelfRequest.current) setState(next)
    } catch (e) {
      if (request === shelfRequest.current) setError(`加载书架失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  const openDir = useCallback(
    async (path: string) => {
      const p = path.trim()
      if (!p || switchInFlight.current) return
      switchInFlight.current = true
      setOpening(true)
      setError(null)
      try {
        const workspace = await setWorkspace(p)
        // 保留旧版使用的路径键，避免升级后找不到本地恢复草稿和最近文件。
        setWork({ root: p, kind: workspace.kind === 'screenplay' ? 'screenplay' : 'novel' })
        setActivePath(null)
        // 登记到最近列表（外部工程），失败不影响打开
        try {
          await rememberExternalProject(p)
        } catch { /* 已登记过或非目录等情况 */ }
        await refresh()
      } catch (e) {
        setError(`打开目录失败：${e instanceof Error ? e.message : String(e)}`)
        throw e
      } finally {
        switchInFlight.current = false
        setOpening(false)
      }
    },
    [refresh],
  )

  const remember = useCallback(
    async (path: string) => {
      try {
        await rememberExternalProject(path)
        await refresh()
      } catch (e) {
        setError(`登记工程失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [refresh],
  )

  const forget = useCallback(
    async (path: string) => {
      try {
        await forgetWork(path)
        await refresh()
      } catch (e) {
        setError(`移除失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [refresh],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const workRoot = work?.root ?? null
  const workKind = work?.kind ?? 'novel'
  const workName = workRoot?.split(/[/\\]/).filter(Boolean).pop() ?? ''

  const closeWork = useCallback(() => {
    setWork(null)
    setActivePath(null)
    void refresh()
  }, [refresh])

  return (
    <Ctx.Provider
      value={{ state, refresh, openDir, remember, forget, workRoot, workName, workKind, opening, error, setError, activePath, setActivePath, closeWork }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useProject() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useProject must be used within ProjectProvider')
  return v
}
