// Q3 / Q14 / Q15 / Q17: can TrueForge call OUR local MCP server (127.0.0.1, custom header) registered via the API?
// Starts the echo MCP server, registers it, creates an agent with preload:true, runs a turn that calls `echo`.
import { MCP_URL, MCP_TOKEN, pickModel, registerMcp, upsertAgent, newSession, streamTurn, saveFixture, fixtureLines, summarize, findDone } from './_lib.mjs';
import { startMcpServer, calls } from './mcp-server.mjs';
const PRELOAD = process.env.PRELOAD !== 'false'; // set $env:PRELOAD="false" for the Q17 comparison
const model = await pickModel();
const srv = await startMcpServer();
try {
  const reg = await registerMcp('forge-spike-q3', MCP_URL, MCP_TOKEN);
  console.log('registered MCP server -> HTTP', reg.status, JSON.stringify(reg.json).slice(0, 600));
  await upsertAgent('spike-tools', {
    model: { name: model },
    instructions: 'You can call tools. When the user asks you to echo something, call the echo tool and report its exact result.',
    mcp_servers: [{ name: 'forge-spike-q3', preload: PRELOAD, require_approval_for_tools: ['gated_echo'] }],
  });
  const s = await newSession('spike-tools');
  console.log('session:', s.id, ' preload =', PRELOAD);
  const frames = await streamTurn(s.id, { input: [{ type: 'user.message', content: "Call the echo tool with text 'hello' and tell me the result." }], previous_turn_id: 'auto' });
  saveFixture('diagnostic-02-mcp-tool.jsonl', fixtureLines(frames));
  console.log('event type counts:', summarize(frames));
  console.log('turn.done:', JSON.stringify(findDone(frames) && findDone(frames).data));
  console.log(`\nQ3 RESULT: MCP handler executed ${calls.length} call(s).`, calls.length ? 'TrueForge CAN call our local MCP server.' : 'NOT CALLED -> read the [mcp] REJECT lines above and the error events in the fixture.');
  if (calls[0]) console.log('Q14 evidence (does the request carry a call id?): meta =', JSON.stringify(calls[0].meta), ' extraKeys =', calls[0].extraKeys.join(','), ' headers =', JSON.stringify(calls[0].headers));
} finally { srv.close(); }
