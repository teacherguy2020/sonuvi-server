import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMillsRoutes } from '../src/routes/mills.routes.mjs';

function makeApp() {
  return {
    routes: {},
    post(path, handler) { this.routes[`POST ${path}`] = handler; },
    get(path, handler) { this.routes[`GET ${path}`] = handler; },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeMpdFixture({ state = 'stop', song = -1, elapsed = 0, queue = [] } = {}) {
  const commands = [];
  const items = queue.map((item, index) => ({ file: item.file, id: item.id || index + 1 }));
  let currentState = state;
  let currentPos = song;
  let currentElapsed = elapsed;
  let nextId = Math.max(100, ...items.map((item) => item.id)) + 1;

  const status = () => ({
    state: currentState,
    song: currentPos,
    songid: currentPos >= 0 ? Number(items[currentPos]?.id || 0) : 0,
    elapsed: currentElapsed,
  });

  const playlistInfo = () => items
    .map((item, pos) => `file: ${item.file}\nPos: ${pos}\nId: ${item.id}\n`)
    .join('\n');

  const mpdQueryRaw = async (command) => {
    commands.push(command);
    if (command === 'playlistinfo') return `${playlistInfo()}OK\n`;
    if (command.startsWith('listplaylist')) return 'file: Mills/One.flac\nfile: Mills/Two.flac\nfile: Mills/Three.flac\n';
    if (command.startsWith('addid ')) {
      const file = JSON.parse(command.slice(6));
      const id = nextId++;
      items.push({ file, id });
      return `Id: ${id}\nOK\n`;
    }
    if (command.startsWith('moveid ')) {
      const [, rawId, rawPosition] = command.split(/\s+/);
      const index = items.findIndex((item) => item.id === Number(rawId));
      if (index >= 0) {
        const [item] = items.splice(index, 1);
        items.splice(Number(rawPosition), 0, item);
        if (currentPos >= 0) currentPos = items.findIndex((entry) => entry.id === status().songid);
      }
      return 'OK\n';
    }
    if (command.startsWith('deleteid ')) {
      const id = Number(command.slice(8));
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) items.splice(index, 1);
      if (currentPos >= items.length) currentPos = items.length - 1;
      return 'OK\n';
    }
    if (command === 'clear') {
      items.length = 0;
      currentPos = -1;
      currentState = 'stop';
      return 'OK\n';
    }
    if (command.startsWith('playid ')) {
      const id = Number(command.slice(7));
      currentPos = items.findIndex((item) => item.id === id);
      currentState = 'play';
      return 'OK\n';
    }
    if (command.startsWith('play ')) {
      currentPos = Number(command.slice(5));
      currentState = 'play';
      return 'OK\n';
    }
    if (command.startsWith('seekid ')) {
      currentElapsed = Number(command.split(/\s+/)[2]);
      return 'OK\n';
    }
    if (command === 'pause 0') { currentState = 'play'; return 'OK\n'; }
    if (command === 'pause 1') {
      currentState = 'pause';
      return 'OK\n';
    }
    if (command === 'stop') {
      currentState = 'stop';
      return 'OK\n';
    }
    return 'OK\n';
  };

  return {
    commands,
    getStatus: status,
    getQueue: () => items.map((item) => item.file),
    mpdQueryRaw,
  };
}

test('Mills start and stop switch Denon once and ignore duplicates', async () => {
  const app = makeApp();
  const inputs = [];
  const commands = [];
  registerMillsRoutes(app, {
    requireTrackKey: () => true,
    switchDenonInput: async (input) => { inputs.push(input); },
    mpdEscapeValue: (value) => JSON.stringify(value),
    mpdHasACK: (raw) => String(raw).includes('ACK'),
    parseMpdFirstBlock: () => ({ song: -1, state: 'stop' }),
    mpdQueryRaw: async (command) => {
      commands.push(command);
      if (command.startsWith('listplaylist')) return 'file: Mills/One.flac\nfile: Mills/Two.flac\n';
      if (command.startsWith('addid')) return 'Id: 41\n';
      return 'OK\n';
    },
  });

  let res = makeResponse();
  await app.routes['POST /integrations/mills/start']({ body: {} }, res);
  assert.deepEqual(inputs, ['phono']);
  assert.equal(res.body.switched, true);
  assert.equal(res.body.surrogateStarted, false);
  assert.equal(res.body.awaitingSelection, true);
  assert.deepEqual(commands.slice(0, 2), ['status', 'playlistinfo']);

  res = makeResponse();
  await app.routes['POST /integrations/mills/start']({ body: {} }, res);
  assert.deepEqual(inputs, ['phono']);
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.surrogateStarted, false);
  assert.equal(res.body.awaitingSelection, true);
  assert.equal(commands.length, 4);

  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.deepEqual(inputs, ['phono', 'aux1']);
  assert.equal(res.body.switched, true);

  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.deepEqual(inputs, ['phono', 'aux1']);
  assert.equal(res.body.duplicate, true);
});

