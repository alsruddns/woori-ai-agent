# Phase 11C-3.1 — Project Development Locks and Quiz/Docs Preparation

Date: 2026-10-25

## Scope and safety

This phase adds Controller-backed project development locks, target selection, an isolated clone helper, Quiz/Docs read-only analysis records, a Quiz feature draft, and a Project Development panel. It does not call Codex or change a service repository. Push, PR, merge, deployment, and Linux code editing remain disabled.

## Project lock policy

| Project | Default/resulting state | Evidence and action |
|---|---|---|
| Tools | `LOCKED_EXTERNAL_DEVELOPMENT` | The separate multilingual Codex task remains explicitly locked even though the observed working tree was clean. Unlock requires an authenticated administrator, a reason, and explicit confirmation that the other work is complete. |
| Calculator | `LOCKED_POLICY` | Immutable source-edit policy during multilingual work. Its local checkout is on `main`, while the observed remote `develop` SHA is different. |
| Quiz | `LOCKED_CONFLICT` | Local `develop` is clean and equals remote SHA `1053b8896a5363adbfb15d5061f27470b5094371`, but two additional Phase 9D-4 CI worktrees exist. Their ownership was not assumed and they were not removed. |
| Docs | `LOCKED_CONFLICT` | Local `develop` is clean and equals remote SHA `0194542d7b09c4a5cb13f6c1677604aa1e6fa24e`, but two additional Phase 9D-4 CI worktrees exist. They were preserved. |
| Home | `DISABLED` | Feature expansion is excluded. Its checkout has an untracked `.playwright-mcp/` path and is on a feature branch; the existing user work was preserved. |

Git state cannot prove that another Codex session is absent. Clean trees are therefore not treated as proof of exclusive ownership. Unknown repository identity, remote SHA, or tree state fails closed.

## Controller and worker enforcement

Project locks are stored in the Controller SQLite database with a monotonic lock version. Lock changes use an expected version, immutable policy locks for Calculator/Home, and Phase 11B audit intent/result events. The Dashboard mutation uses the existing administrator session and CSRF checks.

Workers read the project lock snapshot together with Controller policy. A claim must submit the current project-lock version. The Controller rejects stale versions, and its SQLite claim transaction checks that a code-change job's service is currently unlocked. The claimed lock version is stored with the job; renew, transition, and side-effect lease checks reject a code-change lease after the lock version changes. Feature execution planning and preflight also block locked projects. Linux code changes, Calculator changes, MoneyBook, and global automatic development remain blocked.

Selection order is Quiz → Docs → Tools → Calculator. At the time of this report, Quiz and Docs are conflict-locked, Tools is externally locked, Calculator is policy-locked, and Home is disabled. The operating mode is `MONITOR_ONLY`; automatic development and Codex execution toggles are OFF. No project is currently eligible.

## Isolated workspaces

The agent-only clone helper accepts only configured repositories, requires a verified base SHA, refuses a destination inside or above the user checkout, never overwrites an existing destination, clones the remote `develop`, confirms its SHA and origin, then creates `agent/<job-id>`. It never pushes, creates a PR, or deletes the clone. The fixture test uses a local bare remote; no service worktree was created.

## Read-only project analysis

### Quiz

- Observed `develop` SHA: `1053b8896a5363adbfb15d5061f27470b5094371`.
- `publishedLocales` declares 26 locales and drives list/detail static routes. Quiz localization quality separately controls indexability and sitemap inclusion.
- Registry source contains 109 quiz registrations: 58 legacy entries and 51 bank entries. The registry marks 71 public: 20 non-static legacy entries plus 51 bank entries. The remaining 38 legacy static entries are not public.
- `QuizView` already supports general retry, bank-question review, and a new bank set. It does not expose a retry-only-incorrect action.
- First feature draft: **Retry Incorrect Questions** for bank quizzes. It filters the in-memory answer review to missed questions, preserves answer keys and localized question copies, adds no route and stores no additional user data. Search demand is `Unknown` and the feature remains a hypothesis.
- Draft locale coverage lists all 26 current published locales. The draft is not release-ready: no implementation, build metadata, locale UI, or sitemap regression has been run for this proposed feature.
- Repository scripts observed: `lint`, `test`, `test:e2e`, `quiz:validate`, `check:localization-quality`, `build`.

### Docs

- Observed `develop` SHA: `0194542d7b09c4a5cb13f6c1677604aa1e6fa24e`.
- `template-schema.ts` is the explicit source of 26 public locales. The localized route and sitemap consume that declaration.
- Registry inspection returned 119 public document tools across the supported locales. Docs uses a document registry, field schema, browser-side engine, translation catalogues, localized SEO helper, canonical, hreflang including `x-default`, and a sitemap route. Browser-local processing is a privacy boundary to preserve.
- No separate Docs robots route was found in the inspected app routes; future work must preserve existing metadata and validate the deployment-wide robots response rather than assume a route exists.
- Repository scripts observed: `lint`, `test`, `check:content-quality`, `build`.

Neither service's tests or build were run in this phase; this was a read-only source/configuration analysis. The two Phase 9D-4 worktrees per repository must be reviewed and safely resolved before code development can be considered.

The local Development Audit Trail contains the Quiz analysis as `DEV-2026-000069`, Docs analysis as `DEV-2026-000070`, and the draft feature specification as `FEATURE-2026-000008`. Their three event chains were verified valid after recording. These IDs refer to the local SQLite audit data; that ignored database is not committed to Git.

## Codex budget observed

The persisted invocation ledger showed 1 invocation today, with usage status `Unknown`; the configured local daily limit is 1. Subscription quota is `Unknown`, so no invocation was available. No Codex process was launched.

## Audit and verification

The Controller records initial policy locks, project lock changes, selection skips/conflicts, read-only repository analyses, and the prepared Quiz specification through the existing Development Audit Trail. The feature record is a draft, not a code change, release, PR, or deployment.

Validation run in the agent repository: TypeScript, ESLint, Vitest, and Dashboard production build. Ubuntu Actions was not run in this phase; its existing workflow is a develop push/PR or manual dispatch workflow and contains no Codex call.

## Phase 11C-3.2 entry conditions

1. Review and resolve the extra Quiz and Docs worktrees without deleting unverified user work.
2. Confirm the intended project lock and current remote `develop` SHA again.
3. Ensure the Controller is in an allowed mode and development/Codex policies remain explicitly enabled only for the intended test scope.
4. Wait for or explicitly budget a Codex invocation; the current local daily slot is consumed and subscription quota is unknown.
5. Recheck Windows MXC, worker lease/fencing token, project lock version, and Audit Trail readiness before any approved fixture or service worktree execution.
