import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { saveStoredPlaylist } from '../src/lib/mpd-stored-playlist.mjs';

import { fixture, ACK } from './fixtures/mpd-stored-playlist.mjs';

const onlyMix = f => assert.deepEqual([...f.playlists.keys()], ['Mix']);

test('create and replace preserve ordered duplicate URIs, Unicode, quotes and backslashes; queue untouched', async () => {
  for (const initial of [{}, { Mix: ['old.flac'] }, { Mix: [] }]) {
    const f = fixture(initial);
    const tracks = ['USB/Björk/"Live" \\ take.flac', 'https://radio.test/a?x=1&b=2', 'USB/Björk/"Live" \\ take.flac'];
    const result = await f.save(tracks);
    assert.equal(result.playlistSaved, true); assert.equal(result.savedTracks, 3);
    assert.deepEqual(result.recoveryPlaylists, []); assert.deepEqual(f.playlists.get('Mix'), tracks); onlyMix(f);
    assert.equal(f.queue.files.length, 111); assert.equal(f.queue.state, 'pause');
  }
});

test('reject invalid names, empty lists and protocol-injection inputs before any MPD command', async () => {
  for (const name of ['', '../Mix', 'A\\B', '.', '..', 'A\nplay', 'sonuvi-tmp-reserved', 'x'.repeat(201)]) {
    const f=fixture();await assert.rejects(f.save(['x'], name), {code:'PLAYLIST_INVALID'});assert.equal(f.calls.length,0);
  }
  for (const tracks of [[], [''], ['x\nclear'], ['x\rplay'], ['x\0'], [null], Array(10001).fill('x')]) {
    const f=fixture();await assert.rejects(f.save(tracks),{code:'PLAYLIST_INVALID'});assert.equal(f.calls.length,0);
  }
});

test('missing command authorization or denied commands fails without stored-playlist writes', async () => {
  for (const response of ['command: playlistadd\nOK\n', ACK, 'OK MPD 0.24.0\n']) {
    const f=fixture({Mix:['old']},({verb})=>verb==='commands'?response:undefined);
    await assert.rejects(f.save());assert.deepEqual(f.playlists.get('Mix'),['old']);assert.equal(f.calls.length,1);
  }
});

test('partial construction rejection cleans only the temporary playlist and retains old destination', async () => {
  const f=fixture({Mix:['old']},({phase,verb,b})=>phase==='before'&&verb==='playlistadd'&&b==='bad'?ACK:undefined);
  await assert.rejects(f.save(['first','bad']),{code:'PLAYLIST_MPD_REJECTED'});
  assert.deepEqual(f.playlists.get('Mix'),['old']);onlyMix(f);assert(!f.calls.some(c=>c[0]==='rename'));
});

test('lost append response cleans the owned temporary when the server remains reachable', async () => {
  const f=fixture({Mix:['old']},({phase,verb})=>{if(phase==='after'&&verb==='playlistadd')throw Error('connection reset')});
  await assert.rejects(f.save(),{code:'PLAYLIST_TRANSPORT'});onlyMix(f);assert.deepEqual(f.playlists.get('Mix'),['old']);
});

test('unreachable cleanup reports retained temporary rather than claiming a clean failure', async () => {
  let offline=false;
  const f=fixture({Mix:['old']},({phase,verb})=>{if(phase==='after'&&verb==='playlistadd')offline=true;if(offline)throw Error('offline')});
  await assert.rejects(f.save(),e=>e.code==='PLAYLIST_RECOVERY_REQUIRED'&&e.recoveryPlaylists.some(n=>n.startsWith('sonuvi-tmp-')));
  assert.deepEqual(f.playlists.get('Mix'),['old']);assert.equal(f.playlists.size,2);
});

test('directory expansion or truncated temporary readback fails before destination rename', async () => {
  for (const reply of ['file: expanded-child\nOK\n','file: new.flac\n']) {
    const f=fixture({Mix:['old']},({phase,verb,a})=>phase==='before'&&verb==='listplaylistinfo'&&a.startsWith('sonuvi-tmp-')?reply:undefined);
    await assert.rejects(f.save());onlyMix(f);assert.deepEqual(f.playlists.get('Mix'),['old']);
  }
});

test('concurrent external edit before commit survives and produces conflict', async () => {
  const f=fixture({Mix:['old']},({phase,verb,a,playlists})=>{if(phase==='after'&&verb==='listplaylistinfo'&&a.startsWith('sonuvi-tmp-'))playlists.set('Mix',['external'])});
  await assert.rejects(f.save(),{code:'PLAYLIST_CONFLICT'});onlyMix(f);assert.deepEqual(f.playlists.get('Mix'),['external']);
});

test('edit racing the first rename is detected in backup and restored, not overwritten', async () => {
  const f=fixture({Mix:['old']},({phase,verb,a,playlists})=>{if(phase==='before'&&verb==='rename'&&a==='Mix')playlists.set('Mix',['external'])});
  await assert.rejects(f.save(),{code:'PLAYLIST_CONFLICT'});onlyMix(f);assert.deepEqual(f.playlists.get('Mix'),['external']);
});

