// Q7: cancel while streaming, cancel again (idempotent), cancel when nothing runs.
import { api, pickModel, upsertAgent, newSession, streamTurn, saveFixture, fixtureLines, summarize, findDone, typeOf } from './_lib.mjs';
const model = await pickModel();
await upsertAgent('spike-plain', { model: { name: model }, instructions: 'You are a concise assistant.' });
const s = await newSession('spike-plain');
let cancelled = false; let t0 = 0; let cancelResp;
const frames = await streamTurn(s.id, { input: [{ type: 'user.message', content: 'Write a 600 word story about a lighthouse.' }], previous_turn_id: 'auto' }, {
  onEvent: (f) => {
    if (!cancelled && typeOf(f) === 'model.message.delta') {
      cancelled = true; t0 = Date.now();
      api('POST', `/api/v1/sessions/${s.id}/cancel`, {}, { allowFail: true }).then((r) => { cancelResp = r; console.log(`cancel -> HTTP ${r.status} in ${Date.now() - t0} ms`, JSON.stringify(r.json)); });
    }
  },
});
saveFixture('04-cancel.jsonl', fixtureLines(frames));
console.log('event counts:', summarize(frames));
console.log('turn.done:', JSON.stringify((findDone(frames) || {}).data), ' (expect state "cancelled")');
const again = await api('POST', `/api/v1/sessions/${s.id}/cancel`, {}, { allowFail: true });
console.log('second cancel (idempotent?) -> HTTP', again.status, JSON.stringify(again.json));
console.log('\nSave these results into docs/spike-report.md Q7.');
