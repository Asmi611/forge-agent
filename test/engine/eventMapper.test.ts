import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '../../src/types/contract.ts';
import {
  createEventMapperState,
  mapRawEvent,
  mapTerminal,
  inferToolResult,
  type PauseInfo,
  type TerminalResult,
} from '../../src/engine/eventMapper.ts';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/events');

describe('Milestone E-02: DeltaMerger and eventMapper', () => {
  describe('Tool-call finalization and argument chunking', () => {
    it('does not finalize tool calls on valid JSON alone until finish_reason arrives', () => {
      const state = createEventMapperState();

      // Delta 1: tool declaration with incomplete JSON args
      const r1 = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_1',
            thread_id: 'main',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'proposeEdit', arguments: '{"path": "a.txt",' },
              },
            ],
          },
        },
        state
      );
      expect(r1.events).toEqual([]);

      // Delta 2: arguments complete and parse as valid JSON, but finish_reason has NOT arrived
      const r2 = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_1',
            thread_id: 'main',
            tool_calls: [
              {
                index: 0,
                function: { arguments: ' "edits": []}' },
              },
            ],
          },
        },
        state
      );
      // Valid JSON alone must NOT emit tool.call
      expect(r2.events).toEqual([]);

      // Delta 3: finish_reason arrives -> tool.call is now finalized and emitted
      const r3 = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_1',
            thread_id: 'main',
            finish_reason: 'tool_calls',
          },
        },
        state
      );
      expect(r3.events).toEqual([
        {
          type: 'tool.call',
          callId: 'call_1',
          tool: 'proposeEdit',
          args: { path: 'a.txt', edits: [] },
          thread: 'main',
        },
      ]);

      // Delta 4: repeated delta after completion does NOT emit duplicate tool.call
      const r4 = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_1',
            thread_id: 'main',
            finish_reason: 'tool_calls',
          },
        },
        state
      );
      expect(r4.events).toEqual([]);
    });

    it('handles empty arguments with finish_reason defaulting to empty object', () => {
      const state = createEventMapperState();

      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_no_args',
            thread_id: 'main',
            tool_calls: [
              {
                index: 0,
                id: 'call_no_args',
                type: 'function',
                function: { name: 'repoMap', arguments: '' },
              },
            ],
          },
        },
        state
      );

      const r = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_no_args',
            thread_id: 'main',
            finish_reason: 'tool_calls',
          },
        },
        state
      );

      expect(r.events).toEqual([
        {
          type: 'tool.call',
          callId: 'call_no_args',
          tool: 'repoMap',
          args: {},
          thread: 'main',
        },
      ]);
    });
  });

  describe('Turn-stream sequence tracking across all event types', () => {
    it('tracks sequence numbers across non-delta events and buffers out-of-order model.message', () => {
      const state = createEventMapperState();

      // Seq 1: turn.created
      const r1 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: { type: 'turn.created', id: 't1' },
        },
        state
      );
      expect(r1.events).toEqual([]);

      // Seq 3: delta arrives before Seq 2 (model.message) -> buffered!
      const r3 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 3,
          data: {
            type: 'model.message.delta',
            id: 'msg_stream',
            content: 'streamed text',
          },
        },
        state
      );
      expect(r3.events).toEqual([]);

      // Seq 2: model.message arrives -> drains Seq 2 and Seq 3 in order!
      const r2 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 2,
          data: {
            type: 'model.message',
            id: 'msg_stream',
            thread_id: 'main',
          },
        },
        state
      );
      expect(r2.events).toEqual([{ type: 'token', text: 'streamed text' }]);
    });

    it('preserves arrival order immediately for unsequenced events', () => {
      const state = createEventMapperState();

      const r1 = mapRawEvent(
        {
          event: 'message',
          data: { type: 'model.message.delta', id: 'm1', content: 'alpha' },
        },
        state
      );
      const r2 = mapRawEvent(
        {
          event: 'message',
          data: { type: 'model.message.delta', id: 'm1', content: ' beta' },
        },
        state
      );

      expect(r1.events).toEqual([{ type: 'token', text: 'alpha' }]);
      expect(r2.events).toEqual([{ type: 'token', text: ' beta' }]);
    });

    it('ignores duplicate turn-stream sequence numbers', () => {
      const state = createEventMapperState();

      const r1 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 5,
          data: { type: 'model.message.delta', id: 'm_dup', content: 'once' },
        },
        state
      );
      expect(r1.events).toEqual([{ type: 'token', text: 'once' }]);

      // Duplicate seq 5
      const rDup = mapRawEvent(
        {
          event: 'message',
          sequence_number: 5,
          data: { type: 'model.message.delta', id: 'm_dup', content: 'once' },
        },
        state
      );
      expect(rDup.events).toEqual([]);
    });

    it('detects unresolved gap at turn.done and invalidates all unfinished messages/calls', () => {
      const state = createEventMapperState();

      // Seq 1: delta with tool call declaration
      mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: {
            type: 'model.message.delta',
            id: 'msg_unfin',
            tool_calls: [
              {
                index: 0,
                id: 'call_broken',
                function: { name: 'runCommand', arguments: '{"file":' },
              },
            ],
          },
        },
        state
      );

      // Turn.done arrives at Seq 3 (Seq 2 was lost)
      const rDone = mapRawEvent(
        {
          event: 'message',
          sequence_number: 3,
          data: {
            type: 'turn.done',
            id: 'td_1',
            state: { status: 'done', output: {} },
          },
        },
        state
      );

      // Explicit gap condition emitted automatically on rDone
      expect(rDone.gap).toEqual({ expected: 2, received: 3 });
      expect(rDone.events).toEqual([]);
      // Tool call in unfinished message must be corrupted and cannot be executed
      const toolCall = state.deltaMerger.getToolCall('msg_unfin', 'call_broken');
      expect(toolCall?.isCorrupted).toBe(true);
      expect(toolCall?.emitted).toBe(false);
    });
  });

  describe('Turn lifecycle and sequence reset', () => {
    it('resets sequence tracking across turns so lower sequence numbers in Turn 2 are not rejected', () => {
      const state = createEventMapperState();

      // Turn 1 ends at seq 2
      mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: { type: 'turn.created', id: 't1' },
        },
        state
      );
      mapRawEvent(
        {
          event: 'message',
          sequence_number: 2,
          data: { type: 'turn.done', id: 'td1', state: { status: 'done' } },
        },
        state
      );

      // Turn 2 begins at seq 1: must NOT be rejected as stale duplicate!
      const rTurn2 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: { type: 'model.message.delta', id: 'msg_t2', content: 'Turn 2' },
        },
        state
      );

      expect(rTurn2.events).toEqual([{ type: 'token', text: 'Turn 2' }]);
    });

    it('buffers out-of-order non-completion deltas and drains them in sequence when missing sequence arrives', () => {
      const state = createEventMapperState();

      // Turn 1 starts at seq 1
      mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: { type: 'model.message.delta', id: 'm1', content: 'Turn 1 start' },
        },
        state
      );

      // Non-completion delta arrives at seq 3 (missing seq 2) -> buffered!
      const r3 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 3,
          data: { type: 'model.message.delta', id: 'm1', content: ' finish' },
        },
        state
      );
      expect(r3.events).toEqual([]);
      expect(r3.gap).toBeUndefined();

      // Seq 2 arrives -> drains seq 2 and then drains buffered seq 3!
      const rDrain = mapRawEvent(
        {
          event: 'message',
          sequence_number: 2,
          data: { type: 'model.message.delta', id: 'm1', content: ' middle' },
        },
        state
      );
      expect(rDrain.events).toEqual([
        { type: 'token', text: ' middle' },
        { type: 'token', text: ' finish' },
      ]);
    });

    it('preserves cumulative PauseInfo and assembled messages across turn boundaries', () => {
      const state = createEventMapperState();

      // Message with gated tool in Turn 1
      mapRawEvent(
        {
          event: 'message',
          data: { type: 'model.message', id: 'msg_t1', thread_id: 'main' },
        },
        state
      );
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_t1',
            tool_calls: [
              {
                index: 0,
                id: 'call_t1',
                function: { name: 'proposeEdit', arguments: '{"path":"x"}' },
              },
            ],
            finish_reason: 'tool_calls',
          },
        },
        state
      );

      // Approval required event adds pause
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'tool.approval_required',
            tool_calls: [{ id: 'call_t1', source_event_id: 'msg_t1' }],
          },
        },
        state
      );

      expect(state.pauses.length).toBe(1);

      // Reset turn stream (e.g. for resumption turn)
      state.resetTurnStream();

      // PauseInfo and assembled message must NOT be discarded
      expect(state.pauses.length).toBe(1);
      expect(state.deltaMerger.getMessage('msg_t1')).toBeDefined();
    });
  });

  describe('Tool call invalidation and corruption guards', () => {
    it('invalidates un-emitted tool calls in messages that have finishReason', () => {
      const state = createEventMapperState();

      // Message with finish_reason stop, but tool call missing arguments / un-emitted
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_fin_unemitted',
            tool_calls: [
              { index: 0, id: 'call_incomplete', function: { name: 'proposeEdit', arguments: '{"path":' } },
            ],
            finish_reason: 'stop',
          },
        },
        state
      );

      const tcBefore = state.deltaMerger.getToolCall('msg_fin_unemitted', 'call_incomplete');
      expect(tcBefore?.emitted).toBe(false);
      expect(tcBefore?.isCorrupted).toBe(true);

      // Invalidate unfinished calls explicitly
      state.deltaMerger.invalidateUnfinished();
      const tcAfter = state.deltaMerger.getToolCall('msg_fin_unemitted', 'call_incomplete');
      expect(tcAfter?.isCorrupted).toBe(true);
    });

    it('marks tool calls missing required fields at gap time as corrupted', () => {
      const state = createEventMapperState();

      // Tool call without name
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_missing_fields',
            tool_calls: [
              { index: 0, id: 'call_no_name', function: { arguments: '{"a":1}' } },
            ],
          },
        },
        state
      );

      state.deltaMerger.invalidateUnfinished();
      const tc = state.deltaMerger.getToolCall('msg_missing_fields', 'call_no_name');
      expect(tc?.isCorrupted).toBe(true);
      expect(tc?.emitted).toBe(false);
    });

    it('confirms corrupted calls cannot be finalized or emitted by later deltas', () => {
      const state = createEventMapperState();

      // Incomplete tool call
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_corrupt_guard',
            tool_calls: [
              { index: 0, id: 'call_guard', function: { name: 'proposeEdit', arguments: '{"invalid"' } },
            ],
          },
        },
        state
      );

      // Invalidate to mark corrupted
      state.deltaMerger.invalidateUnfinished();
      const tc = state.deltaMerger.getToolCall('msg_corrupt_guard', 'call_guard');
      expect(tc?.isCorrupted).toBe(true);

      // Subsequent delta tries to supply valid arguments and finish_reason
      const rLater = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_corrupt_guard',
            tool_calls: [
              { index: 0, id: 'call_guard', function: { arguments: '{"valid": true}' } },
            ],
            finish_reason: 'tool_calls',
          },
        },
        state
      );

      // Must NOT be emitted
      expect(rLater.events).toEqual([]);
      expect(tc?.emitted).toBe(false);
    });
  });

  describe('Safe recovery after finish-boundary gap', () => {
    it('automatically recovers when finish_reason arrives with preceding sequence gap via mapRawEvent', () => {
      const state = createEventMapperState();

      // 1. Process sequence 1
      const r1 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: {
            type: 'model.message.delta',
            id: 'm1',
            tool_calls: [
              { index: 0, id: 'call_gapped', function: { name: 'runCommand', arguments: '{"cmd":' } },
            ],
          },
        },
        state
      );
      expect(r1.events).toEqual([]);

      // 2. Submit sequence 3 with a finish_reason while sequence 2 is missing
      const r3 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 3,
          data: { type: 'model.message.delta', id: 'm1', finish_reason: 'stop' },
        },
        state
      );

      // 3. Verify the returned result exposes the gap automatically without manual checkUnresolvedGap()
      expect(r3.gap).toEqual({ expected: 2, received: 3 });
      expect(r3.events).toEqual([]);

      // 4. Verify unfinished tool calls are corrupted
      const tc = state.deltaMerger.getToolCall('m1', 'call_gapped');
      expect(tc?.isCorrupted).toBe(true);
      expect(tc?.emitted).toBe(false);

      // 5. Verify the tracker recovers according to the documented policy:
      // a late sequence 2 is rejected as stale/duplicate
      const rLate2 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 2,
          data: { type: 'model.message.delta', id: 'm1', content: 'stale late chunk' },
        },
        state
      );
      expect(rLate2.events).toEqual([]);

      // 6. Verify the next valid sequence (sequence 4) is processed
      const r4 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 4,
          data: { type: 'model.message.delta', id: 'm2', content: 'recovered' },
        },
        state
      );
      expect(r4.events).toEqual([{ type: 'token', text: 'recovered' }]);
    });

    it('automatically recovers when turn.done arrives with preceding sequence gap and resets turn stream', () => {
      const state = createEventMapperState();

      // Process sequence 1
      mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: {
            type: 'model.message.delta',
            id: 'm_unfin',
            tool_calls: [
              { index: 0, id: 'call_bad', function: { name: 'proposeEdit', arguments: '{"path":' } },
            ],
          },
        },
        state
      );

      // Submit sequence 3 (turn.done) while sequence 2 is missing
      const rDone = mapRawEvent(
        {
          event: 'message',
          sequence_number: 3,
          data: { type: 'turn.done', id: 'td1', state: { status: 'done' } },
        },
        state
      );

      // Exposes gap automatically without manual checkUnresolvedGap()
      expect(rDone.gap).toEqual({ expected: 2, received: 3 });
      expect(rDone.events).toEqual([]);

      // Tool call corrupted
      const tc = state.deltaMerger.getToolCall('m_unfin', 'call_bad');
      expect(tc?.isCorrupted).toBe(true);
      expect(tc?.emitted).toBe(false);

      // Turn stream was reset by turn.done: Turn 2 can start at sequence 1
      const rTurn2 = mapRawEvent(
        {
          event: 'message',
          sequence_number: 1,
          data: { type: 'model.message.delta', id: 'm_t2', content: 'Turn 2 start' },
        },
        state
      );
      expect(rTurn2.events).toEqual([{ type: 'token', text: 'Turn 2 start' }]);
    });
  });

  describe('Approval correlation validation and error reporting', () => {
    it('resolves valid tool name and arguments from assembled message via sourceEventId (F15)', () => {
      const state = createEventMapperState();

      mapRawEvent(
        {
          event: 'message',
          data: { type: 'model.message', id: 'msg_corr_1', thread_id: 'main' },
        },
        state
      );
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_corr_1',
            tool_calls: [
              {
                index: 0,
                id: 'call_corr_1',
                function: { name: 'createFile', arguments: '{"path":"b.ts","content":"1"}' },
              },
            ],
            finish_reason: 'tool_calls',
          },
        },
        state
      );

      const res = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'tool.approval_required',
            tool_calls: [{ id: 'call_corr_1', source_event_id: 'msg_corr_1' }],
          },
        },
        state
      );

      expect(res.events).toEqual([]);
      expect(res.newPauses).toEqual([
        {
          callId: 'call_corr_1',
          threadId: 'main',
          sourceEventId: 'msg_corr_1',
          toolName: 'createFile',
          args: { path: 'b.ts', content: '1' },
        },
      ]);
    });

    it('reports unresolved correlation error when source message is missing', () => {
      const state = createEventMapperState();

      const res = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'tool.approval_required',
            tool_calls: [{ id: 'call_missing_msg', source_event_id: 'non_existent_msg' }],
          },
        },
        state
      );

      expect(res.newPauses).toEqual([]);
      expect(res.unresolvedPauses).toBeDefined();
      expect(res.unresolvedPauses?.length).toBe(1);
      expect(res.unresolvedPauses?.[0].callId).toBe('call_missing_msg');
      expect(res.unresolvedPauses?.[0].sourceEventId).toBe('non_existent_msg');
    });

    it('reports unresolved correlation error when tool call is missing within source message', () => {
      const state = createEventMapperState();

      mapRawEvent(
        {
          event: 'message',
          data: { type: 'model.message', id: 'msg_empty_tools', thread_id: 'main' },
        },
        state
      );

      const res = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'tool.approval_required',
            tool_calls: [{ id: 'call_not_in_msg', source_event_id: 'msg_empty_tools' }],
          },
        },
        state
      );

      expect(res.newPauses).toEqual([]);
      expect(res.unresolvedPauses?.length).toBe(1);
      expect(res.unresolvedPauses?.[0].reason).toContain('not found in source message');
    });

    it('reports unresolved correlation error when tool arguments are incomplete or corrupted', () => {
      const state = createEventMapperState();

      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_corrupt_call',
            tool_calls: [
              {
                index: 0,
                id: 'call_broken_json',
                function: { name: 'proposeEdit', arguments: '{"unclosed' },
              },
            ],
            finish_reason: 'tool_calls',
          },
        },
        state
      );

      const res = mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'tool.approval_required',
            tool_calls: [{ id: 'call_broken_json', source_event_id: 'msg_corrupt_call' }],
          },
        },
        state
      );

      expect(res.newPauses).toEqual([]);
      expect(res.unresolvedPauses?.length).toBe(1);
      expect(res.unresolvedPauses?.[0].reason).toContain('corrupted or incomplete arguments');
    });

    it('consumePauses atomically returns and empties cumulative pauses', () => {
      const state = createEventMapperState();

      mapRawEvent(
        {
          event: 'message',
          data: { type: 'model.message', id: 'msg_drain', thread_id: 'main' },
        },
        state
      );
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'model.message.delta',
            id: 'msg_drain',
            tool_calls: [
              { index: 0, id: 'call_d1', function: { name: 'runCommand', arguments: '{"c":1}' } },
            ],
            finish_reason: 'tool_calls',
          },
        },
        state
      );
      mapRawEvent(
        {
          event: 'message',
          data: {
            type: 'tool.approval_required',
            tool_calls: [{ id: 'call_d1', source_event_id: 'msg_drain' }],
          },
        },
        state
      );

      expect(state.pauses.length).toBe(1);
      const drained = state.consumePauses();
      expect(drained.length).toBe(1);
      expect(state.pauses.length).toBe(0);
    });
  });

  describe('Terminal state mapping and fact compliance', () => {
    it('prefers paused over done when action_required_on_events is active (F18)', () => {
      const turnDoneWithActionRequired = {
        data: {
          type: 'turn.done',
          id: 'td_paused',
          state: {
            status: 'done',
            output: { content: 'Waiting for approval', type: 'model.message' },
            action_required_on_events: [{ id: 'call_gated' }],
          },
        },
      };

      const terminal = mapTerminal(turnDoneWithActionRequired);
      expect(terminal.status).toBe('paused');
      expect(terminal.outcome).toBe('paused');
      if (terminal.outcome === 'paused') {
        expect(terminal.requiredActions).toEqual([{ id: 'call_gated' }]);
      }
    });

    it('returns status=done with requiredActions when turn finishes with required_actions', () => {
      const turnDoneWithRequiredActions = {
        data: {
          type: 'turn.done',
          id: 'td_finished',
          state: {
            status: 'done',
            output: { content: 'All finished', type: 'model.message' },
            required_actions: [{ action: 'notify' }],
          },
        },
      };

      const terminal = mapTerminal(turnDoneWithRequiredActions);
      expect(terminal.status).toBe('done');
      expect(terminal.outcome).toBe('done');
      if (terminal.outcome === 'done') {
        expect(terminal.requiredActions).toEqual([{ action: 'notify' }]);
      }
    });

    it('maps cancelled status with reason', () => {
      const turnCancelled = {
        data: {
          type: 'turn.done',
          state: { status: 'cancelled', reason: 'User requested cancellation' },
        },
      };

      const terminal = mapTerminal(turnCancelled);
      expect(terminal.status).toBe('cancelled');
      expect(terminal.outcome).toBe('cancelled');
      if (terminal.outcome === 'cancelled') {
        expect(terminal.reason).toBe('User requested cancellation');
      }
    });

    it('maps error status with error message', () => {
      const turnError = {
        data: {
          type: 'turn.done',
          state: { status: 'error', message: 'Rate limit exceeded' },
        },
      };

      const terminal = mapTerminal(turnError);
      expect(terminal.status).toBe('error');
      expect(terminal.outcome).toBe('error');
      if (terminal.outcome === 'error') {
        expect(terminal.message).toBe('Rate limit exceeded');
      }
    });

    it('returns non_terminal for running, unknown, and malformed states', () => {
      expect(mapTerminal({ data: { state: { status: 'running' } } }).outcome).toBe('non_terminal');
      expect(mapTerminal({ data: { state: { status: 'starting' } } }).outcome).toBe('non_terminal');
      expect(mapTerminal({ data: { state: { status: 'pending' } } }).outcome).toBe('non_terminal');
      expect(mapTerminal({ data: { state: { status: 'unrecognized_status' } } }).outcome).toBe('non_terminal');
      expect(mapTerminal(null).outcome).toBe('non_terminal');
      expect(mapTerminal({}).outcome).toBe('non_terminal');
    });
  });

  describe('inferToolResult', () => {
    it('extracts nested error text from TrueForge synthetic denial JSON', () => {
      const denialContent = JSON.stringify({
        error: [
          {
            text: JSON.stringify({
              status: 'denied',
              error: 'User denied proposal to edit src/app.ts',
            }),
          },
        ],
      });

      const { ok, summary } = inferToolResult('call_123', denialContent);
      expect(ok).toBe(false);
      expect(summary).toBe('User denied proposal to edit src/app.ts');
    });

    it('treats normal tool output as success', () => {
      const normalContent = 'file content here';
      const { ok, summary } = inferToolResult('call_norm', normalContent);
      expect(ok).toBe(true);
      expect(summary).toBe('file content here');
    });

    it('recognizes explicit error prefix', () => {
      const { ok, summary } = inferToolResult('call_err', 'Error: file not found');
      expect(ok).toBe(false);
      expect(summary).toBe('Error: file not found');
    });
  });

  describe('Exact replay verification across all 27 recorded fixtures', () => {
    const fixtureExpectations: Record<
      string,
      {
        events: EngineEvent[];
        pauses: PauseInfo[];
        terminal: TerminalResult;
      }
    > = {
  "01-plain.jsonl": {
    "events": [
      {
        "type": "token",
        "text": "Hi"
      },
      {
        "type": "token",
        "text": "! How can I help you today?"
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "Hi! How can I help you today?",
        "type": "model.message",
        "id": "01m7akwx55sd6yh4yp5gc9b072",
        "created_at": "2026-11-13T14:10:05.536Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1174,
          "output_tokens": 9,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 7,
            "tool_definitions": 0,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "02-tool-preload-false.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_4072320294194540154",
        "tool": "list_tools",
        "args": {
          "mcp_server": "forge-spike"
        },
        "thread": "main"
      },
      {
        "type": "tool.result",
        "callId": "call_4072320294194540154",
        "ok": true,
        "summary": "forge-spike:\n  echo, gated_echo"
      },
      {
        "type": "tool.call",
        "callId": "call_17762146402262776310",
        "tool": "get_tool_info",
        "args": {
          "mcp_server": "forge-spike",
          "tool_name": "echo"
        },
        "thread": "main"
      },
      {
        "type": "tool.result",
        "callId": "call_17762146402262776310",
        "ok": true,
        "summary": "{\"description\":\"Echo text back. Use when you are asked to test the echo tool.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"],\"$schema\":\"http://json-schema.org/draft-07/schema#\"},\"outputSchema\":null}"
      },
      {
        "type": "tool.call",
        "callId": "call_6718516625430615684",
        "tool": "call_tool",
        "args": {
          "mcp_server": "forge-spike",
          "input": {
            "text": "hello"
          },
          "tool_name": "echo"
        },
        "thread": "main"
      },
      {
        "type": "tool.result",
        "callId": "call_6718516625430615684",
        "ok": true,
        "summary": "echo: hello"
      },
      {
        "type": "token",
        "text": "The echo"
      },
      {
        "type": "token",
        "text": " tool returned: \"echo: hello\""
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The echo tool returned: \"echo: hello\"",
        "type": "model.message",
        "id": "01m7fvntm8xk0sv5v9zr8z794q",
        "created_at": "2026-11-15T15:02:15.575Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 2075,
          "output_tokens": 10,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1926,
            "skills": 0,
            "instructions": 27,
            "tool_definitions": 0,
            "messages": 122
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "02-tool.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_3628824314702740428",
        "tool": "echo",
        "args": {
          "text": "hello"
        },
        "thread": "main"
      },
      {
        "type": "tool.result",
        "callId": "call_3628824314702740428",
        "ok": true,
        "summary": "echo: hello"
      },
      {
        "type": "token",
        "text": "The"
      },
      {
        "type": "token",
        "text": " result of calling the echo tool with 'hello' is: echo: hello"
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The result of calling the echo tool with 'hello' is: echo: hello",
        "type": "model.message",
        "id": "01m7amhphmk7xxzstvdj2jrfbs",
        "created_at": "2026-11-13T14:21:25.573Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1361,
          "output_tokens": 16,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 27,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03-allow-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_1483655821534885245",
        "tool": "gated_echo",
        "args": {
          "text": "one"
        },
        "thread": "main"
      },
      {
        "type": "tool.result",
        "callId": "call_1483655821534885245",
        "ok": true,
        "summary": "gated echo: one"
      },
      {
        "type": "token",
        "text": "The gated"
      },
      {
        "type": "token",
        "text": "_echo tool has been executed, and the result is: \"gated echo: one\"."
      }
    ],
    "pauses": [
      {
        "callId": "call_1483655821534885245",
        "threadId": "main",
        "sourceEventId": "01m7c8wsgd9fbt1bbh9q7njgf7",
        "toolName": "gated_echo",
        "args": {
          "text": "one"
        }
      }
    ],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The gated_echo tool has been executed, and the result is: \"gated echo: one\".",
        "type": "model.message",
        "id": "01m7c8wvb0zmd5t01m6yat14d7",
        "created_at": "2026-11-14T05:36:16.443Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1378,
          "output_tokens": 21,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03-allow-resume.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_1461082377008658955",
        "tool": "gated_echo",
        "args": {
          "text": "one"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_1461082377008658955",
        "threadId": "main",
        "sourceEventId": "01m7b82nb8h5vsd442a48d1whc",
        "toolName": "gated_echo",
        "args": {
          "text": "one"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03-allow-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_1461082377008658955",
        "tool": "gated_echo",
        "args": {
          "text": "one"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_1461082377008658955",
        "threadId": "main",
        "sourceEventId": "01m7b82nb8h5vsd442a48d1whc",
        "toolName": "gated_echo",
        "args": {
          "text": "one"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03-deny-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_13275446802091080223",
        "tool": "gated_echo",
        "args": {
          "text": "one"
        },
        "thread": "main"
      },
      {
        "type": "tool.result",
        "callId": "call_13275446802091080223",
        "ok": false,
        "summary": "User denied tool call: User rejected all changes to this tool call"
      },
      {
        "type": "token",
        "text": "The gated"
      },
      {
        "type": "token",
        "text": "_echo tool call with the text 'one' was rejected by the user."
      }
    ],
    "pauses": [
      {
        "callId": "call_13275446802091080223",
        "threadId": "main",
        "sourceEventId": "01m7cn27wqcrrp47wjdrtxfcns",
        "toolName": "gated_echo",
        "args": {
          "text": "one"
        }
      }
    ],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The gated_echo tool call with the text 'one' was rejected by the user.",
        "type": "model.message",
        "id": "01m7cn2zedw5bdwmry3se4yqqj",
        "created_at": "2026-11-14T09:09:23.788Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1401,
          "output_tokens": 18,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03-deny-resume.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_13275446802091080223",
        "tool": "gated_echo",
        "args": {
          "text": "one"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_13275446802091080223",
        "threadId": "main",
        "sourceEventId": "01m7cn27wqcrrp47wjdrtxfcns",
        "toolName": "gated_echo",
        "args": {
          "text": "one"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03-deny-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_11681734858318991206",
        "tool": "gated_echo",
        "args": {
          "text": "one"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_11681734858318991206",
        "threadId": "main",
        "sourceEventId": "01m7chwea5hba2a69f1ffrw0g2",
        "toolName": "gated_echo",
        "args": {
          "text": "one"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03-identical-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.result",
        "callId": "call_18263928591380947040",
        "ok": true,
        "summary": "gated echo: same"
      },
      {
        "type": "tool.result",
        "callId": "call_18263928591380948145",
        "ok": false,
        "summary": "User denied tool call: User rejected this one"
      },
      {
        "type": "token",
        "text": "Both"
      },
      {
        "type": "token",
        "text": " gated_echo calls were executed, but the results were mixed: the first call was successfully"
      },
      {
        "type": "token",
        "text": " echoed as \"gated echo: same\", while the second call was rejected by the user."
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "Both gated_echo calls were executed, but the results were mixed: the first call was successfully echoed as \"gated echo: same\", while the second call was rejected by the user.",
        "type": "model.message",
        "id": "01m7d1ktwratz993jsk504xj5f",
        "created_at": "2026-11-14T12:48:26.735Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1452,
          "output_tokens": 38,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03-identical-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_18263928591380947040",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      },
      {
        "type": "tool.call",
        "callId": "call_18263928591380948145",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_18263928591380947040",
        "threadId": "main",
        "sourceEventId": "01m7d1ks5phzt2szth85ckcysd",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      },
      {
        "callId": "call_18263928591380948145",
        "threadId": "main",
        "sourceEventId": "01m7d1ks5phzt2szth85ckcysd",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03-parallel-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.result",
        "callId": "call_8616358205509696178",
        "ok": true,
        "summary": "gated echo: a"
      },
      {
        "type": "tool.result",
        "callId": "call_8616358205509697283",
        "ok": false,
        "summary": "User denied tool call: User rejected this one"
      },
      {
        "type": "tool.result",
        "callId": "call_8616358205509694292",
        "ok": true,
        "summary": "gated echo: c"
      },
      {
        "type": "token",
        "text": "The"
      },
      {
        "type": "token",
        "text": " results of the three gated echo requests are as follows:\n\n*   The request for '"
      },
      {
        "type": "token",
        "text": "a' was successful, returning: \"gated echo: a\".\n*   The request for 'b' was rejected"
      },
      {
        "type": "token",
        "text": " by the user.\n*   The request for 'c' was successful, returning: \"gated echo: c"
      },
      {
        "type": "token",
        "text": "\"."
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The results of the three gated echo requests are as follows:\n\n*   The request for 'a' was successful, returning: \"gated echo: a\".\n*   The request for 'b' was rejected by the user.\n*   The request for 'c' was successful, returning: \"gated echo: c\".",
        "type": "model.message",
        "id": "01m7d1j94f76yd4eswspnj47z3",
        "created_at": "2026-11-14T12:47:24.772Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1500,
          "output_tokens": 69,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 36
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03-parallel-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_8616358205509696178",
        "tool": "gated_echo",
        "args": {
          "text": "a"
        },
        "thread": "main"
      },
      {
        "type": "tool.call",
        "callId": "call_8616358205509697283",
        "tool": "gated_echo",
        "args": {
          "text": "b"
        },
        "thread": "main"
      },
      {
        "type": "tool.call",
        "callId": "call_8616358205509694292",
        "tool": "gated_echo",
        "args": {
          "text": "c"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_8616358205509696178",
        "threadId": "main",
        "sourceEventId": "01m7d1j740c8v03w2b54f1s788",
        "toolName": "gated_echo",
        "args": {
          "text": "a"
        }
      },
      {
        "callId": "call_8616358205509697283",
        "threadId": "main",
        "sourceEventId": "01m7d1j740c8v03w2b54f1s788",
        "toolName": "gated_echo",
        "args": {
          "text": "b"
        }
      },
      {
        "callId": "call_8616358205509694292",
        "threadId": "main",
        "sourceEventId": "01m7d1j740c8v03w2b54f1s788",
        "toolName": "gated_echo",
        "args": {
          "text": "c"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03-wait-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.result",
        "callId": "call_16381064394586784453",
        "ok": true,
        "summary": "gated echo: one"
      },
      {
        "type": "token",
        "text": "The "
      },
      {
        "type": "token",
        "text": "`gated_echo` tool returned: \"gated echo: one\"."
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The `gated_echo` tool returned: \"gated echo: one\".",
        "type": "model.message",
        "id": "01m7d1gwf4dyw7bcjcemc0gx5d",
        "created_at": "2026-11-14T12:46:39.523Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1378,
          "output_tokens": 17,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03-wait-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_16381064394586784453",
        "tool": "gated_echo",
        "args": {
          "text": "one"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_16381064394586784453",
        "threadId": "main",
        "sourceEventId": "01m7d1f09j32t08e72e09s31c7",
        "toolName": "gated_echo",
        "args": {
          "text": "one"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03b-identical-i-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.result",
        "callId": "call_3899841888897935735",
        "ok": false,
        "summary": "User denied tool call: User rejected this one"
      },
      {
        "type": "tool.result",
        "callId": "call_3899841888897936280",
        "ok": true,
        "summary": "gated echo: same"
      },
      {
        "type": "token",
        "text": "The attempt"
      },
      {
        "type": "token",
        "text": " to call the gated_echo tool twice was unsuccessful because the user rejected one of the requests. The"
      },
      {
        "type": "token",
        "text": " first request was denied by the user, while the second request was approved and returned the text \"same\"."
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The attempt to call the gated_echo tool twice was unsuccessful because the user rejected one of the requests. The first request was denied by the user, while the second request was approved and returned the text \"same\".",
        "type": "model.message",
        "id": "01m7d5c2ycm6fa9b3s48ys94mc",
        "created_at": "2026-11-14T13:53:56.522Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1452,
          "output_tokens": 43,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03b-identical-i-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_3899841888897935735",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      },
      {
        "type": "tool.call",
        "callId": "call_3899841888897936280",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_3899841888897935735",
        "threadId": "main",
        "sourceEventId": "01m7d5c0scgnvr7hxtc0cdaf0n",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      },
      {
        "callId": "call_3899841888897936280",
        "threadId": "main",
        "sourceEventId": "01m7d5c0scgnvr7hxtc0cdaf0n",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03b-identical-ii-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.result",
        "callId": "call_5570851725666251651",
        "ok": false,
        "summary": "User denied tool call: User rejected this one"
      },
      {
        "type": "tool.result",
        "callId": "call_5570851725666252936",
        "ok": true,
        "summary": "gated echo: same"
      },
      {
        "type": "token",
        "text": "Both"
      },
      {
        "type": "token",
        "text": " calls to the `gated_echo` tool resulted in different outcomes: one was rejected"
      },
      {
        "type": "token",
        "text": " by the user, while the other successfully returned the text 'same'."
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "Both calls to the `gated_echo` tool resulted in different outcomes: one was rejected by the user, while the other successfully returned the text 'same'.",
        "type": "model.message",
        "id": "01m7d5dv1c22q5cswkdb0k5wrx",
        "created_at": "2026-11-14T13:54:54.158Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1452,
          "output_tokens": 33,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03b-identical-ii-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_5570851725666251651",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      },
      {
        "type": "tool.call",
        "callId": "call_5570851725666252936",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_5570851725666251651",
        "threadId": "main",
        "sourceEventId": "01m7d5drc77v2gbrt4r3h7zg53",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      },
      {
        "callId": "call_5570851725666252936",
        "threadId": "main",
        "sourceEventId": "01m7d5drc77v2gbrt4r3h7zg53",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "03b-identical-iii-resume-sse.jsonl": {
    "events": [
      {
        "type": "tool.result",
        "callId": "call_1478272789039419554",
        "ok": true,
        "summary": "gated echo: same"
      },
      {
        "type": "tool.result",
        "callId": "call_1478272789039421323",
        "ok": false,
        "summary": "User denied tool call: User rejected this one"
      },
      {
        "type": "token",
        "text": "The first"
      },
      {
        "type": "token",
        "text": " attempt to use the `gated_echo` tool with the text 'same' was successful and"
      },
      {
        "type": "token",
        "text": " returned \"gated echo: same\". However, the second attempt was rejected by the user."
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The first attempt to use the `gated_echo` tool with the text 'same' was successful and returned \"gated echo: same\". However, the second attempt was rejected by the user.",
        "type": "model.message",
        "id": "01m7d5f3vvdfqqfbhf3g5bbjnf",
        "created_at": "2026-11-14T13:55:36.452Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1452,
          "output_tokens": 41,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 34,
            "tool_definitions": 128,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "03b-identical-iii-turn1.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_1478272789039419554",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      },
      {
        "type": "tool.call",
        "callId": "call_1478272789039421323",
        "tool": "gated_echo",
        "args": {
          "text": "same"
        },
        "thread": "main"
      }
    ],
    "pauses": [
      {
        "callId": "call_1478272789039419554",
        "threadId": "main",
        "sourceEventId": "01m7d5f0xxfv0j0d737cvnry4b",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      },
      {
        "callId": "call_1478272789039421323",
        "threadId": "main",
        "sourceEventId": "01m7d5f0xxfv0j0d737cvnry4b",
        "toolName": "gated_echo",
        "args": {
          "text": "same"
        }
      }
    ],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "04-cancel-pre-fix.jsonl": {
    "events": [],
    "pauses": [],
    "terminal": {
      "status": "non_terminal",
      "outcome": "non_terminal"
    }
  },
  "04-cancel.jsonl": {
    "events": [
      {
        "type": "token",
        "text": "The lighthouse"
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "cancelled",
      "outcome": "cancelled",
      "reason": "client-cancelled"
    }
  },
  "05-model-404.jsonl": {
    "events": [],
    "pauses": [],
    "terminal": {
      "status": "error",
      "outcome": "error",
      "message": "[Model Error] Request failed (404): The model `llama-3.3-70b-versatile` does not exist or you do not have access to it."
    }
  },
  "05-model-timeout.jsonl": {
    "events": [],
    "pauses": [],
    "terminal": {
      "status": "error",
      "outcome": "error",
      "message": "[Model Error] Cannot connect to API: Headers Timeout Error"
    }
  },
  "diagnostic-01-plain.jsonl": {
    "events": [
      {
        "type": "token",
        "text": "Hi!"
      },
      {
        "type": "token",
        "text": " How can I help you today?"
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "Hi! How can I help you today?",
        "type": "model.message",
        "id": "01m7av7vprhceqyg424cpz9fzn",
        "created_at": "2026-11-13T16:18:30.685Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1174,
          "output_tokens": 9,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 7,
            "tool_definitions": 0,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  },
  "diagnostic-02-mcp-tool.jsonl": {
    "events": [
      {
        "type": "tool.call",
        "callId": "call_15045147603252179801",
        "tool": "echo",
        "args": {
          "text": "hello"
        },
        "thread": "main"
      },
      {
        "type": "tool.result",
        "callId": "call_15045147603252179801",
        "ok": true,
        "summary": "echo: hello"
      },
      {
        "type": "token",
        "text": "The echo"
      },
      {
        "type": "token",
        "text": " tool returned: \"echo: hello\""
      }
    ],
    "pauses": [],
    "terminal": {
      "status": "done",
      "outcome": "done",
      "output": {
        "content": "The echo tool returned: \"echo: hello\"",
        "type": "model.message",
        "id": "01m7avjar0r2a1n3v3mbhzw46f",
        "created_at": "2026-11-13T16:24:13.717Z",
        "thread_id": "main",
        "finish_reason": "stop",
        "usage": {
          "input_tokens": 1367,
          "output_tokens": 10,
          "cache_read_tokens": 0,
          "input_tokens_breakdown": {
            "harness": 1302,
            "skills": 0,
            "instructions": 27,
            "tool_definitions": 129,
            "messages": 0
          }
        },
        "model": {
          "name": "google-gemini/gemini-3-1-flash-lite",
          "params": {
            "max_tokens": 65536
          }
        }
      },
      "requiredActions": []
    }
  }
};

    const fixtureFiles = fs
      .readdirSync(FIXTURES_DIR)
      .filter((file) => file.endsWith('.jsonl'))
      .sort();

    it('verifies all 27 recorded fixtures exist in expectation table', () => {
      expect(fixtureFiles.length).toBe(27);
      expect(Object.keys(fixtureExpectations).length).toBe(27);
      for (const f of fixtureFiles) {
        expect(fixtureExpectations[f]).toBeDefined();
      }
    });

    for (const fixtureFile of fixtureFiles) {
      it(`replays ${fixtureFile} with exact verified events, pauses, and terminal outcome`, () => {
        const expected = fixtureExpectations[fixtureFile];
        const filePath = path.join(FIXTURES_DIR, fixtureFile);
        const lines = fs
          .readFileSync(filePath, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        const state = createEventMapperState();
        const collectedEvents: EngineEvent[] = [];
        const collectedPauses: PauseInfo[] = [];
        let finalTerminal: TerminalResult = mapTerminal({}); // starts non-terminal

        for (const line of lines) {
          const raw = JSON.parse(line) as Record<string, unknown>;
          const result = mapRawEvent(raw, state);
          collectedEvents.push(...result.events);
          collectedPauses.push(...result.newPauses);

          const data = raw.data as Record<string, unknown> | undefined;
          if (data && (data.type === 'turn.done' || data.type === 'turn.update')) {
            finalTerminal = mapTerminal(raw);
          }
        }

        expect(collectedEvents).toEqual(expected.events);
        expect(collectedPauses).toEqual(expected.pauses);
        expect(finalTerminal).toEqual(expected.terminal);
      });
    }

    it('correlates pauses across multiple turns when replaying Turn 1 followed by Resume SSE in the same state', () => {
      const state = createEventMapperState();

      // Turn 1: 03-parallel-turn1.jsonl
      const turn1Lines = fs
        .readFileSync(path.join(FIXTURES_DIR, '03-parallel-turn1.jsonl'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const turn1Events = [];
      const turn1Pauses = [];
      for (const line of turn1Lines) {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const r = mapRawEvent(raw, state);
        turn1Events.push(...r.events);
        turn1Pauses.push(...r.newPauses);
      }

      expect(turn1Events.length).toBe(3);
      expect(turn1Pauses.length).toBe(3);

      // Turn 2: 03-parallel-resume-sse.jsonl in the same state (preserves assembled messages!)
      const resumeLines = fs
        .readFileSync(path.join(FIXTURES_DIR, '03-parallel-resume-sse.jsonl'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const resumeEvents = [];
      const resumePauses = [];
      let term = null;
      for (const line of resumeLines) {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const r = mapRawEvent(raw, state);
        resumeEvents.push(...r.events);
        resumePauses.push(...r.newPauses);
        const data = raw.data as Record<string, unknown> | undefined;
        if (data && data.type === 'turn.done') {
          term = mapTerminal(raw);
        }
      }

      // In the resumption stream, because Turn 1 messages were retained in state,
      // the approval event successfully correlates all 3 calls!
      expect(resumePauses.length).toBe(3);
      expect(resumeEvents.length).toBe(8);
      expect(term?.outcome).toBe('done');
    });
  });
});
