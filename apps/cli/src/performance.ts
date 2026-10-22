import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initDb, serviceFor, localeFor, type FeatureResult, type Finding } from './core.js';

const execFileAsync = promisify(execFile);
type LighthouseReport = { categories: { performance: { score: number | null }; accessibility: { score: number | null } }; audits: Record<string, { numericValue?: number }> };

export async function runLighthouse(runId: string, urls: string[]) {
  const db = initDb();
  const features: FeatureResult[] = [];
  const findings: Finding[] = [];
  const date = new Date().toISOString().slice(0, 10);
  const runDir = path.join('reports', date, runId);
  const dir = path.join(runDir, 'performance');
  fs.mkdirSync(dir, { recursive: true });

  for (const url of urls.slice(0, 2)) {
    for (const strategy of ['mobile', 'desktop'] as const) {
      const started = Date.now();
      const report = path.join(dir, `${serviceFor(url).id}-${strategy}.json`);
      try {
        // Run Lighthouse in native Node. Loading its browser injection through tsx can mis-detect a bundled environment.
        await execFileAsync(process.execPath, [path.resolve('apps/cli/src/lighthouse-runner.mjs'), url, strategy, path.resolve(report)], { timeout: 180_000, maxBuffer: 1024 * 1024 });
        const lhr = JSON.parse(fs.readFileSync(report, 'utf8')) as LighthouseReport;
        const audits = lhr.audits;
        const score = Math.round((lhr.categories.performance.score ?? 0) * 100);
        const accessibility = Math.round((lhr.categories.accessibility.score ?? 0) * 100);
        const record = {
          url, strategy, performanceScore: score, accessibilityScore: accessibility,
          lcpMs: audits['largest-contentful-paint']?.numericValue ?? null,
          cls: audits['cumulative-layout-shift']?.numericValue ?? null,
          fcpMs: audits['first-contentful-paint']?.numericValue ?? null,
          tbtMs: audits['total-blocking-time']?.numericValue ?? null,
          dataType: 'lab',
        };
        const relative = path.relative(runDir, report).replaceAll('\\', '/');
        features.push({ runId, service: serviceFor(url).id, locale: localeFor(url), url, agent: 'performance', feature: `Lighthouse ${strategy}`, status: 'Passed', evidence: JSON.stringify(record), durationMs: Date.now() - started });
        db.prepare('INSERT INTO performance_metrics(run_id,service,url,strategy,lcp_ms,cls,fcp_ms,tbt_ms,performance_score,accessibility_score,report_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(runId, serviceFor(url).id, url, strategy, record.lcpMs, record.cls, record.fcpMs, record.tbtMs, score, accessibility, relative, new Date().toISOString());
        const previous = db.prepare('SELECT performance_score,lcp_ms FROM performance_metrics WHERE url=? AND strategy=? AND run_id<>? ORDER BY id DESC LIMIT 1').get(url, strategy, runId) as { performance_score: number; lcp_ms: number } | undefined;
        if (previous && ((previous.performance_score - score) >= 15 || (previous.lcp_ms > 0 && record.lcpMs !== null && record.lcpMs > previous.lcp_ms * 1.2))) {
          findings.push({ id: `${runId}-${strategy}-performance-regression`, service: serviceFor(url).id, url, locale: localeFor(url), agent: 'performance', severity: 'Medium', status: 'suspected', title: `Lighthouse ${strategy} regression suspected`, description: `Performance ${previous.performance_score} → ${score}; LCP ${previous.lcp_ms}ms → ${record.lcpMs}ms.`, evidence: relative });
          features[features.length - 1]!.status = 'Failed';
        }
      } catch (error) {
        features.push({ runId, service: serviceFor(url).id, locale: localeFor(url), url, agent: 'performance', feature: `Lighthouse ${strategy}`, status: 'Not Covered', reason: `Lighthouse could not complete: ${error instanceof Error ? error.message : String(error)}`, durationMs: Date.now() - started });
      }
    }
  }
  db.close();
  return { features, findings };
}
