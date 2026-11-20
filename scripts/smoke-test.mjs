// Real local RPC/WS acceptance. Uses disposable data and a local fake provider only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const binary = resolve(process.argv[2] || join(root, `src-tauri/target/debug/iris-creation-server${process.platform === 'win32' ? '.exe' : ''}`))
const sandbox = await mkdtemp(join(tmpdir(), 'iris-acceptance-'))
const passed = []
let child, ws, base, output = '', mode = 'success'
const events = []
let agentCalls = 0
const sse = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (mode === 'unauthorized') { res.writeHead(401); res.end('{"error":{"message":"smoke unauthorized"}}'); return }
  if (mode === 'rate-limit') { res.writeHead(429); res.end('{"error":{"message":"smoke rate limit"}}'); return }
  if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{broken'); return }
  if (mode === 'disconnect') { req.socket.destroy(); return }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  if (mode === 'script-agent') {
    const data = JSON.parse(body)
    if (!data.messages[0]?.content.includes('剧本创作助手')) { res.end('data: {"error":"wrong project prompt"}\n\n'); return }
    const replies = ['ACTION: screenplay_list_scenes\nINPUT: {}', 'ACTION: fs_read_text\nINPUT: {"path":"outline/outline.md"}', 'FINAL: 可先用车站广播交代时间，不改写原稿。']
    const reply = replies[agentCalls++]
    res.end(sse(reply) + 'data: [DONE]\n\n')
    return
  }
  const first = Buffer.from(sse('验收正文：'))
  const splitAt = first.indexOf(Buffer.from('验')) + 1
  res.write(first.subarray(0, splitAt))
  await delay(20) // force an SSE line and a CJK character to cross network chunks
  res.write(first.subarray(splitAt))
  if (mode === 'hold') return
  if (mode === 'partial') { res.end(); return }
  if (mode === 'in-band-error') { res.end('data: {"error":{"message":"model aborted"}}\n\n'); return }
  res.write(sse('雨停以后，故事继续。🌧️'))
  res.end('data: [DONE]\n\n')
})

async function waitFor(check, label, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = check()
    if (result) return result
    await delay(25)
  }
  throw new Error(`Timeout: ${label}\n${output.slice(-2000)}`)
}

