import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectAssets, publishRelease, verifyAssets } from './publish-release.mjs'
import { checkVersions, setVersion, validateVersion } from './version.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iris-release-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('all five version authorities update together without touching dependency versions', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'webui'))
  await mkdir(join(root, 'src-tauri'))
  for (const file of ['package.json', 'webui/package.json', 'src-tauri/tauri.conf.json']) {
    await writeFile(join(root, file), JSON.stringify({ version: '0.1.0', other: 'preserved' }))
  }
  await writeFile(join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "iris-creation"\nversion = "0.1.0"\n[dependencies]\nthing = "0.1.0"\n')
  await writeFile(join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "dependency"\nversion = "0.1.0"\n[[package]]\nname = "iris-creation"\nversion = "0.1.0"\n')
  assert.equal(setVersion('0.1.1-rc.1', root), '0.1.1-rc.1')
  assert.equal(checkVersions(root, 'v0.1.1-rc.1'), '0.1.1-rc.1')
  assert.throws(() => checkVersions(root, 'v0.1.0'), /does not match/)
  assert.match(await readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8'), /name = "dependency"\nversion = "0.1.0"/)
  await writeFile(join(root, 'webui/package.json'), '{"version":"0.1.0"}')
  assert.throws(() => checkVersions(root), /Version mismatch/)
})

for (const version of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-rc.01', '../1.0.0', '1.0.0+local', '1.0.0-']) {
  test(`rejects unsafe/invalid release version ${version}`, () => assert.throws(() => validateVersion(version)))
}

test('only complete installer sets are accepted and checksummed', async (t) => {
  const root = await fixture(t)
  const names = [
    'Iris-Creation_0.1.1-rc.1_x64-setup.exe',
    'Iris-Creation_0.1.1-rc.1_aarch64.dmg',
    'Iris-Creation_0.1.1-rc.1_amd64.AppImage',
    'Iris-Creation_0.1.1-rc.1_amd64.deb',
    'Iris-Creation_0.1.1-rc.1_amd64.rpm',
  ]
  for (const name of names) await writeFile(join(root, name), name)
  const assets = await collectAssets(root, '0.1.1-rc.1')
  assert.equal(assets.length, 6)
  const sums = await readFile(join(root, 'SHA256SUMS'), 'utf8')
  for (const asset of assets.slice(0, 5)) assert.ok(sums.includes(`${asset.digest.slice(7)}  ${asset.name}\n`))
  assert.equal((await collectAssets(root, '0.1.1-rc.1')).length, 6)
  await writeFile(join(root, 'iris-creation.exe'), 'not a standalone installer')
  await assert.rejects(collectAssets(root, '0.1.1-rc.1'), /Expected only the five/)
  await rm(join(root, 'iris-creation.exe'))
  await writeFile(join(root, 'Iris-Creation_0.1.1-rc.1_amd64.rpm'), '')
  await assert.rejects(collectAssets(root, '0.1.1-rc.1'), /Empty installer/)
})

function setup(overrides = {}) {
  const assets = ['Iris-setup.exe', 'Iris.dmg', 'Iris.AppImage', 'Iris.deb', 'Iris.rpm', 'SHA256SUMS'].map((name) => ({ name, path: '/dev/null', size: 1, digest: `sha256:${'a'.repeat(64)}` }))
  const calls = []
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
  const fetchImpl = async (url, options) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined
    calls.push({ url, method: options.method, body })
    if (options.body && typeof options.body !== 'string') for await (const _chunk of options.body) { /* consume upload */ }
    if (overrides.handle) {
      const result = overrides.handle(url, options, body)
      if (result !== undefined) return result
    }
    if (url.includes('?per_page=100&page=')) return response([])
    if (url.includes('uploads.github.com')) return response({ id: 10 })
    if (url.includes('/assets?per_page=100')) return response(assets.map((asset) => ({ ...asset, state: 'uploaded' })))
    if (options.method === 'POST') return response({ id: 42, tag_name: 'v0.1.1-rc.1', draft: true, upload_url: 'https://uploads.github.com/repos/owner/iris/releases/42/assets{?name,label}' })
    if (options.method === 'PATCH') return response({ tag_name: 'v0.1.1-rc.1', draft: false, prerelease: true, html_url: 'https://github.com/owner/iris/releases/tag/v0.1.1-rc.1' })
    throw new Error(`Unexpected request ${url}`)
  }
  return { calls, response, assets, options: { repository: 'owner/iris', tag: 'v0.1.1-rc.1', token: 'test-only', notes: 'Candidate; manual acceptance pending.', assets, fetchImpl } }
}

