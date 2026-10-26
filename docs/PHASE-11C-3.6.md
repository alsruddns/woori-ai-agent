# Phase 11C-3.6 — Windows Codex Worker and Quiz Execution Gate

## Result

Quiz source development did not run. The live Controller policy remains authoritative and currently blocks code changes. No policy, Worker registration, invocation ledger, or service repository was modified to bypass that state.

## Live local Controller snapshot

Read-only inspection on 2026-10-26 found the existing loopback Controller online at `127.0.0.1:4180`, using `data/controller/queue.sqlite`. The existing `windows-local-readonly` Worker remained connected and Idle with `allowCodeChanges=false`; its heartbeat and policy acknowledgement were current at Policy Version 7.

The policy was `FEATURE_EXPANSION`, global automation enabled, Emergency Stop off. The following global development gates were off: Feature Discovery, Feature Planning, Feature Specification, Autonomous Feature Development, and Codex Execution. Quiz service development and Codex toggles were on, but service-level toggles do not override those global gates. Automatic PR, merge, and production deployment remained off.

The local invocation ledger showed zero Codex process invocations for UTC date 2026-10-26. ChatGPT subscription quota remained Unknown. No Codex model process was launched.

## Changes

- The dispatcher now restricts code-change work to Quiz `FEATURE-2026-000008` and requires both the task contract and explicit request to carry that exact Feature ID.
- Worker claims now require one explicit Controller Job ID. A code-change claim also requires a Ready Quiz task with the approved Feature ID contract; queue-wide draining is unavailable through this CLI path.
- The existing read-only Worker provisioning/runtime remains unchanged. A separate development Worker is not registered because the live Controller's provisioned Worker map is startup-scoped and the global development gates are off.

## Windows MXC boundary probe

A temporary, synthetic canary run used the installed Codex CLI sandbox without starting a model session. The process wrote inside the designated Quiz task workspace, while writes to a sibling Docs workspace and the user-home canary were denied. The temporary probe tree and canaries were removed. This is evidence for this Windows MXC configuration and test layout only; it does not validate Linux sandboxing or authorize the Quiz repository.

## Verification

- TypeScript: passed.
- ESLint: passed.
- Vitest: 187 tests passed across 30 files.
- Dashboard build: passed.
- Live read-only Worker status: Connected; existing integration smoke job completed with Lease/Fencing Token evidence in the Controller.
- Live code-change Claim, development Worker registration, Quiz Clone creation, Quiz tests/build/localization/SEO/Sitemap, and real Codex execution: not performed because global policy gates are off and no code-change Worker is provisioned.
- Ubuntu Actions: Run `40258855185` succeeded. The workflow reported rootless bubblewrap and Linux host sandbox prerequisites as unverified, so Linux code modification remains disabled.

No Quiz source, PR, push, merge, deployment, or VPS change was made. Tools, Calculator, Linux code-modification, and MoneyBook protections remain in place.

## Required administrator action

In Agent Control Center, explicitly enable the global Feature Planning, Feature Specification, Autonomous Feature Development, and Codex Execution settings if development is intended. Keep PR, merge, and deployment disabled. A separately provisioned Windows development Worker must then be configured with a unique identity, DPAPI-protected token, and a server-side allowlist limited to Quiz `FEATURE-2026-000008`; it must acknowledge the current policy before any job is claimed. Recheck the project lock, ready execution contract, invocation budget, and Sandbox immediately before the eventual run.