async function start() {
  output = ''
  child = spawn(binary, ['--host', '127.0.0.1', '--port', '0', '--static-dir', join(root, 'webui/dist'), '--data-dir', join(sandbox, 'data')], {
    cwd: sandbox,
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  let failure
  child.on('error', (error) => { failure = error })
  await waitFor(() => {
    if (failure) throw failure
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`)
    return /listening on (http:\/\/127\.0\.0\.1:\d+)/.test(output)
  }, 'server startup')
  base = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)[1]
  ws = new WebSocket(base.replace('http:', 'ws:') + '/ws')
  ws.addEventListener('message', (event) => events.push(JSON.parse(event.data)))
  await once(ws, 'open')
}

async function stop() {
  if (ws) { ws.close(); ws = null }
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
    await exited
  }
}

async function rpc(command, args = {}) {
  const response = await fetch(`${base}/api/rpc/${command}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15_000) })
  assert.ok(response.ok, `${command}: HTTP ${response.status}`)
  const value = await response.json()
  if ('err' in value) throw new Error(value.err)
  assert.ok('ok' in value, `Invalid RPC response: ${command}`)
  return value.ok
}

async function stream(id, expected = 'done') {
  await rpc('studio_complete_stream', { streamId: id, providerId: 'smoke-local', messages: [{ role: 'user', content: '仅本地验收' }] })
  return waitFor(() => events.find((event) => event.payload?.streamId === id && event.event === (expected === 'error' ? 'ai_error' : 'ai_stream_done')), id)
}

try {
  await new Promise((ready) => provider.listen(0, '127.0.0.1', ready))
  await start()
  assert.equal(await rpc('ping'), 'pong')
  assert.ok((await fetch(`${base}/api/health`)).ok)
  const html = await (await fetch(base)).text()
  const asset = html.match(/src="([^"]+\.js)"/)
  assert.ok(asset, 'Production entry script is present')
  assert.ok((await fetch(new URL(asset[1], base))).ok)
  assert.equal((await fetch(`${base}/assets/does-not-exist.js`)).status, 404)
  passed.push('production assets and RPC start outside repository on an ephemeral port')

  const work = await rpc('create_novel_work', { name: '验收作品', description: 'Disposable acceptance workspace' })
  await rpc('set_workspace', { path: work.path })
  const path = 'stories/smoke-chapter.md'
  const original = '# 第一章 雨后\r\n\r\n这是保存、恢复与重启验收。🌧️\r\n'
  await rpc('write_text', { path, content: original })
  assert.equal(await rpc('read_text', { path }), original)
  await rpc('write_text_if_current', { path, content: `${original}新段落。\n`, expectedCurrent: original })
  await assert.rejects(rpc('write_text_if_current', { path, content: 'must not overwrite', expectedCurrent: original }), /changed on disk/i)
  assert.equal(await rpc('read_text', { path }), `${original}新段落。\n`)
  const history = await rpc('list_history_entries')
  const snapshot = history.find((entry) => entry.file_path === path)
  assert.ok(snapshot)
  assert.equal(await rpc('read_history_snapshot', { id: snapshot.id }), original)
  await rpc('restore_history_snapshot', { id: snapshot.id })
  assert.equal(await rpc('read_text', { path }), original)
  await assert.rejects(rpc('read_text', { path: '../outside.md' }))
  assert.ok((await rpc('export_work', { format: 'md' })).content.includes('这是保存、恢复与重启验收'))
  passed.push('Unicode/CRLF save, stale-save rejection, history restore, export and path guard')

  const settings = await rpc('get_app_settings')
  settings.providers = [{ id: 'smoke-local', name: 'Local acceptance fixture', kind: 'OpenAICompatible', api_key: '', base_url: `http://127.0.0.1:${provider.address().port}/v1`, model_name: 'fixture' }]
  settings.active_provider_id = 'smoke-local'
  await rpc('set_app_settings', { settings })
  const missing = await stream('missing-key', 'error')
  assert.match(missing.payload.message, /no API key/i)
  await rpc('set_api_key', { providerId: 'smoke-local', apiKey: 'iris-smoke-local-only' })
  await stream('success')
  const generated = events.filter((event) => event.event === 'ai_stream_token' && event.payload.streamId === 'success').map((event) => event.payload.token).join('')
  assert.equal(generated, '验收正文：雨停以后，故事继续。🌧️')
  await rpc('save_chat_session', { session: { id: 'smoke-session', title: '验收会话', workspace_root: work.path, messages: [{ role: 'user', content: '仅本地验收' }, { role: 'assistant', content: generated }] } })
  mode = 'hold'
  await rpc('studio_complete_stream', { streamId: 'cancel', providerId: 'smoke-local', messages: [{ role: 'user', content: 'hold' }] })
  await waitFor(() => events.some((event) => event.event === 'ai_stream_token' && event.payload.streamId === 'cancel'), 'first token before cancellation')
  await rpc('chat_cancel_stream', { streamId: 'cancel' })
  await waitFor(() => events.some((event) => event.event === 'ai_stream_done' && event.payload.streamId === 'cancel' && event.payload.cancelled), 'cancelled event')
  for (const failure of ['unauthorized', 'rate-limit', 'malformed', 'disconnect', 'partial', 'in-band-error']) {
    mode = failure
    const event = await stream(failure, 'error')
    assert.ok(event.payload.message)
    assert.equal(await rpc('read_text', { path }), original)
  }
  passed.push('fake Provider: split UTF-8, streaming, cancellation, missing key, 401/429, malformed response, disconnect and premature EOF; source remains intact')

  const script = await rpc('create_project', { name: '验收作品', description: '验收剧本', kind: 'screenplay' })
  assert.notEqual(script.path, work.path)
  assert.equal(script.kind, 'screenplay')
  assert.equal(script.scenes_count, 1)
  assert.equal(script.chapters_count, 0)
  const workspaceRoot = script.path
  assert.equal((await rpc('set_workspace', { path: workspaceRoot })).kind, 'screenplay')
  const scripted = await rpc('create_screenplay_scene', { workspaceRoot, draft: { title: '最后一班车', interior: 'exterior', location: '老车站', time: '夜', body: '**小秋：** 车还没来。' } })
  assert.equal(scripted.setting, '外景 · 老车站 · 夜')
  const paths = (await rpc('list_screenplay_scenes', { workspaceRoot })).map((scene) => scene.path)
  const reversed = [...paths].reverse()
  await rpc('reorder_screenplay_scenes', { workspaceRoot, expectedPaths: paths, paths: reversed })
  await assert.rejects(rpc('reorder_screenplay_scenes', { workspaceRoot, expectedPaths: paths, paths: reversed }), /场次列表已变化/)

  await assert.rejects(rpc('write_text_if_current', { workspaceRoot: work.path, path: scripted.path, content: 'wrong work', expectedCurrent: '' }), /作品已切换/)
  await assert.rejects(rpc('create_screenplay_scene', { workspaceRoot: work.path, draft: { title: 'wrong work' } }), /作品已切换/)
  await assert.rejects(rpc('init_novel'), /不能初始化为小说/)
  await assert.rejects(rpc('create_file', { workspaceRoot, path: scripted.path }), /exists|file.*failed/i)
  await assert.rejects(rpc('delete_entry', { workspaceRoot, path: scripted.path }), /不直接删除场次/)

  const sceneOriginal = await rpc('read_text', { workspaceRoot, path: scripted.path })
  const sceneEdited = `${sceneOriginal}\n广播里响起末班车的提示。\n`
  await rpc('write_text_if_current', { workspaceRoot, path: scripted.path, content: sceneEdited, expectedCurrent: sceneOriginal })
  const sceneSnapshot = (await rpc('list_history_entries', { workspaceRoot })).find((entry) => entry.file_path === scripted.path)
  assert.equal(await rpc('read_history_snapshot', { workspaceRoot, id: sceneSnapshot.id }), sceneOriginal)
  await assert.rejects(rpc('restore_history_snapshot', { workspaceRoot, id: sceneSnapshot.id, expectedCurrent: sceneOriginal }), /changed on disk/)
  assert.equal(await rpc('read_text', { workspaceRoot, path: scripted.path }), sceneEdited)
  await rpc('restore_history_snapshot', { workspaceRoot, id: sceneSnapshot.id, expectedCurrent: sceneEdited })
  const markdown = await rpc('save_screenplay_export', { workspaceRoot, format: 'md' })
  const plain = await rpc('save_screenplay_export', { workspaceRoot, format: 'txt' })
  assert.match(await readFile(join(workspaceRoot, markdown), 'utf8'), /## 第 1 场 · 最后一班车[\s\S]*## 第 2 场 · 开场/)
  assert.match(await readFile(join(workspaceRoot, plain), 'utf8'), /小秋： 车还没来。/)
  assert.equal(await readFile(join(workspaceRoot, scripted.path), 'utf8'), sceneOriginal)
  passed.push('screenplay: typed shelf, stable scene paths, stale reorder/write/restore rejection, history, ordered Markdown and TXT export')

  assert.equal((await rpc('load_storyboard', { workspaceRoot })).revision, null)
  const shotDraft = { scenePath: scripted.path, title: '月台远景', action: '镜头越过空荡的站台。', dialogue: '远处传来列车声。', framing: 'wide', cameraMove: 'pan', duration: 6, assetIds: [] }
  let board = await rpc('save_storyboard_shot', { workspaceRoot, revision: null, shot: shotDraft })
  const firstShot = board.shots[0].id
  const oldBoardRevision = board.revision
  board = await rpc('save_storyboard_shot', { workspaceRoot, revision: board.revision, shot: { ...shotDraft, title: '手中车票', framing: 'close_up', duration: 3 } })
  const boardPath = join(workspaceRoot, 'creative/storyboard.json')
  const beforeConflict = await readFile(boardPath, 'utf8')
  await assert.rejects(rpc('save_storyboard_shot', { workspaceRoot, revision: oldBoardRevision, shot: shotDraft }), /修改/)
  const shotIds = board.shots.map(shot => shot.id)
  await assert.rejects(rpc('reorder_storyboard_shots', { workspaceRoot, revision: board.revision, expectedIds: shotIds, ids: [firstShot, firstShot] }), /全部镜头/)
  assert.equal(await readFile(boardPath, 'utf8'), beforeConflict)
  board = await rpc('reorder_storyboard_shots', { workspaceRoot, revision: board.revision, expectedIds: shotIds, ids: [...shotIds].reverse() })
  const fixtureImage = await readFile(join(root, 'src-tauri/icons/32x32.png'))
  board = await rpc('import_storyboard_image', { workspaceRoot, revision: board.revision, shotId: firstShot, role: 'location', name: '月台光线参考', originalName: '站台.png', base64: fixtureImage.toString('base64') })
  const reference = board.assets[0]
  assert.equal(reference.available, true)
  assert.equal(reference.width, 32)
  assert.deepEqual(await readFile(join(workspaceRoot, reference.path)), fixtureImage)
  assert.deepEqual(board.shots.find(shot => shot.id === firstShot).assetIds, [reference.id])
  assert.equal((await rpc('read_creative_image', { workspaceRoot, id: reference.id })).mime, 'image/png')
  await assert.rejects(rpc('write_text', { workspaceRoot, path: 'creative/storyboard.json', content: '{}' }), /分镜与素材工具管理/)
  await assert.rejects(rpc('delete_entry', { workspaceRoot, path: reference.path }), /分镜与素材工具管理/)
  await assert.rejects(rpc('rename_entry', { workspaceRoot, from: reference.path, to: 'creative/references/renamed.png' }), /分镜与素材工具管理/)
  const boardExport = await rpc('save_storyboard_export', { workspaceRoot, revision: board.revision })
  const shotSheet = await readFile(join(workspaceRoot, boardExport), 'utf8')
  assert.ok(shotSheet.indexOf('手中车票') < shotSheet.indexOf('月台远景'))
  assert.ok(shotSheet.includes(`../${reference.path}`))
  const beforeInvalidImport = await readdir(join(workspaceRoot, 'creative/references'))
  await assert.rejects(rpc('import_storyboard_image', { workspaceRoot, revision: board.revision, shotId: null, role: 'reference', name: '伪装图', originalName: 'bad.png', base64: Buffer.from('<svg></svg>').toString('base64') }), /图片|PNG/)
  assert.deepEqual(await readdir(join(workspaceRoot, 'creative/references')), beforeInvalidImport)
  await assert.rejects(rpc('load_storyboard'), /workspaceRoot/)
  passed.push('storyboard: shots/order, stale-write rejection, local validated image import/preview and ordered export')

  mode = 'script-agent'
  await rpc('chat_generate_stream', { streamId: 'script-agent', workspaceRoot, providerId: 'smoke-local', messages: [{ role: 'user', content: '读场次和分场大纲，再给开场建议。' }] })
  await waitFor(() => events.some((event) => event.event === 'ai_stream_done' && event.payload.streamId === 'script-agent'), 'screenplay Agent completion')
  const scriptEvents = events.filter((event) => event.payload.streamId === 'script-agent')
  const steps = scriptEvents.filter((event) => event.event === 'ai_agent_step' && event.payload.phase === 'finish')
  assert.deepEqual(steps.map(({ payload }) => [payload.tool, payload.ok]), [['screenplay_list_scenes', true], ['fs_read_text', true]])
  assert.match(scriptEvents.filter((event) => event.event === 'ai_stream_token').map((event) => event.payload.token).join(''), /^可先用车站广播/)
  assert.equal(await rpc('read_text', { workspaceRoot, path: scripted.path }), sceneOriginal)
  passed.push('screenplay Agent reads scenes and outline with its own prompts, while preserving source')

  await stop()
  const restored = join(sandbox, 'restored-work')
  const restoredScript = join(sandbox, 'restored-screenplay')
  await cp(work.path, restored, { recursive: true })
  await cp(script.path, restoredScript, { recursive: true })
  assert.equal(await readFile(join(restored, path), 'utf8'), original)
  await start()
  assert.equal((await rpc('get_app_settings')).active_provider_id, 'smoke-local')
  assert.equal((await rpc('get_chat_session', { id: 'smoke-session' })).messages[1].content, generated)
  assert.equal((await rpc('set_workspace', { path: restored })).kind, 'novel')
  assert.equal(await rpc('read_text', { path }), original)
  assert.ok((await rpc('list_history_entries')).length > 0)
  assert.equal((await rpc('set_workspace', { path: restoredScript })).kind, 'screenplay')
  assert.deepEqual((await rpc('list_screenplay_scenes', { workspaceRoot: restoredScript })).map((scene) => scene.path), reversed)
  assert.equal(await rpc('read_history_snapshot', { workspaceRoot: restoredScript, id: sceneSnapshot.id }), sceneOriginal)
  passed.push('forced restart preserves settings/session; copying whole novel and screenplay directories restores manuscript, order and history')
  const copiedBoard = await rpc('load_storyboard', { workspaceRoot: restoredScript })
  assert.deepEqual(copiedBoard, board)
  assert.equal((await rpc('read_creative_image', { workspaceRoot: restoredScript, id: reference.id })).mime, 'image/png')
  for (const command of ['load_storyboard', 'save_storyboard_shot', 'remove_storyboard_shot', 'reorder_storyboard_shots', 'import_storyboard_image', 'detach_storyboard_asset', 'read_creative_image', 'save_storyboard_export']) {
    await assert.rejects(rpc(command, { workspaceRoot }), /切换|不匹配/)
  }
  const copyBoardPath = join(restoredScript, 'creative/storyboard.json')
  const copiedRaw = await readFile(copyBoardPath, 'utf8')
  await writeFile(copyBoardPath, '{broken')
  await assert.rejects(rpc('load_storyboard', { workspaceRoot: restoredScript }), /损坏/)
  await assert.rejects(rpc('save_storyboard_shot', { workspaceRoot: restoredScript, revision: copiedBoard.revision, shot: shotDraft }), /损坏/)
  assert.equal(await readFile(copyBoardPath, 'utf8'), '{broken')
  await writeFile(copyBoardPath, copiedRaw)
  await rm(join(restoredScript, reference.path))
  const missingReference = await rpc('load_storyboard', { workspaceRoot: restoredScript })
  assert.equal(missingReference.assets[0].available, false)
  assert.deepEqual(missingReference.shots, copiedBoard.shots)
  await assert.rejects(rpc('read_creative_image', { workspaceRoot: restoredScript, id: reference.id }), /丢失|移动/)
  const detached = await rpc('detach_storyboard_asset', { workspaceRoot: restoredScript, revision: missingReference.revision, id: reference.id })
  assert.equal(detached.assets.length, 0)
  assert.deepEqual(detached.shots.find(shot => shot.id === firstShot).assetIds, [])
  // Edits in the copied project cannot touch the source or its manuscript.
  assert.deepEqual(await readFile(join(workspaceRoot, reference.path)), fixtureImage)
  assert.equal(await readFile(join(workspaceRoot, scripted.path), 'utf8'), sceneOriginal)
  passed.push('storyboard: whole-project copy/restart, cross-workspace RPC rejection, corrupt manifests and missing asset safety')
  console.log(JSON.stringify({ passed, notCovered: ['real paid model/network', 'desktop installer UI and OS upgrade', 'long-duration writing and disk-failure recovery'], result: 'pass' }, null, 2))
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  await stop()
  provider.closeAllConnections()
  await new Promise((done) => provider.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
