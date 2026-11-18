import { describe, expect, it, vi } from 'vitest'
import { backendRetryDelay, probeBackend } from './health'

describe('desktop backend startup probe', () => {
  it('accepts a healthy local service', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true,"app":"iris-creation-server"}', { status: 200 }))
    await expect(probeBackend(fetcher as typeof fetch)).resolves.toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }))
  })

  it('does not mistake a cached HTML fallback or unrelated service for the backend', async () => {
    expect((await probeBackend(async () => new Response('<html></html>'))).ok).toBe(false)
    expect((await probeBackend(async () => new Response('{"ok":true}'))).ok).toBe(false)
  })

  it('reports HTTP and network failures in a user-readable way', async () => {
    await expect(probeBackend(async () => new Response('', { status: 503 }))).resolves.toEqual({
      ok: false,
      message: '本地服务返回 HTTP 503',
    })
    await expect(probeBackend(async () => { throw new TypeError('Failed to fetch') })).resolves.toEqual({
      ok: false,
      message: '暂时连接不到本地服务，请稍候重试。',
    })
  })

  it('backs off briefly without delaying startup', () => {
    expect(backendRetryDelay(0)).toBe(250)
    expect(backendRetryDelay(2)).toBe(1000)
    expect(backendRetryDelay(8)).toBe(1500)
  })
})
