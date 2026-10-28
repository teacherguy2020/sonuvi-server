import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const root=process.env.SONUVI_URL_TEST_SOURCE || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const helper=fs.readFileSync(path.join(root,'scripts/now-playing-art.js'),'utf8');
function art(href){const context={window:{},location:new URL(href),URL,console};vm.runInNewContext(helper,context);return context.window.NPArt;}
for(const [href,expected] of [
 ['http://sonuvi.local:8101/index.html','http://sonuvi.local:3101'],
 ['http://10.0.0.4:8101/index.html','http://10.0.0.4:3101'],
 ['http://[::1]:8101/index.html','http://[::1]:3101'],
 ['http://localhost:8000/index.html','http://localhost:3000'],
 ['http://sonuvi.local/index.html','http://sonuvi.local'],
 ['http://sonuvi.local:3101/index.html','http://sonuvi.local:3101'],
 ['https://sonuvi.local/index.html','https://sonuvi.local'],
 ['https://example.test/index.html','https://example.test'],
 ['https://example.test:8443/index.html','https://example.test:8443'],
 ['https://nowplaying-pi.example.ts.net/index.html','https://nowplaying-pi.example.ts.net'],
 ['https://moode.brianwis.com/index.html','https://moode.brianwis.com'],
]) test('API origin: '+href,()=>assert.equal(art(href).apiBase(),expected));
test('explicit API override remains authoritative',()=>assert.equal(art('https://example.test').apiBase('https://api.example.test/'),'https://api.example.test'));
test('HTTPS next-track HTTP artwork uses existing track proxy',()=>assert.equal(art('https://sonuvi.local').trackUrl('http://moode.local/coverart.php/file','USB/Music/a b.flac'),'https://sonuvi.local/art/track_640.jpg?file=USB%2FMusic%2Fa%20b.flac'));
test('HTTP artwork and safe HTTPS artwork remain unchanged',()=>{
 assert.equal(art('http://sonuvi.local:8101').trackUrl('http://moode.local/image.jpg','song.flac'),'http://moode.local/image.jpg');
 assert.equal(art('https://sonuvi.local').trackUrl('https://cdn.example.test/image.jpg','song.flac'),'https://cdn.example.test/image.jpg');
 assert.equal(art('https://sonuvi.local').trackUrl('/art/track.jpg','song.flac'),'https://sonuvi.local/art/track.jpg');
});
const pages=['app.html','index.html','player-render.html','player.html','peppy.html','config.html','controller-now-playing.html','controller-now-playing-grid.html','controller-now-playing-tablet.html','diagnostics.html','display.html','displays.html','visualizer.html','mobile.html','kiosk-designer.html'];
test('all affected pages parse and load the current shared helper before consumers',()=>{
 for(const page of pages){
  const s=fs.readFileSync(path.join(root,page),'utf8');
  assert.match(s,/scripts\/now-playing-art\.js\?v=20261028-https1/,page);
  if(s.includes('scripts/index-ui.js'))assert(s.indexOf('scripts/now-playing-art.js')<s.indexOf('scripts/index-ui.js'),page);
  for(const [index,m] of [...s.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()){
   if(/\bsrc\s*=/.test(m[1])||/type=["'](?:application\/(?:ld\+)?json|importmap)/i.test(m[1]))continue;
   new vm.Script(m[2],{filename:page+':inline-'+index});
  }
 }
});
test('affected consumers use the shared API resolver',()=>{
 for(const file of ['config.html','player.html','peppy.html','scripts/index-ui.js','scripts/diagnostics.js','display.html','displays.html','visualizer.html','mobile.html','kiosk-designer.html']){
  const s=fs.readFileSync(path.join(root,file),'utf8');
  assert.match(s,/globalThis\.NPArt\.apiBase\(\)/,file);
  assert.doesNotMatch(s,/const LAN_API_PORT|const LAN_STATIC_PORT/,file);
 }
});
test('repository proxy example routes Peppy through API and preserves web/API ports',()=>{
 const s=fs.readFileSync(path.join(root,'ops/caddy/sonuvi.Caddyfile.example'),'utf8');
 assert.match(s,/\/peppy\/\*/);
 assert.match(s,/reverse_proxy 127\.0\.0\.1:3101/);
 assert.match(s,/reverse_proxy 127\.0\.0\.1:8101/);
});
test('Diagnostics preserves entered credentials and reuses browser authorization',()=>{
 const s=fs.readFileSync(path.join(root,'scripts/diagnostics.js'),'utf8');
 assert.doesNotMatch(s,/cfg\?\.trackKey/);
 assert.match(s,/SonuviRuntimeAuth\?\.trackKey\?\.\(\)/);
 assert.match(s,/!String\(\$\('key'\)\.value \|\| ''\)\.trim\(\)/);
});

