import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getAiPolicy, requestModelApi } from '../apps/cli/src/ai-policy.js';
import { buildCodexPrompt } from '../apps/cli/src/codex-prompts.js';

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});

describe('zero-cost AI policy', () => {
  it('never enables model calls from API keys', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.PAID_AI_API_ENABLED = 'false';
    process.env.AI_API_BUDGET_USD = '0';
    process.env.AI_AUTO_EXECUTION = 'false';
    expect(getAiPolicy()).toEqual({ paidApiEnabled: false, budgetUsd: 0, autoExecution: false, codexInteractive: true });
    await expect(requestModelApi({ prompt: 'test' })).rejects.toThrow(/paid model APIs are disabled/i);
  });

  it('fails closed for unsafe paid execution settings', () => {
    expect(() => getAiPolicy({ PAID_AI_API_ENABLED: 'true', AI_API_BUDGET_USD: '1', AI_AUTO_EXECUTION: 'true' } as NodeJS.ProcessEnv)).toThrow(/prohibited/i);
  });

  it('generates a review prompt from evidence without invoking an AI model', () => {
    const prompt = buildCodexPrompt({ id: 'f1', service: 'calculator', url: 'https://www.woori.today/ko/calculators/percentage', locale: 'ko', agent: 'qa', severity: 'High', status: 'confirmed', title: 'Client error', description: 'Calculation crashed', evidence: 'pageerror reproduced' });
    expect(prompt).toContain('pageerror reproduced');
    expect(prompt).toContain('Do not modify production');
  });

  it('keeps model SDKs and provider endpoints out of runtime and CI configuration', () => {
    const root = process.cwd();
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const dependencyNames = [...Object.keys(packageJson.dependencies), ...Object.keys(packageJson.devDependencies)].join(' ').toLowerCase();
    expect(dependencyNames).not.toMatch(/openai|anthropic|google-genai|@google\/generative/);
    const source = fs.readdirSync(path.join(root, 'apps/cli/src')).filter(name => name.endsWith('.ts')).map(name => fs.readFileSync(path.join(root, 'apps/cli/src', name), 'utf8')).join('\n').toLowerCase();
    expect(source).not.toMatch(/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/);
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/scheduled-audit.yml'), 'utf8');
    expect(workflow).toMatch(/PAID_AI_API_ENABLED:\s*["']false["']/);
    expect(workflow).toMatch(/AI_API_BUDGET_USD:\s*["']0["']/);
    expect(workflow).toMatch(/AI_AUTO_EXECUTION:\s*["']false["']/);
  });
});
