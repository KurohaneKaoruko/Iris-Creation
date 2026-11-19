// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BookshelfState } from '../api/backend'
import { ProjectProvider, useProject } from './ProjectContext'

const backend = vi.hoisted(() => ({ getBookshelfState: vi.fn(), setWorkspace: vi.fn(), rememberExternalProject: vi.fn(), forgetWork: vi.fn() }))
vi.mock('../api/backend', () => backend)

function shelf(sceneCount: number): BookshelfState {
  return {
    default_root: '/works', external_projects: [], last_workspace: '/works/script', launch_mode: 'picker',
    default_projects: [{ path: '/works/script', name: '夜路', kind: 'screenplay', source: 'default', description: null,
      chapters_count: 0, scenes_count: sceneCount, total_words: 0, updated_at: 0, is_valid_workspace: true }],
  }
}

let root: Root
let context: ReturnType<typeof useProject>
let element: HTMLElement

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.resetAllMocks()
  backend.getBookshelfState.mockResolvedValue(shelf(1))
  backend.setWorkspace.mockResolvedValue({ root: '/works/script', kind: 'screenplay' })
  element = document.createElement('div')
  root = createRoot(element)
  function Probe() { context = useProject(); return null }
  await act(async () => root.render(<ProjectProvider><Probe /></ProjectProvider>))
})

afterEach(async () => { await act(async () => root.unmount()) })

it('recounts scenes when the author returns to the shelf', async () => {
  await act(async () => context.openDir('/works/script'))
  expect(context.workKind).toBe('screenplay')
  expect(context.state?.default_projects[0].scenes_count).toBe(1)
  backend.getBookshelfState.mockResolvedValue(shelf(3))
  await act(async () => context.closeWork())
  expect(context.workRoot).toBeNull()
  expect(context.state?.default_projects[0].scenes_count).toBe(3)
})

it('does not replace a newer shelf response with an older request', async () => {
  let respond!: (value: BookshelfState) => void
  backend.getBookshelfState.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve }))
  backend.getBookshelfState.mockResolvedValueOnce(shelf(4))
  await act(async () => { void context.refresh(); await context.refresh() })
  await act(async () => respond(shelf(2)))
  expect(context.state?.default_projects[0].scenes_count).toBe(4)
})
