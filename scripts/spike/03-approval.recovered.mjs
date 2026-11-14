// Q4 / Q5 / Q6 / Q14 / Q15: approval pause + resume (recovered implementation).
// Modes:
//   allow     one gated call -> pause -> resume allow             (expected MCP execs: 1)
//   deny      one gated call -> pause -> resume deny with reason  (expected MCP execs: 0)
//   wait      wait WAIT_MIN min -> resume allow                   (expected MCP execs: 1)
//   parallel  3 gated calls -> decisions: allow, deny, allow      (expected MCP execs: 2)
//   identical 2 identical gated calls -> reverse order decisions  (expected MCP execs: 1)
// Run: $env:MODE="allow"; node scripts/spike/03-approval.recovered.mjs

import {
  api,
  MCP_URL,
  MCP_TOKEN,
  pickModel,
  registerMcp,
  upsertAgent,
  newSession,
  streamTurn,
  submitApprovalEvent,
  subscribeTurnEvents,
  turnIdOf,
  typeOf,
  findApproval,
  findDone,
  fixtureLines,
  saveFixture,
  summarize,
  sleep,
} from './_lib.mjs';
import { startMcpServer, calls, closeMcpServer } from './mcp-server.mjs';

const MODE = process.env.MODE || 'allow';
const PERM = (process.env.PERM || 'i').toLowerCase();
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60_000);

if (MODE === 'identical' && !['i', 'ii', 'iii'].includes(PERM)) {
  console.error(`Unknown PERM: '${PERM}'. Expected one of: i, ii, iii`);
  process.exit(1);
}

const fixturePrefix = MODE === 'identical' ? `03b-identical-${PERM}` : `03-${MODE}`;

const PROMPTS = {
  allow: "Call the gated_echo tool with text 'one' and tell me the result.",
  deny: "Call the gated_echo tool with text 'one' and tell me the result.",
  wait: "Call the gated_echo tool with text 'one' and tell me the result.",
  parallel: "In ONE single message, call the gated_echo tool three times in parallel with the texts 'a', 'b' and 'c'. Then summarise the three results.",
  identical: "In ONE single message, call the gated_echo tool twice in parallel, both times with exactly the text 'same'. Then summarise the results.",
};

const EXPECTED_PENDING_TOOL_CALLS = {
  allow: 1,
  deny: 1,
  wait: 1,
  parallel: 3,
  identical: 2,
};

const EXPECTED_EXECS = {
  allow: 1,
  deny: 0,
  wait: 1,
  parallel: 2,
  identical: 1,
};

