/** 桌面壳/本地服务启动探测：把端口、资源和启动时序问题转为明确状态。 */
export type BackendProbe = { ok: true } | { ok: false; message: string }

export function backendRetryDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt), 1500)
}

export async function probeBackend(fetcher: typeof fetch = fetch): Promise<BackendProbe> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    const response = await fetcher('/api/health', { cache: 'no-store', signal: controller.signal })
    if (!response.ok) return { ok: false, message: `本地服务返回 HTTP ${response.status}` }
    const result = await response.json() as { ok?: unknown; app?: unknown }
    if (result.ok !== true || result.app !== 'iris-creation-server') {
      return { ok: false, message: '服务响应不正确，请确认启动的是 Iris-Creation 本地服务。' }
    }
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: /failed to fetch|network|load failed/i.test(detail)
        ? '暂时连接不到本地服务，请稍候重试。'
        : detail,
    }
  } finally {
    clearTimeout(timeout)
  }
}
