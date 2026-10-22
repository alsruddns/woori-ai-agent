import fs from 'node:fs';
import path from 'node:path';
import type { Finding } from './core.js';

export function buildCodexPrompt(finding: Finding): string {
  return [
    `## ${finding.title}`,
    `- Service: ${finding.service}`,
    `- URL: ${finding.url}`,
    `- Locale: ${finding.locale}`,
    `- Severity: ${finding.severity}`,
    `- Evidence status: ${finding.status}`,
    `- Description: ${finding.description}`,
    `- Evidence: ${finding.evidence ?? 'No evidence was stored.'}`,
    '',
    'Review the referenced behavior using read-only inspection. Identify the responsible service repository and exact source location before proposing a change. Do not modify production, user data, or any service repository. Return a minimal fix proposal and a regression test.',
  ].join('\n');
}

export function writeCodexPrompts(findings: Finding[], outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, 'CODEX_PROMPTS.md');
  const content = findings.length
    ? `# Codex review prompts\n\n${findings.map(buildCodexPrompt).join('\n\n---\n\n')}\n`
    : '# Codex review prompts\n\nNo findings are available. Run a supported deterministic analysis first.\n';
  fs.writeFileSync(file, content, 'utf8');
  return file;
}
