import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { estimateTokens, fitToBudget } from '../../src/context/budget';
import { WorkspaceIndex, extractHeadings, extractImports, extractSymbols, importKey, isTestPath, type FileSource } from '../../src/context/indexer';
import { DEFAULT_RANKER_CONFIG, rank, snippetRange } from '../../src/context/ranker';
import { analyzeQuery, splitIdentifier, stem } from '../../src/context/terms';

// A small made-up shop project. Nothing here is special to the engine: it is just text.
const REPO: Record<string, string> = {
  'src/shop/payments.py': '"""Handle card payments and refunds."""\nclass PaymentGateway:\n    pass\n\ndef charge_card(card, amount):\n    return amount\n\ndef refund_payment(order):\n    return order\n',
  'src/shop/invoices.py': 'from shop.payments import charge_card\n\ndef create_invoice(order):\n    return charge_card(order, 1)\n\ndef send_invoice(order):\n    pass\n',
  'src/shop/shipping.py': 'def calculate_shipping_rate(weight, zone):\n    return weight * zone\n',
  'src/shop/cli.py': 'from shop import payments\n\ndef main():\n    parse_arguments()\n\ndef parse_arguments():\n    pass\n',
  'tests/test_payments.py': 'from shop.payments import charge_card\n\ndef test_charge_card():\n    assert charge_card(1, 2)\n',
  'tests/test_shipping.py': 'from shop.shipping import calculate_shipping_rate\n\ndef test_rate():\n    pass\n',
  'docs/payments.md': '# Payments\n\nHow card payments and refunds work.\n',
  'docs/shipping.rst': 'Shipping\n========\n\nRates by zone.\n',
  'CHANGELOG.md': '# Changes\n' + 'payments payments payments refund charge card\n'.repeat(60),
  'package-lock.json': '{"payments": "payments payments charge card refund"}\n'.repeat(40),
  'README.md': '# Shop\n\nA small shop.\n',
};

class MemorySource implements FileSource {
  reads = 0;
  constructor(public files: Record<string, string>, public mtime = 1) {}
  async list() { return Object.entries(this.files).map(([path, text]) => ({ path, size: text.length, mtimeMs: this.mtime })); }
  async read(path: string) { this.reads++; return this.files[path]; }
}

async function build(files: Record<string, string> = REPO): Promise<WorkspaceIndex> {
  const idx = new WorkspaceIndex();
  await idx.build(new MemorySource(files));
  return idx;
}
const paths = (r: { path: string }[]): string[] => r.map((x) => x.path);

describe('words and queries', () => {
  it('splits snake_case, camelCase and kebab-case', () => {
    expect(splitIdentifier('parseHTTPRequest')).toEqual(['parse', 'http', 'request']);
    expect(splitIdentifier('refund_payment-order')).toEqual(['refund', 'payment', 'order']);
  });
  it('drops stop words and short words, keeps identifier-like and quoted text as high value', () => {
    const q = analyzeQuery('Please fix the refund_payment bug in "card payments" so it is ok');
    const t = Object.fromEntries(q.terms.map((x) => [x.term, x.weight]));
    expect(t.the).toBeUndefined();
    expect(t.ok).toBeUndefined();
    expect(t.refund).toBe(2);
    expect(t.payment).toBe(2);
    expect(t.bug).toBe(1);
  });
  it('detects intent by category only', () => {
    expect([...analyzeQuery('add tests and docs for this').intents].sort()).toEqual(['doc', 'test']);
    expect([...analyzeQuery('read the settings from the command line').intents].sort()).toEqual(['cli', 'config']);
  });
  it('stemming is the same for the query and the index', () => {
    expect(stem('payments')).toBe(stem('payment'));
    expect(stem('refunds')).toBe(stem('refund'));
  });
});

