# Phase 11C-3.4 — Windows Worker connection and Quiz execution gate

## Result

- The existing Controller and Worker CLI can run as separate processes and communicate over authenticated loopback HTTP.
- `scripts/worker-process-smoke.mjs` verified registration, heartbeat, policy acknowledgement, analysis-job claim, lease/fencing token issuance, `Running → Testing → Completed`, controller restart/reconnect without duplicate registration, code-change denial under the default policy, and emergency-stop denial. It used a disposable SQLite database and a temporary Worker identity. It did not register a persistent Worker in the user's Controller database.
- The real local Controller currently has no registered Workers. The local Worker environment has no Controller URL, Worker ID, host label, or Worker token configured. `pnpm agent worker status` reports local Codex CLI, ChatGPT login, and MXC readiness, but no central heartbeat.
- Policy switches for feature development and Codex execution are now administrator-editable. They remain OFF in the current Controller policy. Calculator's immutable code lock, automatic bug-fix lock, PR, merge, deploy, Linux code-modification, and MoneyBook restrictions remain enforced.
- API execution capability is derived from policy, a current Windows code-change Worker and policy acknowledgement, Quiz service policy, current project-selection result, and invocation budget. A policy toggle by itself does not make execution Ready.
- No Quiz source was changed and no Codex model process was invoked. The actual Controller policy, invocation ledger, and service repositories were not modified.

## Worker commands

`pnpm agent worker status` is a local diagnostic. It reports only whether required environment variables are present, never their values. The central connection is queried by `pnpm agent worker policy` or `pnpm agent worker heartbeat` when credentials are configured.

In a Controller terminal, an administrator must provision a stable Worker ID, a random token of at least 32 characters, and an explicit OS/write policy, then start:

```powershell
$env:WOORI_CONTROLLER_HOST = '127.0.0.1'
$env:WOORI_CONTROLLER_PORT = '4180'
$env:WOORI_CONTROLLER_WORKER_TOKENS = '{"windows-quiz-dev":"<same-random-token>"}'
$env:WOORI_CONTROLLER_WORKER_POLICIES = '{"windows-quiz-dev":{"os":"windows","allowCodeChanges":false}}'
pnpm agent controller serve
```

In a separate Worker terminal, configure the same token through the local secret-handling method and run:

```powershell
$env:WOORI_CONTROLLER_URL = 'http://127.0.0.1:4180'
$env:WOORI_CONTROLLER_WORKER_ID = 'windows-quiz-dev'
$env:WOORI_CONTROLLER_HOST_LABEL = 'windows-dev'
$env:WOORI_CONTROLLER_WORKER_TOKEN = '<same-random-token>'
pnpm agent worker status
pnpm agent worker register
pnpm agent worker heartbeat-loop --interval-seconds=30
```

Stop the foreground heartbeat loop with Ctrl+C. Do not place the token in repository files, command history, logs, or screenshots. `allowCodeChanges` is deliberately shown as `false` for initial registration. An administrator must decide separately whether to provision code-change capability after reviewing the isolation and policy gates; changing this Controller-side Worker policy invalidates/requires re-registration and does not override global policy, project locks, budget, or the audit gate. Remote Controller connections require authenticated TLS on a private network.

## Current policy snapshot

Read-only inspection during this phase reported Policy Version 7, `FEATURE_EXPANSION`, Emergency Stop OFF, and global automation ON. Global `featurePlanning`, `featureSpecification`, `autonomousFeatureDevelopment`, and `codexExecution` are OFF. Quiz service feature development and Codex policy are ON, with one concurrent job, one daily development job, one retry, a 900-second execution limit, and maximum complexity 1. Calculator feature development/Codex remain OFF. Automatic PR, merge, and production deployment remain OFF.

The invocation ledger reports 0 of 1 local invocations used for UTC date `2026-10-26`, with one local slot remaining. ChatGPT subscription quota remains **Unknown**. This does not establish that an included subscription allowance is available. No model request was made.

## Administrator actions required before Quiz execution

1. In the authenticated Control Center, explicitly enable global Feature Planning, Feature Specification, Autonomous Feature Development, and Codex Execution. The current Quiz service toggles are already ON; verify them without changing Calculator or Tools policy.
2. Provision a persistent Windows Worker token and Controller-side policy. First register with `allowCodeChanges=false`; confirm a fresh heartbeat and current Policy Version acknowledgement. Only after reviewing the code-change sandbox and the dedicated Clone path should an administrator explicitly provision a trusted Windows code-change Worker.
3. Confirm the Quiz project lock is AVAILABLE, the remote `develop` SHA and Clone allowlist are current, and the audit/artefact store is writable.
4. Confirm the local invocation budget has not been consumed and accept that ChatGPT subscription usage is not exposed by the CLI. If the user requires guaranteed zero overage, keep execution blocked while quota is Unknown.
5. Re-run the preflight and request the one-task Quiz fixture/service-clone execution explicitly. No PR, push, merge, or deployment is part of this phase.

## Verification

- Isolated process integration: `node --import tsx scripts/worker-process-smoke.mjs`
- Policy and queue tests: `pnpm exec vitest run tests/agent-policy.test.ts tests/distributed-queue.test.ts`
- Full repository checks are recorded in the phase completion report; CI must be associated with the final pushed commit.
