import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeStreamEvents } from '../api/rpc'
import { chatCancelStream, chatGenerateStream, type ChatMessagePayload } from '../api/backend'

/** 常见后端错误 → 中文用户话术；未命中时原样透传 */
const ERROR_I18N: Array<[RegExp, string]> = [
  [/no api key/i, '未配置 API Key——点击右上角「设置」添加密钥'],
  [/api key.*(invalid|incorrect|unauthorized)|401/i, 'API Key 无效或已过期——请到「设置」检查密钥'],
  [/workspace not set/i, '尚未打开作品目录'],
  [/insufficient (quota|balance)|quota exceeded|billing/i, 'Provider 额度或余额不足'],
  [/rate limit|429/i, '请求过于频繁（触发限速），稍后重试'],
  [/timed? out|timeout/i, '连接超时——检查网络或 Provider 地址'],
  [/request failed|network/i, '网络请求失败——检查网络连接或 Provider 地址'],
  [/http 4\d\d/i, '请求被拒绝（4xx）——检查模型名 / 参数 / 密钥'],
  [/http 5\d\d/i, 'Provider 服务端错误（5xx），稍后重试'],
  [/missing choices/i, 'Provider 返回格式异常——确认 base_url 指向 OpenAI 兼容接口'],
  [/decode failed/i, '响应解析失败——Provider 可能不支持流式返回'],
]

/** 错误中文化：命中映射输出中文话术并附原文摘录，未命中原样透传 */
export function localizeError(raw: string): string {
  for (const [re, msg] of ERROR_I18N) {
    if (re.test(raw)) return `${msg}（${raw.slice(0, 120)}）`
  }
  return raw
}

export type ChatRole = 'user' | 'assistant'

/** 一次工具调用步骤（Cline 式步骤卡数据） */
export type AgentStep = {
  actionId: string
  step: number
  tool: string
  phase: string
  ok?: boolean
  durationMs?: number
  inputPreview?: string
  observationPreview?: string
  /** fs_list_dir 的紧凑列表 */
  listItems?: Array<{ name: string; kind: string }>
  readPath?: string
  readLines?: number
  readChars?: number
  readPreview?: string
  writePath?: string
}

export type ChatItem = {
  id: string
  role: ChatRole
  content: string
  streaming?: boolean
  streamId?: string
  failed?: string
  stopped?: boolean
  /** 本条 assistant 消息期间的工具步骤 */
  steps?: AgentStep[]
}

export type ChatEventPayload = {
  streamId?: string
  stream_id?: string
  token?: string
  cancelled?: boolean
  phase?: string
  message?: string
  actionId?: string
  action_id?: string
  step?: number
  tool?: string
  ok?: boolean
  durationMs?: number
  inputPreview?: string
  observationPreview?: string
  listItems?: Array<{ name: string; kind: string }>
  readPath?: string
  readLines?: number
  readChars?: number
  readPreview?: string
  writePath?: string
}

function sid(p: ChatEventPayload): string | null {
  return typeof p.streamId === 'string' ? p.streamId : typeof p.stream_id === 'string' ? p.stream_id : null
}

let seq = 0
const newId = () => `m-${Date.now()}-${(seq += 1)}`

type ChatRun = { id: string; output: string; request?: Promise<void>; timer?: number }

function cancelRemote(run: ChatRun) {
  // A cancel cannot reach the server before the start RPC has registered the task.
  if (run.request) void run.request.then(() => chatCancelStream(run.id)).catch(() => {})
}