if (!PROMPTS[MODE]) {
  console.error(`Unknown MODE: '${MODE}'. Expected one of: ${Object.keys(PROMPTS).join(', ')}`);
  process.exit(1);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Safely close an async iterator with bounded wait and safe ignore if already closed
async function closeIteratorSafely(iter, timeoutMs = 2000) {
  if (iter && typeof iter.return === 'function') {
    let returnTimer;
    try {
      await Promise.race([
        iter.return(),
        new Promise((r) => { returnTimer = setTimeout(r, timeoutMs); }),
      ]);
    } catch {
      // Safe ignore on already-closed or aborted generator
    } finally {
      clearTimeout(returnTimer);
    }
  }
}

// Bounded session cancellation request so TrueForge cancel cannot hang indefinitely
// Verified in scripts/spike/openapi-local.json: POST /api/v1/sessions/{session_id}/cancel
async function cancelSessionBounded(sessionId, timeoutMs = 5000) {
  const cancelAbortCtrl = new AbortController();
  let cancelTimer;

  const timeoutPromise = new Promise((_, reject) => {
    cancelTimer = setTimeout(() => {
      cancelAbortCtrl.abort(); // Abort the cancellation fetch immediately when timeout wins
      reject(new Error(`Session cancel request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    console.log(`[CANCEL] Sending POST /api/v1/sessions/${sessionId}/cancel (bounded to ${timeoutMs}ms)...`);
    const cancelRes = await Promise.race([
      api('POST', `/api/v1/sessions/${sessionId}/cancel`, {}, { allowFail: true, signal: cancelAbortCtrl.signal }),
      timeoutPromise,
    ]);
    console.log(`[CANCEL] Session cancel response: HTTP ${cancelRes.status}`);
    return cancelRes;
  } catch (err) {
    if (!cancelAbortCtrl.signal.aborted) {
      cancelAbortCtrl.abort();
    }
    console.warn(`[CANCEL] Session cancel attempt failed or timed out: ${err.message}`);
    console.warn(`[CANCEL] WARNING: TrueForge session cancel did not complete successfully; underlying SSE reader stream may not be released.`);
    return null;
  } finally {
    clearTimeout(cancelTimer);
  }
}

const model = await pickModel();
let srv;

try {
  // 1. Start MCP server
  console.log(`\n=== Starting MCP test server ===`);
  srv = await startMcpServer();

  // 2. Reuse the existing forge-spike registration safely
  console.log(`\n=== Registering/verifying MCP server 'forge-spike' ===`);
  const reg = await registerMcp('forge-spike', MCP_URL, MCP_TOKEN);
  console.log(`  MCP server registered/verified (reused: ${Boolean(reg.reused)})`);

  // 3. Configure the spike-approval agent with approval required for gated_echo
  console.log(`\n=== Configuring agent 'spike-approval' with model '${model}' ===`);
  await upsertAgent('spike-approval', {
    model: { name: model },
    instructions: 'You can call tools. Follow the user instructions about tool calls exactly. If a tool result says the user rejected it, say so honestly.',
    mcp_servers: [{ name: 'forge-spike', preload: true, require_approval_for_tools: ['gated_echo'] }],
  });

  // 4. Create a session
  const s = await newSession('spike-approval');
  console.log(`\n=== Session created: ${s.id} (MODE: ${MODE}${MODE === 'identical' ? `, PERM: ${PERM}` : ''}) ===`);

  // 5. Start the first turn using streamTurn() with an onEvent callback
  // 6. Stop the stream when typeOf(frame) === 'tool.approval_required'
  console.log(`\n=== Starting Turn 1 (awaiting tool.approval_required) ===`);
  console.log(`Prompt: "${PROMPTS[MODE]}"`);
  let approvalFrameSeen = null;

  const turn1Frames = await withTimeout(
    streamTurn(
      s.id,
      { input: [{ type: 'user.message', content: PROMPTS[MODE] }] },
      {
        onEvent: (frame) => {
          if (typeOf(frame) === 'tool.approval_required') {
            approvalFrameSeen = frame;
            console.log(`  [streamTurn] Detected tool.approval_required -> stopping stream.`);
            return 'stop';
          }
        },
      }
    ),
    TIMEOUT_MS,
    'Turn 1 stream'
  );

  saveFixture(`${fixturePrefix}-turn1.jsonl`, fixtureLines(turn1Frames));
  console.log('Turn 1 event summary:', summarize(turn1Frames));

  // 7. Extract the actual turn ID using turnIdOf(frames)
  const actualTurnId = turnIdOf(turn1Frames);
  console.log(`Actual Turn ID: ${actualTurnId}`);
  if (!actualTurnId) {
    throw new Error('Failed to extract actual turn ID from turn 1 frames');
  }

  // 8. Read tool_calls and thread_id from the approval event payload (snake_case wire format)
  const appr = approvalFrameSeen || findApproval(turn1Frames);
  if (!appr) {
    throw new Error('No tool.approval_required event received. Check model capability or agent gating config.');
  }

  const apprPayload = appr.data || {};
  const toolCalls = apprPayload.tool_calls || apprPayload.toolCalls || [];
  const threadId = apprPayload.thread_id || apprPayload.threadId || 'main';
  const approvalEventId = apprPayload.id;

  // Improvement 1: Validate that approvalEventId exists and toolCalls is nonempty
  console.log(`Approval event ID: ${approvalEventId}`);
  if (!approvalEventId || typeof approvalEventId !== 'string' || approvalEventId.trim().length === 0) {
    throw new Error(
      `Validation failed: approvalEventId is missing or empty in tool.approval_required payload: ${JSON.stringify(apprPayload)}`
    );
  }

  console.log(`Thread ID: ${threadId}`);
  console.log(`Pending tool calls count: ${toolCalls.length}`);
  console.log('Pending tool calls payload:', JSON.stringify(toolCalls, null, 2));

  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error(
      `Validation failed: pending tool_calls array is empty or missing in tool.approval_required payload: ${JSON.stringify(apprPayload)}`
    );
  }

  // Improvement 2: Validate expected pending tool-call counts per mode
  const expectedPendingCalls = EXPECTED_PENDING_TOOL_CALLS[MODE];
  console.log(`Pending tool calls count validation for MODE='${MODE}': actual=${toolCalls.length}, expected=${expectedPendingCalls}`);
  if (toolCalls.length !== expectedPendingCalls) {
    throw new Error(
      `Validation failed: pending tool call count mismatch for MODE='${MODE}': expected ${expectedPendingCalls}, got ${toolCalls.length}`
    );
  }

  for (const tc of toolCalls) {
    if (!tc || !tc.id) {
      throw new Error(`Validation failed: pending tool call missing 'id': ${JSON.stringify(tc)}`);
    }
  }

  // Print merged model message frames for sourceEventId if present (F15)
  const srcIds = new Set(toolCalls.map((t) => t.source_event_id || t.sourceEventId).filter(Boolean));
  for (const f of turn1Frames) {
    if (f.data && srcIds.has(f.data.id)) {
      console.log(`  Source model.message for pending call [${f.data.id}]:`, f.rawData.slice(0, 500));
    }
  }

  // 9. Verify the MCP handler count is zero before approval
  console.log(`\nMCP handler executions before approval: ${calls.length} (must be 0)`);
  if (calls.length !== 0) {
    throw new Error(`Assertion failed: expected 0 MCP calls before approval, found ${calls.length}`);
  }

  // Handle 'wait' mode if requested (Q6)
  if (MODE === 'wait') {
    const waitMin = Number(process.env.WAIT_MIN || 10);
    console.log(`\nMode is 'wait': pausing ${waitMin} minutes before resuming (Q6)...`);
    await sleep(waitMin * 60_000);
    console.log(`Wait complete. Proceeding with approval submission.`);
  }

  // Determine decisions and submission order for each tool call
  let decisions;
  if (MODE === 'identical') {
    const call1 = { id: toolCalls[0].id, callNumber: 1, i: 0 };
    const call2 = { id: toolCalls[1].id, callNumber: 2, i: 1 };
    const allow = { status: 'allow' };
    const deny = { status: 'deny', reason: 'User rejected this one' };

    let orderedCalls;
    if (PERM === 'i') {
      // i: submission order [2,1]; Call 2 allow; Call 1 deny
      orderedCalls = [
        { ...call2, approval: allow },
        { ...call1, approval: deny },
      ];
    } else if (PERM === 'ii') {
      // ii: submission order [1,2]; Call 2 allow; Call 1 deny
      orderedCalls = [
        { ...call1, approval: deny },
        { ...call2, approval: allow },
      ];
    } else {
      // iii: submission order [1,2]; Call 2 deny; Call 1 allow
      orderedCalls = [
        { ...call1, approval: allow },
        { ...call2, approval: deny },
      ];
    }
    decisions = orderedCalls;
    console.log(`\nMode 'identical' (permutation ${PERM}):`);
    console.log(`  Selected permutation: ${PERM}`);
    console.log(`  Submission order: [${decisions.map((d) => d.callNumber).join(', ')}] (IDs: [${decisions.map((d) => d.id).join(', ')}])`);
  } else {
    const order = toolCalls.map((t, i) => ({ id: t.id, i }));
    decisions = order.map(({ id, i }) => {
      let approval = { status: 'allow' };
      if (MODE === 'deny') {
        approval = { status: 'deny', reason: 'User rejected all changes to this tool call' };
      } else if (MODE === 'parallel') {
        if (i === 1) {
          approval = { status: 'deny', reason: 'User rejected this one' };
        } else {
          approval = { status: 'allow' };
        }
      }
      return { id, i, approval };
    });
  }

  console.log('\nDecisions to submit:');
  for (const d of decisions) {
    console.log(`  tool_call_id: ${d.id}${d.callNumber ? ` (Call ${d.callNumber})` : ''} (index ${d.i}) -> ${JSON.stringify(d.approval)}`);
  }

  // 11. Observe the continuation of the SAME turn using subscribeTurnEvents()
  // Cursor handling: use fromEventId to resume from the approval event
  const fromEventId = process.env.NO_CURSOR === '1' ? undefined : approvalEventId;
  console.log(`\n=== Subscribing to turn ${actualTurnId} (cursor: ${fromEventId || 'none'}) ===`);
  const sub = await subscribeTurnEvents(s.id, actualTurnId, { fromEventId });

  const resumeFrames = [];
  const beforeExecutions = calls.length;

  // Improvement 3: Explicitly manage the async iterator so timeout can release it cleanly
  const iter = sub[Symbol.asyncIterator]();
  let timedOut = false;
  let streamCompleted = false;

  const subscriberPromise = (async () => {
    try {
      while (!timedOut && !streamCompleted) {
        const { value: frame, done } = await iter.next();
        if (done) {
          streamCompleted = true;
          break;
        }
        if (!frame) continue;
        resumeFrames.push(frame);
        const evtType = typeOf(frame);
        if (evtType === 'tool.response') {
          console.log(`  [SSE] tool.response:`, frame.rawData.slice(0, 300));
        } else if (evtType === 'turn.done') {
          console.log(`  [SSE] turn.done reached:`, JSON.stringify(frame.data));
          streamCompleted = true;
          break;
        } else {
          console.log(`  [SSE] ${evtType}`);
        }
      }
    } finally {
      // Normal SSE cleanup: ensure iterator is explicitly closed when reading completes
      if (!timedOut) {
        await closeIteratorSafely(iter, 2000);
      }
    }
    return resumeFrames;
  })();

  // Attach immediate rejection handler to prevent unhandled rejection if submission fails early,
  // while preserving original error observation when subscriberPromise is awaited.
  let subscriberErr = null;
  subscriberPromise.catch((err) => {
    subscriberErr = err;
  });

  // AbortController to actively cancel in-flight submitApprovalEvent HTTP requests on timeout
  const resumeAbortCtrl = new AbortController();

  // 10. Submit each decision using submitApprovalEvent()
  // Both decision submission and SSE observation are combined under TIMEOUT_MS
  const resumeWorkflowPromise = (async () => {
    console.log(`\n=== Submitting approval event(s) to turn ${actualTurnId} ===`);
    for (const item of decisions) {
      if (timedOut || resumeAbortCtrl.signal.aborted) break;
      console.log(`  Submitting decision for tool_call_id '${item.id}'...`);
      const res = await submitApprovalEvent(
        s.id,
        actualTurnId,
        threadId,
        item.id,
        item.approval,
        { signal: resumeAbortCtrl.signal }
      );
      console.log(`  -> submitApprovalEvent HTTP ${res.status}`);
    }
    return await subscriberPromise;
  })();

  // Bounded execution: timeout covers both approval submission and SSE observation
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      resumeAbortCtrl.abort(); // Immediately cancel any in-flight approval fetch
      reject(new Error(`Turn resume workflow (approval submission + SSE observation) timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
  });

  try {
    await Promise.race([resumeWorkflowPromise, timeoutPromise]);
  } catch (err) {
    if (!resumeAbortCtrl.signal.aborted) {
      resumeAbortCtrl.abort();
    }
    if (timedOut) {
      console.warn(`[TIMEOUT] Resume workflow timed out after ${TIMEOUT_MS}ms.`);
      // 1. FIRST interrupt the underlying SSE stream via bounded TrueForge session cancellation.
      // Verified in scripts/spike/openapi-local.json: POST /api/v1/sessions/{session_id}/cancel
      // Bounded wait and abortable fetch ensure cancel itself cannot hang indefinitely.
      const cancelRes = await cancelSessionBounded(s.id, 5000);
      if (!cancelRes || !cancelRes.ok) {
        console.warn(`[TIMEOUT] TrueForge session cancel unconfirmed (timed out or failed); SSE reader cannot be guaranteed released.`);
      }

      // 2. SECOND, clean up the async iterator with a bounded wait.
      // Do not await iter.return() before the read is interrupted, as a pending iter.next()
      // would block iter.return() indefinitely.
      await closeIteratorSafely(iter, 2000);
    } else {
      // For any non-timeout error (e.g. submit failure), attempt bounded cancel and close iterator
      const cancelRes = await cancelSessionBounded(s.id, 5000);
      if (subscriberErr && subscriberErr !== err) {
        console.warn(`[CLEANUP] Background subscriber error:`, subscriberErr);
      }
      await closeIteratorSafely(iter, 2000);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Normal completion cleanup: ensure iterator is safely closed if not already done
  await closeIteratorSafely(iter, 2000);

  // 12. Detect turn.done using typeOf(frame), not frame.event alone
  const doneFrame = findDone(resumeFrames);
  if (!doneFrame || typeOf(doneFrame) !== 'turn.done') {
    throw new Error('Did not detect turn.done in resume frames');
  }
  console.log('\nResume event summary:', summarize(resumeFrames));
  console.log('Final turn.done payload:', JSON.stringify(doneFrame.data, null, 2));
  console.log(`Final turn status: ${doneFrame.data?.state || doneFrame.data?.status || 'done'}`);

  // 13. Count actual handler executions using calls.length differences
  const actualExecutions = calls.length - beforeExecutions;
  console.log(`\n=== Execution verification ===`);
  console.log(`MCP executions during resume: ${actualExecutions}`);
  calls.slice(beforeExecutions).forEach((c, idx) => {
    console.log(`  [call #${idx + 1}] tool=${c.tool} args=${JSON.stringify(c.args)} meta=${JSON.stringify(c.meta)}`);
  });

  // 14. Assert expected counts: allow=1, deny=0, wait=1, parallel=2, identical=1
  const expectedExecutions = EXPECTED_EXECS[MODE];
  console.log(`Mode '${MODE}'${MODE === 'identical' ? ` (PERM='${PERM}')` : ''} assertion: actual=${actualExecutions}, expected=${expectedExecutions}`);
  if (actualExecutions !== expectedExecutions) {
    throw new Error(`Assertion failed for MODE='${MODE}': expected ${expectedExecutions} MCP execution(s), got ${actualExecutions}`);
  }
  console.log(`Execution count assertion passed (${actualExecutions} === ${expectedExecutions}).`);

  // 15. Save new fixtures without overwriting any existing fixture
  saveFixture(`${fixturePrefix}-resume-sse.jsonl`, fixtureLines(resumeFrames));

  console.log(`\nWorkflow for MODE='${MODE}' completed successfully.`);
} finally {
  // 16. Always clean up with await closeMcpServer(srv) in finally
  if (srv) {
    console.log(`\nCleaning up MCP server...`);
    await closeMcpServer(srv);
    console.log(`MCP server closed.`);
  }
}
