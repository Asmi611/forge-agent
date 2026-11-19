/**
 * emptyContext.ts -- a placeholder ContextProvider that finds nothing.
 * TEMPORARY: replaced by the real provider (index + ranker) in cards U-06/U-07.
 * It exists so the UiHost is complete (the contract requires `context`) before the ranker exists.
 */
import type { ContextProvider } from '../types/contract';

/** A ContextProvider whose every answer is empty. Never throws. */
export function createEmptyContext(): ContextProvider {
  return {
    resolveMention: async () => null,
    seed: async () => [],
    search: async () => ({ hits: [], omitted: 0 }),
    findSymbol: async () => ({ symbols: [] }),
    repoMap: async () => ({ tree: '', truncated: false }),
  };
}
