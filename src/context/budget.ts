/** budget.ts -- token estimates and "fit these items into a budget". Token estimate = characters / 4 (a documented limitation). */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface BudgetResult<T> { chosen: T[]; used: number; omitted: number }

/**
 * Take items in order (best first). An item that does not fit is skipped, but smaller items after it
 * may still fit. The total never exceeds `budgetTokens`.
 */
export function fitToBudget<T extends { tokens: number }>(items: readonly T[], budgetTokens: number): BudgetResult<T> {
  const chosen: T[] = [];
  let used = 0;
  for (const item of items) {
    if (item.tokens <= 0) continue;
    if (used + item.tokens <= budgetTokens) {
      chosen.push(item);
      used += item.tokens;
    }
  }
  return { chosen, used, omitted: items.length - chosen.length };
}