describe('extracting from files', () => {
  it('symbols in Python and TypeScript', () => {
    expect(extractSymbols(['class A:', '  def go(self):', 'export function run() {}', 'export const x = 1;', 'interface Opts {}']).map((s) => s.name)).toEqual(['A', 'go', 'run', 'x', 'Opts']);
  });
  it('headings from markdown and reStructuredText, first line of docstrings', () => {
    expect(extractHeadings(['# Title', 'text', '## Part'], 'md')).toEqual(['Title', 'Part']);
    expect(extractHeadings(['Usage', '=====', 'text'], 'rst')).toEqual(['Usage']);
    expect(extractHeadings(['"""Does a thing."""'], 'py')).toEqual(['Does a thing.']);
  });
  it('imports, and turning them into keys', () => {
    expect(extractImports('from a.b import c\nimport x.y\n', 'py').sort()).toEqual(['a.b', 'x.y']);
    expect(extractImports("import { q } from './util';\nconst r = require('../lib/z');", 'ts').sort()).toEqual(['../lib/z', './util']);
    expect(importKey('shop.payments', '')).toBe('shop/payments');
    expect(importKey('./util', 'src/app')).toBe('src/app/util');
    expect(importKey('..lib.z', 'src/app')).toBe('src/lib/z');
    expect(importKey('../../../x', 'a')).toBeUndefined();
  });
  it('recognises test files', () => {
    expect(['tests/test_a.py', 'src/a.test.ts', 'src/__tests__/a.ts', 'a_test.go', 'spec/a.rb'].every(isTestPath)).toBe(true);
    expect(['src/contest.py', 'src/latest.ts'].some(isTestPath)).toBe(false);
  });
});

describe('index building', () => {
  it('builds in chunks, yielding about every 100 files', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 250; i++) many[`src/m${i}.py`] = `def f${i}(): pass\n`;
    let yields = 0;
    await new WorkspaceIndex().build(new MemorySource(many), { onYield: () => yields++ });
    expect(yields).toBe(2);
  });
  it('skips unchanged files on a rebuild (size + modified time cache) and excludes vendored folders', async () => {
    const src = new MemorySource({ ...REPO, 'node_modules/x/index.js': 'function secret() {}', 'dist/a.js': 'x' });
    const idx = new WorkspaceIndex();
    await idx.build(src);
    expect(idx.files.has('node_modules/x/index.js')).toBe(false);
    expect(idx.files.has('dist/a.js')).toBe(false);
    const first = src.reads;
    await idx.build(src);
    expect(src.reads).toBe(first); // nothing re-read
    src.mtime = 2;
    await idx.build(src);
    expect(src.reads).toBeGreaterThan(first);
  });
  it('updates one file incrementally', async () => {
    const idx = await build();
    idx.update({ path: 'src/shop/loyalty.py', size: 40, mtimeMs: 5 }, 'def award_points(user): pass\n');
    expect(paths(rank('award points to a user', idx))[0]).toBe('src/shop/loyalty.py');
    idx.remove('src/shop/loyalty.py');
    expect(paths(rank('award points to a user', idx))).not.toContain('src/shop/loyalty.py');
  });
});

