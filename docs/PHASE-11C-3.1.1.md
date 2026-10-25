# Phase 11C-3.1.1 — Existing worktree protection and isolated Clone preparation

## Scope and outcome

This phase changes only `woori-ai-agent`. No Quiz, Docs, Tools, Calculator, Home, or MoneyBook source was edited. No service Clone/worktree was created or removed, no Codex model was called, and no push/PR/merge/deployment was made against a service repository.

The previous `LOCKED_CONFLICT` condition treated any additional Git worktree as a project-wide conflict. That is too broad: a checkout can exist without colliding with a separate, agent-owned Clone. Worktree inventory is now reported separately from development permission and integration risk. Existing worktrees remain read-only and are never cleaned up by this code.

## Read-only repository observations

Observed on 2026-10-25. Worktree owners are unknown; no ownership was inferred from path names.

| Project | Worktree | Branch | HEAD | Working tree | Git operation marker |
| --- | --- | --- | --- | --- | --- |
| Quiz | `C:/Users/achie/git/woori-quiz` | `develop` | `1053b8896a5363adbfb15d5061f27470b5094371` | clean | none |
| Quiz | `C:/Users/achie/AppData/Local/Temp/woori-agent-phase9d4-main-ci/main-tests/woori-quiz` | `codex/phase9d4-main-ci-smoke` | `3d1a099f518f4b340166bd2419bb5dc340b41467` | clean | none |
| Quiz | `C:/Users/achie/AppData/Local/Temp/woori-agent-phase9d4-main-ci/woori-quiz` | `codex/phase9d4-main-ci` | `2247b37aef5a97cebd79955ef95541ad52c09883` | clean | none |
| Docs | `C:/Users/achie/git/woori-docs` | `develop` | `0194542d7b09c4a5cb13f6c1677604aa1e6fa24e` | clean | none |
| Docs | `C:/Users/achie/AppData/Local/Temp/woori-agent-phase9d4-main-ci/main-tests/woori-docs` | `codex/phase9d4-main-ci-smoke` | `98b934649641b5044e63218be2ba382de32c3256` | clean | none |
| Docs | `C:/Users/achie/AppData/Local/Temp/woori-agent-phase9d4-main-ci/woori-docs` | `codex/phase9d4-main-ci` | `071aab9544f7c8b1572771aa7a0bfe954b857696` | clean | none |

The current Quiz and Docs `origin/develop` SHAs matched their primary develop checkout at observation time. This confirms the pinned base for those observations only; it does not identify worktree owners or establish that external development has ended.

## Lock and eligibility model

- Additional worktrees, dirty paths, stale checkout SHAs, in-progress Git operations, Git worktree locks, and prunable entries are recorded as inventory/integration-review evidence.
- An extra worktree alone no longer changes an otherwise verified project into `LOCKED_CONFLICT`.
- Existing worktree ownership remains `Unknown`; the system does not delete or edit those checkouts.
- Repository identity or remote `develop` SHA that cannot be verified still fails closed as `LOCKED_UNVERIFIED`.
- Persisted manual, external-development, policy, and disabled locks remain authoritative. In particular, Tools remains externally locked, Calculator remains policy locked, Home remains disabled, and MoneyBook remains excluded.
- Dashboard/API status separates `Workspace Ready`, `Development Policy Allowed`, and `Codex Execution Allowed`. A verified remote base or a ready isolated workspace is not an execution authorization.
- Quiz remains before Docs in target order. Both can be skipped by current mode, policy, worker, sandbox, lease, audit, or budget gates without altering those gates.

## Isolated Clone Manager

The Clone Manager uses a configured path allowlist and requires a repository allowlist, verified remote `develop` SHA, non-overlapping workspace root, safe path components, no existing destination, and a task-specific `agent/<job-id>` branch. It disables interactive Git prompts and isolates Git hooks; it does not copy project environment files or credentials. Fresh `ls-remote` validation occurs at Clone time rather than on each controller status/claim request.

Clone reservation and completion are tied to the current project-lock version, controller-policy version, active code-change job, Worker, Lease ID, expiry, and Fencing Token. These are checked before Clone work and again before marking the workspace Ready. Stale state fails closed. A failed Clone is recorded and left for review; it is not automatically deleted. Automatic push and PR remain disabled.

No real Quiz or Docs Clone was created in this phase. The Clone Manager was exercised against temporary local bare-Git fixtures, including an existing linked worktree with an uncommitted user file. The test confirmed that the user file and existing worktree remained unchanged while a separate Clone was pinned to the fixture's remote `develop` SHA.

## Preserved Quiz draft

`FEATURE-2026-000008` / `QUIZ-RETRY-INCORRECT-QUESTIONS` remains a draft specification for retrying only missed questions in the existing quiz result flow. It proposes no new route, leaves search demand `Unknown`, and remains unreleased. No Quiz source was changed.

## Execution policy and audit

The Controller remains in `MONITOR_ONLY`; the persisted local Codex daily invocation count remains `1/1`, and subscription balance remains `Unknown`. This phase made zero Codex model invocations and did not change those values. The Linux Codex sandbox lock, Calculator lock, Tools external-development lock, automatic PR, merge, and deployment restrictions remain in place.

Project lock/worktree observations and target-selection skips are recorded through the existing Development Audit Trail. Clone fixture tests verify reservation, Ready state, pinned SHA, and preservation of a dirty user worktree; service-level audit events were not created because no service Clone or service development job was executed.

## Verification

- Windows local TypeScript: passed.
- Windows local ESLint: passed.
- Windows local Vitest: 29 files, 173 tests passed.
- Dashboard production build: passed.
- Real service Clone readiness: not executed; fixture Clone only.
- Real Codex/model execution: not executed by policy.
- Ubuntu Actions: pending the push of this agent-repository change; report the actual run result separately.

Quiz/Docs existing worktrees are preserved, but their owner is unknown. Before actual Quiz development, require current authenticated development policy, a fresh project-lock/policy version, available Worker and valid Lease, verified Windows Sandbox, invocation budget, audit storage, and a newly verified isolated Clone. If these gates block Quiz, Docs can be re-evaluated; no lock or budget is automatically changed.