export function useChat(workspaceRoot?: string) {
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [busy, setBusy] = useState(false)
  const activeRun = useRef<ChatRun | null>(null)
  const subscription = useRef<ReturnType<typeof subscribeStreamEvents> | null>(null)
  /** 最新消息列表镜像（供 resendFrom 读取，避免闭包过期） */
  const messagesRef = useRef<ChatItem[]>([])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const finishStream = useCallback((run: ChatRun, patch: Partial<ChatItem>) => {
    if (activeRun.current !== run) return false
    activeRun.current = null
    window.clearTimeout(run.timer)
    setBusy(false)
    setMessages((ms) => ms.map((m) => (m.streamId === run.id ? { ...m, streaming: false, ...patch } : m)))
    return true
  }, [])

  useEffect(() => {
    const sub = subscribeStreamEvents((event, raw) => {
      const p = (raw ?? {}) as ChatEventPayload
      const run = activeRun.current
      if (!run || sid(p) !== run.id) return
      const id = run.id
      if (event === 'ai_stream_token') {
        const token = typeof p.token === 'string' ? p.token : ''
        if (!token) return
        run.output += token
        const text = run.output
        setMessages((ms) => ms.map((m) => (m.streamId === id ? { ...m, content: text } : m)))
      } else if (event === 'ai_agent_step') {
        const actionId = p.actionId ?? `s-${p.step ?? 0}`
        setMessages((ms) => {
          const idx = ms.findIndex((m) => m.streamId === id)
          if (idx < 0) return ms
          const target = ms[idx]
          const steps = [...(target.steps ?? [])]
          const existing = steps.findIndex((s) => s.actionId === actionId)
          const incoming: AgentStep = {
            actionId,
            step: p.step ?? steps.length + 1,
            tool: p.tool ?? 'tool',
            phase: p.phase ?? 'start',
            ok: p.ok,
            durationMs: p.durationMs,
            inputPreview: p.inputPreview,
            observationPreview: p.observationPreview,
            listItems: p.listItems,
            readPath: p.readPath,
            readLines: p.readLines,
            readChars: p.readChars,
            readPreview: p.readPreview,
            writePath: p.writePath,
          }
          if (existing >= 0) steps[existing] = incoming
          else steps.push(incoming)
          return ms.map((message, index) => index === idx ? { ...target, steps } : message)
        })
      } else if (event === 'ai_error') {
        const msg = typeof p.message === 'string' && p.message ? p.message : '生成失败（Provider 未配置或网络错误）'
        finishStream(run, { failed: localizeError(msg) })
      } else if (event === 'ai_stream_done') {
        finishStream(run, p.cancelled ? { stopped: true, content: run.output } : {
          content: run.output,
          failed: run.output.trim() ? undefined : '未收到任何回复，请检查 Provider / API Key 配置',
        })
      }
    }, () => {
      const run = activeRun.current
      if (run?.request && finishStream(run, { failed: '流式连接已断开，当前回复可能不完整。' })) cancelRemote(run)
    })
    subscription.current = sub

    return () => {
      const run = activeRun.current
      activeRun.current = null
      subscription.current = null
      sub.unlisten()
      if (run) { window.clearTimeout(run.timer); cancelRemote(run) }
    }
  }, [finishStream])

  const startStream = useCallback(
    (userText: string, history: ChatMessagePayload[], opts?: { systemPrompt?: string; assistantId?: string | null; providerId?: string | null }) => {
      const sub = subscription.current
      if (!sub || activeRun.current) return
      const streamId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const run: ChatRun = { id: streamId, output: '' }
      activeRun.current = run
      setBusy(true)
      setMessages((ms) => [
        ...ms,
        { id: newId(), role: 'user', content: userText },
        { id: newId(), role: 'assistant', content: '', streaming: true, streamId, steps: [] },
      ])

      const withSys: ChatMessagePayload[] = [...history, { role: 'user', content: userText }]
      if (opts?.systemPrompt) withSys.unshift({ role: 'system', content: opts.systemPrompt })
      void sub.waitReady().then(() => {
        if (activeRun.current !== run) return
        run.timer = window.setTimeout(() => {
          if (finishStream(run, { failed: '等待完整回复超时，请重试。' })) cancelRemote(run)
        }, 260000)
        run.request = chatGenerateStream({
          streamId, messages: withSys, workspaceRoot,
          assistantId: opts?.assistantId ?? null,
          providerId: opts?.providerId ?? null,
        })
        return run.request
      }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        finishStream(run, { failed: localizeError(msg) })
      })
    },
    [finishStream, workspaceRoot],
  )

  const send = useCallback(
    async (userText: string, opts?: { assistantId?: string | null; providerId?: string | null; systemPrompt?: string; useMarkdown?: boolean }) => {
      const text = userText.trim()
      if (!text || activeRun.current) return
      const history: ChatMessagePayload[] = messagesRef.current.map((m) => ({ role: m.role, content: m.content }))
      startStream(text, history, opts)
    },
    [startStream],
  )

  const cancel = useCallback(() => {
    const run = activeRun.current
    if (run && finishStream(run, { stopped: true, content: run.output })) cancelRemote(run)
  }, [finishStream])

  const clear = useCallback(() => {
    cancel()
    setMessages([])
  }, [cancel])

  const restore = useCallback(
    (msgs: Array<{ role: ChatRole; content: string }>) => {
      cancel()
      setMessages(msgs.map((m) => ({ id: newId(), role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: String(m.content ?? '') })))
    },
    [cancel],
  )

  /** 以最后一条用户消息重发（重新生成）：丢弃其后的全部消息 */
  const resendFrom = useCallback(
    (userText: string, opts?: { systemPrompt?: string }) => {
      cancel()
      const ms = messagesRef.current
      const idx = ms.map((m) => m.role).lastIndexOf('user')
      const keptHist = (idx >= 0 ? ms.slice(0, idx) : []).map((m) => ({ role: m.role, content: m.content }) as ChatMessagePayload)
      setMessages(keptHist.map((m) => ({ id: newId(), role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content })))
      startStream(userText, keptHist, opts)
    },
    [cancel, startStream],
  )

  return { messages, busy, send, cancel, clear, restore, resendFrom }
}
