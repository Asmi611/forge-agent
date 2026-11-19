/**
 * proposalOrder.ts -- the order in which files are reviewed: source files first,
 * then tests, then docs. Pure code (no VS Code), easy to unit test.
 */
export type ReviewGroup = 'source' | 'test' | 'doc';

const RANK: Record<ReviewGroup, number> = { source: 0, test: 1, doc: 2 };

export function groupOf(path: string): ReviewGroup {
  const p = path.toLowerCase();
  if (p.includes('test')) return 'test';
  if (/\.(md|rst|txt)$/.test(p)) return 'doc';
  return 'source';
}

/** Stable sort: source, then tests, then docs; alphabetical by path inside a group. */
export function sortForReview<T extends { path: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const byGroup = RANK[groupOf(a.path)] - RANK[groupOf(b.path)];
    return byGroup !== 0 ? byGroup : a.path.localeCompare(b.path);
  });
}
