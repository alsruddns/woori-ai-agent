import fs from 'node:fs';
import path from 'node:path';
import { initDb, type Check, type Finding } from './core.js';
import { buildGrowthCandidates } from './free-analysis.js';

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
  const candidates=buildGrowthCandidates();
  const rows = candidates.map(item => `## ${item.service}: ${item.name}\n\n- 중복 여부: ${item.duplicate}\n- 사용자 가치: ${item.userValue}\n- 난이도: ${item.effort}\n- Backend: ${item.backendRequired}\n- 운영 비용: ${item.operatingCost}\n- 다국어: ${item.internationalization}\n- 우선순위: ${item.priority}\n- 근거: 발견 경로 ${item.evidence.discoveredRouteCount}개; 예시 ${item.evidence.sampleRoutes.join(', ')||'없음'}\n- 검색량: 측정하지 않음\n- Codex 검토 프롬프트: ${item.codexPrompt}\n`).join('\n');
  const file = path.join(outputDir, 'FEATURE_IDEAS.md');
  fs.writeFileSync(file, `# Rule-generated feature hypotheses\n\n검색량, 방문자 수, 수익, 사용자 조사 수치는 수집하지 않았습니다. 제안은 공개 경로에서 만든 가설이며 기능 중복 및 저장소 구조를 검토한 뒤 결정해야 합니다.\n\n${rows}`, 'utf8');
  fs.writeFileSync(path.join(outputDir,'FEATURE_IDEAS.json'),JSON.stringify({generatedAt:new Date().toISOString(),source:'discovered public routes; no search volume or traffic data',candidates},null,2),'utf8');
  return file;
}
