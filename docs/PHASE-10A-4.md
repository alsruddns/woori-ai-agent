# Phase 10A-4 — Scheduler and Live Monitor

## Implemented

- The Controller SQLite file is the only schedule authority. SQLite is never shared as a network file. Definitions use a unique `(schedule_id, scheduled_for)` key and deterministic run IDs; `BEGIN IMMEDIATE` protects schedule ticks and run claims.
- The four bounded profiles are hourly HTTP smoke (five URLs maximum), six-hour SEO metadata sample (five), daily localization/content rules (ten, choosing only already discovered sitemap URLs and falling back to known QA routes), and weekly stored issue recurrence summary (no site crawl). Daily locale selection rotates across locales actually present in the sitemap URL store; unverified locale paths are not fabricated. Each run is sequential, has a timeout, and does not replay stale catch-up slots. An expired active run becomes `Recovery Required`; it is never automatically reassigned. Recovery requires operator confirmation of process termination.
- Schedule definitions and per-service read-only switches are seeded by Controller start or `pnpm agent scheduler init`. Definitions do not overwrite operator switches. `WOORI_SCHEDULER_ENABLED=false` is the default; the daemon also requires `PAID_AI_API_ENABLED=false`, `AI_API_BUDGET_USD=0`, and `AI_AUTO_EXECUTION=false`.
- Implemented checks are public HTTP and rendered HTML metadata rules only. These do not exercise interactive features and do not inspect browser JavaScript errors, axe accessibility, Lighthouse, or real-user performance. Those remain on the existing manually/Actions-driven paths. GSC is not polled by the scheduler, preserving its existing request/cache limits. Competitor collection is skipped unless a separately reviewed and approved flow is built.
- MoneyBook is excluded. Calculator may receive read-only checks; its code change lock remains. Codex, Linux code modification, PR creation, merge, deployment, and rollback remain disabled.
- `/api/live` uses a ten-second browser polling interval. Local-only dashboard API remains bound to `127.0.0.1`; remote monitoring uses the existing authenticated Worker TLS/nonce protocol at `/v1/monitor/snapshot`. Missing credentials or unreachable Controller are shown as Offline/Not Configured, never Online. No status-changing dashboard action exists for code, PR, merge, deployment, or rollback.
- Safe per-service switches can pause/resume only read-only QA, SEO, localization and improvement-candidate collection. AdSense API remains Not Configured. These switches do not override the global scheduler opt-in.
- Worker resource snapshots are sampled at most every five minutes and retained with bounded row/age cleanup. Runtime events are capped at 20,000 rows/30 days; notification history is capped at 1,000/90 days. CPU count and available memory are reported; CPU utilization is not measured.

## Scheduler operation

1. Review `.env.example`, `configs/schedules.json`, and the systemd examples. Keep `WOORI_SCHEDULER_ENABLED=false` until the read-only schedule has been reviewed on a non-production host.
2. Configure the same local Controller DB path for Controller and scheduler. Do not place the SQLite file on NFS/SMB or share it between machines.
3. Run `pnpm agent scheduler init` to seed definitions, `pnpm agent scheduler status` to inspect state, and `pnpm agent scheduler tick` to create due rows without running them.
4. Only after explicit operator opt-in, set the four environment policy values and use `pnpm agent scheduler daemon`. `scheduler run-once` is similarly guarded. Stopping the process leaves an active run in place; after lease expiry it requires the documented operator recovery flow.
5. The Windows Task Scheduler helper is opt-in and registers a current-user logon task only when passed `-Confirm`. It does not alter startup entries or run during this build.

## Windows

```powershell
pnpm agent scheduler init
pnpm agent scheduler status
# Optional, only after review and explicit local opt-in:
./scripts/register-scheduler-task.ps1 -Confirm
# Start/stop the registered task after reviewing policy:
./scripts/control-scheduler-task.ps1 -Action Start -Confirm
./scripts/control-scheduler-task.ps1 -Action Stop -Confirm
# Remove:
./scripts/unregister-scheduler-task.ps1 -Confirm
```

The scheduler daemon reads the repository `.env` via the existing local environment loader. No Task Scheduler registration was performed as part of this phase.

## Ubuntu / systemd preparation (not installed)

Examples are in `deploy/systemd/`. They use a dedicated `woori-agent` account, `ProtectSystem=strict`, `ProtectHome=true`, restricted write paths, `NoNewPrivileges`, bounded CPU/memory/task counts, restart limits, and process-group shutdown. Verify the actual Node/tsx paths and systemd support on a non-production Ubuntu test machine. The Linux heartbeat unit is only a restricted worker heartbeat; it does not grant Linux code changes. `MemoryMax` values are conservative design caps, not evidence that the production VM has capacity for browser workloads.

Before any future deployment, create `/etc/woori-agent/{controller,scheduler,worker}.env` with mode `0600`; provision distinct Worker credentials out-of-band; set the Controller to loopback or an explicitly approved private TLS address; keep the Controller DB under `/var/lib/woori-agent`; and review the service units. No `systemctl enable`, `start`, VPS login, package installation, or production change was performed here. Do not add Docker socket, PostgreSQL, operational SSH keys, or service environment files to this account.

Useful read-only checks after a separately approved non-production installation:

```sh
systemctl status woori-agent-controller.service woori-agent-scheduler.service woori-agent-worker.service
journalctl -u woori-agent-controller.service -u woori-agent-scheduler.service -u woori-agent-worker.service --since today
```

Emergency stop (only for a future, explicitly approved installation): stop scheduler first, then worker, then controller. Preserve the SQLite file and logs for diagnosis. Removal consists of stopping and disabling only these dedicated units, removing their unit files, and deleting the dedicated state only after an explicit backup/retention decision. These commands are guidance and were not executed.

## Verification boundaries and next phase

The app-level Controller/Worker code still uses a private TLS protocol, but this phase does not prove an end-to-end remote private-network TLS deployment. The local live polling route and read-only scheduler module are implemented; actual continuous scheduling was not enabled. Phase 10B requires an isolated Ubuntu integration run covering TLS certificates, service account permissions, systemd limits, restart/recovery, memory pressure, and observed duplicate claims. Linux Codex sandbox and code edits remain blocked.
