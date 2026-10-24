#!/usr/bin/env bash
set -Eeuo pipefail

ACTION=install
ARCHIVE=
EXPECTED_SHA256=
APPLY=false
for arg in "$@"; do
  case "$arg" in
    --action=*) ACTION="${arg#*=}" ;;
    --package=*) ARCHIVE="${arg#*=}" ;;
    --sha256=*) EXPECTED_SHA256="${arg#*=}" ;;
    --apply) APPLY=true ;;
    --help) echo 'Usage: install.sh --action=verify|preflight|install --package=<linux-package.tar.gz> --sha256=<64-hex> [--apply]'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
[[ "$ACTION" == verify || "$ACTION" == preflight || "$ACTION" == install ]] || { echo 'Only verify, preflight, and install actions are supported.' >&2; exit 2; }
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo 'A package archive is required.' >&2; exit 2; }
[[ "$EXPECTED_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Provide the independently reviewed 64-character SHA-256.' >&2; exit 2; }
actual="$(sha256sum -- "$ARCHIVE" | cut -d' ' -f1)"
[[ "${actual,,}" == "${EXPECTED_SHA256,,}" ]] || { echo 'Package SHA-256 mismatch.' >&2; exit 3; }
python3 - "$ARCHIVE" <<'PY'
import posixpath, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive.getmembers():
        name = member.name.removeprefix("./")
        normalized = posixpath.normpath(name)
        if name.startswith("/") or normalized == ".." or normalized.startswith("../"):
            raise SystemExit("Unsafe archive path.")
        if member.islnk():
            target = posixpath.normpath(member.linkname.removeprefix("./"))
            if member.linkname.startswith("/") or target == ".." or target.startswith("../"):
                raise SystemExit("Package contains a hard link escaping its root.")
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(normalized), member.linkname))
            if member.linkname.startswith("/") or target == ".." or target.startswith("../"):
                raise SystemExit("Package contains a symlink escaping its root.")
PY
if [[ "$ACTION" == verify || ( "$ACTION" == install && "$APPLY" != true ) ]]; then
  printf 'Package verified. action=%s sha256=%s apply=%s\n' "$ACTION" "$actual" "$APPLY"
  [[ "$ACTION" != install || "$APPLY" == true ]] || echo 'Dry-run only. Re-run with --apply as root to install; services will remain disabled and stopped.'
  exit 0
fi
if [[ "$ACTION" == install && "$EUID" -ne 0 ]]; then echo 'Applying installation requires root. Run only on an approved non-production rehearsal host.' >&2; exit 4; fi
run_preflight(){
  [[ "$(uname -s)" == Linux ]] || { echo 'Linux host required.' >&2; return 1; }
  grep -q '^ID=ubuntu$' /etc/os-release || { echo 'Ubuntu host required.' >&2; return 1; }
  command -v node >/dev/null && command -v systemctl >/dev/null && command -v python3 >/dev/null || { echo 'Node.js, systemd, and Python 3 are required.' >&2; return 1; }
  [[ -f /sys/fs/cgroup/cgroup.controllers ]] || { echo 'Unified cgroup v2 is required for the configured service limits.' >&2; return 1; }
  local expected major abi arch available load cpus disk systemd_version
  expected="$(python3 - "$ARCHIVE" <<'PY'
import json,sys,tarfile
with tarfile.open(sys.argv[1],"r:gz") as archive:
    item=archive.extractfile("./package-runtime.json") or archive.extractfile("package-runtime.json")
    if item is None: raise SystemExit("Missing package-runtime.json")
    print(json.dumps(json.load(item)))
PY
)"
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"; abi="$(node -p 'process.versions.modules')"; arch="$(node -p 'process.arch')"
  [[ "$(node -p 'process.platform')" == linux && "$major" == "$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).nodeMajor))' "$expected")" && "$abi" == "$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).nodeModulesAbi))' "$expected")" && "$arch" == "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).arch)' "$expected")" ]] || { echo 'Node ABI/platform/architecture does not match this package.' >&2; return 1; }
  systemd_version="$(systemd --version | head -n1 | awk '{print $2}')"; [[ "${systemd_version:-0}" -ge 235 ]] || { echo 'systemd 235 or newer is required.' >&2; return 1; }
  available="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"; cpus="$(getconf _NPROCESSORS_ONLN)"; load="$(awk '{print $1}' /proc/loadavg)"; disk="$(df -Pk /var/lib | awk 'NR==2 {print int($4/1024)}')"
  printf 'Preflight: Ubuntu, Node %s ABI %s arch %s, systemd %s, cgroup v2, MemAvailable=%s MiB, load1=%s/%s CPU, free /var=%s MiB\n' "$major" "$abi" "$arch" "$systemd_version" "$available" "$load" "$cpus" "$disk"
  [[ "$available" -ge 768 ]] || { echo 'MemAvailable is below 768 MiB.' >&2; return 1; }
  awk -v load="$load" -v cpus="$cpus" 'BEGIN {exit !(load < cpus*0.75)}' || { echo 'Host load is at or above 75% of CPU count.' >&2; return 1; }
  [[ "$disk" -ge 4096 ]] || { echo 'Free /var disk is below 4 GiB.' >&2; return 1; }
}
if [[ "$ACTION" == preflight ]]; then run_preflight; exit $?; fi
run_preflight || { echo 'Install preflight failed; no agent service was changed.' >&2; exit 4; }

