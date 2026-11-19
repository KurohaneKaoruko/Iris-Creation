#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release.sh <version> [--allow-dirty] [--skip-checks] [--no-push]

Examples:
  ./scripts/release.sh 0.2.0
  ./scripts/release.sh 0.2.0-beta.1 --skip-checks --no-push
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

VERSION="$1"
shift

ALLOW_DIRTY=0
SKIP_CHECKS=0
NO_PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --no-push) NO_PUSH=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
  shift
done

if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "Invalid version '$VERSION'. Example: 0.2.0 or 0.2.0-beta.1" >&2
  exit 1
fi

TAG="v$VERSION"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PACKAGE_MANAGER="npm"
if [[ -f pnpm-lock.yaml ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm-lock.yaml detected, but 'pnpm' is not installed. Install pnpm (or enable corepack) and retry." >&2
    exit 1
  fi
  PACKAGE_MANAGER="pnpm"
fi

run_step() {
  echo ">> $*"
  "$@"
}

if [[ "$ALLOW_DIRTY" -ne 1 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is not clean. Commit/stash changes first, or use --allow-dirty." >&2
    exit 1
  fi
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag '$TAG' already exists." >&2
  exit 1
fi

if [[ ! -f "docs/releases/$TAG.md" ]]; then
  echo "Missing release notes: docs/releases/$TAG.md" >&2
  exit 1
fi

echo "Updating versions to $VERSION ..."

run_step node scripts/version.mjs set "$VERSION"
run_step node scripts/version.mjs check "$TAG"

if [[ "$SKIP_CHECKS" -ne 1 ]]; then
  run_step "$PACKAGE_MANAGER" run lint
  run_step "$PACKAGE_MANAGER" run test
  run_step node --test scripts/release.test.mjs
  run_step "$PACKAGE_MANAGER" run build
  run_step cargo test --locked --manifest-path src-tauri/Cargo.toml
fi

run_step git add package.json webui/package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json

if [[ -z "$(git diff --cached --name-only)" ]]; then
  echo "No staged version changes detected." >&2
  exit 1
fi

run_step git commit -m "chore(release): $TAG"
run_step git tag "$TAG"

if [[ "$NO_PUSH" -ne 1 ]]; then
  run_step git push origin HEAD
  run_step git push origin "$TAG"
  echo
  echo "Release tag pushed: $TAG"
  echo "GitHub Actions workflow will build bundles and publish the release."
else
  echo
  echo "Tag created locally: $TAG (not pushed due to --no-push)."
fi
