import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {alexaPublicCaddyfile,alexaPublicReadPaths,alexaPublicWritePaths} from '../src/lib/alexa-public-https.mjs';
const doc={core:{ports:{api:3101}},plugins:{alexa:{enabled:true,publicDomain:'music.example.com'}}};
test('public proxy preserves local443, provisions public TLS and uses explicit methods/routes',()=>{
 const value=alexaPublicCaddyfile(doc);assert.match(value,/https_port 9443/);assert.match(value,/disable_http_challenge/);assert.match(value,/acme-v02.api.letsencrypt.org/);assert.match(value,/respond 404/);
 assert.ok(!alexaPublicReadPaths.includes('/config/runtime/admin'));
 assert.ok(!alexaPublicWritePaths.includes('/config/runtime'));
 assert.ok(!value.includes('/v1/'));assert.ok(!value.includes('/__controller/'));assert.ok(!value.includes('/config.html'));
 assert.equal(alexaPublicCaddyfile({...doc,plugins:{alexa:{enabled:false}}}),null);
 for(const domain of ['evil.test {\nrespond 200','sonuvi.local','https://example.com','127.0.0.1'])assert.throws(()=>alexaPublicCaddyfile({...doc,plugins:{alexa:{enabled:true,publicDomain:domain}}}));
});
test('all skill API requests have a deliberate public route',async()=>{
 const source=await fs.readFile(new URL('../alexa/lib/api.js',import.meta.url),'utf8');
 for(const match of source.matchAll(/API_BASE \+ '([^']+)'/g))assert.ok([...alexaPublicReadPaths,...alexaPublicWritePaths,'/config/diagnostics/playback'].includes(match[1]),match[1]);
 // Diagnostic payloads may contain private state: intentionally not exposed.
 assert.ok(!alexaPublicReadPaths.includes('/config/diagnostics/playback'));
});
