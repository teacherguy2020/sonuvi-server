import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

test('reads complete large MPD query responses before disconnecting', async () => {
  const largeResponse = Array.from({ length: 140 }, (_, i) =>
    `file: USB/Pat Metheny Group/track-${String(i + 1).padStart(3, '0')}.flac\n` +
    'Artist: Pat Metheny Group\n' +
    'AlbumArtist: Pat Metheny Group\n' +
    `Album: Album ${Math.floor(i / 10) + 1}\n` +
    `Title: Track ${i + 1}\n`,
  ).join('');

  const server = net.createServer((socket) => {
    socket.write('OK MPD 0.24.0\n');
    socket.on('data', (data) => {
      if (String(data).includes('find albumartist')) {
        socket.write(`${largeResponse}OK\n`);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.MPD_HOST = '127.0.0.1';
  process.env.MPD_PORT = String(address.port);

  try {
    const { mpdQueryRaw } = await import(`../src/services/mpd.service.mjs?large-response=${Date.now()}`);
    const raw = await mpdQueryRaw('find albumartist "Pat Metheny Group"', 2000);
    assert.equal((raw.match(/^file:/gm) || []).length, 140);
    assert.ok(raw.length > 16 * 1024);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Mills hold blocks every MPD playback form at socket boundary, including command lists', async () => {
  const { mpdQueryRawAt, setMpdPlaybackHoldProvider } = await import('../src/services/mpd.service.mjs');
  const received=[];
  const server=net.createServer(socket=>{
    socket.write('OK MPD 0.24.0\n');
    socket.on('data',data=>{received.push(String(data).trim());socket.write('OK\n');});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const options={host:'127.0.0.1',port:server.address().port};
  let held=true;setMpdPlaybackHoldProvider(()=>held);
  try {
    for(const command of ['play','play 0','playid 147','pause 0','pause','next','previous','seekid 147 0','command_list_begin\nplayid 147\ncommand_list_end']) {
      await assert.rejects(mpdQueryRawAt(command,options),{code:'MILLS_PLAYBACK_HELD'});
    }
    assert.deepEqual(received,[]);
    await mpdQueryRawAt('status',options);await mpdQueryRawAt('pause 1',options);
    assert.deepEqual(received,['status','pause 1']);
    held=false;await mpdQueryRawAt('playid 147',options);
    assert.equal(received.at(-1),'playid 147');
  } finally {setMpdPlaybackHoldProvider(()=>false);await new Promise(resolve=>server.close(resolve));}
});

test('Mills acquired while waiting for MPD greeting still prevents command transmission', async () => {
  const { mpdQueryRawAt, setMpdPlaybackHoldProvider } = await import('../src/services/mpd.service.mjs');
  let held=false,received='';
  const server=net.createServer(socket=>{
    held=true;socket.write('OK MPD 0.24.0\n');
    socket.on('data',data=>{received+=data;socket.write('OK\n');});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  setMpdPlaybackHoldProvider(()=>held);
  try {
    await assert.rejects(mpdQueryRawAt('playid 147',{host:'127.0.0.1',port:server.address().port}),{code:'MILLS_PLAYBACK_HELD'});
    assert.equal(received,'');
  } finally {setMpdPlaybackHoldProvider(()=>false);await new Promise(resolve=>server.close(resolve));}
});
