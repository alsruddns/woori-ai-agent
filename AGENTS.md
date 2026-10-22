# Woori AI Agent

- Run only on a developer workstation or GitHub Actions. Never deploy this project to the production VPS.
- Treat `https://www.woori.today` as read-only. Do not submit forms that persist data, log in, click ads, or call `/api/`.
- Keep one browser worker, at least 1 second between HTTP page requests, and default to at most 50 inspected pages.
- Reports must distinguish confirmed findings, suspected observations, skipped checks, and Not Configured integrations.
- Never fabricate traffic, revenue, search volume, or AI findings. API integrations remain disabled until credentials and scopes are configured.
- Preserve the six services and twelve agent identifiers in `configs/services.json` and the CLI registry.
- Use commit format `Type : [Scope] Description` on `develop`.
