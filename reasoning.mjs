const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);

/**
 * Convert Anthropic thinking budgets to the effort values accepted by CC.
 * Keep the thresholds monotonic so larger budgets never reduce the effort.
 */
export function mapAnthropicThinkingToReasoningEffort(thinking) {
  if (!thinking || typeof thinking !== 'object') return undefined;

  if (thinking.type === 'disabled' || thinking.type === 'none') return undefined;
  if (thinking.type === 'adaptive') return thinking.effort ?? 'medium';
  if (thinking.budget_tokens === undefined) return undefined;

  const budgetTokens = Number(thinking.budget_tokens);
  if (budgetTokens >= 16_000) return 'max';
  if (budgetTokens >= 10_000) return 'high';
  if (budgetTokens >= 5_000) return 'medium';
  return REASONING_EFFORTS[0];
}
