import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  STUDIO_TOOLS,
  STUDIO_CATEGORIES,
  STUDIO_STYLES,
  runStudioTool,
  generateVariants,
  learnStyleFingerprint,
  parseStyleFingerprint,
  fingerprintText,
  studioResultToMarkdown,
  type StudioHandle,
  type StyleFingerprint,
} from '../../api/studio'
import { getAppSettings, createDir, writeText, type ProjectKind } from '../../api/backend'
import { chapterBodyFromResult, createChapterWithContent } from '../../api/novel'
import { createScene, SCREENPLAY_TOOLS, splitSceneDraft } from '../../api/screenplay'
import { loadStyleFingerprint, saveStyleFingerprint } from '../../api/stylefp'
import { MarkdownView } from './MarkdownView'
import { Icon, type IconName } from '../../components/Icon'
import './StudioDialog.css'

type Props = {
  workKind?: ProjectKind
  workspaceRoot?: string
  initialToolId?: string
  /** 打开时预填输入框（编辑器选中文字直达润改） */
  initialText?: string
  /** 当前编辑器打开的文件路径；「插入」按钮依赖它 */
  activePath: string | null
  /** 当前编辑器内容 */
  activeContent: string
  /** 追加到编辑器草稿（插入结果） */
  onInsertToEditor: (text: string) => void
  /** 编辑器存在有效选区时为 true；「替换选区」按钮依赖它 */
  canReplaceSelection?: boolean
  /** 用结果替换编辑器原选区（润改闭环） */
  onReplaceSelection?: (text: string) => void
  onClose: () => void
  onOpenSavedScene?: (path: string) => void
}

type RunState = 'idle' | 'running' | 'done' | 'error' | 'stopped'

/** 与 studio.ts VARIANT_ANGLES 对齐的短标签（选稿卡片用） */
const VARIANT_ANGLE_LABELS = ['悬疑冷峻', '细腻心理', '快节奏冲突', '感官画面']

