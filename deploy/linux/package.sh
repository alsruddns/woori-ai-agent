#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT="${1:-$ROOT/dist/linux}"
[[ "$(uname -s)" == Linux ]] || { echo 'Build the server package on Linux/Ubuntu to match native module ABI.' >&2; exit 2; }
command -v pnpm >/dev/null || { echo 'pnpm is required.' >&2; exit 2; }
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$node_major" -eq 22 ]] || { echo 'Build packages with Node.js 22.' >&2; exit 2; }
revision="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
stage="$(mktemp -d)"
cleanup(){ rm -rf -- "$stage"; }
trap cleanup EXIT
mkdir -p "$stage/apps/cli" "$stage/apps/dashboard" "$stage/configs" "$stage/deploy"
cp "$ROOT/package.json" "$ROOT/pnpm-lock.yaml" "$ROOT/pnpm-workspace.yaml" "$stage/"
cp "$ROOT/apps/cli/package.json" "$stage/apps/cli/"
cp "$ROOT/apps/dashboard/package.json" "$stage/apps/dashboard/"
cp -a "$ROOT/apps/cli/src" "$stage/apps/cli/"
cp -a "$ROOT/configs/." "$stage/configs/"
mkdir -p "$stage/deploy/systemd" "$stage/deploy/linux/env"
cp "$ROOT"/deploy/systemd/woori-agent-controller.* "$stage/deploy/systemd/"
cp "$ROOT"/deploy/systemd/woori-agent-scheduler.service "$stage/deploy/systemd/"
cp "$ROOT"/deploy/systemd/woori-agent-worker.service "$stage/deploy/systemd/"
cp "$ROOT"/deploy/systemd/woori-agent-dashboard.service "$stage/deploy/systemd/"
cp "$ROOT"/deploy/systemd/woori-agent-backup.service "$ROOT"/deploy/systemd/woori-agent-backup.timer "$stage/deploy/systemd/"
cp "$ROOT"/deploy/linux/env/*.example "$stage/deploy/linux/env/"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({nodeMajor:Number(process.versions.node.split(".")[0]),nodeModulesAbi:process.versions.modules,arch:process.arch,platform:process.platform},null,2)+"\n")' "$stage/package-runtime.json"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1
pnpm install --prod --frozen-lockfile --dir "$stage"
[[ ! -d "$stage/.cache/ms-playwright" && ! -d "$stage/.local-browsers" ]] || { echo 'Browser binaries unexpectedly included.' >&2; exit 3; }
mkdir -p "$OUTPUT"
archive="$OUTPUT/woori-ai-agent-linux-$revision.tar.gz"
[[ ! -e "$archive" ]] || { echo 'Release archive already exists; refusing overwrite.' >&2; exit 3; }
tar -czf "$archive" -C "$stage" .
sha256sum "$archive" > "$archive.sha256"
printf 'Created %s\n' "$archive"
cat "$archive.sha256"
printf 'Browser binaries included: no\nRuntime target: Ubuntu, Node.js 22, pnpm lockfile, production dependencies only\n'
