# Local development orchestrator (Phase 9C)

This is a local, one-task-at-a-time workflow. Queue discovery never starts a model. A write run requires a `Ready` task, a clean verified service clone, service code opt-in, an explicit `--approve=true`, and a relative path allowlist. The runner creates a task branch in a temporary Git worktree and pins the Codex Windows sandbox to MXC while ignoring user config. Draft PR creation is a separate service opt-in plus a second explicit per-task approval. Automatic merge and deployment remain disabled.

## Commands

```powershell
pnpm agent development status
pnpm agent development codex
pnpm agent development repositories
pnpm agent development queue
pnpm agent development queue --discover=true
pnpm agent development transition --task-id=dev-<id> --to=Triaged
pnpm agent development transition --task-id=dev-<id> --to=Ready
pnpm agent development settings --service=docs --code=on --deploy=off
pnpm agent development settings --service=docs --code=on --pr=on --deploy=off
pnpm agent development run --task-id=dev-<id>
pnpm agent development run --task-id=dev-<id> --approve=true --allow-paths=src/**,tests/** --timeout-ms=600000
pnpm agent development executions
pnpm agent development github
pnpm agent development pr --task-id=dev-<id>
pnpm agent development pr --task-id=dev-<id> --approve-pr=true
pnpm agent development ci --task-id=dev-<id>
pnpm agent development prs
pnpm agent development cleanup --task-id=dev-<id>
```

The first `run` without approval returns a read-only preflight report; it does not call Codex or edit files. The write command is a single, explicit local action; there is no batch worker. Review the task and allowed paths before passing `--approve=true`. Do not enable code or PR opt-in for Calculator during its protected multilingual work. MoneyBook is never eligible. A clean worktree is required; pre-existing edits in the source clone cause an immediate block. Turn on PR opt-in before the local Codex run so its isolated task worktree starts from the configured PR base branch.

## Codex authentication, cost, and sandbox

The runner only accepts `codex login status` output that confirms ChatGPT authentication. It blocks if any paid API credential environment variables are present, does not forward environment credentials to the child process, and ignores Codex user config so a saved `danger-full-access` setting cannot take effect. Runs explicitly use `workspace-write`, `windows.sandbox=mxc`, no user config, and one attempt. No API key fallback or retry occurs. GitHub Actions and non-Windows platforms are blocked.

`codex login status` verifies the authentication mode; it does not expose the current ChatGPT plan allowance. Usage limits can therefore only be observed from a Codex execution result. A limit/quota error is stored as a failure and stops the task without retry. ChatGPT plan usage is distinct from an API key, but availability and included usage depend on the signed-in plan. This project makes no claim about remaining quota.

The runner probes the Windows MXC `:workspace` sandbox before execution. It never selects `danger-full-access`. If the probe fails, the task is blocked. Windows-native Codex supports MXC on compatible Windows 11 systems; this machine’s probe returned `WOORI_MXC_OK`.

Logs are local under `data/development-executions/`, capped and redacted. SQLite stores status, version, auth mode, timestamps, exit code, timeout, worktree/branch, changed files, validation results and reason. API keys, auth JSON, refresh tokens and secret values are not logged. Codex output is treated as untrusted.

## Isolation and validation

The Codex prompt is bounded to the task and the explicit allowlist. Protected paths such as `.env*`, `.github`, deployment/infra directories, `node_modules`, key and certificate files, and broad `*`/`**` allowlists are rejected. After the run, tracked and untracked paths are checked, symlinks are rejected, `git diff --check` runs, and changed text files are scanned for private-key and token patterns. The runner then runs the package’s configured `typecheck` (when present), `lint`, `test`, and `build` scripts one at a time through the Codex `:workspace` sandbox with network access unavailable. The first timeout or failed command stops validation. Existing source worktrees are never used as the Codex workspace.

Successful Codex output alone is not success. At least one in-scope change and all required validations must pass. The task then becomes `Testing`, meaning local verification is complete and review is still required. Failed or timed-out worktrees are retained for inspection. Cleanup only removes the exact recorded worktree and branch when it has no uncommitted changes; dirty worktrees are never force-deleted.

## Repository inventory and protections

The exact remotes, local paths, current branches, dirty-file counts, package scripts, deployment workflow names, and verified PR base branches are in `configs/development-repositories.json`. Runtime status rechecks each repository before every task. Calculator is write-locked. MoneyBook is excluded. Source clones with dirty files remain ineligible until the owner finishes and commits or otherwise clears that work.

All five eligible clones are Next.js/TypeScript/pnpm projects. Their primary branches are never checked out or overwritten; with PR opt-in enabled, the executor fetches the configured remote PR base and creates `codex-agent/<service>/<task-id>` in a separate worktree from that base. Worktrees are stored under the orchestrator's ignored `data/development-worktrees/` directory. Before PR creation, the orchestrator rechecks that the remote base SHA has not moved, the validated diff is unchanged, no duplicate PR or branch exists, the workflow triggers cannot deploy the task branch, and the task branch is the only ref pushed.

## GitHub PR and CI behavior

`development github` uses the existing `gh` authentication in its local credential store and prints only login, scopes, repository permission, default branch, and configured base branch. It never stores or logs a token. Permissions are not expanded automatically. PR automation is OFF by default per service and Calculator remains locked. A PR attempt needs `--approve-pr=true`, successful local Codex validation, a clean and verified source clone, the recorded allowlist, secret scanning, and a safe-workflow review. It commits and pushes only the isolated task branch, then asks `gh` to create a Draft PR. It has no merge, deploy, or rollback command path.

The orchestrator checks existing GitHub workflow triggers at the verified PR base. It blocks deployment-capable `pull_request`/`pull_request_target` workflows and push workflows that can match the generated task branch. After a PR exists it reads check rollups and workflow run IDs using `gh`; absent PR checks remain `Not Configured`, never Passed. Existing service workflows were inspected read-only: their deployment triggers target `main` or manual dispatch, and no PR check workflow was present in the inspected configuration. Thus these repositories currently have no configured PR CI result to report. Service repositories were not modified and no live service PR was created in Phase 9C.

The PR creation path is covered with a temporary local Git repository, local bare remote, and mocked GitHub CLI responses. This verifies commit/push isolation, Draft PR command construction, duplicate/idempotent handling, and CI status mapping without writing to GitHub. A real write integration has not been run against any GitHub repository.

## Deferred

Automatic merge, approval-triggered deployment, rollback, and automatic queue scheduling remain disabled (Phase 9D). GitHub Actions never runs Codex. These require separate implementation and must not be inferred from a task reaching `Testing`, `PR Created`, or `Awaiting Approval`.
