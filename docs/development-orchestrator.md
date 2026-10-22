# Local development orchestrator (Phase 9A)

The first phase records the five eligible repositories, builds a deduplicated SQLite task queue and reports local execution readiness. It does not edit service repositories, create worktrees, invoke Codex, create pull requests or deploy. All automation and deployment flags start OFF.

## Commands

```powershell
pnpm agent development status
pnpm agent development repositories
pnpm agent development queue
pnpm agent development queue --discover=true
pnpm agent development add --service=docs --kind=content --priority=Medium --title="Review document page" --evidence="Observed issue and URL" --acceptance="Reproduce, add a regression check, run lint/test/build"
pnpm agent development transition --task-id=dev-<id> --to=Triaged
pnpm agent development run --task-id=dev-<id>
```

`run` is a dry-run and intentionally exits as Not Configured. Do not interpret a queue status as code completion.

## Verified local inventory

The paths, origin URLs, current branches, dirty-file counts, package scripts and deployment workflow file names in `configs/development-repositories.json` were read from the local clones on 2026-10-22. Recheck all of them before use; this inventory is not a permanent lock state.

- `woori-home`: `C:/Users/achie/git/woori-home`, `main`, clean; `publish.yml`.
- `woori-calculator`: `C:/Users/achie/git/woori-calculator`, `develop`, 4 modified files; explicitly locked during multilingual expansion; `deploy.yml`.
- `woori-tools`: `C:/Users/achie/git/woori-tools`, `develop`, 3 modified files; runtime lock until clean; `deploy.yml`.
- `woori-docs`: `C:/Users/achie/git/woori-docs`, `develop`, clean; `deploy.yml`.
- `woori-quiz`: `C:/Users/achie/git/woori-quiz`, `main`, clean; `deploy.yml`.
- MoneyBook is read-only QA only and is excluded from the development queue.

All five clones are Next.js/TypeScript/pnpm projects. The inventory lists verified lint, test, build and service-specific commands. It uses work branches only in future phases; no primary branch is to be overwritten.

## Execution prerequisites and cost policy

The `codex` executable was not found on PATH during the Phase 9A check. Running Codex-related desktop processes do not establish that a supported CLI, ChatGPT login, plan quota, non-interactive mode or free usage allowance is available. Therefore this phase does not run `codex exec`, install a CLI, or try API-key fallback. The `gh` executable/authentication and repository write permission also must be checked before any PR operation.

`PAID_AI_API_ENABLED=false`, `AI_API_BUDGET_USD=0`, and `AI_AUTO_EXECUTION=false` remain enforced by the existing code-level guard. The queue stores evidence and acceptance criteria only; it does not contain credentials. `MoneyBook` is never eligible, Calculator stays locked, and auto-deploy is disabled for every service.

## Deferred phases

Phase 9B requires verifying a supported local Codex CLI and its account/usage status before adding an isolated worktree executor. Phase 9C requires verified GitHub authentication and write permission. Phase 9D requires reviewed repository workflow, approval and health-check/rollback contracts. Until those checks pass, execution, PR, merge, deployment and rollback actions remain disabled.
