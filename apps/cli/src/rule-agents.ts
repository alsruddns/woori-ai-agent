import fs from 'node:fs';
import path from 'node:path';
import { initDb, config, type Check, type Finding } from './core.js';

export function reviewContent(runId: string, checks: Check[]): Finding[] {
  const findings: Finding[] = [];
  const add = (check: Check, severity: Finding['severity'], title: string, description: string, evidence?: string) => findings.push({ id: `${runId}-content-${findings.length + 1}`, runId, service: check.service, url: check.url, locale: check.locale, agent: 'content', severity, status: 'confirmed', title, description, evidence });
  for (const check of checks) {
    if (!check.title) add(check, 'Medium', 'Missing page title', 'The inspected document has no title metadata.');
    if (!check.description) add(check, 'Low', 'Missing meta description', 'The inspected document has no description metadata.');
    if (check.h1Count !== 1) add(check, 'Low', 'Heading structure needs review', `Observed ${check.h1Count} H1 elements; this rule checks heading count only and does not assess writing quality.`);
  }
  const byTitle = new Map<string, Check[]>();
  for (const check of checks) if (check.title) byTitle.set(check.title.trim().toLocaleLowerCase(), [...(byTitle.get(check.title.trim().toLocaleLowerCase()) ?? []), check]);
  for (const group of byTitle.values()) if (group.length > 1) for (const check of group) add(check, 'Low', 'Duplicate title in inspected pages', `The title was repeated across ${group.length} inspected URLs.`, group.map(item => item.url).join('\n'));
  return findings;
}

export function comparePageMetadata(runId: string, checks: Check[]): Finding[] {
  const db = initDb();
  const prior = db.prepare("SELECT id FROM runs WHERE id<>? AND status IN ('Completed','Failed') AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(runId) as { id: string } | undefined;
  if (!prior) { db.close(); return []; }
  const old = new Map((db.prepare('SELECT url,status,title,description,canonical FROM checks WHERE run_id=?').all(prior.id) as Array<{url:string;status:number|null;title?:string;description?:string;canonical?:string}>).map(item => [item.url, item]));
  db.close();
  const findings: Finding[] = [];
  for (const current of checks) {
    const before = old.get(current.url);
    if (!before) { findings.push({ id: `${runId}-change-${findings.length + 1}`, runId, service: current.service, url: current.url, locale: current.locale, agent: 'change', severity: 'Info', status: 'confirmed', title: 'Newly inspected URL', description: `This URL was not present in previous inspection ${prior.id}.`, evidence: JSON.stringify({ previousRunId: prior.id, current: { status: current.status, title: current.title } }) }); continue; }
    const fields = (['status', 'title', 'description', 'canonical'] as const).filter(key => (before[key] ?? null) !== (current[key] ?? null));
    if (fields.length) findings.push({ id: `${runId}-change-${findings.length + 1}`, runId, service: current.service, url: current.url, locale: current.locale, agent: 'change', severity: 'Medium', status: 'suspected', title: 'Page metadata changed', description: `Observed changes in: ${fields.join(', ')}. This may be an expected content update.`, evidence: JSON.stringify({ previousRunId: prior.id, fields, before, current: { status: current.status, title: current.title, description: current.description, canonical: current.canonical } }) });
  }
  return findings;
}

export function writeGrowthIdeas(outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const rows = config.services.map(service => `## ${service.label}\n\n- Idea: Add a focused comparison or guided workflow around an existing public route.\n- Basis: The service has public routes under ${service.basePaths.join(', ')}; this is a rule-generated product hypothesis, not measured search demand.\n- User value: Help visitors move from a single task to a related next step.\n- Effort: Medium; confirm existing feature inventory in the service repository before implementation.\n- Codex prompt: Inspect the read-only public flow and the service repository, then propose one small feature with a user story and a regression test. Do not change production.\n`).join('\n');
  const file = path.join(outputDir, 'FEATURE_IDEAS.md');
  fs.writeFileSync(file, `# Rule-generated feature hypotheses\n\nNo search volume, traffic, revenue, or user survey data was available. Validate each idea with product evidence before prioritizing.\n\n${rows}`, 'utf8');
  return file;
}
