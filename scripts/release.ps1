param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [switch]$AllowDirty,
    [switch]$SkipChecks,
    [switch]$NoPush
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command
    )
    Write-Host ">> $Command" -ForegroundColor Cyan
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $Command"
    }
}

function Resolve-PackageManager {
    if (Test-Path "pnpm-lock.yaml") {
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $pnpm) {
            throw "pnpm-lock.yaml detected, but 'pnpm' is not installed. Install pnpm (or enable corepack) and retry."
        }
        return "pnpm"
    }
    return "npm"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot

try {
    if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') {
        throw "Invalid version '$Version'. Example: 0.2.0 or 0.2.0-beta.1"
    }

    $tag = "v$Version"
    $packageManager = Resolve-PackageManager

    if (-not $AllowDirty) {
        $dirty = git status --porcelain
        if ($LASTEXITCODE -ne 0) {
            throw "git status failed"
        }
        if ($dirty) {
            throw "Working tree is not clean. Commit/stash changes first, or use -AllowDirty."
        }
    }

    $existingTag = git tag --list $tag
    if ($LASTEXITCODE -ne 0) {
        throw "git tag failed"
    }
    if ($existingTag) {
        throw "Tag '$tag' already exists."
    }

    if (-not (Test-Path "docs/releases/$tag.md")) {
        throw "Missing release notes: docs/releases/$tag.md"
    }

    Write-Host "Updating versions to $Version ..." -ForegroundColor Yellow

    Invoke-Step "node scripts/version.mjs set $Version"
    Invoke-Step "node scripts/version.mjs check $tag"

    if (-not $SkipChecks) {
        Invoke-Step "$packageManager run lint"
        Invoke-Step "$packageManager run test"
        Invoke-Step "node --test scripts/release.test.mjs"
        Invoke-Step "$packageManager run build"
        Invoke-Step "cargo test --locked --manifest-path src-tauri/Cargo.toml"
    }

    Invoke-Step "git add package.json webui/package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json"

    $staged = git diff --cached --name-only
    if ($LASTEXITCODE -ne 0) {
        throw "git diff --cached failed"
    }
    if (-not $staged) {
        throw "No staged version changes detected."
    }

    Invoke-Step "git commit -m `"chore(release): $tag`""
    Invoke-Step "git tag $tag"

    if (-not $NoPush) {
        Invoke-Step "git push origin HEAD"
        Invoke-Step "git push origin $tag"
        Write-Host ""
        Write-Host "Release tag pushed: $tag" -ForegroundColor Green
        Write-Host "GitHub Actions workflow will build bundles and publish the release." -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "Tag created locally: $tag (not pushed due to -NoPush)." -ForegroundColor Yellow
    }
}
finally {
    Pop-Location
}
