// @vitest-environment jsdom
/**
 * useChat 事件协议测试（零新依赖：react-dom/test-utils 的 act + 自建挂载壳）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react' // React 18: act 从 react 导出（react-dom/test-utils 已弃用路径在 18.3 仍可用，但 react 直接导出最稳）
import { chatCancelStream, chatGenerateStream } from '../api/backend'
import { useChat } from './useChat'

type HookApi = ReturnType<typeof useChat>

// ---- mock rpc / backend ----
type Handler = (event: string, payload: unknown) => void
let streamHandler: Handler | undefined
let disconnected: (() => void) | undefined
let mockWait: Promise<void>
let mockGenResult: () => Promise<void>

vi.mock('../api/rpc', () => ({
  subscribeStreamEvents: vi.fn((handler: Handler, onDisconnect: () => void) => {
    streamHandler = handler
    disconnected = onDisconnect
    return { waitReady: () => mockWait, unlisten: () => { streamHandler = undefined; disconnected = undefined } }
  }),
}))

vi.mock('../api/backend', () => ({
  chatGenerateStream: vi.fn(() => mockGenResult()),
  chatCancelStream: vi.fn(() => Promise.resolve()),
}))

function emit(event: string, payload: unknown) {
  streamHandler?.(event, payload)
}

/** 极简 hook 挂载壳 */
function mountHook(use: () => HookApi): { api: HookApi; unmount: () => void } {
  let captured: HookApi | null = null
  function Probe(): ReactElement {
    captured = use()
    return createElement('div')
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(Probe))
  })
  return {
    get api() {
      if (!captured) throw new Error('hook not rendered')
      return captured
    },
    unmount: () => act(() => root.unmount()),
  }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  mockWait = Promise.resolve()
  mockGenResult = () => Promise.resolve()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('useChat 事件协议', () => {
  it('token 累积 + done 收尾，content 干净落地', async () => {
    const h = mountHook(useChat)
    expect(streamHandler).toBeTypeOf('function')

    await act(async () => {
      await h.api.send('你好', {})
    })
    const sid = h.api.messages.at(-1)?.streamId
    expect(sid).toBeTruthy()
    expect(h.api.busy).toBe(true)

    act(() => emit('ai_stream_token', { streamId: sid, token: '第一段。' }))
    act(() => emit('ai_stream_token', { streamId: sid, token: '第二段。' }))
    expect(h.api.messages.at(-1)?.content).toBe('第一段。第二段。')

    act(() => emit('ai_stream_done', { streamId: sid }))
    expect(h.api.busy).toBe(false)
    expect(h.api.messages.at(-1)?.streaming).toBe(false)
    expect(h.api.messages.at(-1)?.content).toBe('第一段。第二段。')
    expect(h.api.messages.at(-1)?.failed).toBeUndefined()
    h.unmount()
  })

  it('ai_error 立即终止流（无 done 也能收尾）', async () => {
    const h = mountHook(useChat)
    await act(async () => {
      await h.api.send('hi', {})
    })
    const sid = h.api.messages.at(-1)?.streamId
    act(() => emit('ai_error', { streamId: sid, message: 'no API key configured' }))
    expect(h.api.busy).toBe(false)
    expect(h.api.messages.at(-1)?.failed).toContain('未配置 API Key')
    h.unmount()
  })

  it('其它 streamId 的事件不串流', async () => {
    const h = mountHook(useChat)
    await act(async () => {
      await h.api.send('q', {})
    })
    act(() => emit('ai_stream_token', { streamId: 'other', token: '污染' }))
    expect(h.api.messages.at(-1)?.content).toBe('')
    act(() => emit('ai_stream_done', { streamId: h.api.messages.at(-1)?.streamId }))
    expect(h.api.busy).toBe(false)
    h.unmount()
  })

  it('RPC reject 也会终止流', async () => {
    mockGenResult = () => Promise.reject(new Error('network down'))
    const h = mountHook(useChat)
    await act(async () => {
      await h.api.send('hi', {})
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(h.api.busy).toBe(false)
    expect(h.api.messages.at(-1)?.failed).toContain('网络请求失败')
    h.unmount()
  })

  it('空文本不发送', async () => {
    const h = mountHook(useChat)
    await act(async () => {
      await h.api.send('   ', {})
    })
    expect(h.api.messages.length).toBe(0)
    h.unmount()
  })

  it('clear 复位 busy 并清空消息', async () => {
    const h = mountHook(useChat)
    await act(async () => {
      await h.api.send('q', {})
    })
    act(() => {
      h.api.clear()
    })
    expect(h.api.messages.length).toBe(0)
    expect(h.api.busy).toBe(false)
    h.unmount()
  })

  it('stopping before the handshake prevents the request entirely', async () => {
    let ready!: () => void
    mockWait = new Promise((resolve) => { ready = resolve })
    const h = mountHook(useChat)
    await act(async () => h.api.send('先停下'))
    expect(chatGenerateStream).not.toHaveBeenCalled()
    act(() => h.api.cancel())
    await act(async () => ready())
    expect(h.api.messages.at(-1)?.stopped).toBe(true)
    expect(chatGenerateStream).not.toHaveBeenCalled()
    h.unmount()
  })

  it('a disconnect ends a partial run and cancels only after the launch RPC settles', async () => {
    let acknowledge!: () => void
    mockGenResult = () => new Promise((resolve) => { acknowledge = resolve })
    const h = mountHook(() => useChat('/screenplay'))
    await act(async () => h.api.send('场次一'))
    const id = h.api.messages.at(-1)?.streamId
    expect(chatGenerateStream).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: '/screenplay' }))
    act(() => emit('ai_stream_token', { streamId: id, token: '半截回复' }))
    act(() => disconnected?.())
    expect(h.api.busy).toBe(false)
    expect(h.api.messages.at(-1)).toMatchObject({ content: '半截回复', failed: expect.stringContaining('断开') })
    expect(chatCancelStream).not.toHaveBeenCalled()
    await act(async () => acknowledge())
    expect(chatCancelStream).toHaveBeenCalledWith(id)
    act(() => emit('ai_stream_done', { streamId: id }))
    expect(h.api.messages.at(-1)?.failed).toContain('断开')
    h.unmount()
  })

  it('restore 载入历史会话', () => {
    const h = mountHook(useChat)
    act(() => {
      h.api.restore([
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
      ])
    })
    expect(h.api.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(h.api.messages[0].content).toBe('旧问题')
    h.unmount()
  })
})

describe('localizeError 错误中文化', () => {
  it('常见后端错误映射中文话术并保留原文', async () => {
    const { localizeError } = await import('./useChat')
    expect(localizeError('request failed: no API key configured')).toContain('未配置 API Key')
    expect(localizeError('http 401: unauthorized')).toContain('无效或已过期')
    expect(localizeError('workspace not set')).toContain('尚未打开')
    expect(localizeError('http 502 bad gateway')).toContain('服务端错误')
  })

  it('未知错误原样透传', async () => {
    const { localizeError } = await import('./useChat')
    expect(localizeError('something totally custom')).toBe('something totally custom')
  })
})
