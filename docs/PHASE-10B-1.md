# Phase 10B-1 — Linux package and operations

This phase prepares a Linux deployment package for a separately approved rehearsal. It does not install anything on iwinv. No SSH session, `systemctl`, Docker, database, Nginx, or production-service operation was performed while preparing this package.

## Package scope

The Ubuntu 24.04 / Node.js 22 package contains the CLI and Dashboard API, configuration, systemd unit files, and production Node dependencies. `deploy/linux/package.sh` builds it on Linux from the current Git revision using the frozen pnpm lockfile. Playwright and Puppeteer browser downloads are disabled. The CLI's JavaScript Playwright/Lighthouse libraries remain in the production dependency graph because existing CLI modules import them; Chromium itself is not included. The package manifest records the Node major version, native module ABI, platform, and architecture, and the installer rejects a mismatch.

Build and inspect on an Ubuntu build host:

```sh
bash deploy/linux/package.sh ./dist/linux
sha256sum -c ./dist/linux/woori-ai-agent-linux-<revision>.tar.gz.sha256
```

Copy the archive and its checksum through the approved transfer path. Review the SHA-256 independently. Verify first; installation remains a separate explicit action:

```sh
sudo bash deploy/linux/install.sh --action=verify --package=woori-ai-agent-linux-<revision>.tar.gz --sha256=<reviewed-sha256>
sudo bash deploy/linux/install.sh --action=preflight --package=woori-ai-agent-linux-<revision>.tar.gz --sha256=<reviewed-sha256>
sudo bash deploy/linux/install.sh --action=install --package=woori-ai-agent-linux-<revision>.tar.gz --sha256=<reviewed-sha256> --apply
```

The installer refuses unsafe archive paths, escaping symlinks, mismatched Node ABI/architecture, existing release directories, and differing pre-existing unit files. It never enables or starts a unit. Existing environment files are never overwritten. `current` points to the selected immutable, root-owned release. A service account cannot modify package code.

## Identities and filesystem

- `woori-agent`: Controller, Scheduler, Dashboard API, and database backup; system account with `/usr/sbin/nologin`.
- `woori-agent-worker`: read-only heartbeat worker; separate system account, no sudo/docker membership.
- `/opt/woori-ai-agent`: root-owned releases and `current` symlink.
- `/etc/woori-ai-agent`: root-owned configuration, mode `0600`; provision secrets out of band.
- `/var/lib/woori-ai-agent`: Controller and analysis SQLite files, mode `0700`.
- `/var/lib/woori-ai-agent-worker`: separate Worker state, mode `0700`.
- `/var/log/woori-ai-agent`: restricted log directory; services also emit to journald.

The package does not copy Windows DPAPI data, OAuth tokens, Codex credentials, GitHub credentials, operations SSH keys, or service environment files. The Worker token template is a placeholder and must be provisioned out of band before starting the Worker. Its default endpoint is loopback HTTP; remote Worker/TLS is not enabled or declared verified.

## Units and resource caps

