/**
 * Paid model APIs are intentionally unsupported. This is a code-level guard:
 * credentials in the environment never enable model traffic.
 */
export type AiPolicy = { paidApiEnabled: false; budgetUsd: 0; autoExecution: false; codexInteractive: true };

export function getAiPolicy(env: NodeJS.ProcessEnv = process.env): AiPolicy {
  // Reject unsafe settings instead of silently treating them as permission.
  if (env.PAID_AI_API_ENABLED === 'true' || Number(env.AI_API_BUDGET_USD ?? '0') !== 0 || env.AI_AUTO_EXECUTION === 'true') {
    throw new Error('Paid AI execution is prohibited. Set PAID_AI_API_ENABLED=false, AI_API_BUDGET_USD=0, AI_AUTO_EXECUTION=false.');
  }
  return { paidApiEnabled: false, budgetUsd: 0, autoExecution: false, codexInteractive: true };
}

/** Deliberate fail-closed entry point for any future model integration. */
export async function requestModelApi(input: unknown): Promise<never> {
  void input;
  throw new Error('Not Configured: paid model APIs are disabled by the project zero-cost policy. Use a user-run Codex session.');
}

export function assertNoPaidAiApi(env: NodeJS.ProcessEnv = process.env): void {
  getAiPolicy(env);
}
