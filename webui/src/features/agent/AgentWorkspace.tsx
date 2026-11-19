import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FsEntry } from '../../api/backend'
import { createDir, createFile, listWorkspaceTree, readText, renameEntry, deleteEntry as del, writeTextIfCurrent, getSkills, getChatSession, saveChatSession, deleteChatSession, getAppSettings, getApiKeyStatus, exportWork, type Skill, type ChatMessagePayload } from '../../api/backend'
import { listChapters, createChapterFile, loadWritingHistory, recordTodayWords } from '../../api/novel'
import { subscribeEvent } from '../../api/rpc'
import { useProject } from '../../state/ProjectContext'
import { useChat, type ChatItem } from '../../hooks/useChat'
import { useTheme } from '../../state/ThemeContext'
import { Icon } from '../../components/Icon'
import { SessionSidebar } from './SessionSidebar'
import { FileTree } from './FileTree'
import { FilePreview } from './FilePreview'
import { CommandPalette, type Command } from './CommandPalette'
import { QuickOpen } from './QuickOpen'
import {
  CHAPTER_METADATA_PATH, collectDocuments, isHiddenWorkspaceEntry, isScenePath, isTextDocument, parseChapterTitles,
  parseRecentDocuments, recentDocumentsKey, rememberDocument, resolveDocumentReference,
} from '../../api/documents'
import { locateSearchMatch, type SearchLocation } from '../../api/search'
import { listScenes, type Scene } from '../../api/screenplay'
import { sessionToMarkdown } from '../../api/sessionExport'
import { Markdown } from './Markdown'
import { StepCard } from './StepCard'
import { PromptDialog, ConfirmDialog } from '../workspace/Dialogs'
import { SettingsDialog } from './SettingsDialog'
import { ToolsDialog, type ToolsTab } from './ToolsDialog'
import { StudioDialog } from './StudioDialog'
import { ChaptersPanel } from './ChaptersPanel'
import { NewSceneDialog, ScenePanel } from './ScenePanel'
import { LorePanel } from './LorePanel'
import { DiffView } from './DiffView'
import { findHits, nextHit, type FindHit } from '../../api/editorFind'
import { revealEditorSelection } from './editorSelection'
import { editorDraftKey, parseEditorDraft, shouldOfferDraftRecovery, type EditorDraft } from '../../api/editorDraft'
import './AgentWorkspace.css'

