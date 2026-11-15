import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMillsRoutes, getMillsIntegrationState } from '../src/routes/mills.routes.mjs';
import { registerSeeburgRoutes, jukeboxEntries } from '../src/routes/seeburg.routes.mjs';
import { registerMultiphoneRoutes } from '../src/routes/multiphone.routes.mjs';

function fixture({ switchInput, initialState = 'play' } = {}) {
  jukeboxEntries.clear();
  const routes = {}, commands = [], inputs = [];
  const app = { post: (p, f) => { routes[p] = f; }, get() {} };
  let items = [{ id: 1, file: 'House/One.flac' }, { id: 2, file: 'House/Two.flac' }];
  let id = 1, state = initialState, elapsed = 42, nextId = 100;
  const status = () => ({ state, song: items.findIndex(x => x.id === id), songid: id, elapsed, playlistlength: items.length });
  const block = x => `file: ${x.file}\nId: ${x.id}\nPos: ${items.indexOf(x)}\n`;
  const parse = raw => Object.fromEntries(raw.split('\n').filter(x => x.includes(': ')).map(x => { const i = x.indexOf(': '); return [x.slice(0,i).toLowerCase(),x.slice(i+2)]; }));
  const query = async cmd => {
    commands.push(cmd);
    if (cmd === 'status') return Object.entries(status()).map(([k,v]) => `${k}: ${v}`).join('\n')+'\nOK\n';
    if (cmd === 'playlistinfo') return items.map(block).join('\n')+'OK\n';
    if (cmd.startsWith('playlistid ')) return items.filter(x => x.id === Number(cmd.split(' ')[1])).map(block).join('\n')+'OK\n';
    if (cmd.startsWith('listplaylist ')) {
      const source = JSON.parse(cmd.slice(13)).split(' ')[0];
      return [1,2,3].map(n => `file: ${source}/${n}.flac`).join('\n')+'\nOK\n';
    }
    if (cmd.startsWith('addid ')) { const x = { id: nextId++, file: JSON.parse(cmd.slice(6)) }; items.push(x); return `Id: ${x.id}\nOK\n`; }
    if (cmd.startsWith('moveid ')) { const [,i,p] = cmd.split(' ').map(Number); const [x] = items.splice(items.findIndex(x => x.id === i),1); items.splice(p,0,x); return 'OK\n'; }
    if (cmd.startsWith('deleteid ')) { items = items.filter(x => x.id !== Number(cmd.slice(9))); return 'OK\n'; }
    if (cmd === 'clear') { items = []; id = 0; state = 'stop'; elapsed = 0; return 'OK\n'; }
    if (cmd.startsWith('playid ') || cmd.startsWith('play ')) { const n = Number(cmd.split(' ')[1]); id = cmd.startsWith('playid ') ? n : items[n].id; elapsed = 0; state = 'play'; return 'OK\n'; }
    if (cmd === 'pause 1') { state = 'pause'; return 'OK\n'; }
    if (cmd === 'pause 0') { state = 'play'; return 'OK\n'; }
    throw Error('Unexpected MPD command '+cmd);
  };
  const deps = { requireTrackKey: () => true, mpdQueryRaw: query, mpdEscapeValue: JSON.stringify,
    mpdHasACK: raw => raw.includes('ACK'), parseMpdFirstBlock: parse, jukeboxStatePath: null,
    getMillsIntegrationState, entries: jukeboxEntries,
    switchDenonInput: async input => { inputs.push(input); await switchInput?.(input); } };
  registerSeeburgRoutes(app,deps); registerMultiphoneRoutes(app,deps); registerMillsRoutes(app,deps);
  const call = async (route,body = {}) => { const res = { statusCode:200,status(n) { this.statusCode=n;return this; },json(x) { this.body=x;return this; } }; await routes['/integrations/'+route]({body},res); assert.equal(res.statusCode,200,JSON.stringify(res.body));return res.body; };
  return { call, commands, inputs, status, query, queue: () => items.map(x => ({...x})),
    advance: seconds => { if (state === 'play') elapsed += seconds; }, seek: n => { elapsed=n; } };
}

test('Seeburg requested during Mills stays paused rather than playing unheard', async () => {
  const f = fixture();
  await f.call('mills/start');
  try {
    const selected = await f.call('seeburg/selection',{number:1});
    assert.equal(f.status().state,'pause');
    assert.equal(selected.playbackStarted,false);
    f.advance(180);
    assert.equal(f.status().elapsed,42);
    await f.call('mills/stop');
    assert.equal(f.status().songid,selected.mpdSongId);
    assert.equal(f.status().elapsed,0);
    assert.equal(f.status().state,'play');
    assert.deepEqual(f.queue().map(x => x.file),['Seeburg/1.flac','House/One.flac','House/Two.flac']);
  } finally { await f.call('mills/stop'); }
});

