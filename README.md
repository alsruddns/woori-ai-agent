# Woori AI Agent

Read-only website intelligence for the six public woori.today services. Runs locally on Windows or in GitHub Actions; it is not installed on the production VPS and does not modify the existing service repositories.

## Quick start (PowerShell)

```powershell
corepack enable
pnpm install
pnpm exec playwright install chromium
Copy-Item .env.example .env
pnpm agent:discover
pnpm agent:qa -- --service=all --max-pages=12
pnpm agent:seo -- --service=docs --max-pages=12
pnpm agent:dashboard
```

The dashboard is served at `http://127.0.0.1:5173`. Reports are written to `reports/YYYY-MM-DD/<run-id>/`; SQLite history is stored in `data/woori-agent.sqlite`.

## CLI

Commands: `discover`, `qa`, `seo`, `content`, `competitor`, `growth`, `ux`, `performance`, `localization`, `ads`, `change`, `analytics`, `improvement`, `all`, `status`.

Use `pnpm agent <command> -- --service=home|calculator|tools|money|docs|quiz|all --max-pages=50`. `agent:explore` exits Not Configured unless an actual AI provider adapter is implemented and configured. The autonomous AI, Search Console, GA4, AdSense, Lighthouse, and content/competitor analysis are not represented as successful when unavailable.

## Verified route inventory (2026-10-22)

The production root redirects to `/ko`. Its server-rendered navigation links to `/ko/calculators`, `/ko/tools`, `/ko/money`, `/ko/docs`, and `/ko/quiz`. `robots.txt` allows public paths and disallows `/api/`; it advertises five service sitemaps plus the main sitemap. Observed URL counts: main sitemap 417, calculator 2,550, tools 2,655, money 12, docs 1,800, quiz 457, total 7,891. These are discovered sitemap entries, not inspected pages. The public locale list comes from the home sitemap and is configurable.

## Phase 2 implementation status

- Implemented: source-attributed discovery, read-only SQLite API and run history, service-scoped Playwright QA, axe-core accessibility, mobile overflow checks, Lighthouse mobile/desktop lab measurements, report artifacts, and dashboard filters for service/locale/run.
- Verified representative flows: Home navigation/data cards and population link; Calculator formula interaction attempts; Tools JSON formatting/copy and lotto output; MoneyBook public/login page review without authentication; Docs search, links, and synthetic template copy; Quiz category navigation and one answer advancing the progress counter.
- Wi-Fi QR generation and image resizing have dedicated synthetic-input checks, but this run did not expose a verifiable generated output; both remain `Not Covered` rather than being counted as successful.
- Calculator result/edge validation fails closed: the three tested calculators currently show a client error after valid calculation input. Boundary results therefore remain `Not Covered`. Quiz result/restart remains `Not Covered`; result correctness is not inferred from UI text.
- Accessibility findings are recorded as failures; axe currently reports visible-label naming issues on Tools and Calculator pages and serious color contrast issues on Docs and Quiz pages. Home and MoneyBook representative pages passed the automated axe scan.
- Content, Competitor, Growth, Ads, Change baselines, Analytics APIs, and AI Improvement remain `Not Configured` until their real data sources or model adapter are implemented. Localization currently checks route metadata only. Lighthouse reports are lab measurements and do not claim real-user performance.
- Discovery found 7,891 sitemap entries plus two independently verified public routes. This is not the inspected-page count. Page limits still cap each run; dashboard and reports show actual inspected pages separately.
- Production checks block write methods, `/api/`, advertising/tracking requests, and external-origin crawling. No login, account write, ad interaction, or user-data change is performed.

## GitHub Actions

The workflow runs a small daily audit at 06:00 KST (UTC 21:00), uploads artifacts for 30 days, and supports manual dispatch. GitHub scheduled jobs can start late. Current cross-repository deployment workflows cannot be observed from this repository; connect a `repository_dispatch` or `workflow_run` only after granting a narrowly scoped GitHub App/token permission in the service repositories. No deployment signal is currently claimed.

Use repository secrets only when adding external API adapters. Limit OAuth scopes and API quotas. GitHub-hosted runner data is ephemeral; uploaded report artifacts are the configured retention mechanism. Local database and reports are ignored by Git.

## Codex + Playwright MCP

Interactive browser exploration is separate from deterministic CLI/Actions QA. Follow [the MCP exploration guide](docs/playwright-mcp.md). In the local Codex installation checked on 2026-10-22, the Playwright server was enabled in configuration but shown as `Unsupported`; package CLI invocation worked, while an actual MCP browser session was not available to verify. `agent:explore` correctly reports `Not Configured`. CI unattended AI requires a model adapter, credentials, and explicit budgets.
