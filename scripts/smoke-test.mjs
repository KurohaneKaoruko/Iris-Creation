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
import { verifyFilesystemBoundaries } from './fs-boundary-smoke.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const binary = resolve(process.argv[2] || join(root, `src-tauri/target/debug/iris-creation-server${process.platform === 'win32' ? '.exe' : ''}`))
const sandbox = await mkdtemp(join(tmpdir(), 'iris-acceptance-'))
const passed = []
let child, ws, base, output = '', mode = 'success'
const events = []
let agentCalls = 0
const sse = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
// 媒体 fake 供应商共享状态（PNG fixture / 最小 MP4 / Runway 任务表）
const mediaFixtures = await readFile(join(root, 'src-tauri/icons/32x32.png'))
const mediaImageB64 = mediaFixtures.toString('base64')
const mediaVideo = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)])
let runwayTaskSeq = 1
const runwayTasks = new Map()
const provider = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  // ---- 媒体工作台 fake 供应商（OpenAI 兼容图像 / Runway 兼容视频 / 假 CDN）----
  if (req.url.startsWith('/img/images/')) {
    if (!/Bearer sk-image-smoke/.test(req.headers.authorization ?? '')) { res.writeHead(401); res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: mediaImageB64 }] }))
    return
  }
  if (req.url.startsWith('/vid/v1/text_to_video') || req.url.startsWith('/vid/v1/image_to_video')) {
    if (!/Bearer sk-video-smoke/.test(req.headers.authorization ?? '') || !(req.headers['x-runway-version'] === '2024-11-06')) { res.writeHead(401); res.end('{}'); return }
    const id = `11111111-2222-3333-4444-${String(runwayTaskSeq++).padStart(12, '0')}`
    runwayTasks.set(id, { status: 'PENDING', tries: 0 })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id }))
    return
  }
  if (req.url.startsWith('/vid/v1/tasks/')) {
    const task = runwayTasks.get(req.url.split('/').pop())
    if (!task) { res.writeHead(404); res.end('{}'); return }
    task.tries += 1
    if (task.tries < 2) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'RUNNING', progress: 0.4 })); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'SUCCEEDED', output: [`http://127.0.0.1:${provider.address().port}/cdn/out.mp4`] }))
    return
  }
  if (req.url.startsWith('/cdn/')) {
    if (req.headers.range) { res.writeHead(206, { 'content-range': `bytes ${req.headers.range}/0` }); res.end(); return }
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(mediaVideo)
    return
  }
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
    const result = await check()
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
  assert.match(snapshot.content_hash, /^[0-9a-f]{64}$/)
  assert.equal(await rpc('read_history_snapshot', { id: snapshot.id }), original)
  await rpc('restore_history_snapshot', { id: snapshot.id })
  assert.equal(await rpc('read_text', { path }), original)
  const restoreBackup = (await rpc('list_history_entries')).find(entry => entry.file_path === path && entry.reason === 'restore-backup')
  assert.ok(restoreBackup)
  assert.equal(await rpc('read_history_snapshot', { id: restoreBackup.id }), `${original}新段落。\n`)
  await rpc('restore_history_snapshot', { id: restoreBackup.id, expectedCurrent: original })
  assert.equal(await rpc('read_text', { path }), `${original}新段落。\n`)
  await rpc('restore_history_snapshot', { id: snapshot.id, expectedCurrent: `${original}新段落。\n` })
  const historyIndexPath = join(work.path, '.novel/.history/revisions.json')
  const savedIndex = await readFile(historyIndexPath)
  const savedStore = JSON.parse(savedIndex)
  const savedRecord = savedStore.entries.find(entry => entry.id === snapshot.id)
  assert.ok(savedRecord.snapshot_rel_path.startsWith('.novel/.history/snapshots/'))
  const savedSnapshotPath = join(work.path, savedRecord.snapshot_rel_path)
  const savedSnapshot = await readFile(savedSnapshotPath)
  await writeFile(savedSnapshotPath, 'tampered snapshot')
  await assert.rejects(rpc('read_history_snapshot', { id: snapshot.id }), /校验/)
  await assert.rejects(rpc('restore_history_snapshot', { id: snapshot.id, expectedCurrent: original }), /校验/)
  assert.equal(await rpc('read_text', { path }), original)
  assert.deepEqual(await readFile(historyIndexPath), savedIndex)
  await writeFile(savedSnapshotPath, savedSnapshot)
  delete savedRecord.content_hash // legacy records remain readable without pretending to be verified
  await writeFile(historyIndexPath, JSON.stringify(savedStore))
  assert.equal(await rpc('read_history_snapshot', { id: snapshot.id }), original)
  await writeFile(historyIndexPath, savedIndex)
  await assert.rejects(rpc('read_text', { path: '../outside.md' }))
  assert.ok((await rpc('export_work', { format: 'md' })).content.includes('这是保存、恢复与重启验收'))
  passed.push('Unicode/CRLF save, stale-save rejection, reversible history restore, snapshot integrity/legacy metadata, export and path guard')

  const boundaries = await verifyFilesystemBoundaries({ rpc, base, workRoot: work.path, path, original, sandbox })
  passed.push(`filesystem HTTP boundary: unsafe/managed/stale paths, unchanged manuscript/history, MD/Markdown/TXT and internal JSON compatibility, 16 MiB read/body limits; symlinks ${boundaries.symlinksChecked ? 'checked' : 'not checked on Windows'}`)

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
  await assert.rejects(rpc('write_text', { workspaceRoot, path: 'creative/storyboard.json', content: '{}' }), /分镜与媒体服务管理/)
  await assert.rejects(rpc('delete_entry', { workspaceRoot, path: reference.path }), /分镜与媒体服务管理/)
  await assert.rejects(rpc('rename_entry', { workspaceRoot, from: reference.path, to: 'creative/references/renamed.png' }), /分镜与媒体服务管理/)
  const boardExport = await rpc('save_storyboard_export', { workspaceRoot, revision: board.revision })
  const shotSheet = await readFile(join(workspaceRoot, boardExport), 'utf8')
  assert.ok(shotSheet.indexOf('手中车票') < shotSheet.indexOf('月台远景'))
  assert.ok(shotSheet.includes(`../${reference.path}`))
  const beforeInvalidImport = await readdir(join(workspaceRoot, 'creative/references'))
  const beforeInvalidBoard = await readFile(boardPath)
  for (const encoded of ['', 'invalid-base64!', Buffer.from('<svg></svg>').toString('base64'), fixtureImage.subarray(0, fixtureImage.length / 2).toString('base64'), 'A'.repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4)]) {
    await assert.rejects(rpc('import_storyboard_image', { workspaceRoot, revision: board.revision, shotId: null, role: 'reference', name: '伪装图', originalName: 'bad.png', base64: encoded }), /图片|PNG|10 M/)
    assert.deepEqual(await readFile(boardPath), beforeInvalidBoard)
  }
  assert.deepEqual(await readdir(join(workspaceRoot, 'creative/references')), beforeInvalidImport)
  await assert.rejects(rpc('load_storyboard'), /workspaceRoot/)
  passed.push('storyboard: shots/order, stale-write rejection, local validated image import/preview and ordered export')

  // ---- creative media studio: settings via secrets channel, fake image/video providers, streaming endpoint ----
  const mediaImage = mediaFixtures
  let runwayCalls = 0
  provider.on('request', (req) => { runwayCalls += req.url.startsWith('/vid/v1/') ? 1 : 0 })
  const mediaPort = provider.address().port
  await rpc('save_creative_media_settings', { request: {
    settings: { imageBase: `http://127.0.0.1:${mediaPort}/img`, imageModel: 'fake-image-1', videoBase: `http://127.0.0.1:${mediaPort}/vid` },
    imageKey: 'sk-image-smoke', videoKey: 'sk-video-smoke',
  } })
  const mediaView = await rpc('get_creative_media_settings')
  assert.equal(mediaView.imageKeyConfigured, true)
  assert.equal(mediaView.videoKeyConfigured, true)
  assert.ok(!JSON.stringify(mediaView).includes('sk-image-smoke'), 'keys must never echo back')

  let imageJob = await rpc('generate_creative_media', { workspaceRoot, request: { kind: 'image', shotId: null, sourceId: null, prompt: '雨夜霓虹站台', portrait: true } })
  assert.equal(imageJob.state, 'submitting')
  imageJob = await waitFor(async () => {
    try {
      const job = await rpc('refresh_creative_media', { workspaceRoot, id: imageJob.id })
      return job.state === 'ready' ? job : null
    } catch (error) { if (/正在处理/.test(String(error))) return null; throw error }
  }, 'image generation to finish')
  assert.equal(imageJob.asset.format, 'png')
  assert.deepEqual(await readFile(join(workspaceRoot, `creative/assets/${imageJob.id}.png`)), mediaImage)
  let mediaResponse = await fetch(`${base}/api/creative-media/${imageJob.id}`, { headers: { host: '127.0.0.1' } })
  assert.equal(mediaResponse.status, 200)
  assert.equal(mediaResponse.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), mediaImage)
  mediaResponse = await fetch(`${base}/api/creative-media/${imageJob.id}`, { headers: { host: '127.0.0.1', range: 'bytes=4-7' } })
  assert.equal(mediaResponse.status, 206)
  assert.equal(mediaResponse.headers.get('content-range'), `bytes 4-7/${mediaImage.length}`)
  assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), mediaImage.subarray(4, 8))

  // 图生视频：提交→Waiting→轮询 SUCCEEDED→MP4 落盘→流式端点可读。
  let videoJob = await rpc('generate_creative_media', { workspaceRoot, request: { kind: 'video', shotId: null, sourceId: imageJob.id, prompt: '镜头推进', duration: 5 } })
  videoJob = await waitFor(async () => {
    try {
      const job = await rpc('refresh_creative_media', { workspaceRoot, id: videoJob.id })
      return job.state === 'ready' ? job : null
    } catch (error) { if (/正在处理/.test(String(error))) return null; throw error }
  }, 'video generation to finish')
  assert.equal(videoJob.asset.format, 'mp4')
  assert.deepEqual(await readFile(join(workspaceRoot, `creative/assets/${videoJob.id}.mp4`)), mediaVideo)
  mediaResponse = await fetch(`${base}/api/creative-media/${videoJob.id}`, { headers: { host: '127.0.0.1' } })
  assert.equal(mediaResponse.status, 200)
  assert.equal(mediaResponse.headers.get('content-type'), 'video/mp4')
  assert.ok(runwayCalls >= 2, 'video used the Runway-compatible route')
  // 媒体受管路径不可经通用文件命令越权改写（两类作品一致）。
  await assert.rejects(rpc('write_text', { workspaceRoot, path: `creative/jobs/${imageJob.id}.json`, content: '{}' }), /媒体服务管理/)
  await assert.rejects(rpc('delete_entry', { workspaceRoot, path: `creative/assets/${imageJob.id}.png` }), /媒体服务管理/)
  // 其他作品上下文读不到本作品的素材（workspace 绑定）。
  await assert.rejects(rpc('refresh_creative_media', { workspaceRoot: work.path, id: imageJob.id }), /未找到|已切换/)
  assert.equal((await fetch(`${base}/api/creative-media/00000000-0000-4000-8000-000000000000`, { headers: { host: '127.0.0.1' } })).status, 404)
  passed.push('creative media: secrets-channel settings, fake image/video providers, streaming endpoint with ranges, managed-path guard')

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
