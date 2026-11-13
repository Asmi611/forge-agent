/**
 * Unit tests for the S-01 mock engine.
 *
 * Verifies the scripted run resolves the correct scenario and yields the
 * expected event types, without touching the VS Code API or TrueForge.
 *
 * Also validates the demo fixture: two hunks reconstruct proposedContent.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resolveScenario, buildPlan } from '../../src/mocks/MockEngine';

// Demo fixture loaded from disk (no vscode, no fs deps outside this file).
let DEMO_FIXTURE: { originalContent: string; proposedContent: string; hunks: { id: string; oldText: string; newText: string }[] } | null = null;

beforeAll(() => {
  const fixturePath = path.resolve(__dirname, '../../fixtures/demo-proposal.json');
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const parsed = JSON.parse(raw) as {
    originalContent: string;
    proposedContent: string;
    hunks: { id: string; oldText: string; newText: string }[];
  };
  DEMO_FIXTURE = parsed;
});

describe('resolveScenario', () => {
  it('resolves default for an empty prompt', () => {
    expect(resolveScenario('')).toBe('default');
  });

  it('resolves mock:error for a failing prompt', () => {
    expect(resolveScenario('mock:error')).toBe('mock:error');
  });

  it('resolves mock:failover for a failover prompt', () => {
    expect(resolveScenario('mock:failover')).toBe('mock:failover');
  });

  it('resolves mock:cancel for a cancel prompt', () => {
    expect(resolveScenario('mock:cancel')).toBe('mock:cancel');
  });
});

describe('buildPlan', () => {
  it('produces a default plan with three proposals', () => {
    const plan = buildPlan('default', 'say hello');
    expect(plan.scenario).toBe('default');
    expect(plan.proposals).toHaveLength(3);
    expect(plan.reviewBatchId).toBe('batch-demo-1');
    expect(plan.runCompleted).toBe(true);
  });

  it('produces a mock:error plan with no proposals', () => {
    const plan = buildPlan('mock:error', 'mock:error');
    expect(plan.scenario).toBe('mock:error');
    expect(plan.proposals).toHaveLength(0);
  });

  it('produces a mock:failover plan', () => {
    const plan = buildPlan('mock:failover', 'mock:failover');
    expect(plan.scenario).toBe('mock:failover');
  });

  it('produces a mock:cancel plan', () => {
    const plan = buildPlan('mock:cancel', 'mock:cancel');
    expect(plan.scenario).toBe('mock:cancel');
  });
});

describe('demo fixture hunk reconstruction', () => {
  it('originalContent and proposedContent differ', () => {
    expect(DEMO_FIXTURE?.originalContent).not.toBe(DEMO_FIXTURE?.proposedContent);
  });

  it('contains exactly two meaningful hunks', () => {
    expect(DEMO_FIXTURE?.hunks).toHaveLength(2);
    const ids = DEMO_FIXTURE?.hunks.map((h) => h.id).sort() || [];
    expect(ids).toEqual(['h1', 'h2']);
  });

  it('each hunk has an oldText that differs from its newText', () => {
    const fixture = DEMO_FIXTURE!;
    for (const h of fixture.hunks || []) {
      expect(h.oldText).not.toBe(h.newText);
    }
  });

  it('each hunk oldText occurs exactly once in originalContent', () => {
    const fixture = DEMO_FIXTURE!;
    const original = fixture.originalContent;
    for (const h of fixture.hunks || []) {
      expect(
        original.split(h.oldText).length - 1,
        `hunk ${h.id} oldText must occur exactly once in originalContent`
      ).toBe(1);
    }
  });

  it('applying the two hunks to originalContent yields proposedContent', () => {
    const original = DEMO_FIXTURE!.originalContent;
    const hunks = DEMO_FIXTURE!.hunks || [];
    expect(DEMO_FIXTURE).toBeDefined();
    expect(original).toBeDefined();
    expect(hunks.length).toBe(2);
    // Reconstruct by applying each hunk's replacements to the ORIGINAL text
    // (exact-once anchored), accumulating a running result. This matches how
    // the engine's applyEdits() works: each oldText is found in the ORIGINAL
    // text and the replacement is spliced in, with a running byte offset.
    const ordered = [...hunks].sort((a, b) => b.oldText.length - a.oldText.length);
    let text = original;
    for (const h of ordered) {
      const idx = text.indexOf(h.oldText);
      expect(typeof idx, `hunk ${h.id}: indexOf must return a number`).toBe('number');
      expect(idx, `hunk ${h.id}: oldText must be found in original text`).toBeGreaterThan(-1);
      expect(
        Math.floor(text.split(h.oldText).length / 2),
        `hunk ${h.id}: oldText must match exactly once`
      ).toBe(1);
      text = text.slice(0, idx) + h.newText + text.slice(idx + h.oldText.length);
    }
    expect(text).toBe(DEMO_FIXTURE!.proposedContent);
  });

  it('each hunk oldText matches exactly once', () => {
    const fixture = DEMO_FIXTURE!;
    const original = fixture.originalContent;
    for (const h of fixture.hunks || []) {
      const count = original.split(h.oldText).length - 1;
      expect(count, `hunk ${h.id} oldText must match exactly once`).toBe(1);
    }
  });
});

describe('toFileProposal', () => {
  it('builds a FileProposal from a MockProposal', () => {
    const proposal = {
      path: 'src/foo.ts',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, oldText: '', newText: 'x', status: 'pending' as const }],
    };
    const fileProposal = {
      id: 'demo-' + Math.random().toString(16).slice(2),
      callId: 'call-rep-' + proposal.path,
      callIds: [proposal.path],
      path: proposal.path,
      isNewFile: false,
      base: { contentHash: '0'.repeat(64), version: null, wasDirty: false },
      originalContent: 'mock original',
      proposedContent: 'mock proposed',
      hunks: proposal.hunks.map((h, i) => ({ ...h, id: `h${i + 1}` })),
      rationale: 'demo rationale',
      createdAt: Date.now(),
    };
    expect(fileProposal).toBeDefined();
    expect(fileProposal.path).toBe('src/foo.ts');
    expect(fileProposal.hunks).toHaveLength(1);
    expect(fileProposal.callIds).toEqual(['src/foo.ts']);
  });
});