test('first rename rejection cleans candidate; promotion rejection restores original and cleans candidate', async () => {
  for(const rejectOld of [true,false]) {
    const f=fixture({Mix:['old']},({phase,verb,a})=>phase==='before'&&verb==='rename'&&(rejectOld?a==='Mix':a.startsWith('sonuvi-tmp-'))?ACK:undefined);
    await assert.rejects(f.save(),{code:'PLAYLIST_MPD_REJECTED'});onlyMix(f);assert.deepEqual(f.playlists.get('Mix'),['old']);
  }
});

test('new destination promotion rejection cleans temporary without deleting a concurrent target', async () => {
  const f=fixture({},({phase,verb,a,playlists})=>{if(phase==='before'&&verb==='rename'&&a.startsWith('sonuvi-tmp-'))playlists.set('Mix',['external'])});
  await assert.rejects(f.save(),{code:'PLAYLIST_MPD_REJECTED'});onlyMix(f);assert.deepEqual(f.playlists.get('Mix'),['external']);
});

test('rollback rejection retains backup and candidate with actionable recovery names', async () => {
  const f=fixture({Mix:['old']},({phase,verb,a})=>phase==='before'&&verb==='rename'&&a!=='Mix'?ACK:undefined);
  await assert.rejects(f.save(),e=>e.code==='PLAYLIST_RECOVERY_REQUIRED'&&e.recoveryPlaylists.length===2);
  assert([...f.playlists].some(([n,v])=>n.startsWith('sonuvi-backup-')&&v[0]==='old'));assert(!f.playlists.has('Mix'));
});

test('lost rename responses retain recovery copies without blind deletion or retry', async () => {
  for(const lostOld of [true,false]) {
    const f=fixture({Mix:['old']},({phase,verb,a})=>{if(phase==='after'&&verb==='rename'&&(lostOld?a==='Mix':a.startsWith('sonuvi-tmp-')))throw Error('lost reply')});
    await assert.rejects(f.save(),e=>e.code==='PLAYLIST_RECOVERY_REQUIRED'&&e.recoveryPlaylists.includes('Mix'));
    assert(!f.calls.some(c=>c[0]==='rm'));assert([...f.playlists].some(([n,v])=>n.startsWith('sonuvi-backup-')&&v[0]==='old'));
  }
});

test('post-promotion verification failure retains previous playlist without replacing concurrent content', async () => {
  const f=fixture({Mix:['old']},({phase,verb,a,b,playlists})=>{if(phase==='after'&&verb==='rename'&&a.startsWith('sonuvi-tmp-'))playlists.set(b,['external'])});
  await assert.rejects(f.save(),{code:'PLAYLIST_RECOVERY_REQUIRED'});
  assert.deepEqual(f.playlists.get('Mix'),['external']);assert([...f.playlists.keys()].some(n=>n.startsWith('sonuvi-backup-')));
});

test('successful promotion with failed old-copy cleanup returns success plus explicit warning', async () => {
  const f=fixture({Mix:['old']},({phase,verb,a})=>phase==='before'&&verb==='rm'&&a.startsWith('sonuvi-backup-')?ACK:undefined);
  const result=await f.save();assert(result.playlistSaved);assert.equal(result.warnings.length,1);assert.equal(result.recoveryPlaylists.length,1);assert.deepEqual(f.playlists.get('Mix'),['new.flac']);
});

test('same-name concurrent save is rejected before interleaved MPD operations', async () => {
  let release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const f=fixture({},async({phase,verb})=>{if(phase==='before'&&verb==='commands'){entered();await gate}});
  const first=f.save();await started;
  await assert.rejects(f.save(),{code:'PLAYLIST_BUSY'});release();await first;onlyMix(f);
});

test('real MPD TCP client handles greetings and fragmented replies without using production network', async () => {
  const f=fixture({Mix:['old']});
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('OK MPD 0.24.0\n');let buffer='';
    socket.on('data',async chunk=>{buffer+=chunk;const index=buffer.indexOf('\n');if(index<0)return;const line=buffer.slice(0,index);buffer=buffer.slice(index+1);const response=await f.query(line);socket.write(response.slice(0,3));setTimeout(()=>socket.write(response.slice(3)),2)});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  process.env.MPD_HOST='127.0.0.1';process.env.MPD_PORT=String(server.address().port);
  try {
    const {mpdQueryRaw}=await import('../src/services/mpd.service.mjs');
    const result=await saveStoredPlaylist({query:mpdQueryRaw,playlistName:'Mix',replaceExisting:true,tracks:['USB/one.flac','https://radio.test/stream']});
    assert(result.playlistSaved);onlyMix(f);assert.deepEqual(f.playlists.get('Mix'),['USB/one.flac','https://radio.test/stream']);
  } finally {for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r))}
});
