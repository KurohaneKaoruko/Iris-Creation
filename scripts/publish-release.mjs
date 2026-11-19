import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVersions } from './version.mjs'

export async function collectAssets(directory, version) {
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name !== 'SHA256SUMS') files.push(path)
      else if (!entry.isFile()) throw new Error(`Unsupported artifact: ${path}`)
    }
  }
  await walk(directory)
  if (version) {
    // Reject stale/wrong-architecture artifacts before they can reach a release.
    const expectedNames = new Set([
      `Iris-Creation_${version}_x64-setup.exe`,
      `Iris-Creation_${version}_aarch64.dmg`,
      `Iris-Creation_${version}_amd64.AppImage`,
      `Iris-Creation_${version}_amd64.deb`,
      `Iris-Creation_${version}_amd64.rpm`,
    ])
    const actualNames = files.map((path) => basename(path))
    if (actualNames.length !== expectedNames.size || actualNames.some((name) => !expectedNames.has(name))) {
      throw new Error(`Expected only the five v${version} installers for Windows x64, macOS arm64 and Linux x64; got: ${actualNames.join(', ')}`)
    }
  }
  const types = [/\-setup\.exe$/, /\.dmg$/, /\.AppImage$/, /\.deb$/, /\.rpm$/]
  if (files.length !== types.length || types.some((type) => files.filter((file) => type.test(file)).length !== 1)) {
    throw new Error('Expected exactly five installers: NSIS setup.exe, DMG, AppImage, DEB and RPM (no raw executables)')
  }
  const assets = []
  for (const path of files.sort()) {
    const name = basename(path)
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) throw new Error(`Unsafe asset name: ${name}`)
    const { size } = await stat(path)
    if (size === 0) throw new Error(`Empty installer: ${name}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    assets.push({ path, name, size, digest: `sha256:${hash.digest('hex')}` })
  }
  const checksum = assets.map((asset) => `${asset.digest.slice(7)}  ${asset.name}\n`).join('')
  const path = resolve(directory, 'SHA256SUMS')
  await writeFile(path, checksum)
  assets.push({ path, name: 'SHA256SUMS', size: Buffer.byteLength(checksum), digest: `sha256:${createHash('sha256').update(checksum).digest('hex')}` })
  return assets
}

export function verifyAssets(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error('Release asset count mismatch')
  for (const asset of expected) {
    const matches = actual.filter((item) => item.name === asset.name)
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== asset.size || matches[0].digest !== asset.digest) {
      throw new Error(`Release asset verification failed: ${asset.name}`)
    }
  }
}

export async function publishRelease({ repository, tag, token, assets, notes, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required')
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag)) throw new Error('A version tag is required')
  if (!Array.isArray(assets) || assets.length !== 6 || new Set(assets.map((asset) => asset.name)).size !== 6) throw new Error('Six verified assets are required')
  const base = `https://api.github.com/repos/${repository}`
  async function request(url, method = 'GET', json, file) {
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10' }
    if (file) Object.assign(headers, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) })
    else if (json) headers['Content-Type'] = 'application/json'
    const body = file ? createReadStream(file.path) : json ? JSON.stringify(json) : undefined
    try {
      const response = await fetchImpl(url, { method, headers, body, ...(file ? { duplex: 'half' } : {}), signal: AbortSignal.timeout(file ? 900_000 : 60_000) })
      if (!response.ok) throw new Error(`GitHub ${method} failed: HTTP ${response.status}`)
      const result = await response.json()
      if (!result || typeof result !== 'object') throw new Error('Malformed GitHub response')
      return result
    } finally {
      if (file) body.destroy()
    }
  }
  // List with authentication, including drafts. Any HTTP/JSON error stops publication.
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('Release pagination limit exceeded')
    const releases = await request(`${base}/releases?per_page=100&page=${page}`)
    if (!Array.isArray(releases) || releases.some((release) => typeof release.tag_name !== 'string')) throw new Error('Malformed release list')
    if (releases.some((release) => release.tag_name === tag)) throw new Error(`Release ${tag} already exists; refusing to overwrite or delete it`)
    if (releases.length < 100) break
  }
  const prerelease = tag.includes('-')
  const release = await request(`${base}/releases`, 'POST', {
    tag_name: tag, name: tag, draft: true, prerelease, make_latest: 'false',
    body: notes, generate_release_notes: true,
  })
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.draft !== true || release.tag_name !== tag) throw new Error('Invalid draft release response')
  try {
    const upload = new URL(release.upload_url.replace(/\{.*$/, ''))
    if (upload.origin !== 'https://uploads.github.com' || upload.pathname !== `/repos/${repository}/releases/${release.id}/assets`) throw new Error('Invalid upload URL')
    for (const asset of assets) {
      upload.searchParams.set('name', asset.name)
      await request(upload.toString(), 'POST', undefined, asset)
    }
    const actual = await request(`${base}/releases/${release.id}/assets?per_page=100`)
    verifyAssets(actual, assets)
    const published = await request(`${base}/releases/${release.id}`, 'PATCH', { draft: false, prerelease, make_latest: prerelease ? 'false' : 'true' })
    if (published.draft !== false || published.tag_name !== tag || published.prerelease !== prerelease) throw new Error('Publication response did not confirm the expected release state')
    return { id: release.id, tag, prerelease, url: published.html_url }
  } catch (error) {
    throw new Error(`${error.message}. Release ${release.id} was not deleted; inspect its state before retrying.`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const tag = process.env.GITHUB_REF_NAME
    if (!tag || process.env.GITHUB_REF_TYPE !== 'tag') throw new Error('Publication requires a Git tag event')
    checkVersions(root, tag)
    const version = checkVersions(root, tag)
    const assets = await collectAssets(resolve(root, process.argv[2] || 'release-artifacts'), version)
    const notesPath = resolve(root, `docs/releases/${tag}.md`)
    const notes = await readFile(notesPath, 'utf8')
    console.log(JSON.stringify(await publishRelease({ repository: process.env.GITHUB_REPOSITORY, tag, token: process.env.GH_TOKEN, assets, notes })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
