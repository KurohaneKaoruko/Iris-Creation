// Real HTTP filesystem checks; all files are under the parent smoke test's sandbox.
import assert from 'node:assert/strict'
import { mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function verifyFilesystemBoundaries({ rpc, base, workRoot, path, original, sandbox }) {
  const outside = join(sandbox, 'boundary-outside')
  await mkdir(outside)
  const secret = join(outside, 'secret.md')
  await writeFile(secret, '其他作品的内容')
  const protectedPaths = ['.novel/work.json', '.novel/.history/boundary.txt', '.novel/snapshots/boundary.txt', '.git/config']
  for (const file of protectedPaths.slice(1)) {
    await mkdir(join(workRoot, file, '..'), { recursive: true })
    await writeFile(join(workRoot, file), 'protected')
  }
  const beforeProtected = await Promise.all(protectedPaths.map(file => readFile(join(workRoot, file))))
  const historyPath = join(workRoot, '.novel/.history/revisions.json')
  const beforeHistory = await readFile(historyPath)
  const scoped = (command, args) => rpc(command, { workspaceRoot: workRoot, ...args })
  const actions = target => [
    ['read_text', { path: target }],
    ['write_text', { relative_path: target, content: 'bad' }],
    ['write_text_if_current', { relativePath: target, content: 'bad', expectedCurrent: original }],
    ['create_file', { path: target }],
    ['create_dir', { path: target }],
    ['delete_entry', { path: target }],
    ['rename_entry', { from: target, to: 'boundary-renamed.md' }],
    ['rename_entry', { from: path, to: target }],
  ]
  const unchanged = async () => {
    assert.equal(await readFile(join(workRoot, path), 'utf8'), original)
    assert.equal(await readFile(secret, 'utf8'), '其他作品的内容')
    assert.deepEqual(await readFile(historyPath), beforeHistory)
    assert.deepEqual(await Promise.all(protectedPaths.map(file => readFile(join(workRoot, file)))), beforeProtected)
  }
  for (const target of ['../boundary-outside/secret.md', '..\\boundary-outside\\secret.md', 'C:\\outside\\secret.md', 'stories/bad\nname.md', '.novel/work.json.', secret]) {
    for (const [command, args] of actions(target)) await assert.rejects(scoped(command, args), undefined, `${command}: ${JSON.stringify(target)}`)
  }
  for (const target of [...protectedPaths, '.novel', '.novel/.history', '.novel/snapshots', '.git']) {
    for (const [command, args] of actions(target).filter(([command]) => command !== 'read_text')) {
      await assert.rejects(scoped(command, args), /管理|维护/)
    }
  }
  for (const [command, args] of [...actions(path), ['list_workspace_tree', { maxDepth: 4 }]]) {
    await assert.rejects(rpc(command, { ...args, workspace_root: outside }), /作品已切换/)
  }
  const rejected = await fetch(`${base}/api/rpc/write_text`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceRoot: workRoot, path: '../bad.md', content: 'bad' }), signal: AbortSignal.timeout(15_000),
  })
  assert.equal(rejected.status, 200)
  const envelope = await rejected.json()
  assert.equal(typeof envelope.err, 'string')
  assert.equal('ok' in envelope, false)
  await unchanged()

  // These paths remain supported. Neither normalized paths nor internal JSON are Markdown-only.
  for (const extension of ['md', 'markdown', 'txt']) {
    await scoped('write_text', { path: `.\\stories\\boundary.${extension}`, content: '兼容正文' })
    assert.equal(await scoped('read_text', { path: `./stories//boundary.${extension}` }), '兼容正文')
  }
  await scoped('write_text', { path: '.novel/.settings/boundary.json', content: '{"chapters":[]}' })
  assert.equal(await scoped('read_text', { path: '.novel/.settings/boundary.json' }), '{"chapters":[]}')

  const largePath = join(workRoot, 'stories/boundary-large.txt')
  const large = await open(largePath, 'w')
  try { await large.truncate(16 * 1024 * 1024 + 1) } finally { await large.close() }
  try {
    await assert.rejects(scoped('read_text', { path: 'stories/boundary-large.txt' }), /16 MiB/)
    const response = await fetch(`${base}/api/rpc/write_text`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot: workRoot, path, content: 'a'.repeat(16 * 1024 * 1024 + 1) }), signal: AbortSignal.timeout(15_000),
    })
    assert.equal(response.status, 413, 'The HTTP body limit rejects oversized JSON before dispatch')
    await unchanged()
  } finally { await rm(largePath) }

  let symlinksChecked = false
  if (process.platform !== 'win32') {
    const directoryLink = join(workRoot, 'boundary-link')
    const fileLink = join(workRoot, 'stories/boundary-link.md')
    await symlink(outside, directoryLink, 'dir')
    await symlink(secret, fileLink, 'file')
    try {
      for (const target of ['boundary-link/secret.md', 'boundary-link/new.md', 'stories/boundary-link.md']) {
        for (const [command, args] of actions(target)) await assert.rejects(scoped(command, args))
      }
      const refs = await scoped('resolve_inline_references', { payload: { input: '#file:stories/boundary-link.md' } })
      assert.equal(refs.resolved_input.includes('其他作品的内容'), false)
      await assert.rejects(scoped('export_work', { format: 'md' }), /链接/)
      const tree = JSON.stringify(await scoped('list_workspace_tree', { maxDepth: 8 }))
      assert.equal(tree.includes('boundary-link'), false)
      await unchanged()
      symlinksChecked = true
    } finally { await rm(directoryLink); await rm(fileLink) }
  }
  return { symlinksChecked }
}