Controller, Scheduler, and Dashboard API share `woori-agent-controller.slice`: at most 50% CPU (0.5 vCPU equivalent), 384 MiB memory, 320 MiB `MemoryHigh`, and 96 tasks combined. The heartbeat Worker has its own slice: at most 50% CPU, 256 MiB memory, 224 MiB `MemoryHigh`, and 48 tasks. Each service also uses `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, control-group process shutdown, and narrowly scoped writable state paths. No unit has Docker socket, operating database, SSH key, or host-home access.

The Dashboard API binds to `127.0.0.1:4174`; the Controller template binds to `127.0.0.1:4180`. No Nginx route or public listener is installed. `WOORI_DEPLOYMENT_PROFILE=linux-readonly` prevents the Dashboard API from enabling code changes, PR automation, or deployment settings. Codex remains blocked by the existing Linux sandbox policy.

Units included:

- `woori-agent-controller.service`
- `woori-agent-dashboard.service`
- `woori-agent-worker.service`
- `woori-agent-scheduler.service` (requires the explicit opt-in marker and environment value)
- `woori-agent-backup.service` and `.timer` (timer disabled by default)

The backup timer, when explicitly enabled, uses SQLite's online backup API for Controller and analysis databases, verifies integrity, then retains at most 14 recognized snapshots and removes snapshots older than 90 days. Backups are mode `0600`. Backup/restore/prune failures create a bounded Dashboard operator notification when the Controller database is writable, and the unit failure remains visible in journald. Restore verifies the snapshot and will only create a new destination; it will not overwrite a database. To restore a live database later, an operator must stop the relevant agent units and deliberately move the old database aside before restoring to the now-absent path.

## Dry-run-first operations

All state-changing `manage.sh` actions require `--apply`; without it they only print a dry-run. `status`, `logs`, `verify`, and `preflight` are read-only.

```sh
bash deploy/linux/manage.sh preflight
bash deploy/linux/manage.sh init-scheduler scheduler                 # dry-run
sudo bash deploy/linux/manage.sh init-scheduler scheduler --apply
sudo bash deploy/linux/manage.sh start controller --apply
sudo bash deploy/linux/manage.sh start dashboard --apply
sudo bash deploy/linux/manage.sh status all
sudo bash deploy/linux/manage.sh logs controller
sudo bash deploy/linux/manage.sh backup backup --apply
sudo bash deploy/linux/manage.sh enable backup --apply                # enables only the daily backup timer
sudo bash deploy/linux/manage.sh scheduler-opt-in scheduler --apply   # only after read-only rehearsal/review
sudo bash deploy/linux/manage.sh start scheduler --apply
```

`enable` and `start` are separate actions. The scheduler is globally OFF in all templates; turning it on only allows the existing read-only scheduler path and does not grant code modification, PR, merge, or deployment rights. The backup timer is also disabled unless explicitly enabled. Removal stops and disables only these dedicated agent units and retains databases, configuration, logs, accounts, and release files for review.

Before starting anything on a rehearsal host, run `manage.sh preflight`. Linux scheduling blocks if MemAvailable is unknown or below 768 MiB, free disk is unknown or below 4 GiB, 1-minute load reaches 75% of CPU count, or the current cgroup OOM counter is unavailable/nonzero. These are conservative defaults, configurable through `WOORI_LINUX_MIN_AVAILABLE_MIB`, `WOORI_LINUX_MIN_FREE_DISK_MIB`, and `WOORI_LINUX_MAX_LOAD_PER_CPU`. They are not evidence that iwinv currently has these resources. A previous OOM counter blocks scheduling until an operator reviews/restarts the isolated agent cgroup.

## Rehearsal and recovery order

1. Use a disposable Ubuntu 24.04 host, Node.js 22 with matching native ABI, systemd, Python 3, and enough disk. Do not begin on iwinv in this phase.
2. Verify package digest and run `install.sh --action=verify`. Review users, unit files, firewall/listeners, and resource capacity before `install --apply`.
3. Confirm users are not root, sudo, or docker; verify `/etc` mode `0600`, state directories `0700`, code root-owned, and `docker.sock`, production database, operations SSH keys, and service environment files are inaccessible.
4. Run `systemd-analyze verify` through `manage.sh verify`. Initialize Scheduler definitions while keeping global Scheduler OFF. Start Controller and Dashboard only; check localhost health and logs. Configure no external TLS listener.
5. After read-only smoke and resource observation, optionally start the heartbeat Worker with a disposable per-Worker credential. Remote TLS remains a separate, unverified step.
6. Test SQLite backup, integrity check, restore to a new path, and retention on disposable databases. Do not restore over an active database.
7. Scheduler and backup timer remain disabled until their specific opt-ins. Linux Codex, Playwright, Lighthouse, Next.js builds, paid APIs, automatic PR, merge, deploy, and rollback remain disabled.

Emergency stop: stop Scheduler first, then Worker, Dashboard, Controller. Preserve SQLite, logs, and configs. The remove action does not delete state. No iwinv installation, runtime test, systemd change, or production access occurred in this phase.

## Verification boundaries

CI can test shell syntax, package construction on Ubuntu, archive validation, resource-policy logic, SQLite WAL backups/restores, and static systemd policy. It cannot prove that the iwinv kernel enforces cgroup limits, that AppArmor/rootless namespaces permit the desired operations, that account boundaries work on the actual host, that TLS/remote Worker authentication is correctly provisioned, or that the current iwinv resource headroom is adequate. Linux Codex code modification remains blocked.
