# Service fix requests

This file records public-site defects for the owners of the relevant service repositories. This agent repository does not modify those services.

## Calculator result pages crash on valid values

- Services: `woori-calculator`
- Reproducible URLs:
  - `https://www.woori.today/ko/calculators/compound-interest`
  - `https://www.woori.today/ko/calculators/simple-interest`
  - `https://www.woori.today/ko/calculators/percentage`
- Reproduction count: 2 of 2 attempts per URL on 2026-10-22.
- Actions: focus each input, fill values using browser input/change events, blur, then activate the visible calculate button. For compound interest, select monthly frequency `12` before calculation.
- Inputs: compound/simple `principal=12345.67`, `rate=6.25`, `years=3.5`; compound `frequency=12`; percentage `A=271`, `B=17`.
- Expected results from independent fixtures: compound final amount `15355.71`; simple interest result `15046.29`; 17% of 271 is `46.07`.
- Actual result: the application transitions to its “This page couldn't load” error screen. Both attempts raised a browser `pageerror`:
  - compound: `Cannot read properties of undefined (reading '최종 금액')`
  - simple: `Cannot read properties of undefined (reading '단리 이자')`
  - percentage: `Cannot read properties of undefined (reading 'A의 B%')`
- Classification: confirmed client-side runtime failure in the public site. Inputs were populated and observable before the action; the same failure reproduced in an independent diagnostic script and in the normal QA runner. This is not a locator-only failure.
- Evidence: ignored run artifacts under `reports/2026-10-22/calculator-repro-*/` include `reproduction.json`, each attempt's DOM snapshot, screenshot, and Playwright Trace. The normal QA report also retains its screenshot and trace.
- Suggested investigation: inspect result localization/label lookup for the `ko` locale and ensure the calculation result object is defined before rendering localized labels. Add unit tests for all three formula result shapes and a browser regression test.

## Accessibility findings currently tracked as known issues

`configs/a11y-known-issues.json` tracks exact service/rule/selector signatures with a review deadline of 2026-11-21. They remain visible in reports as `Known Issue`; new selectors or rules are still treated as new failures. Review and expire this baseline by its date.
