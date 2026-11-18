// Q4 / Q5 / Q6 / Q14 / Q15: approval pause + resume.
// MODE = allow (default) | deny | parallel | identical | wait
//   allow     one gated call -> pause -> resume allow            -> fixtures 03-approval-required, 03-allow
//   deny      one gated call -> pause -> resume deny + reason     -> 03-deny
//   parallel  3 different gated calls in ONE message, mixed decisions (Q5)
//   identical 2 identical gated calls, decisions given in reverse order (03b)
//   wait      like allow but waits WAIT_MIN minutes (default 10) before resuming (Q6)
// Run: $env:MODE="deny"; node scripts/spike/03-approval.mjs
import { MCP_URL, MCP_TOKEN, pickModel, registerMcp, upsertAgent, newSession, streamTurn, saveFixture, fixtureLines, summarize, findDone, findApproval, typeOf, sleep } from './_lib.mjs';
import { startMcpServer, calls } from './mcp-server.mjs';
const MODE = process.env.MODE || 'allow';
const PROMPTS = {
  allow: "Call the gated_echo tool with text 'one' and tell me the result.",
  deny: "Call the gated_echo tool with text 'one' and tell me the result.",
  wait: "Call the gated_echo tool with text 'one' and tell me the result.",
  parallel: "In ONE single message, call the gated_echo tool three times in parallel with the texts 'a', 'b' and 'c'. Then summarise the three results.",
  identical: "In ONE single message, call the gated_echo tool twice in parallel, both times with exactly the text 'same'. Then summarise the results.",
};
if (!PROMPTS[MODE]) { console.error('unknown MODE', MODE); process.exit(1); }
const model = await pickModel();
const srv = await startMcpServer();
try {
  await registerMcp('forge-spike', MCP_URL, MCP_TOKEN);
  await upsertAgent('spike-approval', {
    model: { name: model },
    instructions: 'You can call tools. Follow the user instructions about tool calls exactly. If a tool result says the user rejected it, say so honestly.',
    mcp_servers: [{ name: 'forge-spike', preload: true, require_approval_for_tools: ['gated_echo'] }],
  });
  const s = await newSession('spike-approval');
  console.log('session:', s.id, ' MODE =', MODE);
  const f1 = await streamTurn(s.id, { input: [{ type: 'user.message', content: PROMPTS[MODE] }], previous_turn_id: 'auto' });
  saveFixture(`03-${MODE}-turn1.jsonl`, fixtureLines(f1));
  console.log('turn 1 event counts:', summarize(f1));
  const done1 = findDone(f1); console.log('turn 1 turn.done:', JSON.stringify(done1 && done1.data));
  const appr = findApproval(f1);
  console.log('\nRAW tool.approval_required (Q4/F15 - is there a tool name or arguments?):\n', JSON.stringify(appr && appr.data, null, 2));
  if (!appr) { console.log('NO approval event. Either the model did not call the tool or gating is not honoured -> read the fixture. (If gating is ignored: ADR-2b.)'); process.exit(3); }
  console.log(`\nMCP handler executed BEFORE any decision: ${calls.length} call(s)  (must be 0 -> the pause really happens before execution)`);

  const d = appr.data;
  const toolCalls = d.toolCalls || d.tool_calls || [];
  const threadId = d.threadId || d.thread_id || 'main';
  console.log(`pending approvals: ${toolCalls.length} (Q5)`);
  // print the merged model.message(s) that carry the call(s), so we can see names + args (F15 primary path)
  const srcIds = new Set(toolCalls.map((t) => t.sourceEventId || t.source_event_id));
  for (const f of f1) if (f.data && srcIds.has(f.data.id)) console.log('  frame for sourceEventId', f.data.id, '->', f.rawData.slice(0, 700));

  if (MODE === 'wait') { const m = Number(process.env.WAIT_MIN || 10); console.log(`waiting ${m} min before resuming (Q6)...`); await sleep(m * 60_000); }

  // decisions
  let order = toolCalls.map((t, i) => ({ id: t.id, i }));
  if (MODE === 'identical') order = order.reverse(); // resume in reverse order: [2,1]
  const input = order.map(({ id, i }) => {
    let approval = { status: 'allow' };
    if (MODE === 'deny') approval = { status: 'deny', reason: 'User rejected all changes to this tool call' };
    if ((MODE === 'parallel' || MODE === 'identical') && i === 1) approval = { status: 'deny', reason: 'User rejected this one' };
    return { type: 'user.tool_approval', thread_id: threadId, tool_call_id: id, approval };
  });
  console.log('\nresuming with input:', JSON.stringify(input));
  const before = calls.length;
  const f2 = await streamTurn(s.id, { input, previous_turn_id: 'auto' });
  saveFixture(`03-${MODE}-resume.jsonl`, fixtureLines(f2));
  console.log('resume event counts:', summarize(f2));
  console.log('resume turn.done:', JSON.stringify((findDone(f2) || {}).data));
  console.log(`\nMCP handler executed during resume: ${calls.length - before} call(s)`);
  calls.slice(before).forEach((c, k) => console.log(`  exec #${k + 1}: ${c.tool} args=${JSON.stringify(c.args)} meta=${JSON.stringify(c.meta)}`));
  for (const f of f2) if (typeOf(f) === 'tool.response') console.log('  tool.response:', f.rawData.slice(0, 400));
  console.log('\nExpected: allow -> 1 exec; deny -> 0 exec and the deny reason appears as the tool result; parallel -> 2 exec (a,c); identical -> 1 exec.');
} finally { srv.close(); }