test('creates a draft, uploads and verifies six assets before publishing a non-latest prerelease', async () => {
  const { options, calls } = setup()
  assert.equal((await publishRelease(options)).prerelease, true)
  const writes = calls.filter((call) => call.method !== 'GET')
  assert.equal(writes.length, 8)
  assert.equal(writes[0].body.draft, true)
  assert.equal(writes[0].body.make_latest, 'false')
  assert.deepEqual(writes.at(-1).body, { draft: false, prerelease: true, make_latest: 'false' })
  assert.ok(calls.findIndex((call) => call.url.endsWith('/assets?per_page=100')) < calls.findIndex((call) => call.method === 'PATCH'))
  assert.ok(calls.every((call) => call.method !== 'DELETE'))
})

test('a stable version is published as Latest only after the verification GET', async () => {
  const state = setup()
  state.options.tag = 'v0.1.1'
  const patch = state.options.fetchImpl
  state.options.fetchImpl = async (url, options) => {
    const response = await patch(url, options)
    if (options.method === 'POST' && url.endsWith('/releases')) {
      // Mirror the stable tag/release metadata returned by GitHub.
      return new Response(JSON.stringify({ id: 42, tag_name: 'v0.1.1', draft: true, upload_url: 'https://uploads.github.com/repos/owner/iris/releases/42/assets{?name,label}' }))
    }
    if (options.method === 'PATCH') return new Response(JSON.stringify({ tag_name: 'v0.1.1', draft: false, prerelease: false, html_url: 'https://github.com/owner/iris/releases/tag/v0.1.1' }))
    return response
  }
  await publishRelease(state.options)
  const verificationIndex = state.calls.findIndex((call) => call.url.endsWith('/assets?per_page=100'))
  const publishIndex = state.calls.findIndex((call) => call.method === 'PATCH')
  assert.ok(verificationIndex >= 0 && verificationIndex < publishIndex)
  assert.deepEqual(state.calls[publishIndex].body, { draft: false, prerelease: false, make_latest: 'true' })
})

for (const status of [401, 403, 404, 429, 500, 502]) {
  test(`HTTP ${status} aborts instead of pretending no release exists`, async () => {
    const state = setup({ handle: () => new Response('{}', { status }) })
    await assert.rejects(publishRelease(state.options), new RegExp(`HTTP ${status}`))
    assert.equal(state.calls.length, 1)
  })
}

for (const draft of [false, true]) {
  test(`never deletes or overwrites an existing ${draft ? 'draft' : 'published'} release`, async () => {
    const state = setup({ handle: () => new Response(JSON.stringify([{ tag_name: 'v0.1.1-rc.1', draft, id: 7 }])) })
    await assert.rejects(publishRelease(state.options), /already exists/)
    assert.ok(state.calls.every((call) => call.method === 'GET'))
  })
}

test('checks later pages for existing releases', async () => {
  const state = setup({ handle: (url) => {
    if (url.endsWith('page=1')) return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}` }))))
    return new Response(JSON.stringify([{ tag_name: 'v0.1.1-rc.1' }]))
  } })
  await assert.rejects(publishRelease(state.options), /already exists/)
  assert.equal(state.calls.length, 2)
})

test('malformed successful API response also aborts without writes', async () => {
  const state = setup({ handle: () => new Response('{"message":"unexpected"}') })
  await assert.rejects(publishRelease(state.options), /Malformed release list/)
  assert.equal(state.calls.length, 1)
})

test('upload failure leaves draft intact and never publishes', async () => {
  const state = setup({ handle: (url) => url.includes('uploads.github.com') ? new Response('{}', { status: 502 }) : undefined })
  await assert.rejects(publishRelease(state.options), /HTTP 502.*not deleted/)
  assert.ok(state.calls.every((call) => !['PATCH', 'DELETE'].includes(call.method)))
})

test('hash mismatch prevents publication even when all uploads returned success', async () => {
  const state = setup({ handle: (url) => url.endsWith('/assets?per_page=100') ? new Response(JSON.stringify(state.assets.map((asset) => ({ ...asset, state: 'uploaded', digest: 'sha256:wrong' })))) : undefined })
  await assert.rejects(publishRelease(state.options), /verification failed/)
  assert.ok(state.calls.every((call) => !['PATCH', 'DELETE'].includes(call.method)))
})

test('asset verification rejects missing, duplicate, truncated and uncommitted uploads', () => {
  const { assets } = setup()
  const actual = assets.map((asset) => ({ ...asset, state: 'uploaded' }))
  verifyAssets(actual, assets)
  assert.throws(() => verifyAssets(actual.slice(1), assets), /count mismatch/)
  for (const patch of [{ name: actual[1].name }, { size: 0 }, { state: 'starter' }, { digest: undefined }]) {
    assert.throws(() => verifyAssets([{ ...actual[0], ...patch }, ...actual.slice(1)], assets), /verification failed/)
  }
})
