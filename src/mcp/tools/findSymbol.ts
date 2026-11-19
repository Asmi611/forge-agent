/**
 * MCP Tool: findSymbol (Milestone E-04).
 *
 * Exposes workspace symbol definition lookup capped at top 10 results
 * per docs/01-ARCHITECTURE.md §3.
 */

import { z } from 'zod';
import { type ToolExecutionContext, type ToolCallResult } from '../limits.ts';
import { isSecretFile } from '../secretGuard.ts';
import {
  DEDUPLICATION_NOTICE,
  LOW_BUDGET_WARNING,
  BUDGET_EXHAUSTED_MESSAGE,
} from '../../engine/budget.ts';

/** Tool name matching the frozen contract. */
export const FIND_SYMBOL_TOOL_NAME = 'findSymbol';

/** Maximum symbols returned per query. */
export const MAX_FIND_SYMBOLS = 10;

/** Input schema for findSymbol tool. */
export const findSymbolInputSchema = z.object({
  name: z.string().min(1).describe('Symbol name to look up in the workspace (classes, functions, types, etc.)'),
});

/** Tool description conforming to two-line format with usage hint. */
export const FIND_SYMBOL_TOOL_DESCRIPTION =
  'Find symbol definitions in workspace documents.\nUse when locating definitions of functions, classes, interfaces, or variables by name.';

/**
 * Handles findSymbol tool execution.
 *
 * @param args - Tool arguments matching findSymbol schema
 * @param ctx - Tool execution context containing host and optional budget
 * @returns Tool result with text content
 */
export async function handleFindSymbol(
  args: z.infer<typeof findSymbolInputSchema>,
  ctx: ToolExecutionContext
): Promise<ToolCallResult> {
  // 1. Refuse if budget is already exhausted
  if (ctx.budget?.isExhausted()) {
    return {
      content: [{ type: 'text', text: BUDGET_EXHAUSTED_MESSAGE }],
      isError: true,
    };
  }

  const name = args.name.trim();
  if (!name) {
    return {
      content: [{ type: 'text', text: 'Symbol name cannot be empty.' }],
      isError: true,
    };
  }

  // 2. Check deduplication
  const queryKey = `findSymbol:${name.toLowerCase()}`;
  if (ctx.budget) {
    const dedupe = ctx.budget.checkDeduplication(queryKey);
    if (dedupe.isDuplicate) {
      ctx.budget.chargeText(DEDUPLICATION_NOTICE);
      return {
        content: [{ type: 'text', text: DEDUPLICATION_NOTICE }],
      };
    }
  }

  // 3. Query host context provider
  let rawSymbols: Array<{ name: string; path: string; line: number; kind: string }>;
  try {
    const result = await ctx.host.context.findSymbol({ name });
    rawSymbols = result.symbols;
  } catch (err: unknown) {
    const message = (err as Error).message ?? String(err);
    return {
      content: [{ type: 'text', text: `Symbol lookup failed: ${message}` }],
      isError: true,
    };
  }

  // 4. Filter secret files
  const safeSymbols = rawSymbols.filter((sym) => !isSecretFile(sym.path));

  // 5. Cap at top 10 results
  const cappedSymbols = safeSymbols.slice(0, MAX_FIND_SYMBOLS);
  const omitted = safeSymbols.length - cappedSymbols.length;

  if (cappedSymbols.length === 0) {
    let emptyMsg = `No symbols found matching '${name}'.`;
    if (ctx.budget?.isLow()) {
      emptyMsg = `${emptyMsg}\n\n[${LOW_BUDGET_WARNING}]`;
    }
    ctx.budget?.chargeText(emptyMsg);
    return {
      content: [{ type: 'text', text: emptyMsg }],
    };
  }

  const lines = cappedSymbols.map(
    (sym) => `${sym.name} (${sym.kind}) at ${sym.path}:${sym.line}`
  );

  if (omitted > 0) {
    lines.push(`... (${omitted} more symbol(s) omitted)`);
  }

  let finalText = lines.join('\n');

  // 6. Append low budget warning if threshold reached
  if (ctx.budget?.isLow()) {
    finalText = `${finalText}\n\n[${LOW_BUDGET_WARNING}]`;
  }

  // 7. Charge budget
  ctx.budget?.chargeText(finalText);

  return {
    content: [{ type: 'text', text: finalText }],
  };
}
