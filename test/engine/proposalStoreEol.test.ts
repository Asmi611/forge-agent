/**
 * test/engine/proposalStoreEol.test.ts
 *
 * Permanent regression tests for CRLF, LF, and mixed-EOL handling across:
 * - ProposalStore.createProposal (stripping \r from diff hunk lines)
 * - applyEdits
 * - buildText (src/review/hunkText.ts)
 * - applyProposals (src/review/applyCore.ts)
 */

import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/engine/applyEdits.ts';
import { ProposalStore } from '../../src/engine/ProposalStore.ts';
import { buildText } from '../../src/review/hunkText.ts';
import {
  applyProposals,
  hashText,
  type WorkspaceOps,
} from '../../src/review/applyCore.ts';
import type { BaseSnapshot, FileProposal } from '../../src/types/contract.ts';

const dummyBase: BaseSnapshot = {
  contentHash: 'hash-base',
  version: 1,
  wasDirty: false,
};

describe('ProposalStore and Review EOL handling', () => {
  const excerptLf = `if t.TYPE_CHECKING:  # pragma: no cover
    from .wrappers import Response


def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no"})


def get_load_dotenv(default: bool = True) -> bool:
`;

  const crlfOriginal = excerptLf.replace(/\r?\n/g, '\r\n');

  const oldText = [
    'def get_debug_flag() -> bool:',
    '    """Get whether debug mode should be enabled for the app, indicated by the',
    '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
    '    """',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    return bool(val and val.lower() not in {"0", "false", "no"})',
  ].join('\n');

  const newText = [
    'def get_debug_flag() -> bool:',
    '    """Get whether debug mode should be enabled for the app, indicated by the',
    '    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
    '',
    '    The values ``"0"``, ``"false"``, ``"no"``, ``"off"``, and ``"n"`` (case-insensitive)',
    '    are treated as ``False``.',
    '    """',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
  ].join('\n');

  const expectedFinalLf = `if t.TYPE_CHECKING:  # pragma: no cover
    from .wrappers import Response


def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.

    The values \`\`"0"\`\`, \`\`"false"\`\`, \`\`"no"\`\`, \`\`"off"\`\`, and \`\`"n"\`\` (case-insensitive)
    are treated as \`\`False\`\`.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})


def get_load_dotenv(default: bool = True) -> bool:
`;

  const expectedFinalCrlf = expectedFinalLf.replace(/\r?\n/g, '\r\n');

  it('applies CRLF proposals end-to-end without \\r\\r\\n and succeeds in applyProposals', async () => {
    const applyRes = applyEdits(crlfOriginal, [{ oldText, newText }]);
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;

    expect(applyRes.text).toBe(expectedFinalCrlf);

    const store = new ProposalStore();
    const createRes = store.createProposal({
      callId: 'call-crlf-1',
      path: 'src/flask/helpers.py',
      base: {
        contentHash: hashText(crlfOriginal),
        version: 1,
        wasDirty: false,
      },
      originalContent: crlfOriginal,
      proposedContent: applyRes.text,
      rationale: 'support extra falsy values in FLASK_DEBUG',
    });

    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const proposal: FileProposal = createRes.proposal;
    expect(proposal.hunks.length).toBe(2);

    // Verify hunks do not contain stray \\r
    for (const h of proposal.hunks) {
      expect(h.oldText.includes('\r')).toBe(false);
      expect(h.newText.includes('\r')).toBe(false);
      h.status = 'accepted';
    }

    const built = buildText(proposal, 'final');
    expect(built.text.includes('\r\r\n')).toBe(false);
    expect(built.text).toBe(expectedFinalCrlf);

    // Simulated VS Code document with CRLF line endings
    let docText = crlfOriginal;
    let diskText = crlfOriginal;

    const fakeOps: WorkspaceOps = {
      async readCurrent(_p: string) {
        return { exists: true, text: docText, isDirty: docText !== diskText };
      },
      async readDisk(_p: string) {
        return diskText;
      },
      async applyEdit(changes) {
        for (const c of changes) {
          if (c.kind === 'replace') {
            docText = c.text.replace(/\r/g, '').replace(/\n/g, '\r\n');
          }
        }
        return true;
      },
      async save(_p: string) {
        diskText = docText;
        return true;
      },
      async persistRecovery() {
        return '/mock/storage/recovery.json';
      },
    };

    const outcome = await applyProposals(fakeOps, [proposal], 'apply-crlf-test');
    expect(outcome.results[0].applied).toBe(true);
    expect(outcome.results[0].failure).toBeUndefined();
    expect(docText).toBe(expectedFinalCrlf);
    expect(diskText).toBe(expectedFinalCrlf);
  });

  it('applies LF proposals end-to-end with unchanged behavior', async () => {
    const applyRes = applyEdits(excerptLf, [{ oldText, newText }]);
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;

    expect(applyRes.text).toBe(expectedFinalLf);

    const store = new ProposalStore();
    const createRes = store.createProposal({
      callId: 'call-lf-1',
      path: 'src/flask/helpers.py',
      base: {
        contentHash: hashText(excerptLf),
        version: 1,
        wasDirty: false,
      },
      originalContent: excerptLf,
      proposedContent: applyRes.text,
      rationale: 'support extra falsy values in FLASK_DEBUG',
    });

    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const proposal: FileProposal = createRes.proposal;
    for (const h of proposal.hunks) {
      expect(h.oldText.includes('\r')).toBe(false);
      expect(h.newText.includes('\r')).toBe(false);
      h.status = 'accepted';
    }

    const built = buildText(proposal, 'final');
    expect(built.text).toBe(expectedFinalLf);

    let docText = excerptLf;
    let diskText = excerptLf;

    const fakeOps: WorkspaceOps = {
      async readCurrent(_p: string) {
        return { exists: true, text: docText, isDirty: docText !== diskText };
      },
      async readDisk(_p: string) {
        return diskText;
      },
      async applyEdit(changes) {
        for (const c of changes) {
          if (c.kind === 'replace') {
            docText = c.text;
          }
        }
        return true;
      },
      async save(_p: string) {
        diskText = docText;
        return true;
      },
      async persistRecovery() {
        return '/mock/storage/recovery.json';
      },
    };

    const outcome = await applyProposals(fakeOps, [proposal], 'apply-lf-test');
    expect(outcome.results[0].applied).toBe(true);
    expect(outcome.results[0].failure).toBeUndefined();
    expect(docText).toBe(expectedFinalLf);
    expect(diskText).toBe(expectedFinalLf);
  });

  it('preserves the invariant that proposedContent equals original with ALL hunks applied for LF and CRLF', () => {
    const store = new ProposalStore();

    // LF invariant
    const lfRes = store.createProposal({
      callId: 'call-inv-lf',
      path: 'test.py',
      base: dummyBase,
      originalContent: excerptLf,
      proposedContent: expectedFinalLf,
      rationale: 'LF invariant',
    });
    expect(lfRes.ok).toBe(true);
    if (!lfRes.ok) return;
    for (const h of lfRes.proposal.hunks) h.status = 'accepted';
    expect(buildText(lfRes.proposal, 'final').text).toBe(expectedFinalLf);

    // CRLF invariant
    const crlfRes = store.createProposal({
      callId: 'call-inv-crlf',
      path: 'test.py',
      base: dummyBase,
      originalContent: crlfOriginal,
      proposedContent: expectedFinalCrlf,
      rationale: 'CRLF invariant',
    });
    expect(crlfRes.ok).toBe(true);
    if (!crlfRes.ok) return;
    for (const h of crlfRes.proposal.hunks) h.status = 'accepted';
    expect(buildText(crlfRes.proposal, 'final').text).toBe(expectedFinalCrlf);
  });

  it('maintains byte-identity of untouched lines in mixed CRLF/LF files and tests edited lines behavior', () => {
    // A file with mixed line endings:
    // Line 1: CRLF
    // Line 2: LF
    // Line 3: CRLF
    // Line 4: LF
    // Line 5: CRLF
    const mixedOriginal = 'line1\r\nline2\nline3\r\nline4\nline5\r\n';

    // 1. Edit a CRLF region (line3)
    const applyRes1 = applyEdits(mixedOriginal, [
      { oldText: 'line3', newText: 'line3_mod\nline3_add' },
    ]);
    expect(applyRes1.ok).toBe(true);
    if (!applyRes1.ok) return;

    const store = new ProposalStore();
    const createRes1 = store.createProposal({
      callId: 'call-mixed-1',
      path: 'mixed.txt',
      base: dummyBase,
      originalContent: mixedOriginal,
      proposedContent: applyRes1.text,
      rationale: 'edit CRLF region',
    });
    expect(createRes1.ok).toBe(true);
    if (!createRes1.ok) return;

    for (const h of createRes1.proposal.hunks) h.status = 'accepted';
    const built1 = buildText(createRes1.proposal, 'final');

    // Invariant holds:
    expect(built1.text).toBe(applyRes1.text);

    // Untouched lines remain 100% byte-identical:
    expect(built1.text.startsWith('line1\r\nline2\n')).toBe(true);
    expect(built1.text.endsWith('\nline4\nline5\r\n')).toBe(true);

    // Edited lines adopted CRLF because line 3 was CRLF:
    expect(built1.text).toContain('line3_mod\r\nline3_add\r\n');

    // 2. Edit an LF region (line2\n)
    const applyRes2 = applyEdits(mixedOriginal, [
      { oldText: 'line2\n', newText: 'line2_mod\nline2_add\n' },
    ]);
    expect(applyRes2.ok).toBe(true);
    if (!applyRes2.ok) return;

    const createRes2 = store.createProposal({
      callId: 'call-mixed-2',
      path: 'mixed.txt',
      base: dummyBase,
      originalContent: mixedOriginal,
      proposedContent: applyRes2.text,
      rationale: 'edit LF region',
    });
    expect(createRes2.ok).toBe(true);
    if (!createRes2.ok) return;

    for (const h of createRes2.proposal.hunks) h.status = 'accepted';
    const built2 = buildText(createRes2.proposal, 'final');

    // Invariant holds:
    expect(built2.text).toBe(applyRes2.text);

    // Untouched lines remain 100% byte-identical:
    expect(built2.text.startsWith('line1\r\n')).toBe(true);
    expect(built2.text.endsWith('\nline3\r\nline4\nline5\r\n')).toBe(true);

    // Edited lines adopted LF because line 2 was LF:
    expect(built2.text).toContain('line2_mod\nline2_add\n');

    // 3. Single-line edit without trailing newline on an LF line in a dominantly-CRLF file
    const applyRes3 = applyEdits(mixedOriginal, [
      { oldText: 'line2', newText: 'line2_mod\nline2_add' },
    ]);
    expect(applyRes3.ok).toBe(true);
    if (!applyRes3.ok) return;

    const createRes3 = store.createProposal({
      callId: 'call-mixed-3',
      path: 'mixed.txt',
      base: dummyBase,
      originalContent: mixedOriginal,
      proposedContent: applyRes3.text,
      rationale: 'single line edit without newline',
    });
    expect(createRes3.ok).toBe(true);
    if (!createRes3.ok) return;

    for (const h of createRes3.proposal.hunks) h.status = 'accepted';
    const built3 = buildText(createRes3.proposal, 'final');

    // Untouched lines remain 100% byte-identical:
    expect(built3.text.startsWith('line1\r\n')).toBe(true);
    expect(built3.text.endsWith('\nline3\r\nline4\nline5\r\n')).toBe(true);

    // Edited lines: buildText picks the EOL of the replaced line (line2 had LF),
    // so new lines receive LF:
    expect(built3.text).toContain('line2_mod\nline2_add\n');
  });

  it('rejecting a hunk in a CRLF proposal restores original CRLF lines cleanly without corruption', () => {
    const applyRes = applyEdits(crlfOriginal, [{ oldText, newText }]);
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;

    const store = new ProposalStore();
    const createRes = store.createProposal({
      callId: 'call-crlf-partial',
      path: 'src/flask/helpers.py',
      base: dummyBase,
      originalContent: crlfOriginal,
      proposedContent: applyRes.text,
      rationale: 'partial acceptance',
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const proposal = createRes.proposal;
    expect(proposal.hunks.length).toBe(2);

    // Accept hunk 1, reject hunk 2
    proposal.hunks[0].status = 'accepted';
    proposal.hunks[1].status = 'rejected';

    const built = buildText(proposal, 'final');
    expect(built.text.includes('\r\r\n')).toBe(false);

    // The rejected hunk 2 keeps the original return line with clean CRLF
    expect(built.text).toContain('return bool(val and val.lower() not in {"0", "false", "no"})\r\n');
    // The accepted hunk 1 has the docstring additions with clean CRLF
    expect(built.text).toContain('The values ``"0"``, ``"false"``, ``"no"``, ``"off"``, and ``"n"`` (case-insensitive)\r\n');
  });
});