/** 创作工坊：一站式 AI 文本创作工具集（构思 / 写作 / 润改 / 实用） */
export function StudioDialog({ workKind, workspaceRoot, initialToolId, initialText, activePath, activeContent, onInsertToEditor, canReplaceSelection, onReplaceSelection, onClose, onOpenSavedScene }: Props) {
  const screenplay = workKind === 'screenplay'
  const catalog = screenplay ? SCREENPLAY_TOOLS : STUDIO_TOOLS
  const [toolId, setToolId] = useState(() => catalog.find((candidate) => candidate.id === initialToolId)?.id ?? catalog[0].id)
  const tool = useMemo(
    () => catalog.find((t) => t.id === toolId) ?? catalog[0],
    [catalog, toolId],
  )

  const [instruction, setInstruction] = useState('')
  const [style, setStyle] = useState('')
  const [targetWords, setTargetWords] = useState('')
  const [providerId, setProviderId] = useState<string>('')
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  // 选中文字直达：仅挂载时预填一次
  const [inputText, setInputText] = useState(initialText ?? '')

  const [runState, setRunState] = useState<RunState>('idle')
  const [result, setResult] = useState('')
  const [errMsg, setErrMsg] = useState('')
  const handleRef = useRef<StudioHandle | null>(null)
  const variantHandlesRef = useRef<StudioHandle[]>([])
  const resultBodyRef = useRef<HTMLDivElement | null>(null)
  const generation = useRef(0)
  const savingRef = useRef(false)
  const [savingResult, setSavingResult] = useState(false)
  const [savedFile, setSavedFile] = useState('')
  const [saveError, setSaveError] = useState('')

  // 多稿对照
  const [multiMode, setMultiMode] = useState(false)
  const [variantCount, setVariantCount] = useState(2)
  const [variants, setVariants] = useState<Array<{ text: string; done: boolean }>>([])
  const [pickedVariant, setPickedVariant] = useState<number | null>(null)

  // 风格学习：范文 → 文风指纹（持久化到工程，任务队列等场景共用）
  const [styleFp, setStyleFp] = useState<StyleFingerprint | null>(null)
  const [fpLearning, setFpLearning] = useState(false)
  const [fpErr, setFpErr] = useState('')
  const fpHandleRef = useRef<StudioHandle | null>(null)

  useEffect(() => {
    if (!screenplay) void loadStyleFingerprint().then(setStyleFp)
  }, [screenplay])

  useEffect(() => {
    void getAppSettings()
      .then((s) => {
        const ps = s.providers ?? []
        setProviders(ps.map((p) => ({ id: p.id, name: p.name || p.id })))
        if (ps.length > 0) setProviderId((v) => v || (ps.find((p) => p.id === s.active_provider_id) ?? ps[0]).id)
      })
      .catch(() => {})
  }, [])

  // 工具切换：保留通用输入，重置结果
  const switchTool = useCallback((id: string) => {
    setToolId(id)
    setRunState('idle')
    setResult('')
    setErrMsg('')
    setSaveError('')
    setSavedFile('')
    setVariants([])
    setPickedVariant(null)
    setSaveChapterOpen(false)
    setChapterSaved(null)
  }, [])

  const onToken = useCallback((full: string) => {
    setResult(full)
    const el = resultBodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const run = useCallback(() => {
    if (!inputText.trim() || runState === 'running' || savingRef.current) return
    const request = ++generation.current
    const current = () => generation.current === request
    setRunState('running')
    setErrMsg('')
    setSaveError('')
    setSavedFile('')
    setSaveChapterOpen(false)
    setChapterSaved(null)
    const input = {
      text: inputText,
      instruction,
      style,
      targetWords: targetWords ? Number(targetWords) : undefined,
      fingerprint: styleFp,
    }
    const pid = providerId || null

    if (multiMode && !screenplay) {
      // 多稿：清空旧稿，逐稿流式更新
      setVariants(new Array(variantCount).fill(null).map(() => ({ text: '', done: false })))
      setPickedVariant(null)
      setResult('')
      void generateVariants({
        tool,
        input,
        count: variantCount,
        providerId: pid,
        handlesOut: variantHandlesRef.current,
        onVariant: (i, text, done) => {
          if (!current()) return
          setVariants((vs) => {
            const next = [...vs]
            next[i] = { text, done }
            return next
          })
          if (done) {
            const el = resultBodyRef.current
            if (el) el.scrollTop = el.scrollHeight
          }
        },
      })
        .then((results) => {
          if (!current()) return
          setVariants(results.map((text) => ({ text, done: true })))
          // 自动选中第一份成功稿
          const firstOk = results.findIndex((r) => r.trim())
          setPickedVariant(firstOk >= 0 ? firstOk : null)
          setResult(results[firstOk] ?? '')
          setRunState('done')
        })
        .catch((e) => {
          if (!current()) return
          setErrMsg(e instanceof Error ? e.message : String(e))
          setRunState('error')
        })
      return
    }

    setResult('')
    setPickedVariant(null)
    setVariants([])
    handleRef.current = runStudioTool({ tool, input, providerId: pid, onToken: (text) => { if (current()) onToken(text) } })
    handleRef.current.promise
      .then((out) => {
        if (!current()) return
        setResult(out)
        setRunState('done')
      })
      .catch((e) => {
        if (!current()) return
        setErrMsg(e instanceof Error ? e.message : String(e))
        setRunState('error')
      })
  }, [inputText, runState, tool, instruction, style, targetWords, providerId, onToken, multiMode, variantCount, styleFp, screenplay])

  /** 多稿模式选稿：选中稿进入主结果区（复制/存盘/插入都作用于它） */
  const pickVariant = useCallback((i: number) => {
    setPickedVariant(i)
    setVariants((vs) => {
      if (vs[i]) setResult(vs[i].text)
      return vs
    })
  }, [])

  const cancel = useCallback(() => {
    generation.current += 1
    handleRef.current?.cancel()
    for (const h of variantHandlesRef.current) h.cancel()
    setRunState('stopped')
  }, [])

  useEffect(() => () => {
    generation.current += 1
    handleRef.current?.cancel()
    for (const h of variantHandlesRef.current) h.cancel()
    fpHandleRef.current?.cancel()
  }, [])

  /** 风格学习：从输入框范文提取文风指纹（覆盖旧指纹） */
  const learnStyle = useCallback(() => {
    if (!inputText.trim() || fpLearning) return
    setFpLearning(true)
    setFpErr('')
    fpHandleRef.current = learnStyleFingerprint({
      sample: inputText,
      providerId: providerId || null,
    })
    fpHandleRef.current.promise
      .then((raw) => {
        const learned = parseStyleFingerprint(raw)
        if (learned) {
          setStyleFp(learned)
          // 持久化到工程（无工程时静默：本次会话内仍可用）
          void saveStyleFingerprint(learned).catch(() => {})
        } else {
          setFpErr('AI 输出未能解析为文风指纹，请换一段特征更鲜明的范文重试')
        }
        setFpLearning(false)
      })
      .catch((e) => {
        setFpErr(e instanceof Error ? e.message : String(e))
        setFpLearning(false)
      })
  }, [inputText, fpLearning, providerId])

  const close = () => { if (!savingRef.current) onClose() }

  const copyResult = useCallback(() => {
    void navigator.clipboard.writeText(result).catch(() => {})
  }, [result])

  const saveAsFile = useCallback(async () => {
    if (!result.trim() || savingRef.current) return
    savingRef.current = true
    setSavingResult(true)
    setSaveError('')
    const name = `studio/${tool.id}-${Date.now()}.md`
    try {
      // 幂等建立目录，真正的权限错误应提示给作者。
      await createDir('studio', workspaceRoot)
      await writeText(name, studioResultToMarkdown(tool, {
        text: inputText,
        instruction,
        style,
        targetWords: targetWords ? Number(targetWords) : undefined,
      }, result), workspaceRoot)
      setSavedFile(name)
    } catch (e) {
      setSaveError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      savingRef.current = false
      setSavingResult(false)
    }
  }, [result, tool, inputText, instruction, style, targetWords, workspaceRoot])

  const insertToEditor = useCallback(() => {
    if (!result.trim() || !activePath) return
    onInsertToEditor(result)
    onClose()
  }, [result, activePath, onInsertToEditor, onClose])

  /** 替换编辑器原选区（润改闭环：旧文删除、新文就位） */
  const replaceInEditor = useCallback(() => {
    if (!result.trim() || !onReplaceSelection) return
    onReplaceSelection(result)
    onClose()
  }, [result, onReplaceSelection, onClose])

  // ==== 存为章节：结果直写 stories/chapter-XXXX.md 并纳入章节管理 ====
  const [saveChapterOpen, setSaveChapterOpen] = useState(false)
  const [chapterTitle, setChapterTitle] = useState('')
  const [chapterSaved, setChapterSaved] = useState<string | null>(null)

  const openSaveChapter = useCallback(() => {
    // 预填：AI 产出的首行 `# 标题`（chapterBodyFromResult 剥除后不会重复出现在正文）
    const { title } = screenplay ? splitSceneDraft(result) : chapterBodyFromResult(result)
    setChapterTitle(title)
    setSaveChapterOpen(true)
    setChapterSaved(null)
  }, [result, screenplay])

  const saveAsChapter = useCallback(async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSavingResult(true)
    setSaveError('')
    const { body } = screenplay ? splitSceneDraft(result) : chapterBodyFromResult(result)
    try {
      let path: string
      if (screenplay) {
        if (!workspaceRoot) throw new Error('请先打开剧本作品。')
        path = (await createScene(workspaceRoot, { title: chapterTitle, body })).path
      } else {
        path = await createChapterWithContent(chapterTitle, body)
      }
      setChapterSaved(path)
    } catch (e) {
      setSaveError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      savingRef.current = false
      setSavingResult(false)
    }
  }, [chapterTitle, result, screenplay, workspaceRoot])

  const running = runState === 'running'
  const hasResult = result.trim().length > 0
  const canApply = hasResult && runState === 'done' && !savingResult
  const isReview = tool.id === 'script-review'

  return (
    <div className="studio-overlay" onClick={close}>
      <div className="studio-dialog" role="dialog" aria-modal="true" aria-label={screenplay ? '剧本工坊' : '创作工坊'} onClick={(e) => e.stopPropagation()} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Escape') { event.stopPropagation(); close() }
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, textarea, input, select')].filter((item) => !item.matches(':disabled'))
          if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
            event.preventDefault()
            ;(event.shiftKey ? controls.at(-1) : controls[0])?.focus()
          }
        }
      }}>
        <div className="studio-head">
          <div className="studio-title">
            <Icon name="sparkles" size={15} />
            {screenplay ? '剧本工坊' : '创作工坊'}
          </div>
          <button className="studio-x" onClick={close} disabled={savingResult} aria-label="关闭工坊"><Icon name="x" size={16} /></button>
        </div>

        <div className="studio-layout">
          <nav className="studio-nav">
            {STUDIO_CATEGORIES.filter((cat) => catalog.some((item) => item.category === cat)).map((cat) => (
              <div key={cat}>
                <div className="studio-cat">{cat}</div>
                {catalog.filter((t) => t.category === cat).map((t) => (
                  <button
                    key={t.id}
                    className={`studio-navitem${toolId === t.id ? ' active' : ''}`}
                    disabled={running || savingResult}
                    aria-pressed={toolId === t.id}
                    onClick={() => switchTool(t.id)}
                  >
                    <Icon name={t.icon as IconName} size={14} />
                    {t.name}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="studio-main">
            <div className="studio-toolhead">
              <div className="studio-toolname">{tool.name}</div>
              <div className="studio-tooldesc">{tool.desc}</div>
            </div>

            <div className="studio-fields">
              <textarea
                className="studio-input"
                aria-label="创作输入"
                value={inputText}
                disabled={running || savingResult}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={tool.placeholder}
                spellCheck={false}
                autoFocus
              />
              <div className="studio-fieldrow">
                <label className="studio-field">
                  <span className="studio-label">附加要求（可选）</span>
                  <input
                    className="studio-input"
                    style={{ minHeight: 0 }}
                    value={instruction}
                    disabled={running || savingResult}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="例如：第一人称 / 避免成语 / 面向青少年读者"
                    spellCheck={false}
                  />
                </label>
                <label className="studio-field" style={{ maxWidth: 150 }}>
                  <span className="studio-label">模型</span>
                  <select className="studio-select" value={providerId} disabled={running || savingResult} onChange={(e) => setProviderId(e.target.value)}>
                    {providers.length === 0 ? <option value="">默认 Provider</option> : null}
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="studio-fieldrow">
                {!screenplay ? <label className="studio-field" style={{ maxWidth: 170 }}>
                  <span className="studio-label">多稿对照</span>
                  <div className="studio-multirow">
                    <button
                      type="button"
                      className={`studio-multi-toggle${multiMode ? ' on' : ''}`}
                      onClick={() => setMultiMode((v) => !v)}
                      title="同一输入并排生成 2-4 稿不同视角，择优选用"
                    >
                      <Icon name={multiMode ? 'check-circle' : 'book-open'} size={13} />
                      {multiMode ? '已开启' : '关闭'}
                    </button>
                    {multiMode ? (
                      <select
                        className="studio-select"
                        style={{ minHeight: 0 }}
                        value={variantCount}
                        onChange={(e) => setVariantCount(Number(e.target.value))}
                      >
                        {[2, 3, 4].map((n) => (
                          <option key={n} value={n}>{n} 稿</option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                </label> : null}
                {tool.styleField ? (
                  <label className="studio-field" style={{ maxWidth: 150 }}>
                    <span className="studio-label">文风</span>
                    <select className="studio-select" value={style} onChange={(e) => setStyle(e.target.value)}>
                      <option value="">不指定</option>
                      {STUDIO_STYLES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {tool.styleField ? (
                  <label className="studio-field">
                    <span className="studio-label">风格学习（粘贴范文后提取其文风）</span>
                    {styleFp ? (
                      <div className="studio-fp">
                        <span className="studio-fp-tag" title={fingerprintText(styleFp)}>
                          <Icon name="pen-line" size={12} />
                          已学习范文风格
                        </span>
                        <button type="button" className="studio-fp-x" onClick={() => { setStyleFp(null); void saveStyleFingerprint(null).catch(() => {}) }} title="移除文风指纹（工程内同步清除）">
                          <Icon name="x" size={11} />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="studio-stop"
                        style={{ justifyContent: 'flex-start' }}
                        disabled={!inputText.trim() || fpLearning}
                        onClick={learnStyle}
                        title="把上方输入框的范文交给 AI 分析，提取文风指纹套用到生成"
                      >
                        <Icon name={fpLearning ? 'clock' : 'search'} size={13} />
                        {fpLearning ? '分析中……' : '从范文学习文风'}
                      </button>
                    )}
                  </label>
                ) : null}
                {fpErr ? <div className="studio-fp-err">{fpErr}</div> : null}
                {tool.wordsField ? (
                  <label className="studio-field" style={{ maxWidth: 150 }}>
                    <span className="studio-label">目标字数</span>
                    <input
                      className="studio-num"
                      type="number"
                      min={50}
                      step={100}
                      value={targetWords}
                      onChange={(e) => setTargetWords(e.target.value)}
                      placeholder="如 800"
                    />
                  </label>
                ) : null}
                <label className="studio-field">
                  <span className="studio-label">使用当前编辑器内容</span>
                  <button
                    type="button"
                    className="studio-stop"
                    style={{ justifyContent: 'flex-start' }}
                    disabled={!activePath || !activeContent.trim() || running || savingResult}
                    onClick={() => setInputText(activeContent.slice(0, 12000))}
                    title={activePath ? `从 ${activePath} 填入` : '先在右侧面板打开一个文件'}
                  >
                    <Icon name="file" size={13} />
                    {activePath ? '填入当前文件' : '未打开文件'}
                  </button>
                </label>
              </div>
            </div>

            <div className="studio-actions">
              {running ? (
                <button className="studio-stop" onClick={cancel}>
                  <Icon name="x" size={13} />
                  停止
                </button>
              ) : (
                <button className="studio-run" onClick={run} disabled={!inputText.trim() || savingResult}>
                  <Icon name="sparkles" size={14} />
                  生成
                </button>
              )}
              {runState === 'running' ? <span className="studio-status">生成中……</span> : null}
              {runState === 'error' ? <span className="studio-status err" role="alert">{errMsg}</span> : null}
              {runState === 'done' ? <span className="studio-status">完成 · {result.length} 字</span> : null}
              {runState === 'stopped' ? <span className="studio-status" role="status">已停止 · 未完成文本仅供复制</span> : null}
              {screenplay ? <span className="studio-status">输入会发送给所选模型；结果不会自动写入剧本。</span> : null}
            </div>

            <div className="studio-result">
              <div className="studio-resultbar">
                <span className="studio-resulttag">
                  <Icon name="file-text" size={12} />
                  结果
                </span>
                <div className="studio-result-actions">
                  <button className="ok" onClick={copyResult} disabled={!hasResult || running}>
                    <Icon name="check" size={12} />
                    复制
                  </button>
                  <button className="ok" onClick={() => void saveAsFile()} disabled={!canApply} title="保存到 studio/ 目录">
                    <Icon name="download" size={12} />
                    存为文件
                  </button>
                  {(!screenplay || tool.id === 'script-scene') ? <button className="ok" onClick={openSaveChapter} disabled={!canApply || !!chapterSaved}>
                    <Icon name="file-plus" size={12} />
                    {screenplay ? '存为新场次' : '存为章节'}
                  </button> : null}
                  {!isReview ? <button
                    className="ok"
                    onClick={insertToEditor}
                    disabled={!canApply || !activePath}
                    title={activePath ? `插入到 ${activePath}` : '先在右侧面板打开一个文件'}
                  >
                    <Icon name="arrow-right" size={12} />
                    插入编辑器
                  </button> : null}
                  {!isReview && canReplaceSelection && onReplaceSelection ? (
                    <button
                      className="ok"
                      onClick={replaceInEditor}
                      disabled={!canApply}
                      title="用结果替换编辑器中原来的选中文本（润改闭环）"
                    >
                      <Icon name="square-pen" size={12} />
                      替换选区
                    </button>
                  ) : null}
                </div>
              </div>
              {savedFile ? <span className="studio-saved-ok" role="status">已保存到 {savedFile}</span> : null}
              {saveError ? <span className="studio-status err" role="alert">{saveError}</span> : null}
              {saveChapterOpen ? (
                <div className="studio-savechapter">
                  <input
                    className="studio-input"
                    style={{ minHeight: 0, flex: 1 }}
                    value={chapterTitle}
                    onChange={(e) => setChapterTitle(e.target.value)}
                    maxLength={screenplay ? 100 : undefined}
                    aria-label={screenplay ? '新场次标题' : '新章节标题'}
                    placeholder={screenplay ? '场次标题（可留空）' : '章节标题（缺省用「第 N 章」）'}
                    disabled={savingResult || !!chapterSaved}
                    spellCheck={false}
                  />
                  {chapterSaved ? (
                    <span className="studio-saved-ok">
                      <Icon name="check-circle" size={13} />
                      已存入 {chapterSaved}
                      {screenplay && onOpenSavedScene ? <button className="studio-stop" onClick={() => { onClose(); onOpenSavedScene(chapterSaved) }}>打开新场次</button> : null}
                    </span>
                  ) : (
                    <>
                      <button className="studio-run" disabled={!canApply} onClick={() => void saveAsChapter()}>
                        <Icon name="check" size={12} />
                        {savingResult ? '保存中…' : '写入'}
                      </button>
                      <button className="studio-stop" disabled={savingResult} onClick={() => setSaveChapterOpen(false)}>
                        取消
                      </button>
                    </>
                  )}
                </div>
              ) : null}
              <div className="studio-resultbody" ref={resultBodyRef}>
                {variants.length > 0 ? (
                  <div className="studio-variants">
                    {variants.map((v, i) => (
                      <button
                        key={i}
                        className={`studio-variant${pickedVariant === i ? ' picked' : ''}${v.done ? '' : ' gen'}`}
                        onClick={() => pickVariant(i)}
                        title={v.done ? '点击选用此稿' : '生成中…'}
                      >
                        <span className="studio-variant-head">
                          {v.done ? <Icon name="file-text" size={12} /> : <Icon name="clock" size={12} />}
                          第 {i + 1} 稿 · {VARIANT_ANGLE_LABELS[i % VARIANT_ANGLE_LABELS.length]}
                          {pickedVariant === i ? <Icon name="check" size={12} /> : null}
                        </span>
                        <span className="studio-variant-body">{v.text.slice(0, 90) || '……'}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {hasResult ? (
                  running ? (
                    <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', margin: 0 }}>
                      {result}
                      <span className="studio-caret" />
                    </pre>
                  ) : (
                    <MarkdownView content={result} />
                  )
                ) : (
                  <div className="studio-empty">
                    <Icon name="sparkles" size={22} />
                    {runState === 'running' ? '正在生成……' : '在上方输入内容，点击「生成」开始创作'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
