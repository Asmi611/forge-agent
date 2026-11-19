/**
 * MCP Tool: searchWorkspace (Milestone E-04).
 *
 * Exposes text search across workspace documents with caps (20 hits, 160 chars preview)
 * and credential redaction per docs/01-ARCHITECTURE.md §3 and docs/03-SECURITY.md.
 */

import { z } from 'zod';
import {
  MAX_SEARCH_HITS,
  MAX_PREVIEW_CHARS,
  truncateSearchHits,
  truncatePreview,
  type ToolExecutionContext,
  type ToolCallResult,
} from '../limits.ts';
import { isSecretFile, redactSecrets } from '../secretGuard.ts';
import {
  RunBudget,
  DEDUPLICATION_NOTICE,
  LOW_BUDGET_WARNING,
  BUDGET_EXHAUSTED_MESSAGE,
} from '../../engine/budget.ts';

/** Tool name matching the frozen contract. */
export const SEARCH_WORKSPACE_TOOL_NAME = 'searchWorkspace';

/** Input schema for searchWorkspace tool. */
export const searchWorkspaceInputSchema = z.object({
  query: z.string().min(1).describe('Text query or pattern to search across workspace files'),
  glob: z.string().optional().describe('Optional glob filter (e.g. "*.ts", "src/**")'),
  maxResults: z.number().int().positive().optional().describe('Maximum number of matches (capped at 20)'),
});

/** Tool description conforming to two-line format with usage hint. */
export const SEARCH_WORKSPACE_TOOL_DESCRIPTION =
  'Search for text matches or patterns across workspace files.\nUse when locating functions, identifiers, usages, or configuration across the project.';

/**
 * Handles searchWorkspace tool execution.
 *
 * @param args - Tool arguments matching searchWorkspace schema
 * @param ctx - Tool execution context containing host and optional budget
 * @returns Tool result with text content
 */
export async function handleSearchWorkspace(
  args: z.infer<typeof searchWorkspaceInputSchema>,
  ctx: ToolExecutionContext
): Promise<ToolCallResult> {
  // 1. Refuse if budget is already exhausted
  if (ctx.budget?.isExhausted()) {
    return {
      content: [{ type: 'text', text: BUDGET_EXHAUSTED_MESSAGE }],
      isError: true,
    };
  }

  const query = args.query.trim();
  if (!query) {
    return {
      content: [{ type: 'text', text: 'Search query cannot be empty.' }],
      isError: true,
    };
  }

  // 2. Check deduplication
  const requestedMax = Math.min(args.maxResults ?? MAX_SEARCH_HITS, MAX_SEARCH_HITS);
  const queryKey = RunBudget.getSearchKey(query, args.glob, requestedMax);

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
  let rawHits: Array<{ path: string; line: number; preview: string }>;
  let rawOmitted = 0;

  try {
    const searchResult = await ctx.host.context.search({
      query,
      glob: args.glob,
      maxResults: requestedMax,
    });
    rawHits = searchResult.hits;
    rawOmitted = searchResult.omitted;
  } catch (err: unknown) {
    const message = (err as Error).message ?? String(err);
    return {
      content: [{ type: 'text', text: `Search execution failed: ${message}` }],
      isError: true,
    };
  }

  // 4. Filter out secret files from search hits
  const safeHits = rawHits.filter((hit) => !isSecretFile(hit.path));

  // 5. Apply limits: cap hits at MAX_SEARCH_HITS (20)
  const { hits: cappedHits, omitted: capOmitted } = truncateSearchHits(safeHits, MAX_SEARCH_HITS);
  const totalOmitted = rawOmitted + capOmitted;

  if (cappedHits.length === 0) {
    let emptyMsg = `No matches found for query '${query}'.`;
    if (ctx.budget?.isLow()) {
      emptyMsg = `${emptyMsg}\n\n[${LOW_BUDGET_WARNING}]`;
    }
    ctx.budget?.chargeText(emptyMsg);
    return {
      content: [{ type: 'text', text: emptyMsg }],
    };
  }

  // 6. Format lines with preview length limit and secret redaction
  const formattedLines: string[] = [];
  for (const hit of cappedHits) {
    const previewTruncated = truncatePreview(hit.preview, MAX_PREVIEW_CHARS);
    const redactedPreview = redactSecrets(previewTruncated);
    formattedLines.push(`${hit.path}:${hit.line}: ${redactedPreview}`);
  }

  if (totalOmitted > 0) {
    formattedLines.push(`... (${totalOmitted} more match(es) omitted)`);
  }

  let finalText = formattedLines.join('\n');

  // 7. Append low budget warning if threshold reached
  if (ctx.budget?.isLow()) {
    finalText = `${finalText}\n\n[${LOW_BUDGET_WARNING}]`;
  }

  // 8. Charge budget
  ctx.budget?.chargeText(finalText);

  return {
    content: [{ type: 'text', text: finalText }],
  };
}
