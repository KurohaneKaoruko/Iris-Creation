import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const jsonFiles = ['package.json', 'webui/package.json', 'src-tauri/tauri.conf.json']
const cargoFiles = [
  ['src-tauri/Cargo.toml', /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m],
  ['src-tauri/Cargo.lock', /(^name = "iris-creation"\r?\nversion = ")([^"]+)(")/m],
]

export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`)
  }
  const prerelease = version.split('-').slice(1).join('-')
  if (prerelease.split('.').some((part) => /^0\d+$/.test(part))) throw new Error('Numeric prerelease identifiers cannot have leading zeros')
  return version
}

export function checkVersions(directory = root, tag) {
  const versions = jsonFiles.map((file) => [file, JSON.parse(readFileSync(resolve(directory, file), 'utf8')).version])
  for (const [file, pattern] of cargoFiles) {
    const match = readFileSync(resolve(directory, file), 'utf8').match(pattern)
    if (!match) throw new Error(`Version not found in ${file}`)
    versions.push([file, match[2]])
  }
  const version = validateVersion(versions[0][1])
  for (const [file, current] of versions) {
    if (current !== version) throw new Error(`Version mismatch: ${file} has ${current}, expected ${version}`)
  }
  if (tag && tag !== `v${version}`) throw new Error(`Tag ${tag} does not match v${version}`)
  return version
}

export function setVersion(version, directory = root) {
  validateVersion(version)
  // Prepare every change before writing, so missing/malformed inputs fail early.
  const updates = jsonFiles.map((file) => {
    const data = JSON.parse(readFileSync(resolve(directory, file), 'utf8'))
    data.version = version
    return [file, `${JSON.stringify(data, null, 2)}\n`]
  })
  for (const [file, pattern] of cargoFiles) {
    const raw = readFileSync(resolve(directory, file), 'utf8')
    if (!pattern.test(raw)) throw new Error(`Version not found in ${file}`)
    updates.push([file, raw.replace(pattern, (_, before, _old, after) => `${before}${version}${after}`)])
  }
  for (const [file, content] of updates) writeFileSync(resolve(directory, file), content)
  return checkVersions(directory)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2)
  try {
    if (command === 'set' && value) console.log(`Version: ${setVersion(value)}`)
    else if (command === 'check') console.log(`Version: ${checkVersions(root, value)}`)
    else throw new Error('Usage: node scripts/version.mjs set <version> | check [v<version>]')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
