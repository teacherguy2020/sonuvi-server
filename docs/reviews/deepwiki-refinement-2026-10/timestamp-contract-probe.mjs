// Read-only route probe: mocked catalog/history; no HTTP listener, device, or persistent state.
import assert from 'node:assert/strict';
import { registerMobileRoutes } from '../../../src/routes/mobile.routes.mjs';
import { createMobileSessionToken } from '../../../src/lib/mobile-auth.mjs';
const routes = new Map();
const app = Object.fromEntries(['get','post','delete'].map(method => [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]));
const apiSecret = 'fictional-audit-test-only';
let observed;
registerMobileRoutes(app, {
  enabled: true, apiSecret, trackIdSecret: 'fictional-track-test-only',
  getBrowseIndex: async () => ({ tracks: [{ file: 'audit/track.flac', artist: 'Fixture', title: 'Track', album: 'Fixture', durationSec: 240 }] }),
  listeningHistory: { observe: async event => { observed = event; return { recorded: false, reason: 'probe-only' }; } },
});
const token = createMobileSessionToken({ secret: apiSecret, deviceId: 'audit-only' });
const request = (body = {}) => ({ headers: { authorization: `Bearer ${token}` }, body, query: { q: 'Track' }, params: {}, protocol: 'https', get: () => 'audit.invalid' });
const response = () => ({ statusCode: 200, body: null, status(n) { this.statusCode=n;return this; }, json(x) { this.body=x;return this; }, set(){return this;} });
const search=response();await routes.get('GET /v1/mobile/search')(request(),search);
assert.equal(search.statusCode,200);const trackId=search.body.items[0].id;
const results=[];
for (const name of ['startedAtMs','legacy-startedAt','omitted-state-and-timestamp','future-timestamp','older-than-seven-days']) {
 const before=Date.now();const wanted=before-60_000;
 const body={trackId,sessionId:`audit-${name}`,elapsedSec:60};
 if(name==='startedAtMs')body.startedAtMs=wanted;
 if(name==='legacy-startedAt')body.startedAt=wanted;
 if(name==='future-timestamp')body.startedAtMs=before+60_000;
 if(name==='older-than-seven-days')body.startedAtMs=before-8*86400000;
 const res=response();await routes.get('POST /v1/mobile/playback/events')(request(body),res);const after=Date.now();
 assert.equal(res.statusCode,200);assert.equal(observed.status.state,'progress');
 if(name==='startedAtMs')assert.equal(observed.startedAtMs,wanted);
 else if(name==='older-than-seven-days')assert.ok(observed.startedAtMs>=before-7*86400000 && observed.startedAtMs<=after-7*86400000);
 else assert.ok(observed.startedAtMs>=before && observed.startedAtMs<=after);
 results.push({case:name,status:res.statusCode,state:observed.status.state,outcome:name==='startedAtMs'?'preserved':name==='older-than-seven-days'?'clamped-to-seven-day-window':'request-time',passed:true});
}
console.log(JSON.stringify({scope:'mocked Server handler only; not an observed iOS payload',results},null,2));