install_identity() {
  local name="$1" home="$2" shell groups
  if getent passwd "$name" >/dev/null; then
    shell="$(getent passwd "$name" | cut -d: -f7)"
    groups="$(id -nG "$name")"
    [[ "$shell" == /usr/sbin/nologin ]] || { echo "Refusing existing $name account with interactive shell." >&2; return 1; }
    [[ " $groups " != *' sudo '* && " $groups " != *' docker '* ]] || { echo "Refusing $name account in sudo/docker group." >&2; return 1; }
  else
    useradd --system --user-group --home-dir "$home" --create-home --shell /usr/sbin/nologin "$name"
  fi
}
archive_name="$(basename "$ARCHIVE")"
release="${archive_name%.tar.gz}"
[[ "$release" =~ ^woori-ai-agent-linux-[A-Za-z0-9._-]+$ ]] || { echo 'Archive name must be woori-ai-agent-linux-<revision>.tar.gz.' >&2; exit 4; }
[[ ! -e /opt/woori-ai-agent/current || -L /opt/woori-ai-agent/current ]] || { echo 'current exists and is not a symlink; refusing replacement.' >&2; exit 4; }
install -d -o root -g root -m 0755 /opt/woori-ai-agent/releases
release_dir="/opt/woori-ai-agent/releases/$release"
[[ ! -e "$release_dir" ]] || { echo 'Release directory already exists; refusing overwrite.' >&2; exit 4; }
incoming="$(mktemp -d /opt/woori-ai-agent/releases/.incoming.XXXXXX)"
cleanup(){ [[ -n "${incoming:-}" && -d "$incoming" ]] && rm -rf -- "$incoming"; }
trap cleanup EXIT
tar -xzf "$ARCHIVE" --directory "$incoming" --no-same-owner --no-same-permissions
[[ -f "$incoming/package.json" && -f "$incoming/package-runtime.json" && -f "$incoming/apps/cli/src/index.ts" && -x "$incoming/node_modules/.bin/tsx" ]] || { echo 'Package content or runtime dependencies are incomplete.' >&2; exit 4; }
if ! node - "$incoming/package-runtime.json" <<'NODE'
const fs=require('fs'), expected=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(expected.platform!=='linux'||expected.nodeMajor!==Number(process.versions.node.split('.')[0])||expected.nodeModulesAbi!==process.versions.modules||expected.arch!==process.arch)process.exit(1);
NODE
then echo 'Package Node ABI or architecture does not match this host.' >&2; exit 4; fi
for unit in woori-agent-controller.service woori-agent-scheduler.service woori-agent-worker.service woori-agent-dashboard.service woori-agent-backup.service woori-agent-backup.timer woori-agent-controller.slice woori-agent-worker.slice; do
  target="/etc/systemd/system/$unit"
  [[ ! -e "$target" ]] || cmp -s "$incoming/deploy/systemd/$unit" "$target" || { echo "Existing unit differs: $target. Review manually; installer will not overwrite it." >&2; exit 5; }
done
install_identity woori-agent /var/lib/woori-ai-agent
install_identity woori-agent-worker /var/lib/woori-ai-agent-worker
install -d -o root -g root -m 0750 /etc/woori-ai-agent
install -d -o woori-agent -g woori-agent -m 0700 /var/lib/woori-ai-agent/controller
install -d -o woori-agent-worker -g woori-agent-worker -m 0700 /var/lib/woori-ai-agent-worker
install -d -o woori-agent -g woori-agent -m 0700 /var/log/woori-ai-agent
chown -R root:root "$incoming"
chmod -R a+rX,go-w "$incoming"
chmod 0755 "$incoming"
mv -- "$incoming" "$release_dir"
incoming=
current_tmp="/opt/woori-ai-agent/.current-$release"
ln -s "$release_dir" "$current_tmp"
if [[ -e /opt/woori-ai-agent/current || -L /opt/woori-ai-agent/current ]]; then
  [[ -L /opt/woori-ai-agent/current ]] || { rm -f -- "$current_tmp"; echo 'current exists and is not a symlink; refusing replacement.' >&2; exit 4; }
  mv -Tf -- "$current_tmp" /opt/woori-ai-agent/current
else
  mv -- "$current_tmp" /opt/woori-ai-agent/current
fi

for spec in 'controller.env:controller.env.example' 'scheduler.env:scheduler.env.example' 'dashboard.env:dashboard.env.example' 'worker.env:worker.env.example'; do
  target="/etc/woori-ai-agent/${spec%%:*}"; source="/opt/woori-ai-agent/current/deploy/linux/env/${spec#*:}"
  if [[ ! -e "$target" ]]; then install -o root -g root -m 0600 "$source" "$target"; fi
done
for unit in woori-agent-controller.service woori-agent-scheduler.service woori-agent-worker.service woori-agent-dashboard.service woori-agent-backup.service woori-agent-backup.timer woori-agent-controller.slice woori-agent-worker.slice; do
  source="/opt/woori-ai-agent/current/deploy/systemd/$unit"; target="/etc/systemd/system/$unit"
  if [[ -e "$target" ]]; then cmp -s "$source" "$target" || { echo "Existing unit differs: $target. Review manually; installer will not overwrite it." >&2; exit 5; }
  else install -o root -g root -m 0644 "$source" "$target"; fi
done
systemctl daemon-reload
printf 'Installed release %s. No service was enabled or started. Configure credentials out-of-band; keep scheduler opt-in absent.\n' "$release"
