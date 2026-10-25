# Phase 11C-2 — Fixture-scoped Codex execution

## Safety boundary

The Feature Factory now has a structured execution planner, bounded retries, a release-readiness validator, and a disposable fixture runner. Service repositories remain blocked. Calculator edits, Linux Codex writes, PR creation, merge, deployment, and rollback remain disabled. GitHub Actions does not invoke Codex.

The real fixture command is an explicit local opt-in:

```powershell
pnpm agent feature-factory fixture-run --execute=true
```

It checks Windows Codex readiness, ChatGPT login, the MXC sandbox, absence of paid AI API credentials, and local execution before creating any files. It creates a temporary Git repository outside the workspace, discovers a Docs candidate, creates a draft specification and audit intent, then asks Codex to implement a small document-format validation helper. The existing executor creates a separate worktree and runs lint, tests, and build itself. Changes are limited to fixture source, tests, locales, and public evidence files. The fixture and its isolated SQLite data are removed after the result is collected.

The command does not expose auth files, execute scripts supplied by external sites, access service repositories, push, create PRs, or deploy. A Codex usage/authorization error stops without a paid API fallback. The Codex CLI does not expose remaining ChatGPT plan usage before invocation; the command uses a bounded 4-minute execution window. It permits at most two distinct validation repair attempts; repeated failure, timeout, auth/quota response, stale policy, or expired local lease stops the loop. The Windows executor clears configured MCP servers for source-edit sessions to avoid unrelated remote tool context and token use.

## Release readiness

`validateFeatureReleaseReadiness` requires an authoritative locale declaration and evidence for every locale: route, visible strings, title/description, canonical, hreflang, x-default, robots, sitemap, and build/render evidence. The live service Feature Factory does not yet have authoritative public-locale and generated-output evidence in its draft specifications, so service development remains blocked. Fixture evidence is never treated as evidence for a live repository.

## Cost and execution mode

The only model execution path is local Codex CLI using the existing ChatGPT login and Windows MXC adapter. `OPENAI_API_KEY`/other paid credentials cause preflight failure; there is no API fallback. The fixture execution is deliberately excluded from Vitest and CI so automated builds cannot spend Codex usage.

## 2026-10-25 actual fixture execution

Windows Codex CLI `0.163.0` reported ChatGPT authentication and the MXC probe was Ready; no paid API environment credentials were present. The actual fixture execution used the earlier temperature-converter fixture contract. It produced observed untracked source, test, locale, metadata, and sitemap files in the disposable worktree, then failed independent lint because the model chose `.mjs`/different filenames while validation expected `.js`. The bounded loop made two repair retries and stopped after 3 attempts. The captured Codex response also said it could not inspect files because the prompt prohibited shell use. This was a prompt/fixture-contract failure, not a confirmed product feature success. The isolated audit hash chain verified, and the fixture was deleted. No production repository, PR, or deployment was touched.

The executor prompt now permits safe file inspection and editing inside only the sandboxed worktree while still prohibiting validation commands, package installs, network access, and external processes. The current fixture contract names exact expected files, validation scripts, and public routes. These corrections have not been rerun through Codex: the observed result remains **Failed**, and a later explicitly requested fixture run is required to verify them end to end.

## Linux

Linux feature code edits remain disabled. Ubuntu CI covers common planner/release-gate/retry logic without model calls. Windows fixture success, if observed, does not certify Linux sandboxing.
