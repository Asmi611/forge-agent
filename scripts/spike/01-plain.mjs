// Q2 (plain half): create an agent with NO tools, create a session, stream one turn "say hi".
// Saves fixtures/events/01-plain.jsonl.  Needs TF_MODEL (run once without it to list models).
import { pickModel, upsertAgent, newSession, streamTurn, saveFixture, fixtureLines, summarize, findDone, turnIdOf } from './_lib.mjs';
const model = await pickModel();
await upsertAgent('spike-plain', { model: { name: model }, instructions: 'You are a concise assistant.' });
const s = await newSession('spike-plain');
console.log('session:', s.id);
const frames = await streamTurn(s.id, { input: [{ type: 'user.message', content: 'say hi' }], previous_turn_id: 'auto' });
saveFixture('01-plain.jsonl', fixtureLines(frames));
console.log('event type counts:', summarize(frames));
console.log('turn id:', turnIdOf(frames));
console.log('turn.done:', JSON.stringify(findDone(frames) && findDone(frames).data));
console.log('\nOpen http://localhost:8790 -> Sessions and check this session is visible (Q16).');