test('Mills stop remains retryable when Aux 1 switching fails', async () => {
  const app = makeApp();
  let attempts = 0;
  registerMillsRoutes(app, {
    requireTrackKey: () => true,
    switchDenonInput: async (input) => {
      if (input === 'aux1' && attempts++ === 0) throw new Error('hub unavailable');
    },
    mpdEscapeValue: (value) => JSON.stringify(value),
    mpdHasACK: (raw) => String(raw).includes('ACK'),
    parseMpdFirstBlock: () => ({ song: -1, state: 'stop' }),
    mpdQueryRaw: async (command) => command.startsWith('listplaylist') ? 'file: Mills/One.flac\n' : command.startsWith('addid') ? 'Id: 42\n' : 'OK\n',
  });

  let res = makeResponse();
  await app.routes['POST /integrations/mills/start']({ body: {} }, res);
  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.equal(res.statusCode, 502);

  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.switched, true);
});

test('Mills physical selection displays the requested playlist entry without digital playback', async () => {
  const app = makeApp();
  const inputs = [];
  const commands = [];
  let nextId = 50;
  registerMillsRoutes(app, {
    requireTrackKey: () => true,
    switchDenonInput: async (input) => { inputs.push(input); },
    mpdEscapeValue: (value) => JSON.stringify(value),
    mpdHasACK: (raw) => String(raw).includes('ACK'),
    parseMpdFirstBlock: () => ({ song: -1, state: 'stop' }),
    mpdQueryRaw: async (command) => {
      commands.push(command);
      if (command.startsWith('listplaylist')) {
        return 'file: Mills/One.flac\nfile: Mills/Two.flac\nfile: Mills/Three.flac\n';
      }
      if (command.startsWith('addid')) return `Id: ${nextId++}\n`;
      if (command.startsWith('playlistid')) return 'file: Mills/Three.flac\nTitle: Three\nArtist: Mills \\\"Artist\\\"\nAlbum: Mills Album\nDate: 1975\nEncoded: FLAC\n';
      return 'OK\n';
    },
  });

  let res = makeResponse();
  await app.routes['POST /integrations/mills/start']({ body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(inputs, ['phono']);

  res = makeResponse();
  await app.routes['POST /integrations/mills/selection']({ body: { slot: 3 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.slot, 3);
  assert.equal(res.body.file, 'Mills/Three.flac');
  assert.equal(res.body.playbackStarted, false);
  assert.equal(res.body.displayOnly, true);
  assert.equal(res.body.metadata.title, 'Three');
  assert.equal(res.body.metadata.artist, 'Mills "Artist"');
  assert.deepEqual(inputs, ['phono']);
  assert.equal(commands.some((command) => /^play(?: |id )/.test(command)), false);
  assert.equal(commands.filter((command) => command.startsWith('deleteid')).length, 1);

  res = makeResponse();
  await app.routes['POST /integrations/mills/selection']({ body: { slot: 3 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.duplicate, true);
  assert.equal(commands.filter((command) => command.startsWith('addid')).length, 1);

  res = makeResponse();
  await app.routes['POST /integrations/mills/selection']({ body: { slot: 21 } }, res);
  assert.equal(res.statusCode, 400);

  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.equal(res.statusCode, 200);

  res = makeResponse();
  await app.routes['POST /integrations/mills/selection']({ body: { slot: 1 } }, res);
  assert.equal(res.statusCode, 409);
});

test('Mills allows the same slot again after the duplicate-report window', async () => {
  const app = makeApp();
  const commands = [];
  let nextId = 60;
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;

  try {
    registerMillsRoutes(app, {
      requireTrackKey: () => true,
      switchDenonInput: async () => {},
      mpdEscapeValue: (value) => JSON.stringify(value),
      mpdHasACK: (raw) => String(raw).includes('ACK'),
      parseMpdFirstBlock: () => ({ song: -1, state: 'stop' }),
      mpdQueryRaw: async (command) => {
        commands.push(command);
        if (command.startsWith('listplaylist')) return 'file: Mills/One.flac\n';
        if (command.startsWith('addid')) return `Id: ${nextId++}\n`;
        return 'OK\n';
      },
    });

    let res = makeResponse();
    await app.routes['POST /integrations/mills/start']({ body: {} }, res);
    res = makeResponse();
    await app.routes['POST /integrations/mills/selection']({ body: { slot: 1 } }, res);
    assert.equal(res.body.duplicate, false);

    now += 5001;
    res = makeResponse();
    await app.routes['POST /integrations/mills/selection']({ body: { slot: 1 } }, res);
    assert.equal(res.body.duplicate, false);
    assert.equal(commands.filter((command) => command.startsWith('addid')).length, 2);

    res = makeResponse();
    await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
    assert.equal(res.statusCode, 200);
  } finally {
    Date.now = realNow;
  }
});

test('Mills snapshots and pauses playback, waits for slots, and restores the playing session', async () => {
  const app = makeApp();
  const inputs = [];
  const fixture = makeMpdFixture({
    state: 'play',
    song: 1,
    elapsed: 42.5,
    queue: [
      { file: 'House/Before.flac', id: 10 },
      { file: 'House/Current.flac', id: 11 },
      { file: 'House/After.flac', id: 12 },
    ],
  });
  registerMillsRoutes(app, {
    requireTrackKey: () => true,
    switchDenonInput: async (input) => { inputs.push(input); },
    mpdEscapeValue: (value) => JSON.stringify(value),
    mpdHasACK: (raw) => String(raw).includes('ACK'),
    parseMpdFirstBlock: () => fixture.getStatus(),
    mpdQueryRaw: fixture.mpdQueryRaw,
  });

  let res = makeResponse();
  await app.routes['POST /integrations/mills/start']({ body: {} }, res);
  assert.equal(res.body.awaitingSelection, true);
  assert.equal(fixture.commands.filter((command) => command.startsWith('addid')).length, 0);
  assert.ok(fixture.commands.includes('pause 1'));
  assert.deepEqual(inputs, ['phono']);

  res = makeResponse();
  await app.routes['POST /integrations/mills/selection']({ body: { slot: 1 } }, res);
  assert.equal(res.body.playbackStarted, false);
  assert.equal(res.body.displayOnly, true);
  assert.equal(fixture.commands.some((command) => /^play(?: |id )/.test(command)), false);
  assert.equal(fixture.getQueue().includes('Mills/One.flac'), false);

  const originalNow = Date.now;
  Date.now = () => originalNow() + 6000;
  try {
    res = makeResponse();
    await app.routes['POST /integrations/mills/selection']({ body: { slot: 2 } }, res);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(res.body.playbackStarted, false);
  assert.ok(fixture.commands.filter((command) => command.startsWith('deleteid')).length >= 2);

  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(inputs, ['phono', 'aux1']);
  assert.deepEqual(fixture.getQueue(), ['House/Before.flac', 'House/Current.flac', 'House/After.flac']);
  assert.ok(fixture.commands.includes('pause 0'));
  assert.equal(fixture.commands.includes('clear'), false);
  assert.equal(fixture.getStatus().songid, 11);
});

test('Mills restores paused and stopped sessions without a physical selection', async () => {
  for (const initialState of ['pause', 'stop']) {
    const app = makeApp();
    const fixture = makeMpdFixture({
      state: initialState,
      song: 0,
      elapsed: 17,
      queue: [{ file: `House/${initialState}.flac`, id: 20 }],
    });
    registerMillsRoutes(app, {
      requireTrackKey: () => true,
      switchDenonInput: async () => {},
      mpdEscapeValue: (value) => JSON.stringify(value),
      mpdHasACK: (raw) => String(raw).includes('ACK'),
      parseMpdFirstBlock: () => fixture.getStatus(),
      mpdQueryRaw: fixture.mpdQueryRaw,
    });

    let res = makeResponse();
    await app.routes['POST /integrations/mills/start']({ body: {} }, res);
    res = makeResponse();
    await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(fixture.getQueue(), [`House/${initialState}.flac`]);
    if (initialState === 'pause') {
      assert.equal(fixture.getStatus().state, 'pause');
      assert.equal(fixture.commands.includes('pause 0'), false);
    } else {
      assert.equal(fixture.getStatus().state, 'stop');
      assert.equal(fixture.commands.some((command) => command.startsWith('playid')), false);
    }
  }
});

test('Mills stop remains retryable when MPD cleanup or restoration fails', async () => {
  const app = makeApp();
  const inputs = [];
  const fixture = makeMpdFixture({
    state: 'play',
    song: 0,
    elapsed: 8,
    queue: [{ file: 'House/BeforeRetry.flac', id: 30 }],
  });
  let failClear = true;
  registerMillsRoutes(app, {
    requireTrackKey: () => true,
    switchDenonInput: async (input) => { inputs.push(input); },
    mpdEscapeValue: (value) => JSON.stringify(value),
    mpdHasACK: (raw) => String(raw).includes('ACK'),
    parseMpdFirstBlock: () => fixture.getStatus(),
    mpdQueryRaw: async (command) => {
      if (command === 'pause 0' && failClear) {
        failClear = false;
        fixture.commands.push(command);
        return 'ACK [50@0] {pause} forced test failure\n';
      }
      return fixture.mpdQueryRaw(command);
    },
  });

  let res = makeResponse();
  await app.routes['POST /integrations/mills/start']({ body: {} }, res);
  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(inputs, ['phono', 'aux1']);

  res = makeResponse();
  await app.routes['POST /integrations/mills/stop']({ body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(inputs, ['phono', 'aux1', 'aux1']);
  assert.deepEqual(fixture.getQueue(), ['House/BeforeRetry.flac']);
});

for (const change of ['replace', 'resume', 'seek']) {
  test(`Mills delayed stop preserves user ${change} instead of restoring stale snapshot`, async () => {
    const app = makeApp();
    const fixture = makeMpdFixture({ state: 'play', song: 0, elapsed: 12,
      queue: [{ file: 'Old/Album.flac', id: 10 }] });
    registerMillsRoutes(app, { requireTrackKey: () => true, switchDenonInput: async () => {},
      mpdEscapeValue: JSON.stringify, mpdHasACK: raw => String(raw).includes('ACK'),
      parseMpdFirstBlock: () => fixture.getStatus(), mpdQueryRaw: fixture.mpdQueryRaw });
    await app.routes['POST /integrations/mills/start']({body:{}}, makeResponse());
    if (change === 'replace') {
      await fixture.mpdQueryRaw('clear');
      await fixture.mpdQueryRaw('addid "New/Album.flac"');
    }
    if(change==='seek')await fixture.mpdQueryRaw('seekid 10 30');
    else await fixture.mpdQueryRaw('play 0');
    const before = fixture.getQueue(); const start = fixture.commands.length;
    const res = makeResponse();
    await app.routes['POST /integrations/mills/stop']({body:{}}, res);
    assert.equal(res.statusCode, 200); assert.equal(res.body.active, false);
    assert.deepEqual(fixture.getQueue(), before); assert.equal(fixture.getStatus().state, change==='seek'?'pause':'play');
    assert.equal(fixture.commands.slice(start).some(c => /^(clear$|play(?: |id )|seekid |pause |stop$|addid )/.test(c)), false);
  });
}

 test('Mills resume uses post-switch pause checkpoint, preserving amplifier-switch elapsed time and queue IDs', async () => {
  const app=makeApp();
  const fixture=makeMpdFixture({state:'play',song:0,elapsed:12,queue:[{file:'House/Current.flac',id:10}]});
  registerMillsRoutes(app,{requireTrackKey:()=>true,switchDenonInput:async input=>{
    if(input==='phono')await fixture.mpdQueryRaw('seekid 10 15.5');
  },mpdEscapeValue:JSON.stringify,mpdHasACK:raw=>String(raw).includes('ACK'),
  parseMpdFirstBlock:()=>fixture.getStatus(),mpdQueryRaw:fixture.mpdQueryRaw});
  await app.routes['POST /integrations/mills/start']({body:{}},makeResponse());
  const res=makeResponse();await app.routes['POST /integrations/mills/stop']({body:{}},res);
  assert.equal(res.statusCode,200);assert.equal(fixture.getStatus().state,'play');
  assert.equal(fixture.getStatus().elapsed,15.5);assert.equal(fixture.getStatus().songid,10);
  assert.equal(fixture.commands.includes('clear'),false);
 });
