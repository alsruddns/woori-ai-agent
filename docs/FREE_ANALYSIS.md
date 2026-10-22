# Free analysis and external data policy

Analysis uses deterministic rules and user-run Codex sessions. CLI and CI do not invoke metered model APIs. API keys do not activate AI. Keep `PAID_AI_API_ENABLED=false`, `AI_API_BUDGET_USD=0`, and `AI_AUTO_EXECUTION=false`.

## Google Search Console and GA4

Both integrations are disabled by default. Credentials alone never issue a request. A user must explicitly set `GSC_API_ENABLED=true` or `GA4_API_ENABLED=true` after granting the service account read-only access to the relevant property. Authentication uses the official service-account JWT OAuth flow.

1. Enable only the required Search Console API or Analytics Data API in Google Cloud.
2. Add the service account as a read-only property user.
3. Keep its private key in a local secret store. Do not commit it or expose it in reports, artifacts, or logs.
4. Do not enable billing or paid products. If a zero-cost quota cannot be confirmed for the Google project, leave the integration disabled.
5. Set the property and explicit opt-in variables below. GitHub Actions always forces all provider opt-ins to `false`.

```dotenv
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=
GSC_SITE_URL=sc-domain:example.com
GSC_API_ENABLED=false
GA4_PROPERTY_ID=
GA4_API_ENABLED=false
ANALYTICS_START_DATE=
ANALYTICS_END_DATE=
```

Provider limits are 8 requests per day; each run can make at most 4 data requests. Results are cached for 6 hours. Incremental collection overlaps the last stored date by 3 days. HTTP 429, daily limits, or low GA4 remaining quota stop collection without retries. Only actual API responses are stored in `analytics_daily`. `Not Configured` means no measured value is available; it is never converted to zero.

Official documentation: [Search Console pricing](https://developers.google.com/webmaster-tools/pricing), [Search Console usage limits](https://developers.google.com/webmaster-tools/limits), [GA4 Data API quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas), [GA4 authorization scopes](https://developers.google.com/analytics/devguides/reporting/data/v1/authorization).

## AdSense

AdSense API requests are disabled by default. Keep `ADSENSE_API_ENABLED=false` unless read-only access is configured and the project owner has confirmed that its API use has no charge. Account identifiers or keys do not activate requests. DOM inspection does not click ads or generate impressions.

Official documentation: [AdSense API quotas](https://developers.google.com/adsense/management/appendix/limits), [AdSense read-only OAuth scope](https://developers.google.com/adsense/management/direct_requests).

## Competitor candidates

`configs/competitor-candidates.json` lists one public candidate per service with a source link and the reason it may be relevant. This is a research inventory; it does not enable page crawling. `node scripts/check-competitor-robots.mjs` requests each candidate's `robots.txt` once and does not request homepages. A current terms review, robots review, explicit enablement, and review date are required before the comparison crawler can fetch pages. A successful robots response does not mean terms have been reviewed.

The crawler is limited to 3 pages per domain, at least 1.5 seconds between page requests, HTTPS, same-domain pages, and no followed redirects. It only reads public HTML. It does not infer traffic, search volume, or ad revenue.

Candidates are Our World in Data (Home), Calculator.net (Calculator), JSONFormatter (Tools), Goodbudget (MoneyBook), Smartsheet templates (Docs), and JetPunk (Quiz). They are comparison hypotheses, not endorsements or formal competitor claims.

## Inspection profiles

`configs/inspection-strategy.json` sets these caps:

- Daily: smoke QA, SEO, and locale checks; at most 6 browser pages.
- Weekly: QA, SEO, content, change, and UX samples; at most 24 pages.
- Monthly: expanded SEO, content, and change inspection; at most 200 pages.
- Changed: URLs not checked in the last 24 hours first; at most 50 pages.

Browser concurrency is one. Discovery count and inspected count are reported separately.

```powershell
pnpm agent audit --profile=daily
pnpm agent audit --profile=weekly
pnpm agent audit --profile=monthly
pnpm agent audit --profile=changed
```

## Interpretation

Content signals such as title, body length, FAQ markers, source/date wording, document structure, and broken links are rule-based observations. Semantic title/body relevance, technical correctness, feature duplication, user value, and translation quality require Codex review. Growth candidates are hypotheses. No search volume or visitor estimate is invented.
