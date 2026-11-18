// Q1 / Q13: what does the local TrueForge expose? Run: node scripts/spike/00-discover.mjs
import { api, BASE } from './_lib.mjs';
console.log('TrueForge base URL:', BASE);
for (const p of ['/api/v1/capabilities', '/api/v1/auth/me', '/api/v1/models', '/api/v1/settings/model-providers', '/api/v1/settings/mcp-servers', '/api/v1/agents']) {
  const r = await api('GET', p, undefined, { allowFail: true }).catch((e) => ({ status: 'NETWORK ERROR', json: String(e) }));
  console.log(`\nGET ${p} -> ${r.status}\n${JSON.stringify(r.json, null, 2).slice(0, 1800)}`);
}
console.log('\nAPI docs (open in browser):', BASE + '/api/v1/docs');
