# Phase 11C-2.1 — Codex Fixture Validation

## Outcome

The execution contract, workspace path tracking, JSON reader, rendered-HTML evidence parser, and untracked-file diff collection were hardened. A real Windows Codex run modified the temporary TypeScript fixture and passed its independent typecheck, ESLint, build, and three unit tests. The complete feature run is **not verified as successful**: its release-readiness result was `Not Ready`, and the ephemeral fixture was removed before the corrected HTML evidence parser could re-read those exact artifacts. No additional Codex request was made after the three bounded fixture-run invocations.

## Failure causes

### Earlier Phase 11C run

The retained run summary confirms a mismatch between expected CommonJS `.js` paths and emitted `.mjs`/different paths. The prompt also prohibited inspection while asking Codex to correct files. The raw lint stderr was not retained, so its exact diagnostic is unknown. There is no evidence that MXC caused the failure.

### Phase 11C-2.1 runs

1. The first live run's actual Git status parser used a trimmed command helper on `git status --porcelain -z`. Trimming removed the status-column space, so slicing the status prefix dropped the first character from the first changed path (`locales/en.json` became `ocales/en.json`). The exact-target validator correctly rejected it. This was a confirmed verifier bug.
2. A subsequent Codex run emitted a UTF-8 BOM in JSON. The fixture's plain `JSON.parse` threw before final fixture evidence could be recorded. BOM-prefixed JSON is valid UTF-8 input; the reader now strips a BOM and fails closed on malformed JSON.
3. The final live run's Codex implementation passed all four independent commands and the contract validator. The release evidence parser nevertheless reported the rendered HTML metadata as missing. Source inspection found a double-escaped word-boundary regex (`\\b`) in the HTML tag matcher. This parser defect is fixed to use a word boundary. The same run's summary omitted untracked file contents because an expected `git ls-files` miss short-circuited the untracked diff path; this is also fixed and covered by a temporary-repository test.

The final live fixture's reported target files included both locale JSON files, metadata, robots, sitemap, and both locale HTML files; however, the generated files were removed by the fixture cleanup before the parser fix, so their content cannot now be independently rechecked. Therefore the observed `Not Ready` result is not upgraded to `Ready` based on inference.

## Implemented safeguards

- One versioned `ExecutionContract` is shared by the planner, prompt, fixed verifier, and release evidence collector.
- It includes the live worktree root, exact target paths, allowed extensions, immutable inputs/tests, exports, behavior, test paths, fixed verification commands, timeout, retry cap, policy version, and real temporary Controller Lease/Fencing Token.
- The prompt provides exact worktree-rooted paths and allows inspection only inside the temporary worktree. It forbids changing tests/configuration, network access, credentials, and unrelated processes.
- Git status is read without trimming NUL-delimited output. Exact target/extension, immutable-file, symlink, realpath, deletion, required-artifact, export, secret, and whitespace checks remain fail-closed.
- Fixed commands run independently in this order: typecheck, lint, build, test. The fixture tests and package/compiler/linter configuration are immutable.
- BOM-safe JSON parsing and locale HTML/metadata/robots/sitemap evidence parsing have dedicated tests. Missing or malformed evidence remains Not Ready.
- Untracked artifact diffs are collected without staging them.
- After a fixture run, the runner now imports a redacted outcome and the temporary hash-chain verification summary into the persistent project Development Audit Trail before reporting completion. This new persistent import path passed typechecking and the general audit tests, but it was not exercised by the already completed live runs.
- The last live run used zero retries to preserve the three-invocation budget. The executor's normal retry cap remains at two retries; repeated errors, quota/auth failures, timeout, policy/lease changes, and environment failures stop retries.

## Actual verification evidence

- Live Windows Codex fixture invocations: 3.
- First run: executor output reported one attempt and failed on the dropped first path character.
- Second run: the runner exited on BOM JSON parsing before printing its result. Its `attemptCount` was not preserved, so the total individual Codex process count across all invocations cannot be certified from retained evidence.
- Third run: Codex CLI 0.163.0; ChatGPT login; MXC Ready; paid API environment absent; `attemptCount: 1`, `retryCount: 0`.
- Third run changed files reported by the exact contract: `src/normalize-input.ts`, `locales/en.json`, `locales/ko.json`, `src/metadata.json`, `public/robots.txt`, `public/sitemap.xml`, and the `en` and `ko` fixture HTML pages.
- Independent checks in the third run: typecheck, lint, build, and 3 Node tests all exited 0. Contract path/export/artifact validation returned `passed: true`.
- Release readiness from that live run: `Not Ready` because the then-current HTML tag parser did not observe rendered metadata. The parser has since been corrected and tested against rendered fixture HTML, but the exact live artifact set was already deleted; full live release readiness remains unverified.
- Temporary audit at run time: feature hash chain valid (5 events), task chain valid (6 events). The third run predated persistent audit import and its temp SQLite was deleted. New runs will persist a summary; the new import path was not exercised live.
- API-key/paid model fallback: none. The ChatGPT Codex session used existing account allowance; it may consume that subscription's quota. No claim is made about the account's overall plan cost.
- Live services, their repositories, iwinv, PRs, merge, and deployment: untouched.

## Automated checks after fixes

- TypeScript: passed.
- ESLint: passed.
- Vitest: 157 tests passed across 27 files.
- Dashboard production build: passed.
- `git diff --check`: passed.
- Ubuntu CI: not yet run for this change; it will be triggered by the woori-ai-agent develop push and reported from the actual Actions result.

## Remaining work

The whole Phase 11C-2.1 success condition is not met until one new disposable Codex fixture run completes with independent checks, locale/SEO/sitemap readiness `Ready`, valid temporary and persistent audit chains, and safe cleanup. Further Codex execution was stopped because the intermediate run's attempt count was lost and the user capped live calls. Do not run further Codex until the call budget is explicitly reset or a reliable persistent attempt counter is in place. Phase 11C-3 is not ready.
