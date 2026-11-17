/**
 * repoMap.ts -- a compact picture of the project's folders and files, small enough for a model.
 * Folders come first, then files; every folder shows how many files it holds. Noise is already
 * left out because the index never contains it. Pure code: it only reads the index.
 */
import { estimateTokens } from './budget';
import type { WorkspaceIndex } from './indexer';

export interface RepoMapResult { tree: string; truncated: boolean }

interface Node { name: string; dirs: Map<string, Node>; files: string[]; count: number }

function newNode(name: string): Node {
  return { name, dirs: new Map(), files: [], count: 0 };
}

/** Normalise "src/", "./src", "src\\x" to "src/x"; undefined if it tries to leave the project. */
export function cleanDir(dir: string | undefined): string | undefined {
  const parts = (dir ?? '').replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..') || /^[A-Za-z]:$/.test(parts[0] ?? '')) return undefined;
  return parts.join('/');
}

/** Draw the tree under `dir`, `depth` levels deep, in at most `maxTokens`. */
export function renderRepoMap(index: WorkspaceIndex, dir: string | undefined, depth: number | undefined, maxTokens: number): RepoMapResult {
  const base = cleanDir(dir);
  if (base === undefined) return { tree: '', truncated: false };
  const maxDepth = Math.min(Math.max(Math.floor(depth ?? 2), 1), 6);

  const root = newNode(base === '' ? '.' : base);
  const prefix = base === '' ? '' : `${base}/`;
  for (const path of [...index.files.keys()].sort()) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split('/');
    let node = root;
    node.count++;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) { next = newNode(part); node.dirs.set(part, next); }
      next.count++;
      node = next;
    }
    node.files.push(parts[parts.length - 1] ?? path);
  }
  if (root.count === 0) return { tree: '', truncated: false };

  const lines: string[] = [`${root.name}/ (${root.count} file${root.count === 1 ? '' : 's'})`];
  const walk = (node: Node, level: number): void => {
    const pad = '  '.repeat(level);
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`${pad}${d.name}/ (${d.count} file${d.count === 1 ? '' : 's'})`);
      if (level < maxDepth) walk(d, level + 1);
    }
    if (level <= maxDepth) for (const f of node.files.sort()) lines.push(`${pad}${f}`);
  };
  walk(root, 1);

  // Keep whole lines only, within the budget.
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (const line of lines) {
    const cost = estimateTokens(`${line}\n`);
    if (used + cost > maxTokens - 8) { truncated = true; break; }
    kept.push(line);
    used += cost;
  }
  if (truncated) kept.push('… (more not shown)');
  return { tree: kept.join('\n'), truncated };
}
