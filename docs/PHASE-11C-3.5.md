# Phase 11C-3.5 — Windows Worker and Development Dispatcher

## Implementation

- `worker service start|status|stop` manages a loopback-only Controller and one Windows Worker.
- The Worker credential is generated randomly and stored encrypted with Windows DPAPI for the current user under `%LOCALAPPDATA%\WooriAiAgent\worker-runtime`. The Controller/Worker processes receive only a minimal environment allowlist; the Worker token and policy JSON are not written to logs or the repository.
- The provisioned Worker is read-only: `allowCodeChanges=false`, no `codex-write` capability, and no deployment capability. Starting it does not change the Controller policy.
- Stop refuses to terminate a Worker while its Controller row shows an active job. The encrypted credential is retained so an explicit later restart keeps the same identity.
- `worker dispatch-once --job-id=<id> --execute=true` is one-job-only. It supports the synthetic `worker-integration-smoke` read-only task and an explicitly selected `feature-development` task. It never drains the queue.
- Feature jobs pass through a Dispatcher that rechecks policy, service permission, Project Lock, Worker write permission, ChatGPT Codex and MXC readiness, invocation budget, audit availability, Policy Version, Lease and Fencing Token before calling the existing `executeApprovedTask` executor.
- Feature dispatch requires a Ready local Development Queue task with a versioned execution contract and an isolated Clone whose origin, branch, base SHA, path and clean Git state match the Controller Clone record. Missing evidence blocks execution.
- `worker service integration-smoke --approve=true` creates and locally approves a synthetic read-only job, checks only the local Dashboard `/api/health` endpoint, and records the result in Controller events and Development Audit Trail. It does not call Codex or any service endpoint.

## Commands

```powershell
pnpm agent worker service start
pnpm agent worker service status
pnpm agent worker service integration-smoke --approve=true
pnpm agent worker service stop
```

The smoke command is an explicit local operator action. It is not scheduled. `worker service start` does not enable Windows Task Scheduler or automatic startup.

## Current policy behavior

The actual Controller policy is loaded from `data/controller/queue.sqlite`. A registered read-only Worker can heartbeat and acknowledge the latest Policy Version, but the Controller's global Feature Planning, Feature Specification, Autonomous Feature Development and Codex Execution settings remain authoritative. No policy toggle is changed by this phase.

Linux code modification, Calculator code modification, Tools' external development lock, MoneyBook development, PR creation, merge and deployment remain blocked.