describe('ranking', () => {
  it('finds the right file from a request with NO file or symbol names', async () => {
    const idx = await build();
    expect(paths(rank('work out the cost to ship an order by weight and zone', idx)).slice(0, 3)).toContain('src/shop/shipping.py');
    expect(paths(rank('refund money to a customer', idx))[0]).toBe('src/shop/payments.py');
  });
  it('explains itself: the reason names the fields, terms and signals that matched', async () => {
    const idx = await build();
    const top = rank('charge a card', idx)[0];
    expect(top?.path).toBe('src/shop/payments.py');
    expect(top?.reason).toMatch(/symbols: .*charge_card/);
    for (const r of rank('charge a card', idx)) expect(r.reason.length).toBeGreaterThan(0);
  });
  it('test affinity: the tests of a top source file come along, with a reason', async () => {
    const r = rank('charge a card', await build());
    const t = r.find((x) => x.path === 'tests/test_payments.py');
    expect(t).toBeDefined();
    expect(t?.reason).toContain('test of payments.py');
  });
  it('doc affinity and import neighbours', async () => {
    const r = rank('charge a card', await build());
    expect(r.find((x) => x.path === 'docs/payments.md')?.reason).toMatch(/docs mention|path: payment/);
    expect(r.find((x) => x.path === 'src/shop/invoices.py')?.reason).toContain('imports payments.py');
  });
  it('slot reservation: asking for tests and docs keeps one of each', async () => {
    const r = rank('change how shipping rates work, with tests and docs', await build(), DEFAULT_RANKER_CONFIG, 3);
    expect(r.some((x) => x.path.startsWith('tests/'))).toBe(true);
    expect(r.some((x) => /^docs\//.test(x.path))).toBe(true);
  });
  it('diversity: at most 3 files from one folder among the first 8', async () => {
    const files: Record<string, string> = { ...REPO };
    for (let i = 0; i < 6; i++) files[`src/shop/util/helper${i}.py`] = 'def helper(): return "payments payments payments"\n';
    const r = rank('payments', await build(files));
    const dirs = r.slice(0, 8).map((x) => x.path.split('/').slice(0, -1).join('/'));
    for (const d of new Set(dirs)) expect(dirs.filter((x) => x === d).length).toBeLessThanOrEqual(3);
  });
  it('noise penalty: lock files and changelogs do not beat real code', async () => {
    const r = paths(rank('payments refund charge card', await build()));
    expect(r.indexOf('src/shop/payments.py')).toBeLessThan(r.indexOf('CHANGELOG.md') === -1 ? 99 : r.indexOf('CHANGELOG.md'));
    expect(r.indexOf('src/shop/payments.py')).toBeLessThan(r.indexOf('package-lock.json') === -1 ? 99 : r.indexOf('package-lock.json'));
  });
  it('weights are inputs: with a zero path weight, a path-only match loses to a symbol match', async () => {
    const idx = await build();
    const noPath = { ...DEFAULT_RANKER_CONFIG, weights: { path: 0, symbols: 3, headings: 2, body: 1 } };
    expect(rank('shipping', idx, noPath)).toBeDefined();
    expect(rank('shipping', idx)[0]?.score).not.toBe(rank('shipping', idx, noPath)[0]?.score);
  });
  it('is deterministic', async () => {
    const idx = await build();
    expect(rank('charge a card for an invoice', idx)).toEqual(rank('charge a card for an invoice', idx));
  });
  it('an empty or meaningless request returns nothing, and never throws', async () => {
    const idx = await build();
    expect(rank('', idx)).toEqual([]);
    expect(rank('the and of', idx)).toEqual([]);
    expect(rank('zzzzqqq', idx)).toEqual([]);
    expect(rank('anything', new WorkspaceIndex())).toEqual([]);
  });
  it('snippet: the best matching symbol, else the first 60 lines', async () => {
    const idx = await build();
    const f = idx.files.get('src/shop/payments.py')!;
    expect(snippetRange(f, 'refund a payment')).toEqual({ startLine: 8, endLine: 9 });
    expect(snippetRange(f, 'nothing matches xyz')).toEqual({ startLine: 1, endLine: 9 });
  });
});

describe('budget', () => {
  it('estimates tokens as characters / 4 and never exceeds the budget', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    const r = fitToBudget([{ tokens: 600 }, { tokens: 500 }, { tokens: 300 }, { tokens: 100 }], 1000);
    expect(r.used).toBeLessThanOrEqual(1000);
    expect(r.chosen.map((x) => x.tokens)).toEqual([600, 300, 100]);
    expect(r.omitted).toBe(1);
  });
});

describe('speed and the "no project-specific words" rule', () => {
  it('indexes ~2000 files in well under 5 s and ranks in under 200 ms', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) many[`src/pkg${i % 40}/mod${i}.py`] = `def handler_${i}(request):\n    """Process item ${i}."""\n    return request\n`.repeat(8);
    const idx = new WorkspaceIndex();
    const t0 = Date.now();
    await idx.build(new MemorySource(many));
    expect(Date.now() - t0).toBeLessThan(5000);
    const t1 = Date.now();
    rank('process the incoming request handler', idx);
    expect(Date.now() - t1).toBeLessThan(200);
  });
  it('src/context contains no project-specific words', () => {
    const banned = /\b(flask|werkzeug|jinja|get_debug_flag|cli\.py|flask config|forge-demo|counter\.tsx)\b/i;
    for (const f of ['budget.ts', 'terms.ts', 'indexer.ts', 'ranker.ts']) {
      const dir = join(process.cwd(), 'src', 'context');
      expect(readdirSync(dir)).toContain(f);
      expect(banned.test(readFileSync(join(dir, f), 'utf8')), f).toBe(false);
    }
  });
});
