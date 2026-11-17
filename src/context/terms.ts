/**
 * terms.ts -- turning text into search words, and a user's request into a query.
 * No project-specific words anywhere in src/context: only general language and code habits
 * (snake_case, camelCase, kebab-case, stop words, and the CATEGORIES test / doc / config / cli).
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'can', 'could',
  'should', 'would', 'will', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'not', 'but', 'you', 'your', 'our', 'all', 'any',
  'its', 'their', 'them', 'then', 'than', 'also', 'just', 'please', 'want', 'need', 'make', 'sure', 'some', 'there', 'here', 'does',
  'doing', 'done', 'about', 'over', 'out', 'off', 'too', 'very', 'let', 'like', 'such', 'only', 'each', 'other', 'more', 'most',
]);

/** "parseHTTPRequest" -> ["parse","http","request"]; "snake_case-name" -> ["snake","case","name"]. */
export function splitIdentifier(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** A very small stemmer, applied to BOTH the query and the index so they always agree. */
export function stem(word: string): string {
  const w = word;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** All index words of a text (identifier parts, lowercased, stemmed, at least 2 characters). */
export function indexWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
    if (raw === '') continue;
    for (const part of splitIdentifier(raw)) if (part.length >= 2) out.push(stem(part));
  }
  return out;
}

export type Intent = 'test' | 'doc' | 'config' | 'cli';

export interface QueryTerm { term: string; weight: number }
export interface QueryAnalysis { terms: QueryTerm[]; intents: Set<Intent> }

const INTENT_PATTERNS: [Intent, RegExp][] = [
  ['test', /\b(tests?|testing|specs?|unittests?|pytest)\b/i],
  ['doc', /\b(docs?|documentation|readme|guide|tutorial)\b/i],
  ['config', /\b(config|configuration|settings?|options)\b/i],
  ['cli', /\b(cli|commands?|terminal|argv|arguments)\b/i],
];

const INTENT_FILE_WORDS: Partial<Record<Intent, string[]>> = { cli: ['cli'], config: ['config'] };

/**
 * Analyse a request: lowercase words, identifier parts, no stop words, no words under 3 letters.
 * Quoted text and identifier-like tokens (snake_case, camelCase, name.ext) count double.
 */
export function analyzeQuery(prompt: string): QueryAnalysis {
  const weights = new Map<string, number>();
  const add = (word: string, weight: number): void => {
    if (word.length < 3 || STOPWORDS.has(word)) return;
    const s = stem(word);
    weights.set(s, Math.max(weights.get(s) ?? 0, weight));
  };

  const highValue: string[] = [];
  for (const m of prompt.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g)) highValue.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of prompt.matchAll(/[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+\.[A-Za-z]{2,4}\b/g)) highValue.push(m[0]);

  for (const raw of prompt.split(/[^A-Za-z0-9_]+/)) for (const part of splitIdentifier(raw)) add(part, 1);
  for (const text of highValue) for (const part of splitIdentifier(text)) add(part, 2);

  const intents = new Set<Intent>();
  for (const [intent, pattern] of INTENT_PATTERNS) if (pattern.test(prompt)) intents.add(intent);

  // A category also brings its usual file-name word: "command line" -> files called cli; "settings" -> files called config.
  // (By category only, never a project name.)
  for (const intent of intents) {
    for (const word of INTENT_FILE_WORDS[intent] ?? []) weights.set(word, Math.max(weights.get(word) ?? 0, 1.5));
  }

  const terms = [...weights.entries()].map(([term, weight]) => ({ term, weight })).sort((a, b) => a.term.localeCompare(b.term));
  return { terms, intents };
}
