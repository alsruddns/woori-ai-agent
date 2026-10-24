# Phase 10B deployment preparation (not executed)

This is a preparation checklist for a separately approved, non-production rehearsal first. It does not authorize production installation. No VPS login, unit installation, `systemctl enable/start`, container operation, database access, or service deployment occurred in Phase 10A-4.

## Accounts and filesystem layout

Use one unprivileged account for the Controller and Scheduler because they share a local SQLite database with restrictive file permissions. Use a distinct heartbeat-only Worker account. Neither account is in `sudo`, `docker`, or the operating service groups.

```sh
sudo useradd --system --home-dir /var/lib/woori-agent --create-home --shell /usr/sbin/nologin woori-agent
sudo useradd --system --home-dir /var/lib/woori-agent-worker --create-home --shell /usr/sbin/nologin woori-agent-worker
sudo install -d -o root -g root -m 0755 /opt/woori-ai-agent
sudo install -d -o woori-agent -g woori-agent -m 0700 /var/lib/woori-agent
sudo install -d -o woori-agent-worker -g woori-agent-worker -m 0700 /var/lib/woori-agent-worker
sudo install -d -o root -g root -m 0700 /etc/woori-agent
```

Install a reviewed source revision and production dependencies under `/opt/woori-ai-agent` as root or a separate deploy identity. Keep source files root-owned and read-only to service accounts. The Scheduler needs only its own database/output state path. Do not copy the Windows DPAPI OAuth file, Codex credentials, GitHub credentials, operations SSH keys, database credentials, or service environment files.

## Environment file boundaries

Create each environment file as `root:root` mode `0600`; systemd reads it before dropping privileges. Never put credentials in the repository, unit file, command line, SQLite, or journal.

`/etc/woori-agent/controller.env` should include only the Controller DB path, loopback host and port, and provisioned Worker token/policy map when required. For a same-host read-only Worker, use `WOORI_CONTROLLER_HOST=127.0.0.1`, `WOORI_CONTROLLER_PRIVATE_NETWORK=false`, and an HTTP loopback URL. Private-network Worker access is a separate TLS/network change and needs an isolated verification.

`/etc/woori-agent/scheduler.env` should include:

```dotenv
WOORI_CONTROLLER_DB_PATH=/var/lib/woori-agent/controller/queue.sqlite
WOORI_AGENT_DB_PATH=/var/lib/woori-agent/agent.sqlite
WOORI_SCHEDULER_ENABLED=false
PAID_AI_API_ENABLED=false
AI_API_BUDGET_USD=0
AI_AUTO_EXECUTION=false
```

Leave the default `false` in place for review. An explicitly approved read-only test can change it to `true` and create the opt-in marker. Browser testing, Codex, GSC, PR creation, merge, deployment, and rollback remain outside this Scheduler.

`/etc/woori-agent/worker.env` should contain only the Worker ID, non-identifying host label, loopback/private TLS Controller URL, and this Worker’s distinct token. It must not contain the Controller’s token map or code-change credential. Keep Worker policy `allowCodeChanges=false`.

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/woori-agent/controller.env
sudo install -o root -g root -m 0600 /dev/null /etc/woori-agent/scheduler.env
sudo install -o root -g root -m 0600 /dev/null /etc/woori-agent/worker.env
```

Edit these files through the approved secret-management process; do not put literal credentials in shell history.

## Resource and boot policy

The example units under `deploy/systemd/` use a 15% CPU / 256 MiB Controller cap, 20% CPU / 384 MiB Scheduler cap, and 10% CPU / 256 MiB Worker cap, with task limits, `ProtectSystem=strict`, `ProtectHome=true`, `NoNewPrivileges`, process-group termination, `UMask=0077`, and three start attempts per ten minutes. These are initial ceilings, not validated capacity guarantees. The Scheduler unit also has an opt-in marker condition. Verify cgroup v2 enforcement and service paths on the non-production Ubuntu host before relying on these limits.

The scheduler action gate refuses to start below 384 MiB available memory. Linux Codex and generated code stay blocked. Do not run Next.js builds, Playwright, Lighthouse, or broad sitemaps on the 4 GiB production VPS. Use the existing GitHub Actions or a dedicated test machine for those workloads. A latency sample over eight seconds stops the remaining sample; request timeouts are 12 seconds; requests are sequential with at least one second between successful sample requests.

## Staged rehearsal

1. Inspect Ubuntu/kernel, cgroup mode, systemd version, disk space, and existing service load without installing the agent.
2. On a disposable Ubuntu VM, install dependencies, verify systemd units with `systemd-analyze verify`, and confirm the separate users cannot read each other’s environment files or write outside their state directories.
3. Start only the Controller in loopback mode and validate worker registration/heartbeat with disposable credentials. Rehearse TLS separately with a test CA before any remote private-network listener.
4. Keep scheduler opt-in absent and prove the service stays skipped. Then, only on the disposable VM, enable read-only scheduling and verify lease, memory-floor, timeouts, catch-up skipping, event cursor replay, and restart behavior.
5. Observe CPU, memory, disk, process count, public site latency, and error notifications. Stop if operational services show any load impact.
6. Preserve evidence and stop the rehearsal. Production review and approval is a separate phase.

## Stop and remove procedure

For a future approved installation, stop Scheduler first so no new read-only checks start, then stop Worker and Controller. Do not touch operating service containers. Preserve `/var/lib/woori-agent` and `/var/lib/woori-agent-worker` until logs and SQLite evidence are reviewed. Removal should disable and remove only these dedicated units, remove the two agent accounts after preserving required records, and delete only their state directories after an explicit retention decision. No stop, remove, or rollback command was run in this phase.
