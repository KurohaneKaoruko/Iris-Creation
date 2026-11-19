// Real local RPC/WS acceptance. Uses disposable data and a local fake provider only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
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
const provider = createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume request without logging credentials */ }
  if (mode === 'unauthorized') { res.writeHead(401); res.end('{"error":{"message":"smoke unauthorized"}}'); return }
  if (mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{broken'); return }
  if (mode === 'disconnect') { req.socket.destroy(); return }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '验收正文：' } }] })}\n\n`)
  if (mode === 'hold') return
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '雨停以后，故事继续。🌧️' } }] })}\n\n`)
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
  for (const failure of ['unauthorized', 'malformed', 'disconnect']) {
    mode = failure
    const event = await stream(failure, 'error')
    assert.ok(event.payload.message)
    assert.equal(await rpc('read_text', { path }), original)
  }
  passed.push('local fake-provider streaming, cancellation, missing-key/401/malformed/disconnect failures; source remains intact')

  await stop()
  const restored = join(sandbox, 'restored-work')
  await cp(work.path, restored, { recursive: true })
  assert.equal(await readFile(join(restored, path), 'utf8'), original)
  await start()
  assert.equal((await rpc('get_app_settings')).active_provider_id, 'smoke-local')
  assert.equal((await rpc('get_chat_session', { id: 'smoke-session' })).messages[1].content, generated)
  await rpc('set_workspace', { path: restored })
  assert.equal(await rpc('read_text', { path }), original)
  assert.ok((await rpc('list_history_entries')).length > 0)
  passed.push('forced process termination and restart retain settings/session; external directory copy reopens with chapter/history')
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
