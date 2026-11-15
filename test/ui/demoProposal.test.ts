import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { proposalFromFixture, type DemoFixture } from '../../src/review/demoProposal';
import { buildText } from '../../src/review/hunkText';
import { groupOf, sortForReview } from '../../src/review/proposalOrder';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'demo-proposal.json'), 'utf8')) as DemoFixture;

describe('proposalFromFixture (real demo fixture)', () => {
  const base = proposalFromFixture(fixture);
  const all = (s: 'accepted' | 'rejected') => ({ ...base, hunks: base.hunks.map((h) => ({ ...h, status: s })) });

  it('sorts hunks by position and keeps their ids', () => {
    expect(base.hunks.map((h) => [h.id, h.oldStart, h.oldLines, h.newLines])).toEqual([['h2', 4, 1, 2], ['h1', 8, 2, 3]]);
    expect(base.hunks.map((h) => h.newStart)).toEqual([4, 9]); // h1 moves down by the line h2 adds
  });
  it('all accepted == proposedContent, all rejected == original', () => {
    expect(buildText(all('accepted'), 'final').text).toBe(fixture.proposedContent);
    expect(buildText(all('rejected'), 'final').text).toBe(fixture.originalContent);
  });
  it('rejecting only h1 keeps the comment change but not the new button', () => {
    const p = { ...base, hunks: base.hunks.map((h) => ({ ...h, status: h.id === 'h1' ? ('rejected' as const) : ('accepted' as const) })) };
    const text = buildText(p, 'final').text;
    expect(text).toContain('// Verify the feature by running its tests.');
    expect(text).not.toContain('Decrement</button>');
  });
  it('refuses an oldText that does not match exactly once', () => {
    expect(() => proposalFromFixture({ ...fixture, hunks: [{ oldText: 'nope', newText: 'x' }] })).toThrow();
  });
});

describe('review order', () => {
  it('source first, then tests, then docs', () => {
    expect(groupOf('src/app.py')).toBe('source');
    expect(groupOf('tests/test_cli.py')).toBe('test');
    expect(groupOf('docs/cli.rst')).toBe('doc');
    const order = sortForReview([{ path: 'README.md' }, { path: 'tests/test_a.py' }, { path: 'src/b.py' }, { path: 'src/a.py' }]);
    expect(order.map((o) => o.path)).toEqual(['src/a.py', 'src/b.py', 'tests/test_a.py', 'README.md']);
  });
});
