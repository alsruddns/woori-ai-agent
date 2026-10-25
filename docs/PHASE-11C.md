# Phase 11C — Autonomous Feature Factory

## Delivered

- Added a rule-based Feature Factory for Calculator, Tools, Quiz and Docs.
- Candidate hypotheses are stored in SQLite and deduplicated by stable candidate ID. Each scan reads the configured local repository only after its Git origin matches the verified repository URL.
- The route catalog is scanned from Next.js `app`/`pages` trees. Locale strings are treated as observed candidates, not as the authoritative public locale list.
- Candidate overlap uses route-slug token similarity only; a negative result is not proof that a feature is semantically new.
- Priority scores combine configurable project priority weights with heuristic inputs. They are not measured demand, revenue, traffic or user research.
- Search demand remains `Unknown` unless candidate-specific evidence is joined. No external or paid API is called.
- Draft specifications include service-specific test, privacy and domain requirements. Canonical, hreflang, sitemap and public locale completion remain explicitly unverified until source/build evidence exists.
- Draft specifications create Phase 11B Development Audit jobs and append `FEATURE_SPECIFICATION_GENERATED`; they do not create release history or claim a release.
- Added CLI commands `pnpm agent:feature-factory status|discover|spec` and a Dashboard Feature Factory panel with policy-backed toggles, candidate filters and audited draft specification generation.
- Lottery registry entries for KR, US and JP are explicitly `Unverified`; no rule or legal status is assumed.

## Safety gates

- Discovery requires `FEATURE_EXPANSION` or `FULL_AUTONOMOUS`, global discovery/planning enabled, and the service discovery toggle.
- Specification generation is available only in `FEATURE_EXPANSION` with planning/specification enabled; duplicate candidates are stopped for review.
- Calculator code remains locked. MoneyBook is not an eligible feature service. Linux code modification, Codex execution, PR, merge and deployment remain blocked.
- A specification is a review draft, not a validated implementation plan. Unknown public locales, build metadata, sitemap membership, exact route behavior and repository dirty state are visible and require review.
- No target service source files were written by the Feature Factory. It reads configured service trees only.

## Current catalog hypotheses

The candidate registry contains one hypothesis each for Calculator scenario comparison, a verified lottery rule catalog, Quiz review/retry, and Docs format validation. These are candidates only. Their route-level duplicate check and priority score are not a substitute for a product/source review. Search demand is unknown.

## Commands

```powershell
pnpm agent:feature-factory status
pnpm agent:feature-factory discover --service=tools
pnpm agent:feature-factory spec --candidate=tools-lottery-rule-catalog
```

Discovery and specification generation require an authenticated local administrator when invoked through the Dashboard. The current default `MONITOR_ONLY` mode prevents discovery. Change Controller policy deliberately before running a scan. No source-edit execution command is exposed by this phase.

## Not completed in this phase

- No Codex model request or source modification was performed. Existing Windows Codex execution is not automatically enabled by the Feature Factory, and the default service development policy remains OFF.
- Automatic repair loops, full public-locale verification, built-output SEO/sitemap verification, Git commit/PR/CI and release flow are not activated. They remain future work and require the existing Phase 11B audit and Phase 11D release gates.
- Current candidate templates are rule-based hypotheses. GSC metrics are not associated with these candidate concepts, and no demand estimate is presented.
