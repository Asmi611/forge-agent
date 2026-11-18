/**
 * friendlyErrors.ts -- turns an engine error into one plain sentence for a notification.
 * Never shows a stack trace or raw error text (that goes to the Output channel only).
 */
import type { ForgeError } from '../types/contract';

/** One short, plain-language message for the user. `appliedAny` adds a reminder that saved changes can be undone. */
export function friendlyError(error: ForgeError, appliedAny = false): string {
  const detail = error.message.trim();
  let text: string;
  switch (error.kind) {
    case 'unreachable':
      text = 'Forge could not reach TrueForge. Check that TrueForge is running, then try again.';
      break;
    case 'auth':
      text = 'The AI model did not accept its key. Check the key in TrueForge, then try again.';
      break;
    case 'rate_limit':
      text = 'The AI model is busy right now (too many requests). Wait a minute and try again.';
      break;
    case 'model':
      text = 'The AI model had a problem. Try again in a moment.';
      break;
    case 'timeout':
      text = 'The AI model took too long to answer. Try again.';
      break;
    case 'busy':
      text = 'Forge is already working on another request. Stop it or wait for it to finish.';
      break;
    case 'policy':
      text = `Forge stopped because of a safety rule. ${detail}`.trim();
      break;
    case 'stale':
      text = `A file changed while Forge was working, so Forge left it alone. ${detail}`.trim();
      break;
    case 'budget':
      text = 'This request got too big for Forge to handle. Try a smaller request, or @mention the files you mean.';
      break;
    case 'stuck':
      text = 'Forge started repeating itself and stopped. Try asking in different words.';
      break;
    default:
      text = 'Something went wrong. Try again.';
  }
  return appliedAny
    ? `Forge: ${text} Changes you already saved are kept; use "Undo last save" to take them back.`
    : `Forge: ${text} Nothing was changed.`;
}
