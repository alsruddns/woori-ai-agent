# Dashboard Scroll Audit

## Scope

Audited `apps/dashboard/src` for long tables, event histories, card lists, settings forms, and report screens. The dashboard now separates major views into Overview, Analysis, Control Center, Feature Factory, Development, History, and Live Monitor sections. This keeps inactive screens out of the document flow while retaining their local state in the mounted React tree.

## Screen inventory and treatment

| Screen / data | Existing behavior | Treatment |
| --- | --- | --- |
| Overview health, URL coverage, feature coverage, provider state | Dashboard summary and bounded rows | Split into Overview; smaller tables remain ordinary DOM tables |
| AdSense Approval findings and manual review | Potentially long findings and review lists | Analysis view; findings use bounded internal list region |
| Search Console reports and SEO opportunities | Report tables and candidate lists | Analysis view; daily/issue/analytics tables use `VirtualizedTable`; opportunities use `VirtualizedList`; existing API row limits remain |
| QA and agent analysis results | Long result and issue lists | `VirtualizedList`; issue timeline uses `VirtualizedTable` |
| Growth ideas | Card list | `VirtualizedList`; source remains capped by the existing API/query path |
| Development Queue, CI, executions, deployments, workers | Several operational sections on one page | Development view; queue uses bounded internal scrolling, run/event tables and histories are virtualized where they can grow |
| Agent Control Center | Long policy form and audit history | Dedicated view; settings remain ordinary controls with collapsible policy sections; long audit history is virtualized; emergency stop stays readily accessible on desktop |
| Project Development Locks | Project cards and detailed worktree evidence | Dedicated Control Center view; details remain collapsible and project count is bounded |
| Feature Factory | Candidate/specification cards and invocation history | Dedicated view; candidate and long history lists are virtualized; existing service filtering and execution gates are retained |
| Development History | Audit jobs, release history, event detail | Dedicated view; virtualized tables/lists; server-side pagination and filters remain in place |
| Live Monitor | Scheduler history, live events, notifications | Dedicated view; virtualized lists, search/order controls, bounded event retention, follow-new-items control and reader-position preservation |

Small fixed-size policy and status tables are intentionally not virtualized. Tables switch to virtualization at their configured row threshold; small results render as normal semantic tables.

## Shared components

- `VirtualizedTable`: internal scroll viewport, sticky header, stable row keys, measured row height, row selection/keyboard activation, loading/error/empty states, and configurable virtualization threshold.
- `VirtualizedList`: variable-height items, internal scroll viewport, follow-new-items toggle, new-item notification, and stable visible-item anchoring when a live feed prepends an event.
- Development History continues to request bounded server pages; virtualization does not fetch the full audit database.

## Responsive and interaction checks

Browser checks were run at 390, 768, 1280, and 1920 CSS pixels. Tab switching, internal list scroll, sticky header, filter result updates, keyboard row activation, and no page-level horizontal overflow were checked. A 10,000-row synthetic table rendered 17 rows in the DOM at the tested viewport; this is a DOM sample, not a rendering-time or memory benchmark.

The same synthetic test confirmed that inserting a new event while reading an older item retained that item at the same visual position and showed the new-event affordance. Synthetic fixtures were removed after verification.

## Authentication and policies

`.env` remains ignored by Git. The local `WOORI_ADMIN_PASSWORD` configuration was checked for presence and the existing minimum-length condition without printing its value. Existing policy, authentication, and CSRF tests were run. The already-running local API listener did not complete requests during the browser login smoke check, so an end-to-end login session was not independently confirmed in that process. No policy or automation setting was changed.

## Limitations

No 1,000/10,000 row runtime or memory benchmark was collected beyond the DOM-node check. Actual production data performance depends on API payload size and browser/device characteristics. Responsive layout was checked in Chromium at the four requested viewport widths; other browser engines and physical mobile devices were not tested.
