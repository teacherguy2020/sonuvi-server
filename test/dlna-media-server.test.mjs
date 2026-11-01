import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDlnaMediaServer, persistentUdn, selectLanAddress } from '../src/lib/dlna-media-server.mjs';
import { parseSsdpSearchTarget, ssdpAliveAnnouncements } from '../src/lib/dlna-ssdp.mjs';

const fixtureIndex = {
  schema: 'now-playing.browse-index.v3', builtAt: '2026-11-01T12:00:00.000Z',
  artists: [{ key: 'Artist', name: 'Artist' }],
  albums: [{ key: 'Artist|Album', title: 'Album', artist: 'Artist' }],
  tracks: [{ file: 'USB/SamsungMoode/Artist/Album/01 - <Track>.flac', albumKey: 'Artist|Album', title: '<Track>', artist: 'Artist', album: 'Album', genre: 'Jazz', track: '1', duration: 61 }],
};

test('DLNA MediaServer uses private LAN address only', () => {
  assert.equal(selectLanAddress({ preferred: '10.0.0.4' }), '10.0.0.4');
  assert.equal(selectLanAddress({ preferred: 'sonuvi.local', interfaces: {} }), '');
});

test('SSDP parser reads the ST header rather than the ST substring in HOST', () => {
  const request = [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 1',
    'ST: urn:schemas-upnp-org:device:MediaServer:1',
    '',
    '',
  ].join('\r\n');
  assert.equal(parseSsdpSearchTarget(request), 'urn:schemas-upnp-org:device:MediaServer:1');
  assert.equal(parseSsdpSearchTarget(request.replace('MAN: "ssdp:discover"', 'MAN: "other"')), '');
});

test('SSDP announces every MediaServer identity clients can discover', () => {
  const udn = 'uuid:11111111-2222-3333-4444-555555555555';
  const announcements = ssdpAliveAnnouncements({ udn, baseUrl: 'http://10.0.0.4:3101' });
  assert.equal(announcements.length, 5);
  assert.ok(announcements.some((message) => message.includes('NT: upnp:rootdevice')));
  assert.ok(announcements.some((message) => message.includes(`NT: ${udn}`) && message.includes(`USN: ${udn}\r\n`)));
  assert.ok(announcements.some((message) => message.includes('NT: urn:schemas-upnp-org:device:MediaServer:1')));
  assert.ok(announcements.some((message) => message.includes('NT: urn:schemas-upnp-org:service:ContentDirectory:1')));
  assert.ok(announcements.some((message) => message.includes('NT: urn:schemas-upnp-org:service:ConnectionManager:1')));
});

