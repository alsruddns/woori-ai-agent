# Google API zero-cost guard

The agent never creates a Cloud project, links a billing account, enables billing, or grants itself consent. All Google providers are opt-in and use read-only scopes.

## Provider decisions

- **Search Console API:** Google states that API use is free, subject to usage limits. A verified Search Console property and user OAuth consent are still required. The app keeps it disabled until `GSC_API_ENABLED=true`.
- **GA4 Data API:** Requests require a Google Cloud project and consume property/project quotas. Google's quota documentation does not establish that a project cannot incur charges from other enabled products. It stays disabled unless the user explicitly enables the API, confirms the intended request is zero-cost, and confirms Cloud billing remains disabled.
- **AdSense Management API:** Google documents request and report quotas, but the quota documentation is not a price guarantee. It remains disabled unless the user verifies the project has no billable services and explicitly opts in. The app never enables billing.

No credential is needed to run local rules, Playwright, axe, Lighthouse, or SQLite analysis. Without consent and provider configuration, Google integrations report `Not Configured` and store no fabricated measurements. A quota response or HTTP 429 stops the current collection without retry. Local request caps and caching remain in force.

## Local opt-in checklist

1. Create or select a Google Cloud project yourself. Do not enable billing.
2. Review the current Google product pricing and quota pages linked below before enabling any API.
3. Enable only the API required for a provider and grant its read-only OAuth scope.
4. Keep the relevant `*_API_ENABLED` variable false until you decide to connect.
5. For GA4/AdSense, set `GOOGLE_CLOUD_BILLING_DISABLED=true` only after confirming billing is not linked/active. For the additional provider-specific opt-in, set `GA4_ZERO_COST_CONFIRMED=true` or `ADSENSE_ZERO_COST_CONFIRMED=true`.
6. Store credentials using the documented Windows local OAuth/DPAPI flow. Never add credentials to GitHub Actions or commit them.

If a no-cost condition is uncertain, leave the provider disabled. This application never changes Cloud billing settings.

## Official references checked 2026-10-22

- [Search Console API pricing](https://developers.google.com/webmaster-tools/pricing)
- [Search Console API usage limits](https://developers.google.com/webmaster-tools/limits)
- [Google Analytics Data API quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas)
- [AdSense Management API limits](https://developers.google.com/adsense/management/appendix/limits)
