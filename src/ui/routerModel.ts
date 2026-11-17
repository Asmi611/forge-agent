/**
 * routerModel.ts -- plain-language wording and status text for the engine's events. No VS Code here.
 * Rule: users never see stack traces or raw error text; the raw text goes to the Output log only.
 */

export type StatusState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'retrying'; attempt: number; max: number }
  | { kind: 'reviewing'; files: number };

export const MAX_RETRIES = 3;

/** One wording for every error lives in friendlyErrors.ts; re-exported so the router and its tests share it. */
export { friendlyError } from './friendlyErrors';

export function statusLabel(state: StatusState, model: string): { text: string; tooltip: string; command: string } {
  const m = model ? ` · ${model}` : '';
  switch (state.kind) {
    case 'running': return { text: `$(sync~spin) Forge: working…${m}`, tooltip: 'Forge is working. Click to stop.', command: 'forge.stop' };
    case 'retrying': return { text: `$(sync~spin) Forge: retrying ${state.attempt}/${state.max}${m}`, tooltip: 'The model had a problem; Forge is trying again. Click to stop.', command: 'forge.stop' };
    case 'reviewing': return { text: `$(eye) Forge: ${state.files} file${state.files === 1 ? '' : 's'} to review${m}`, tooltip: 'Review each change in the diff, then use "Apply" at the bottom.', command: 'forge.reviewOpen' };
    default: return { text: `$(sparkle) Forge${m}`, tooltip: 'Click to ask Forge to do something.', command: 'forge.askAgent' };
  }
}