test('DLNA device identity is stable across restarts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-dlna-'));
  const identityPath = path.join(root, 'identity.json');
  try {
    const first = await persistentUdn(identityPath);
    assert.match(first, /^uuid:/);
    assert.equal(await persistentUdn(identityPath), first);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('DLNA SCPDs match implemented ContentDirectory and ConnectionManager actions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-dlna-scpc-'));
  const app = express();
  const soapLogs = [];
  const service = createDlnaMediaServer({
    enabled: true, getBrowseIndex: async () => fixtureIndex, resolveFile: async () => '', mountRoot: root,
    identityPath: path.join(root, 'identity.json'), localAddress: '10.0.0.4', port: 3101,
    log: { info: (...entry) => soapLogs.push(entry), warn() {} },
  });
  await service.initialize();
  service.register(app, express);
  const server = await new Promise((resolve) => { const next = app.listen(0, '127.0.0.1', () => resolve(next)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const [contentScpd, connectionScpd] = await Promise.all([
      (await fetch(`${base}/dlna/content-directory.xml`)).text(),
      (await fetch(`${base}/dlna/connection-manager.xml`)).text(),
    ]);
    for (const scpd of [contentScpd, connectionScpd]) {
      assert.match(scpd, /<argumentList>/);
      assert.match(scpd, /<relatedStateVariable>/);
      assert.match(scpd, /<sendEventsAttribute>/);
      assert.doesNotMatch(scpd, /sendEvents=/);
    }
    assert.match(contentScpd, /<name>RequestedCount<\/name><direction>in<\/direction><relatedStateVariable>A_ARG_TYPE_Browse_RequestedCount/);
    assert.match(connectionScpd, /<name>ConnectionID<\/name><direction>in<\/direction><relatedStateVariable>A_ARG_TYPE_ConnectionID/);
    const soap = async (pathName, type, action, body = '') => {
      const response = await fetch(`${base}${pathName}`, { method: 'POST', headers: { 'content-type': 'text/xml', SOAPAction: `"${type}#${action}"` }, body });
      return { status: response.status, body: await response.text() };
    };
    const contentType = 'urn:schemas-upnp-org:service:ContentDirectory:1';
    const connectionType = 'urn:schemas-upnp-org:service:ConnectionManager:1';
    for (const action of ['Browse', 'GetSearchCapabilities', 'GetSortCapabilities', 'GetSystemUpdateID']) {
      const result = await soap('/dlna/content-directory/control', contentType, action, '<ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>1</RequestedCount>');
      assert.equal(result.status, 200, action);
    }
    for (const action of ['GetProtocolInfo', 'GetCurrentConnectionIDs']) {
      const result = await soap('/dlna/connection-manager/control', connectionType, action);
      assert.equal(result.status, 200, action);
    }
    const connection = await soap('/dlna/connection-manager/control', connectionType, 'GetCurrentConnectionInfo', '<ConnectionID>0</ConnectionID>');
    assert.equal(connection.status, 200);
    assert.match(connection.body, /<Direction>Output<\/Direction>/);
    assert.match(connection.body, /<Status>OK<\/Status>/);
    const missing = await soap('/dlna/connection-manager/control', connectionType, 'GetCurrentConnectionInfo', '<ConnectionID>9</ConnectionID>');
    assert.equal(missing.status, 500);
    assert.match(missing.body, /<errorCode>706<\/errorCode>/);
    const unsupported = await soap('/dlna/connection-manager/control', connectionType, 'UnsupportedAction');
    assert.equal(unsupported.status, 500);
    assert.match(unsupported.body, /<errorCode>401<\/errorCode>/);
    assert.deepEqual(soapLogs.at(-1), ['[dlna] SOAP', { service: 'ConnectionManager', action: 'UnsupportedAction', status: 500 }]);
    assert.doesNotMatch(JSON.stringify(soapLogs), /ObjectID|Track Key|track:/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DLNA browse and media routes expose only indexed read-only files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-dlna-media-'));
  const musicPath = path.join(root, 'Artist', 'Album', '01 - <Track>.flac');
  await fs.mkdir(path.dirname(musicPath), { recursive: true });
  await fs.writeFile(musicPath, 'abcdef');
  const app = express();
  const service = createDlnaMediaServer({
    enabled: true, getBrowseIndex: async () => fixtureIndex,
    resolveFile: async () => musicPath, mountRoot: root,
    identityPath: path.join(root, 'identity.json'), localAddress: '10.0.0.4', port: 3101, log: { info() {}, warn() {} },
  });
  await service.initialize();
  service.register(app, express);
  const server = await new Promise((resolve) => { const next = app.listen(0, '127.0.0.1', () => resolve(next)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const device = await (await fetch(`${base}/dlna/device.xml`)).text();
    assert.match(device, /<friendlyName>Sonuvi Music Library<\/friendlyName>/);
    assert.match(device, /urn:schemas-upnp-org:service:ContentDirectory:1/);
    assert.match(device, new RegExp(service.udn));
    const rootResponse = await fetch(`${base}/dlna/content-directory/control`, {
      method: 'POST', headers: { 'content-type': 'text/xml', SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' },
      body: '<ObjectID>0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><StartingIndex>0</StartingIndex><RequestedCount>2</RequestedCount>',
    });
    const rootXml = await rootResponse.text();
    assert.equal(rootResponse.status, 200);
    assert.match(rootXml, /&lt;dc:title&gt;Artists&lt;\/dc:title&gt;/);
    assert.match(rootXml, /<NumberReturned>2<\/NumberReturned>/);

    const albumId = `album:${Buffer.from('Artist|Album').toString('base64url')}`;
    const albumResponse = await fetch(`${base}/dlna/content-directory/control`, {
      method: 'POST', headers: { 'content-type': 'text/xml', SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"' },
      body: `<ObjectID>${albumId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag>`,
    });
    const albumXml = await albumResponse.text();
    assert.match(albumXml, /&amp;lt;Track&amp;gt;/);
    const trackId = `track:${Buffer.from(fixtureIndex.tracks[0].file).toString('base64url')}`;
    const media = await fetch(`${base}/dlna/media/${encodeURIComponent(trackId)}`, { headers: { Range: 'bytes=1-3' } });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get('content-type'), 'audio/flac');
    assert.equal(media.headers.get('content-range'), 'bytes 1-3/6');
    assert.equal(await media.text(), 'bcd');
    assert.equal((await fetch(`${base}/dlna/media/${encodeURIComponent('track:Li4vZXRjL3Bhc3N3ZA')}`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('disabled DLNA service does not register HTTP routes', async () => {
  const app = express();
  createDlnaMediaServer({ enabled: false }).register(app, express);
  const server = await new Promise((resolve) => { const next = app.listen(0, '127.0.0.1', () => resolve(next)); });
  try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/dlna/device.xml`)).status, 404); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});
