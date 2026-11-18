import { afterEach, describe, expect, it, vi } from 'vitest'
import { rpc } from './rpc'
import { listWorkspaceTree, readText } from './backend'

afterEach(() => vi.unstubAllGlobals())

describe('cancellable read RPC', () => {
  it('passes AbortSignal through typed reads and still decodes ordinary replies', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: '正文' }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    expect(await readText('stories/one.md', controller.signal)).toBe('正文')
    expect(fetcher).toHaveBeenCalledWith('/api/rpc/read_text', expect.objectContaining({ signal: controller.signal, body: JSON.stringify({ relativePath: 'stories/one.md' }) }))
    await listWorkspaceTree(8, controller.signal)
    expect(fetcher).toHaveBeenLastCalledWith('/api/rpc/list_workspace_tree', expect.objectContaining({ signal: controller.signal }))
  })

  it('does not swallow cancellation as a successful empty response', async () => {
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')))
    }))
    const controller = new AbortController()
    const pending = rpc('read_text', { relativePath: 'stories/one.md' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