for (const source of ['seeburg','multiphone']) {
  test(`${source}: two waiting requests preserve FIFO, house IDs, and start at zero`, async () => {
    const f = fixture(); await f.call('mills/start');
    try {
      const a = await f.call(source+'/selection',{number:1});
      const b = await f.call(source+'/selection',{number:2});
      assert.deepEqual(f.queue().map(x => x.id),[a.mpdSongId,b.mpdSongId,1,2]);
      assert.equal(f.status().state,'pause');
      assert.ok(!f.commands.some(c => c === 'clear' || /^play(?:id)? /.test(c)));
      f.advance(240); await f.call('mills/stop');
      assert.equal(f.status().songid,a.mpdSongId); assert.equal(f.status().elapsed,0);
      f.advance(2); assert.equal(f.status().songid,a.mpdSongId); assert.equal(f.status().elapsed,2);
      const before = f.commands.length; await f.call('mills/stop');
      assert.equal(f.commands.length,before); // Duplicate stop cannot skip the first request.
      assert.deepEqual(f.queue().map(x => x.id),[a.mpdSongId,b.mpdSongId,1,2]);
    } finally { await f.call('mills/stop'); }
  });
}

test('mixed Seeburg and Mabel requests share FIFO and delayed playNow does not duplicate or start', async () => {
  const f=fixture(); await f.call('mills/start');
  try {
    const a=await f.call('seeburg/selection',{number:1});
    const b=await f.call('multiphone/selection',{number:2,deferPlayback:true});
    const c=await f.call('seeburg/selection',{number:3});
    const confirm=await f.call('multiphone/selection',{number:2,playNow:true});
    assert.equal(confirm.mpdSongId,b.mpdSongId); assert.equal(confirm.playbackStarted,false);
    assert.deepEqual(f.queue().map(x=>x.id),[a.mpdSongId,b.mpdSongId,c.mpdSongId,1,2]);
    await f.call('mills/stop'); assert.equal(f.status().songid,a.mpdSongId);
    assert.equal(jukeboxEntries.size,3);
  } finally { await f.call('mills/stop'); }
});

test('an interrupted priority song resumes at its checkpoint before newly waiting requests', async () => {
  const f=fixture(); const first=await f.call('seeburg/selection',{number:1}); f.advance(35);
  await f.call('mills/start');
  try {
    const second=await f.call('multiphone/selection',{number:2});
    await f.call('mills/stop');
    assert.equal(f.status().songid,first.mpdSongId); assert.equal(f.status().elapsed,35);
    assert.deepEqual(f.queue().map(x=>x.id),[first.mpdSongId,second.mpdSongId,1,2]);
  } finally { await f.call('mills/stop'); }
});

for (const change of ['seek','play','clear']) {
  test(`Mills handoff preserves manual ${change} rather than restoring a stale session`, async () => {
    const f=fixture(); await f.call('mills/start');
    try {
      await f.call('seeburg/selection',{number:1});
      if (change==='seek') f.seek(90); else await f.query(change==='play'?'playid 2':'clear');
      const before=f.status(), queue=f.queue();
      await f.call('mills/stop');
      assert.deepEqual(f.status(),before); assert.deepEqual(f.queue(),queue);
    } finally { await f.call('mills/stop'); }
  });
}

test('no waiting requests resumes house playback at its original checkpoint', async () => {
  const f=fixture(); await f.call('mills/start'); await f.call('mills/stop');
  assert.equal(f.status().songid,1); assert.equal(f.status().elapsed,42); assert.equal(f.status().state,'play');
  assert.deepEqual(f.queue().map(x=>x.id),[1,2]);
});

test('requests racing Phono switching wait for the physical-source hold to be established', async () => {
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture({switchInput:async input=>{if(input==='phono'){entered();await gate;}}});
  const start=f.call('mills/start'); await started;
  const selection=f.call('seeburg/selection',{number:1});
  release(); await start;
  try { const x=await selection; assert.equal(x.playbackStarted,false); assert.equal(f.status().state,'pause'); }
  finally {await f.call('mills/stop');}
});

test('Mills with a previously paused house queue can hand off new waiting requests', async () => {
  const f=fixture({initialState:'pause'}); await f.call('mills/start');
  try {const x=await f.call('seeburg/selection',{number:1}); await f.call('mills/stop');assert.equal(f.status().songid,x.mpdSongId);assert.equal(f.status().elapsed,0);}
  finally {await f.call('mills/stop');}
});
