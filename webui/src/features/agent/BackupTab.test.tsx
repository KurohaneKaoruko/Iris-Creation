// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { BackupTab } from './BackupTab'

vi.mock('../../api/backend', () => ({
  listWorkspaceTree: vi.fn().mockResolvedValue([]),
  readText: vi.fn(), writeText: vi.fn(), createDir: vi.fn(),
}))
vi.mock('../../state/ProjectContext', () => ({ useProject: () => ({ workName: '验收作品' }) }))

it('explicitly says the checksum report cannot restore lost chapters', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<BackupTab />))
    expect(host.textContent).toContain('非完整备份')
    expect(host.textContent).toContain('不包含正文副本，不能用于恢复丢失的文件')
    expect(host.textContent).toContain('生成校验清单')
    expect(host.textContent).not.toContain('备份完成')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
