import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVersions } from './version.mjs'

export function linuxBundlePlan(version) {
  const prerelease = version.match(/^(\d+\.\d+\.\d+)-([0-9A-Za-z.-]+)$/)
  if (!prerelease) return { build: ['exec', 'tauri', 'build', '--ci'], rpm: null }
  // RPM's Version field disallows SemVer's '-' prerelease delimiter. Keep
  // app binaries/DEB/AppImage at the exact semver; encode prerelease in RPM
  // Release so 0.rc.N sorts before the final Release 1.
  const rpmVersion = prerelease[1]
  const rpmRelease = `0.${prerelease[2].replaceAll('-', '.')}`
  const config = JSON.stringify({ version: rpmVersion, bundle: { linux: { rpm: { release: rpmRelease } } } })
  return { build: ['exec', 'tauri', 'build', '--ci', '--bundles', 'deb,appimage'], rpm: ['exec', 'tauri', 'bundle', '--ci', '--bundles', 'rpm', '--config', config] }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, { stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`pnpm ${args.slice(0, 4).join(' ')} failed (${signal || code})`))
    })
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const version = checkVersions(fileURLToPath(new URL('../', import.meta.url)))
    const plan = linuxBundlePlan(version)
    await run(plan.build)
    if (plan.rpm) await run(plan.rpm)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
