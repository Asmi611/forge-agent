/** panelMessages.ts -- what the webview is allowed to ask the extension to do. Anything else is ignored. */
import type { HunkStatus } from '../../types/contract';

export type PanelRequest =
  | { type: 'ready' } | { type: 'send'; text: string } | { type: 'stop' } | { type: 'applyAccepted' } | { type: 'undo' }
  | { type: 'review'; proposalId: string }
  | { type: 'hunk'; proposalId: string; hunkId: string; status: HunkStatus }
  | { type: 'all'; status: HunkStatus; proposalId?: string }
  | { type: 'suggest'; q: string; seq: number };

const str = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
const status = (v: unknown): v is HunkStatus => v === 'accepted' || v === 'rejected' || v === 'pending';

export function parsePanelRequest(raw: unknown): PanelRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready': case 'stop': case 'applyAccepted': case 'undo': return { type: m.type };
    case 'send': return str(m.text) ? { type: 'send', text: m.text } : undefined;
    case 'review': return str(m.proposalId, 500) ? { type: 'review', proposalId: m.proposalId } : undefined;
    case 'hunk': return str(m.proposalId, 500) && str(m.hunkId, 100) && status(m.status) ? { type: 'hunk', proposalId: m.proposalId, hunkId: m.hunkId, status: m.status } : undefined;
    case 'all': return status(m.status) && (m.proposalId === undefined || str(m.proposalId, 500)) ? { type: 'all', status: m.status, ...(typeof m.proposalId === 'string' ? { proposalId: m.proposalId } : {}) } : undefined;
    case 'suggest': return str(m.q, 200) && typeof m.seq === 'number' ? { type: 'suggest', q: m.q, seq: m.seq } : undefined;
    default: return undefined;
  }
}

export interface Suggestion { label: string; detail: string; insert: string }

/** Up to `max` @mention suggestions: files first (name beats folder), then functions/classes. Pure, so it is tested. */
export function suggestMentions(files: Iterable<{ path: string; symbols: readonly { name: string; kind: string }[] }>, query: string, max = 8): Suggestion[] {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const scored: { s: Suggestion; score: number }[] = [];
  for (const f of files) {
    const base = f.path.slice(f.path.lastIndexOf('/') + 1).toLowerCase();
    const p = f.path.toLowerCase();
    let score = -1;
    if (q === '') score = 1;
    else if (base.startsWith(q)) score = 100 - Math.min(50, base.length);
    else if (base.includes(q)) score = 60;
    else if (p.includes(q)) score = 30;
    if (score >= 0) scored.push({ score, s: { label: f.path.slice(f.path.lastIndexOf('/') + 1), detail: f.path, insert: `@${f.path}` } });
    if (q.length >= 2) for (const sym of f.symbols) {
      const n = sym.name.toLowerCase();
      const sc = n.startsWith(q) ? 50 : n.includes(q) ? 20 : -1;
      if (sc >= 0) scored.push({ score: sc, s: { label: sym.name, detail: `${sym.kind} in ${f.path}`, insert: `@${sym.name}` } });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.s.detail.length - b.s.detail.length || a.s.detail.localeCompare(b.s.detail));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const { s } of scored) { if (seen.has(s.insert + s.detail)) continue; seen.add(s.insert + s.detail); out.push(s); if (out.length >= max) break; }
  return out;
}