/** Blob 触发浏览器下载 */
function downloadText(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * 主流 Agent 布局（ChatGPT/Claude/Cline 综合）：
 * [会话侧栏] [中央对话流：消息 + 工具步骤卡 + 悬浮输入] [Artifacts 文件面板（可折叠）]
 */
export function AgentWorkspace() {
  const { workRoot, workName, workKind, activePath, setActivePath, setError, closeWork } = useProject()
  const screenplay = workKind === 'screenplay'
  const { theme, toggleTheme } = useTheme()
  const chat = useChat(workRoot ?? undefined)
  const [tree, setTree] = useState<FsEntry | null>(null)
  const [indexBusy, setIndexBusy] = useState(true)
  const indexRun = useRef(0)
  const [documentTitles, setDocumentTitles] = useState<Map<string, string>>(() => new Map())
  const [scenes, setScenes] = useState<Scene[]>([])
  const [sceneListError, setSceneListError] = useState('')
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    try { return parseRecentDocuments(localStorage.getItem(recentDocumentsKey(workRoot ?? ''))) } catch { return [] }
  })
  const documents = useMemo(() => collectDocuments(tree), [tree])
  const [quickOpen, setQuickOpen] = useState<{ query: string } | null>(null)
  const [fileLocation, setFileLocation] = useState<{ path: string; target: SearchLocation } | null>(null)
  const [editorJump, setEditorJump] = useState<SearchLocation | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileLoadError, setFileLoadError] = useState(false)
  const [fileLoadAttempt, setFileLoadAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [externalChange, setExternalChange] = useState<{ path: string; at: number } | null>(null)
  const [diskConflict, setDiskConflict] = useState<{ path: string; content: string } | null>(null)
  const [previewMode, setPreviewMode] = useState<'content' | 'history'>('content')
  const [skills, setSkills] = useState<Skill[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  // 右侧文件面板默认常驻（对标主流 Agent 三栏）；极窄屏（<900px）才退化为覆盖抽屉
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 900)
  const [panelTab, setPanelTab] = useState<'tree' | 'chapters' | 'lore' | 'file'>(screenplay ? 'chapters' : 'tree')
  const [dialog, setDialog] = useState<
    | { kind: 'new-file' }
    | { kind: 'new-dir' }
    | { kind: 'new-chapter' }
    | { kind: 'new-scene' }
    | { kind: 'rename'; path: string; name: string }
    | { kind: 'delete'; path: string }
    | null
  >(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsTab, setToolsTab] = useState<ToolsTab>(screenplay ? 'search' : 'planner')
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioToolId, setStudioToolId] = useState<string | null>(null)
  /** 编辑器选中文本（选中时显示浮动工坊按钮） */
  const [selection, setSelection] = useState('')
  const [selRange, setSelRange] = useState<{ start: number; end: number } | null>(null)
  /** 编辑器内查找条（Ctrl+F 唤起） */
  const [findOpen, setFindOpen] = useState(false)
  const [pendingGuard, setPendingGuard] = useState<{ description: string; action: () => void } | null>(null)
  const [recoveryDraft, setRecoveryDraft] = useState<EditorDraft | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [keyMissing, setKeyMissing] = useState(false)
  const savedSigRef = useRef('')
  const sessionIdRef = useRef<string | null>(null)
  const draftBaselineRef = useRef('')
  const editingRef = useRef(editing)
  const fileContentRef = useRef(fileContent)
  const saveInFlight = useRef(false)
  editingRef.current = editing
  fileContentRef.current = fileContent
  const hasUnsavedChanges = editing && editDraft !== draftBaselineRef.current
  const activeLocation = fileLocation?.path === activePath ? fileLocation.target : undefined
  const canBeginEdit = !fileLoading && !fileLoadError && !recoveryDraft && previewMode === 'content'
  const isActiveScene = screenplay && isScenePath(activePath)
  const studioCanEdit = !!activePath && canBeginEdit && !saving

  const openStudio = useCallback((toolId: string | null = null) => {
    setStudioToolId(toolId)
    setStudioOpen(true)
  }, [])

  const guardUnsavedAction = useCallback((description: string, action: () => void) => {
    if (saveInFlight.current) return
    if (hasUnsavedChanges) {
      setPendingGuard({ description, action })
      return
    }
    action()
  }, [hasUnsavedChanges])

  const navigateToPath = useCallback((path: string, location?: SearchLocation) => {
    if (path === activePath) {
      setPanelOpen(true)
      setPanelTab('file')
      if (fileLoadError) setFileLoadAttempt((value) => value + 1)
      if (location) {
        setPreviewMode('content')
        setFileLocation({ path, target: { ...location } })
        if (editing && !saveInFlight.current) {
          setFindOpen(false)
          setEditorJump({ ...location })
        }
      }
      return
    }
    guardUnsavedAction('切换文件', () => {
      setFileLocation(location ? { path, target: location } : null)
      setEditing(false)
      setPreviewMode('content')
      setEditorJump(null)
      setFileLoading(true)
      setActivePath(path)
      setPanelOpen(true)
      setPanelTab('file')
    })
  }, [activePath, editing, fileLoadError, guardUnsavedAction, setActivePath])

  const beginEdit = (location?: SearchLocation) => {
    draftBaselineRef.current = fileContent
    setEditDraft(fileContent)
    setPreviewMode('content')
    setEditing(true)
    setEditorJump(location ?? null)
  }

  const continueEditing = () => {
    if (saveInFlight.current) return
    setPendingGuard(null)
    editorRef.current?.focus()
  }

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (activePath) {
        try { localStorage.setItem(editorDraftKey(workRoot ?? '', activePath), JSON.stringify({ baseContent: draftBaselineRef.current, draft: editDraft, savedAt: Date.now() })) } catch { /* storage unavailable */ }
      }
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [hasUnsavedChanges, activePath, workRoot, editDraft])

  const refreshTree = useCallback(async () => {
    if (!workRoot) return
    const run = ++indexRun.current
    setIndexBusy(true)
    try {
      const [nextTree, index] = await Promise.allSettled([
        listWorkspaceTree(8, undefined, workRoot),
        screenplay ? listScenes(workRoot) : readText(CHAPTER_METADATA_PATH, undefined, workRoot).catch(() => ''),
      ])
      if (run !== indexRun.current) return
      if (nextTree.status === 'fulfilled') setTree(nextTree.value)
      else setError(`读取目录失败：${nextTree.reason instanceof Error ? nextTree.reason.message : String(nextTree.reason)}`)
      if (index.status === 'fulfilled') {
        if (typeof index.value === 'string') setDocumentTitles(parseChapterTitles(index.value))
        else {
          setScenes(index.value)
          setSceneListError('')
          setDocumentTitles(new Map(index.value.map((scene) => [scene.path, scene.title])))
        }
      } else if (screenplay) {
        setSceneListError(`读取场次失败：${index.reason instanceof Error ? index.reason.message : String(index.reason)}`)
      }
    } finally {
      if (run === indexRun.current) setIndexBusy(false)
    }
  }, [screenplay, workRoot, setError])

  useEffect(() => {
    void refreshTree()
    return () => { indexRun.current += 1 }
  }, [refreshTree])

  useEffect(() => {
    try { localStorage.setItem(recentDocumentsKey(workRoot ?? ''), JSON.stringify(recentPaths)) } catch { /* storage unavailable */ }
  }, [recentPaths, workRoot])

  useEffect(() => {
    if (!editorJump || !editing || !editorRef.current) return
    const element = editorRef.current
    const hit = locateSearchMatch(element.value, editorJump)
    element.focus()
    revealEditorSelection(element, hit)
    setEditorJump(null)
  }, [editorJump, editing])

  useEffect(() => {
    void getSkills().then(setSkills).catch(() => setSkills([]))
  }, [])

  // 检查激活 Provider 是否已配 Key：未配则顶栏红点提醒
  useEffect(() => {
    void (async () => {
      try {
        const s = await getAppSettings()
        if (!s.providers.length) {
          setKeyMissing(true)
          return
        }
        const active = s.providers.find((p) => p.id === s.active_provider_id) ?? s.providers[0]
        setKeyMissing(!(await getApiKeyStatus(active.id).catch(() => false)))
      } catch {
        setKeyMissing(false)
      }
    })()
  }, [settingsOpen])

  useEffect(() => {
    let timer = 0
    let alive = true
    let activeChanged = false
    const un = subscribeEvent('fs_changed', (raw) => {
      const p = (raw ?? {}) as { path?: string; kind?: string }
      // 读取正文/目录本身会产生 Access 事件：不应再次触发读取和刷新。
      if (p.kind === 'access' || p.path?.startsWith('.novel/.history/')) return
      if (p.path === activePath) activeChanged = true
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void refreshTree()
        if (activePath && activeChanged) {
          activeChanged = false
          const changedPath = activePath
          void readText(activePath, undefined, workRoot ?? undefined).then((c) => {
            if (!alive) return
            if (editingRef.current) {
              if (c !== fileContentRef.current) setDiskConflict({ path: changedPath, content: c })
            } else {
              setFileContent(c)
              setEditDraft(c)
              draftBaselineRef.current = c
            }
            // 非编辑态下文件被外部（Agent）修改时，给一条可关闭的提示
            setExternalChange((prev) => (prev?.path === changedPath ? prev : { path: changedPath, at: Date.now() }))
          }).catch(() => {})
        }
      }, 600)
    })
    return () => {
      alive = false
      window.clearTimeout(timer)
      un()
    }
  }, [refreshTree, activePath, workRoot])

  useEffect(() => {
    setEditing(false)
    setPreviewMode('content')
    setFindOpen(false)
    setDiskConflict(null)
    setExternalChange(null)
    setRecoveryDraft(null)
    setPendingGuard(null)
    setFileLoadError(false)
    setSelection('')
    setSelRange(null)
    setFileContent('')
    setEditDraft('')
    if (!activePath) {
      setFileLoading(false)
      return
    }
    let alive = true
    setFileLoading(true)
    const controller = new AbortController()
    readText(activePath, controller.signal, workRoot ?? undefined)
      .then((c) => {
        if (!alive) return
        setFileContent(c)
        setEditDraft(c)
        draftBaselineRef.current = c
        setFileLoading(false)
        setRecentPaths((paths) => rememberDocument(paths, activePath))
        const key = editorDraftKey(workRoot ?? '', activePath)
        let savedDraft: EditorDraft | null = null
        try { savedDraft = parseEditorDraft(localStorage.getItem(key)) } catch { /* storage disabled */ }
        if (shouldOfferDraftRecovery(savedDraft, c)) setRecoveryDraft(savedDraft)
        else {
          setRecoveryDraft(null)
          if (savedDraft) { try { localStorage.removeItem(key) } catch { /* storage disabled */ } }
        }
      })
      .catch((e) => {
        if (!alive) return
        setFileLoadError(true)
        setError(`读取失败：${e instanceof Error ? e.message : String(e)}`)
        setFileLoading(false)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [activePath, fileLoadAttempt, workRoot, setError])

  useEffect(() => {
    if (!editing || !activePath) return
    const key = editorDraftKey(workRoot ?? '', activePath)
    if (editDraft === draftBaselineRef.current) {
      try { localStorage.removeItem(key) } catch { /* storage unavailable */ }
      return
    }
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({ baseContent: draftBaselineRef.current, draft: editDraft, savedAt: Date.now() }))
      } catch { /* local storage full/private mode: in-memory editing remains available */ }
    }, 700)
    return () => window.clearTimeout(timer)
  }, [editing, editDraft, activePath, workRoot])

  // Agent 提到文件 / 写文件 → 面板亮起
  useEffect(() => {
    const last = chat.messages[chat.messages.length - 1]
    if (last?.role === 'assistant' && (last.steps?.some((s) => s.writePath) || /`[^`]+\.(?:md|markdown|txt)`/.test(last.content))) {
      setPanelOpen(true)
    }
  }, [chat.messages])

  // ---- 会话持久化：流结束后自动保存；打开历史会话 ----
  useEffect(() => {
    if (chat.busy) {
      savedSigRef.current = '' // 新一轮流：待流结束后重新保存
      return
    }
    const msgs = chat.messages
    const hasAssistant = msgs.some((m) => m.role === 'assistant' && !m.streaming && (m.content.trim() || m.failed))
    if (!hasAssistant) return
    const sig = msgs.map((m) => `${m.role}:${m.content}`).join('\u0000')
    if (sig === savedSigRef.current) return
    savedSigRef.current = sig
    if (!sessionIdRef.current) {
      sessionIdRef.current = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setActiveSessionId(sessionIdRef.current)
    }
    const payload: ChatMessagePayload[] = msgs
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }))
    void saveChatSession({
      id: sessionIdRef.current,
      workspace_root: workRoot ?? '',
      messages: payload,
    })
      .catch(() => {})
  }, [chat.busy, chat.messages, workRoot])

  const loadSession = useCallback(
    async (id: string) => {
      try {
        const s = await getChatSession(id)
        sessionIdRef.current = id
        setActiveSessionId(id)
        savedSigRef.current = (s.messages ?? []).map((m) => `${m.role}:${m.content}`).join('\u0000')
        chat.restore((s.messages ?? []).map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: String(m.content ?? '') })))
      } catch {
        /* ignore */
      }
    },
    [chat],
  )

  const newSession = useCallback(() => {
    sessionIdRef.current = null
    setActiveSessionId(null)
    savedSigRef.current = ''
    chat.clear()
  }, [chat])

  /** 删除历史会话；若删的是当前会话则同时清空对话区 */
  const deleteSession = useCallback(
    async (id: string) => {
      await deleteChatSession(id)
      if (sessionIdRef.current === id) {
        sessionIdRef.current = null
        setActiveSessionId(null)
        savedSigRef.current = ''
        chat.clear()
      }
    },
    [chat],
  )

  // 独立的文件与命令入口；弹层内 Escape 不穿透退出专注写作。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || settingsOpen || toolsOpen || studioOpen || dialog || pendingGuard) return
      if (e.key === 'Escape' && focusMode) {
        setFocusMode(false)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setQuickOpen(null)
        setPaletteOpen((v) => !v)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteOpen(false)
        setQuickOpen((value) => value ? null : { query: '' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode, settingsOpen, toolsOpen, studioOpen, dialog, pendingGuard])

  const paletteCommands = useMemo(() => ([
    { id: 'new-session', icon: 'plus', label: '新建会话', hint: 'Ctrl+K 后回车', run: () => guardUnsavedAction('新建会话', newSession) },
    { id: 'quick-open', icon: 'search', label: '快速打开文件', hint: 'Ctrl+P', keywords: 'file open 文件 章节 标题 path', run: () => setQuickOpen({ query: '' }) },
    { id: 'new-chapter', icon: screenplay ? 'clapperboard' : 'file-plus', label: screenplay ? '新建场次' : '新建章节', keywords: 'scene chapter 写作', run: () => setDialog({ kind: screenplay ? 'new-scene' : 'new-chapter' }) },
    ...(screenplay ? [{ id: 'scenes', icon: 'list-checks' as const, label: '显示场次列表', keywords: 'screenplay 分场', run: () => { setPanelOpen(true); setPanelTab('chapters') } }] : []),
    { id: 'new-file', icon: 'file-plus', label: '新建 Markdown 文件', keywords: 'file create', run: () => setDialog({ kind: 'new-file' }) },
    { id: 'new-dir', icon: 'folder-plus', label: '新建目录', keywords: 'folder mkdir', run: () => setDialog({ kind: 'new-dir' }) },
    { id: 'studio', icon: 'sparkles', label: screenplay ? '剧本工坊' : '创作工坊', keywords: 'studio 工坊 创作 头脑风暴 场景 对话 润色 翻译 摘要', run: () => openStudio() },
    { id: 'studio-brainstorm', icon: 'sparkles', label: screenplay ? '工坊：分场大纲' : '工坊：头脑风暴', keywords: '工坊 点子 创意 brainstorm', run: () => openStudio(screenplay ? 'script-outline' : 'brainstorm') },
    { id: 'studio-polish', icon: 'pencil', label: screenplay ? '工坊：对白润色' : '工坊：润色文本', keywords: '工坊 润色 polish 改写', run: () => openStudio(screenplay ? 'script-dialogue' : 'polish') },
    { id: 'studio-critique', icon: 'search', label: screenplay ? '工坊：场次审阅' : '工坊：专业评审', keywords: '工坊 评审 critique 编辑', run: () => openStudio(screenplay ? 'script-review' : 'critique') },
    { id: 'tools-search', icon: 'search', label: '全文检索', keywords: '工具 search 检索 搜索 全文 查找 find', run: () => { setToolsTab('search'); setToolsOpen(true) } },
    { id: 'tools-planner', icon: 'list-checks', label: 'AI 任务队列', keywords: '工具 任务 拆解 队列 planner 章节 连续生成', run: () => { setToolsTab('planner'); setToolsOpen(true) } },
    { id: 'tools-stats', icon: 'chart', label: '作品统计', keywords: '工具 stats 统计', run: () => { setToolsTab('stats'); setToolsOpen(true) } },
    { id: 'tools-export', icon: 'download', label: screenplay ? '导出剧本' : '导出中心', keywords: 'export 导出 整稿 txt markdown dossier', run: () => { setToolsTab('export'); setToolsOpen(true) } },
    { id: 'tools-backup', icon: 'package', label: '备份报告', keywords: 'backup 备份 sha256', run: () => { setToolsTab('backup'); setToolsOpen(true) } },
    { id: 'tools-consistency', icon: 'list-checks', label: '一致性检查', keywords: '工具 检查 consistency 人物 伏笔 情节线', run: () => { setToolsTab('consistency'); setToolsOpen(true) } },
    { id: 'tools-lint', icon: 'scale', label: '正文铁律体检', keywords: '工具 lint 体检 套路', run: () => { setToolsTab('lint'); setToolsOpen(true) } },
    { id: 'tools-import', icon: 'file-input', label: '导入切章', keywords: '工具 导入 import txt 切章', run: () => { setToolsTab('import'); setToolsOpen(true) } },
    { id: 'toggle-panel', icon: 'panel-right', label: panelOpen ? '隐藏文件面板' : '显示文件面板', keywords: 'panel 文件', run: () => setPanelOpen((v) => !v) },
    { id: 'toggle-sidebar', icon: 'panel-left', label: sidebarCollapsed ? '展开会话栏' : '折叠会话栏', keywords: 'sidebar 会话', run: () => setSidebarCollapsed((v) => !v) },
    { id: 'toggle-theme', icon: theme === 'dark' ? 'sun' : 'moon', label: '切换主题', keywords: 'theme dark light 主题', run: toggleTheme },
    { id: 'settings', icon: 'settings', label: '打开设置', keywords: 'settings provider key 设置', run: () => setSettingsOpen(true) },
    {
      id: 'export-md',
      icon: 'download',
      label: '导出整本（Markdown）',
      keywords: 'export 导出',
      run: () => {
        void exportWork('md').then(({ filename, content }) => downloadText(filename, content))
      },
    },
    {
      id: 'export-txt',
      icon: 'download',
      label: '导出整本（TXT）',
      keywords: 'export 导出',
      run: () => {
        void exportWork('txt').then(({ filename, content }) => downloadText(filename, content))
      },
    },
    { id: 'focus-writing', icon: 'focus', label: focusMode ? '退出沉浸写作' : '沉浸写作', keywords: 'focus writing editor 沉浸', run: () => {
      if (!activePath) { setPanelOpen(true); setPanelTab('chapters'); return }
      setFocusMode((v) => !v); setPanelOpen(true); setPanelTab('file')
    } },
    { id: 'close-work', icon: 'log-out', label: '关闭工程（返回启动页）', keywords: 'close launch', run: () => guardUnsavedAction('关闭作品', closeWork) },
  ] satisfies Command[]).filter((command) => !screenplay || !['tools-planner', 'tools-stats', 'tools-consistency', 'tools-lint', 'tools-import', 'export-md', 'export-txt'].includes(command.id)), [newSession, panelOpen, sidebarCollapsed, focusMode, theme, toggleTheme, closeWork, guardUnsavedAction, activePath, openStudio, screenplay])

  const jumpToFile = useCallback(
    (p: string, location?: SearchLocation) => {
      if (location) { navigateToPath(p, location); return } // 检索已拿到完整路径，不做同名回退。
      const matches = resolveDocumentReference(documents, p)
      if (matches.length === 1) { navigateToPath(matches[0].path); return }
      if (matches.length > 1) { setQuickOpen({ query: p }); return }
      // Agent 刚写入的完整相对路径可能早于目录刷新；让实际读取决定是否存在，不静默失效。
      const path = p.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (isTextDocument(path) && path.split('/').every((part) => part && !isHiddenWorkspaceEntry(part) && !part.includes(':'))) navigateToPath(path)
      else setError('无法定位该文档，请使用快速打开选择文件。')
    },
    [documents, navigateToPath, setError],
  )

  const runDialog = useCallback(
    async (action: typeof dialog, value: string, bypassGuard = false) => {
      if (!action) return
      if (!bypassGuard && (action.kind === 'delete' || action.kind === 'rename') && activePath === action.path && hasUnsavedChanges) {
        setPendingGuard({
          description: action.kind === 'delete' ? '删除当前文件' : '重命名当前文件',
          action: () => { void runDialog(action, value, true) },
        })
        return
      }
      try {
        if (action.kind === 'new-file') {
          await createFile(value, workRoot ?? undefined)
          await refreshTree()
          navigateToPath(value)
        } else if (action.kind === 'new-chapter') {
          const existing = await listChapters()
          const p = await createChapterFile(value.trim() || `第${existing.length + 1}章`)
          await refreshTree()
          navigateToPath(p)
        } else if (action.kind === 'new-dir') {
          await createDir(value, workRoot ?? undefined)
          await refreshTree()
        } else if (action.kind === 'rename') {
          const idx = action.path.lastIndexOf('/')
          const to = idx >= 0 ? `${action.path.slice(0, idx)}/${value}` : value
          await renameEntry(action.path, to, workRoot ?? undefined)
          if (activePath === action.path) {
            setActivePath(to)
            setPanelTab('file')
          }
          await refreshTree()
        } else if (action.kind === 'delete') {
          await del(action.path, workRoot ?? undefined)
          if (activePath === action.path) setActivePath(null)
          await refreshTree()
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setDialog(null)
      }
    },
    [activePath, hasUnsavedChanges, navigateToPath, refreshTree, setActivePath, setError, workRoot],
  )

  /** 编辑器选区捕获：供浮动工坊按钮取用 */
  const captureSelection = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const { selectionStart: start, selectionEnd: end } = el
    const sel = el.value.slice(start, end)
    setSelRange(start < end ? { start, end } : null)
    setSelection(sel.length > 0 && sel.length <= 12000 ? sel : '')
  }, [])

  /** 用工坊结果替换编辑器原选区（润改闭环：旧文删除、新文就位、光标落在新文末尾） */
  const replaceSelection = useCallback((text: string) => {
    // Textarea selection offsets are computed from LF text, including for CRLF files.
    setEditDraft((d) => applyReplaceSelection(d.replace(/\r\n?/g, '\n'), selRange, selection, text))
    setEditing(true)
    setSelection('')
    setSelRange(null)
  }, [selRange, selection])

  const saveEdit = useCallback(async (force = false): Promise<boolean> => {
    if (!activePath || fileLoading || fileLoadError || saveInFlight.current) return false
    saveInFlight.current = true
    setSaving(true)
    try {
      if (!force) {
        // The draft baseline must survive crash recovery even when disk has changed since it was written.
        await writeTextIfCurrent(activePath, editDraft, draftBaselineRef.current, workRoot ?? undefined)
      } else {
        if (diskConflict?.path !== activePath) return false
        // Explicit overwrites only accept the version that triggered the conflict, never a third version.
        await writeTextIfCurrent(activePath, editDraft, diskConflict.content, workRoot ?? undefined)
      }
      // 写作统计闭环：章节文件保存时按日累计净增字数（非章节文档不计入）
      if (!screenplay && /^stories\/.*\.(md|txt)$/i.test(activePath)) {
        const delta = editDraft.replace(/\s/g, '').length - fileContent.replace(/\s/g, '').length
        if (delta > 0) {
          await loadWritingHistory().then(({ dailyGoal: goal }) => recordTodayWords(delta, goal)).catch(() => {})
        }
      }
      setFileContent(editDraft)
      setDiskConflict(null)
      setExternalChange(null)
      draftBaselineRef.current = editDraft
      try { localStorage.removeItem(editorDraftKey(workRoot ?? '', activePath)) } catch { /* storage disabled */ }
      setEditing(false)
      void refreshTree()
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/changed on disk/i.test(message)) {
        try {
          setDiskConflict({ path: activePath, content: await readText(activePath, undefined, workRoot ?? undefined) })
        } catch {
          setError('磁盘版本无法读取，请先复制当前草稿再继续。')
        }
        return false
      }
      setError(`保存失败：${message}`)
      return false
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }, [activePath, diskConflict, editDraft, fileContent, fileLoading, fileLoadError, refreshTree, screenplay, setError, workRoot])

  return (
    <div className={`agw ${focusMode ? 'agw-focus-mode' : ''}`}>
      <header className="agw-head">
        <span className="agw-name">{workName}</span>
        <span className="agw-badge">{screenplay ? '剧本' : '小说'}</span>
        <span className="agw-spacer" />
        <button className="agw-iconbtn" onClick={() => setPaletteOpen(true)} title="命令面板（Ctrl+K）">
          <Icon name="command" size={17} />
        </button>
        <button className="agw-iconbtn" onClick={() => setQuickOpen({ query: '' })} title="快速打开文件（Ctrl+P）"><Icon name="search" size={16} /></button>
        <button className={`agw-btn agw-focus-toggle ${focusMode ? 'active' : ''}`} onClick={() => {
          if (!activePath && !focusMode) { setPanelOpen(true); setPanelTab('chapters'); return }
          setFocusMode((v) => !v); setPanelOpen(true); setPanelTab('file')
        }} title={activePath ? '隐藏会话与工具栏，专注写作' : '先在作品面板打开正文'}>
          <Icon name="focus" size={15} /><span>{focusMode ? '退出专注' : '专注写作'}</span>
        </button>
        <button className="agw-iconbtn agw-studio-toggle" onClick={() => openStudio()} title={screenplay ? '剧本工坊' : '创作工坊'}>
          <Icon name="sparkles" size={16} />
        </button>
        <button className="agw-iconbtn" onClick={() => setToolsOpen(true)} title="工具中心">
          <Icon name="wrench" size={17} />
        </button>
        <button className="agw-iconbtn" onClick={() => setSettingsOpen(true)} title="模型与密钥设置">
          <Icon name="settings" size={17} />
          {keyMissing ? <span className="agw-dot" /> : null}
        </button>
        <button className="agw-iconbtn" onClick={toggleTheme} title="切换主题">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
        <span className="agw-head-sep" />
        <button className="agw-btn" onClick={() => setPanelOpen((v) => !v)}>
          <Icon name="panel-right" size={15} />
           {panelOpen ? '隐藏面板' : screenplay ? '作品面板' : '文件面板'}
        </button>
      </header>

      <div className="agw-main">
        <SessionSidebar
          activeSessionId={activeSessionId}
          onNewSession={() => guardUnsavedAction('新建会话', newSession)}
          onLoadSession={(id) => guardUnsavedAction('切换会话', () => { void loadSession(id) })}
          onDeleteSession={(id) => void deleteSession(id)}
          onCloseWork={() => guardUnsavedAction('关闭作品', closeWork)}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
        />

        <ChatColumn chat={chat} skills={skills} workName={workName} screenplay={screenplay} workspaceRoot={workRoot ?? undefined} onJumpFile={jumpToFile} onOpenSettings={() => setSettingsOpen(true)} />

        {panelOpen ? <button className="agw-mobile-scrim" aria-label="关闭文件面板" onClick={() => setPanelOpen(false)} /> : null}
        {panelOpen ? (
          <aside className="agw-side glass-panel">
            <div className="agw-side-tabs">
              <button className={panelTab === 'tree' ? 'active' : ''} onClick={() => setPanelTab('tree')}>文件</button>
              <button className={panelTab === 'chapters' ? 'active' : ''} onClick={() => setPanelTab('chapters')}>{screenplay ? '场次' : '章节'}</button>
              {!screenplay ? <button className={panelTab === 'lore' ? 'active' : ''} onClick={() => setPanelTab('lore')}>设定</button> : null}
              <button className={panelTab === 'file' ? 'active' : ''} disabled={!activePath} onClick={() => setPanelTab('file')}>预览</button>
              <span className="agw-side-spacer" />
              <button className="agw-iconbtn sm" title="新建文件" onClick={() => setDialog({ kind: 'new-file' })}><Icon name="file-plus" size={15} /></button>
              <button className="agw-iconbtn sm" title="新建目录" onClick={() => setDialog({ kind: 'new-dir' })}><Icon name="folder-plus" size={15} /></button>
              <button className="agw-iconbtn sm agw-mobile-close" title="关闭面板" onClick={() => setPanelOpen(false)}><Icon name="x" size={15} /></button>
            </div>

            {panelTab === 'tree' ? (
              <div className="agw-tree">
                {tree ? (
                  <FileTree
                     entry={tree}
                     activePath={activePath}
                     canManage={(path) => !screenplay || !/^scenes\//i.test(path)}
                    onOpen={(p) => {
                      navigateToPath(p)
                    }}
                    onRename={(p) => guardUnsavedAction('重命名文件', () => setDialog({ kind: 'rename', path: p, name: p.split('/').pop() ?? p }))}
                    onDelete={(p) => guardUnsavedAction('删除文件', () => setDialog({ kind: 'delete', path: p }))}
                  />
                ) : (
                  <div className="agw-empty">加载中…</div>
                )}
              </div>
            ) : panelTab === 'lore' ? (
              <LorePanel
                activePath={activePath}
                onOpen={(p) => {
                  navigateToPath(p)
                }}
              />
            ) : panelTab === 'chapters' ? (
              screenplay && workRoot ? <ScenePanel workspace={workRoot} scenes={scenes} activePath={activePath} loading={indexBusy} loadError={sceneListError}
                onOpen={navigateToPath} onNew={() => setDialog({ kind: 'new-scene' })} onRefresh={refreshTree}
                onExport={() => { setToolsTab('export'); setToolsOpen(true) }} onOutline={() => navigateToPath('outline/outline.md')}
                onCharacters={() => navigateToPath('concept/characters.md')} /> : <ChaptersPanel
                activePath={activePath}
                onOpen={(p) => {
                  navigateToPath(p)
                }}
                onNewChapter={() => setDialog({ kind: 'new-chapter' })}
                onImport={() => {
                  setToolsTab('import')
                  setToolsOpen(true)
                }}
              />
            ) : (
              <div className="agw-file">
                {activePath ? (
                  <>
                    <div className={`agw-file-head${isActiveScene ? ' agw-scene-head' : ''}`}>
                      <span className="agw-file-path" title={activePath}>{isActiveScene ? documentTitles.get(activePath) ?? activePath : activePath}</span>
                      <span className="agw-file-actions">
                        {editing ? (
                          <>
                            <span className={`agw-save-state ${hasUnsavedChanges ? 'dirty' : 'saved'}`}>{hasUnsavedChanges ? '未保存' : '已保存'}</span>
                            <button className="agw-btn primary" disabled={saving} onClick={() => void saveEdit()}>{saving ? '保存中…' : '保存'}</button>
                            <button className="agw-btn" disabled={saving} onClick={() => guardUnsavedAction('放弃未保存修改', () => { try { localStorage.removeItem(editorDraftKey(workRoot ?? '', activePath)) } catch {} setEditDraft(fileContent); setEditing(false) })}>取消</button>
                          </>
                        ) : previewMode === 'content' ? (
                          <>
                            <button className="agw-btn" disabled={!canBeginEdit} onClick={() => beginEdit(activeLocation)}>编辑</button>
                            <button className="agw-btn" disabled={fileLoading || fileLoadError} onClick={() => window.dispatchEvent(new CustomEvent('agent-attach-file', { detail: activePath }))} title="作为 Agent 上下文">给 Agent</button>
                            {isActiveScene ? <button className="agw-btn" onClick={() => openStudio('script-review')} disabled={fileLoading || fileLoadError}><Icon name="sparkles" size={13} />场次审阅</button> : null}
                            <button className="agw-btn" disabled={fileLoading || fileLoadError || !!recoveryDraft} onClick={() => setPreviewMode('history')} title="变更历史与版本恢复">历史</button>
                          </>
                        ) : null}
                      </span>
                    </div>
                    {activeLocation && !fileLoading && !fileLoadError ? (
                      <div className="agw-location-note" role="status">
                        <span title={activeLocation.query}>第 {activeLocation.line} 行{activeLocation.query ? ` · ${activeLocation.query}` : ''}</span>
                        {canBeginEdit && !editing ? <button onClick={() => beginEdit(activeLocation)}>编辑此处</button> : null}
                        <button aria-label="清除检索定位" onClick={() => setFileLocation(null)}><Icon name="x" size={12} /></button>
                      </div>
                    ) : null}
                    {isActiveScene && editing ? <p className="agw-scene-guide">首行 # 标题 · 内/外景 · 地点 · 时间 · 对白示例：**角色：** 台词</p> : null}
                    {diskConflict && diskConflict.path === activePath && editing ? (
                      <div className="agw-conflict-note" role="alert">
                        <div><strong>磁盘内容已被其他操作修改</strong><span>为避免静默覆盖，请选择载入新内容或明确覆盖。</span></div>
                        <button disabled={saving} onClick={() => {
                          setFileContent(diskConflict.content)
                          setEditDraft(diskConflict.content)
                          draftBaselineRef.current = diskConflict.content
                          setDiskConflict(null)
                          setEditing(false)
                          try { localStorage.removeItem(editorDraftKey(workRoot ?? '', activePath)) } catch { /* storage disabled */ }
                        }}>载入磁盘版本</button>
                        <button className="danger" disabled={saving} onClick={() => void saveEdit(true)}>仍覆盖</button>
                      </div>
                    ) : null}
                    {externalChange && externalChange.path === activePath && !editing && !diskConflict ? (
                      <div className="agw-external-note">
                        <span><Icon name="refresh" size={13} /> 此文件刚被更新（可能来自 Agent 写入）</span>
                        <button onClick={() => setExternalChange(null)}>知道了</button>
                      </div>
                    ) : null}
                    {recoveryDraft && !editing ? (
                      <div className="agw-recovery-note" role="status">
                        <div><strong>找到未保存的本地草稿</strong><span>{recoveryDraft.baseContent === fileContent ? '原文件未变化' : '磁盘文件已变化，请确认后恢复'}</span></div>
                         <button onClick={() => {
                           draftBaselineRef.current = recoveryDraft.baseContent
                           setEditDraft(recoveryDraft.draft)
                           if (recoveryDraft.baseContent !== fileContent) setDiskConflict({ path: activePath, content: fileContent })
                          setPreviewMode('content')
                          setEditing(true)
                          setEditorJump(activeLocation ?? null)
                          setRecoveryDraft(null)
                        }}>恢复草稿</button>
                        <button className="quiet" onClick={() => { try { localStorage.removeItem(editorDraftKey(workRoot ?? '', activePath)) } catch {} setRecoveryDraft(null) }}>丢弃</button>
                      </div>
                    ) : null}
                    <div className="agw-file-body">
                      {fileLoadError ? <div className="agw-empty" role="alert">读取文件失败，未保存的草稿仍保留在本地。<br /><button className="agw-btn" onClick={() => setFileLoadAttempt((value) => value + 1)}>重新读取</button></div> : previewMode === 'history' && activePath ? (
                         <DiffView
                           key={activePath}
                          path={activePath}
                          workspaceRoot={workRoot ?? undefined}
                          currentContent={fileContent}
                          onClose={() => setPreviewMode('content')}
                          onRestored={() => {
                            setFileLoadAttempt((value) => value + 1)
                            void refreshTree()
                          }}
                        />
                      ) : fileLoading ? (
                        <div className="agw-empty">加载中…</div>
                      ) : editing ? (
                        <div className="agw-editorwrap">
                          <div className="agw-find-anchor">
                            <textarea
                              ref={editorRef}
                              className="agw-editor"
                              aria-label={isActiveScene ? '场次编辑器' : '正文编辑器'}
                              disabled={saving}
                              value={editDraft}
                              onChange={(e) => setEditDraft(e.target.value)}
                               onKeyDown={(e) => {
                                 if (e.nativeEvent.isComposing || e.keyCode === 229) return
                                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                                  e.preventDefault()
                                  void saveEdit()
                                } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                                  e.preventDefault()
                                  if (findOpen) findInputRef.current?.focus()
                                  else setFindOpen(true)
                                }
                              }}
                              onMouseUp={captureSelection}
                              onKeyUp={captureSelection}
                              autoFocus
                            />
                            {findOpen ? (
                              <EditorFindBar
                                text={editDraft}
                                editorRef={editorRef}
                                inputRef={findInputRef}
                                onClose={() => setFindOpen(false)}
                              />
                            ) : null}
                          </div>
                          {selection.trim() ? (
                            <div className="agw-selbar">
                              <span className="agw-selcount">已选 {selection.length} 字</span>
                              <button
                                className="agw-selbtn"
                                onClick={() => {
                                  openStudio(screenplay ? 'script-dialogue' : 'polish')
                                }}
                              >
                                <Icon name="sparkles" size={12} />
                                {screenplay ? '对白润色' : '润色'}
                              </button>
                              {!screenplay ? <><button
                                className="agw-selbtn"
                                onClick={() => {
                                  setStudioToolId('expand')
                                  setStudioOpen(true)
                                }}
                              >
                                <Icon name="sparkles" size={12} />
                                扩写
                               </button>
                              <button
                                className="agw-selbtn"
                                onClick={() => {
                                  setStudioToolId('rewrite-style')
                                  setStudioOpen(true)
                                }}
                              >
                                <Icon name="refresh" size={12} />
                                改文风
                               </button></> : null}
                              <button
                                className="agw-selbtn"
                                onClick={() => {
                                  openStudio(screenplay ? 'script-review' : 'critique')
                                }}
                              >
                                <Icon name="search" size={12} />
                                评审
                              </button>
                              <button
                                className="agw-selbtn"
                                onClick={() => {
                                  setStudioToolId(null)
                                  setStudioOpen(true)
                                }}
                                title="带着选中文本打开创作工坊自选工具"
                              >
                                <Icon name="arrow-right" size={12} />
                                更多工具
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <FilePreview key={activePath} content={fileContent} location={activeLocation} />
                      )}
                    </div>
                  </>
                ) : (
                  <div className="agw-empty">未选择文件</div>
                )}
              </div>
            )}
          </aside>
        ) : null}
      </div>

      {dialog?.kind === 'new-file' ? (
        <PromptDialog title="新建 Markdown 文件" placeholder="outline/ch-0002.md" onConfirm={(v: string) => void runDialog(dialog, v)} onCancel={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'new-dir' ? (
        <PromptDialog title="新建目录" placeholder="concept" onConfirm={(v: string) => void runDialog(dialog, v)} onCancel={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'new-chapter' ? (
        <PromptDialog title="新建章节" placeholder="第3章 灯塔（留空自动编号）" onConfirm={(v: string) => void runDialog(dialog, v)} onCancel={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'new-scene' && workRoot ? <NewSceneDialog workspace={workRoot}
        onClose={() => setDialog(null)} onCreated={(scene) => { setDialog(null); void refreshTree(); navigateToPath(scene.path) }} /> : null}
      {dialog?.kind === 'rename' ? (
        <PromptDialog title="重命名" initialValue={dialog.name} onConfirm={(v: string) => void runDialog(dialog, v)} onCancel={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog title="删除确认" message={`确认删除 ${dialog.path}？`} danger onConfirm={() => void runDialog(dialog, '')} onCancel={() => setDialog(null)} />
      ) : null}

      {pendingGuard ? (
        <div className="modal-overlay" onClick={continueEditing} onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.stopPropagation()
            continueEditing()
          }
        }}>
          <div className="dialog-box glass-panel agw-unsaved-dialog" role="alertdialog" aria-modal="true" aria-labelledby="agw-unsaved-title" onClick={(e) => e.stopPropagation()}>
            <div className="agw-unsaved-icon"><Icon name="save" size={18} /></div>
            <h3 className="dialog-title" id="agw-unsaved-title">还有修改没有保存</h3>
            <p className="dialog-message">先保存当前内容，再{pendingGuard.description}？</p>
            <div className="dialog-actions">
              <button className="dialog-btn" disabled={saving} autoFocus onClick={continueEditing}>继续编辑</button>
              <button className="dialog-btn danger" disabled={saving} onClick={() => {
                const action = pendingGuard.action
                setPendingGuard(null)
                if (activePath) { try { localStorage.removeItem(editorDraftKey(workRoot ?? '', activePath)) } catch {} }
                setEditing(false)
                setEditDraft(fileContent)
                action()
              }}>放弃修改</button>
              <button className="dialog-btn primary" disabled={saving} onClick={() => {
                const action = pendingGuard.action
                void saveEdit(!!diskConflict && diskConflict.path === activePath).then((ok) => {
                  if (!ok) return
                  setPendingGuard(null)
                  action()
                })
              }}>{diskConflict && diskConflict.path === activePath ? '覆盖并继续' : '保存并继续'}</button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {paletteOpen ? <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} /> : null}
      {quickOpen ? <QuickOpen files={documents} titles={documentTitles} screenplay={screenplay} recentPaths={recentPaths} activePath={activePath} loading={indexBusy} initialQuery={quickOpen.query} onClose={() => setQuickOpen(null)} onOpen={navigateToPath} /> : null}
      <ToolsDialog
        open={toolsOpen}
        tab={toolsTab}
        screenplay={screenplay}
        workspaceRoot={workRoot ?? undefined}
        sceneCount={scenes.length}
        onTabChange={setToolsTab}
        onClose={() => setToolsOpen(false)}
        onOpenFile={(path, location) => {
          setToolsOpen(false)
          jumpToFile(path, location)
        }}
      />
      {studioOpen ? (
        <StudioDialog
          workKind={workKind}
          workspaceRoot={workRoot ?? undefined}
          initialToolId={studioToolId ?? undefined}
          initialText={selection || (studioToolId === 'script-review' && isActiveScene && studioCanEdit ? (editing ? editDraft : fileContent).slice(0, 12000) : undefined)}
          activePath={studioCanEdit ? activePath : null}
          activeContent={studioCanEdit ? (editing ? editDraft : fileContent) : ''}
          onInsertToEditor={(text) => {
            if (!studioCanEdit) return
            if (!editing) draftBaselineRef.current = fileContent
            setEditDraft((d) => {
              const current = editing ? d : fileContent
              return current ? `${current}\n\n${text}` : text
            })
            setEditing(true)
          }}
          canReplaceSelection={studioCanEdit && editing && !!selRange && !!selection.trim()}
          onReplaceSelection={replaceSelection}
          onOpenSavedScene={(path) => { void refreshTree(); navigateToPath(path) }}
          onClose={() => {
            setStudioOpen(false)
            setSelection('')
            setSelRange(null)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * 选区替换纯函数：选区仍与捕获时一致 → 原位替换；已失效（内容被改过）→
 * 退化为追加，绝不错删用户文本。
 */
export function applyReplaceSelection(
  draft: string,
  range: { start: number; end: number } | null,
  original: string,
  replacement: string,
): string {
  if (!range || draft.slice(range.start, range.end) !== original) {
    return draft ? `${draft}\n\n${replacement}` : replacement
  }
  return draft.slice(0, range.start) + replacement + draft.slice(range.end)
}

/* ============ 编辑器内查找条 ============ */

type FindBarProps = {
  text: string
  editorRef: React.RefObject<HTMLTextAreaElement | null>
  inputRef: React.Ref<HTMLInputElement>
  onClose: () => void
}

/** 章节编辑器查找条：Ctrl+F 唤起 / Esc 关闭；命中计数 + 上一个/下一个循环 + selection 定位。 */
function EditorFindBar({ text, editorRef, inputRef, onClose }: FindBarProps) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [idx, setIdx] = useState<number | null>(null)
  const lastCriteria = useRef({ query: '', caseSensitive: false })

  const normalized = useMemo(() => text.replace(/\r\n?/g, '\n'), [text])
  const hits = useMemo<FindHit[]>(() => findHits(normalized, query, caseSensitive), [normalized, query, caseSensitive])

  /** 把命中应用到 textarea：选中并滚动到可视区中央 */
  const applyHit = useCallback(
    (hit: FindHit | null) => {
      const el = editorRef.current
      if (!el || !hit) return
      revealEditorSelection(el, hit)
    },
    [editorRef],
  )

  const go = useCallback(
    (next: boolean) => {
      const el = editorRef.current
      const current = hits.findIndex((hit) => hit.start === el?.selectionStart && hit.end === el.selectionEnd)
      const hit = current >= 0
        ? hits[(current + (next ? 1 : hits.length - 1)) % hits.length]
        : nextHit(hits, el ? el.selectionStart : 0, next)
      if (hit) {
        applyHit(hit)
        setIdx(hits.findIndex((h) => h === hit))
      }
    },
    [hits, applyHit, editorRef],
  )

  // 仅在搜索条件变化时定位首个命中；正文修改只更新计数，不挪动正在输入的光标。
  useEffect(() => {
    const previous = lastCriteria.current
    const changed = query !== previous.query || caseSensitive !== previous.caseSensitive
    lastCriteria.current = { query, caseSensitive }
    setIdx(changed && hits.length ? 0 : null)
    if (changed && hits[0]) applyHit(hits[0])
  }, [query, caseSensitive, hits, applyHit])

  return (
    <div
      className="agw-findbar"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
          editorRef.current?.focus()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          go(!e.shiftKey)
        }
      }}
    >
      <Icon name="search" size={13} />
      <input
        ref={inputRef}
        className="agw-find-input"
        aria-label="在正文中查找"
        value={query}
        placeholder="查找…"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <span className={`agw-find-count ${hits.length === 0 && query ? 'none' : ''}`}>
        {query ? (hits.length > 0 ? idx === null ? `${hits.length} 处` : `${idx + 1}/${hits.length}` : '无结果') : ''}
      </span>
      <button className="agw-iconbtn sm" title="上一个（Shift+Enter）" disabled={hits.length === 0} onClick={() => go(false)}>
        <Icon name="chevron-left" size={14} />
      </button>
      <button className="agw-iconbtn sm" title="下一个（Enter）" disabled={hits.length === 0} onClick={() => go(true)}>
        <Icon name="chevron-right" size={14} />
      </button>
      <button
        className={`agw-iconbtn sm ${caseSensitive ? 'toggled' : ''}`}
        title="区分大小写"
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button className="agw-iconbtn sm" title="关闭（Esc）" onClick={onClose}>
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}

/* ============ 中央对话列 ============ */
function ChatColumn({
  chat,
  skills,
  workName,
  screenplay,
  workspaceRoot,
  onJumpFile,
  onOpenSettings,
}: {
  chat: ReturnType<typeof useChat>
  skills: Skill[]
  workName: string
  screenplay: boolean
  workspaceRoot?: string
  onJumpFile: (p: string) => void
  onOpenSettings: () => void
}) {
  const [input, setInput] = useState('')
  const [skillId, setSkillId] = useState('')
  const [attach, setAttach] = useState<{ path: string; content: string } | null>(null)
  const [attachError, setAttachError] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let latest = 0
    const handler = async (e: Event) => {
      const path = (e as CustomEvent<string>).detail
      if (!path) return
      const request = ++latest
      setAttachError('')
      setAttach(null)
      try {
        const content = await readText(path, undefined, workspaceRoot)
        if (request === latest) {
          setAttach({ path, content })
          taRef.current?.focus()
        }
      } catch (error) {
        if (request === latest) setAttachError(`无法附加文件：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    window.addEventListener('agent-attach-file', handler)
    return () => { latest += 1; window.removeEventListener('agent-attach-file', handler) }
  }, [workspaceRoot])

  useEffect(() => {
    // 仅当用户在底部附近才自动跟随；往上翻阅时保持视口（流式时不打扰）
    const el = listRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (near || atBottom) el.scrollTo({ top: el.scrollHeight })
  }, [chat.messages]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }, [])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text) return
    if (chat.busy) return
    setInput('')
    // 重置自动增高高度
    if (taRef.current) taRef.current.style.height = 'auto'
    const skill = !screenplay && skillId ? skills.find((s) => s.id === skillId) : null
    const parts = [screenplay
      ? '当前是剧本作品。以中文 Markdown 回复，用反引号指明文件路径。工具只读，不承诺写回文件。'
      : `你是运行在用户本地作品目录中的写作 Agent（ReAct 循环，可调用 fs_list_dir / fs_read_text / fs_write_text 等工具）。所有产出都是 Markdown 文件，写入工程目录；先看再写；回复用 Markdown，提到文件路径用反引号。当前作品：${workName}。`]
    if (skill?.prompt) parts.push(`<技能规范：${skill.name}>\n${skill.prompt}\n</技能规范>`)
    if (attach) parts.push(`<附带文件：${attach.path}>\n${attach.content.slice(0, screenplay ? 24000 : undefined)}${screenplay && attach.content.length > 24000 ? '\n[仅附加前 24000 字符]' : ''}\n</附带文件>`)
    void chat.send(text, { systemPrompt: parts.join('\n\n') })
    setAttach(null)
  }, [attach, chat, input, screenplay, skillId, skills, workName])

  const retryLast = useCallback(() => {
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser || chat.busy) return
    const skill = !screenplay && skillId ? skills.find((s) => s.id === skillId) : null
    const parts = [screenplay ? '按剧本而非小说的格式回复；只给建议与草稿。' : `你是运行在用户本地作品目录中的写作 Agent。回复用 Markdown；文件路径用反引号。当前作品：${workName}。`]
    if (skill?.prompt) parts.push(skill.prompt)
    chat.resendFrom(lastUser.content, { systemPrompt: parts.join('\n\n') })
  }, [chat, screenplay, skillId, skills, workName])

  return (
    <div className="chatcol">
      <div className="chatcol-scroll" ref={listRef} onScroll={onScroll}>
        <div className="chatcol-inner">
          {chat.messages.length === 0 ? (
            <div className="chatcol-hero">
              <h2>{workName}</h2>
              <p>{screenplay ? '让 Agent 读取分场与人物资料，协助梳理情节、起草或审阅。建议不会直接写入原稿。' : '对 Agent 说要做什么。它会读目录、写 Markdown，过程逐步可见。'}</p>
              <div className="chatcol-samples">
                {(screenplay ? [
                  '按场次检查冲突如何逐步推进，指出节奏断点',
                  '参考分场大纲，给下一场一个可拍摄的草稿',
                  '核对当前场次中的人物动机、道具和时间线',
                ] : [
                  '读一下整个目录，总结当前工程结构',
                  '根据已有内容，写下一章到 stories/ 里',
                  '检查人物设定与正文是否一致，输出报告 concept/consistency.md',
                ]).map((s) => (
                  <button key={s} className="chatcol-sample" onClick={() => { setInput(s); taRef.current?.focus() }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {chat.messages.map((m) => (
            <MessageRow key={m.id} m={m} onJumpFile={onJumpFile} onRetry={retryLast} canRetry={!chat.busy} onOpenSettings={onOpenSettings} />
          ))}
        </div>
      </div>
      {chat.messages.length > 0 ? (
        <div className="chatcol-sessionbar">
          <span className="csb-count">{chat.messages.filter((m) => m.role === 'user').length} 问 · {chat.messages.filter((m) => m.role === 'assistant').length} 答</span>
          <button
            className="csb-export"
            title="导出会话为 Markdown 分享稿"
            onClick={() => {
              const md = sessionToMarkdown({ workName, messages: chat.messages })
              downloadText(`${workName}-会话记录.md`, md)
            }}
          >
            <Icon name="download" size={13} />
            导出会话
          </button>
        </div>
      ) : null}
      {!atBottom && chat.messages.length > 0 ? (
        <button
          className="chatcol-jumpdown"
          title="滚动到底部"
          onClick={() => {
            const el = listRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            setAtBottom(true)
          }}
        >
          <Icon name="arrow-down" size={16} />
        </button>
      ) : null}

      <div className="composer glass-float">
        {attachError ? <div className="scene-notice error" role="alert">{attachError}</div> : null}
        {attach ? (
          <div className="composer-attach">
            <Icon name="paperclip" size={13} />
            <span title={attach.path}>{attach.path}</span>
            <button onClick={() => setAttach(null)} title="移除附件"><Icon name="x" size={13} /></button>
          </div>
        ) : null}
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            // 自动增高（上限 ~10 行）
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 220)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="给 Agent 下指令…（Enter 发送，Shift+Enter 换行）"
          rows={2}
        />
        <div className="composer-tools">
          {screenplay ? <span className="composer-count" title="Agent 可读取场次和资料，不会修改场次文件">剧本助手 · 只读资料</span> : <select className="composer-skill" value={skillId} onChange={(e) => setSkillId(e.target.value)} title="写作技能">
            <option value="">通用写作</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>}
          <span className="composer-spacer" />
          {input.length > 0 ? <span className="composer-count">{input.length} 字</span> : null}
          {chat.busy ? (
            <button className="composer-btn stop" onClick={chat.cancel}>停止</button>
          ) : (
            <button className="composer-btn send" disabled={!input.trim()} onClick={send} title="发送（Enter）">
              <Icon name="arrow-up" size={17} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageRow({ m, onJumpFile, onRetry, canRetry, onOpenSettings }: { m: ChatItem; onJumpFile: (p: string) => void; onRetry: () => void; canRetry: boolean; onOpenSettings: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(m.content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`msg-row ${m.role}`}>
      <div className={`msg ${m.role} ${m.failed ? 'failed' : ''}`}>
        {m.role === 'assistant' ? (
          <>
            {m.steps && m.steps.length > 0 ? (
              <div className="msg-steps">
                {m.steps.map((s) => (
                  <StepCard key={s.actionId} step={s} onOpenFile={onJumpFile} />
                ))}
              </div>
            ) : null}
            <Markdown content={m.content} />
            {m.streaming && !m.content && (!m.steps || m.steps.length === 0) ? <span className="msg-typing" aria-label="正在输入" /> : null}
          </>
        ) : (
          <p className="msg-user-text">{m.content}</p>
        )}
        {m.failed ? (
          <div className="msg-error">
            <span>{m.failed}</span>
            <button className="msg-error-action" onClick={onOpenSettings}>打开设置 →</button>
          </div>
        ) : null}
        {m.stopped ? <div className="scene-notice" role="status">已停止 · 回复可能不完整</div> : null}
        {m.role === 'assistant' && !m.streaming && m.content ? (
          <div className="msg-actions">
            <button onClick={copy}>{copied ? '已复制' : '复制'}</button>
            {canRetry ? <button onClick={onRetry}>重新生成</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
