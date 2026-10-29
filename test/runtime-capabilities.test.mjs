import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApnsProvider } from '../src/lib/apns.mjs';
import { createLastfmScrobbler } from '../src/lib/lastfm-scrobbler.mjs';
import { createLocalPibuzBridgeClient } from '../src/local-client.mjs';
import { execFileStrict } from '../src/lib/exec.mjs';
import { createQobuzConnectController } from '../src/lib/qobuz-connect-control.mjs';
import {
  CapabilityDeniedError,
  createRuntimeCapabilities,
  rehearsalReadOnlyMiddleware,
} from '../src/lib/runtime-capabilities.mjs';
import { UpnpControlPoint } from '../src/lib/upnp-control-point.mjs';
import { mpdQueryRaw } from '../src/services/mpd.service.mjs';
import { HarmonyHubClient } from '../src/services/harmony.service.mjs';

function rehearsalCapabilities(stateRoot = '/synthetic/rehearsal-state') {
  return createRuntimeCapabilities({
    env: {
      SONUVI_EXECUTION_MODE: 'rehearsal',
      SONUVI_REHEARSAL_STATE_ROOT: stateRoot,
    },
  });
}

function assertDenied(error) {
  assert.equal(error instanceof CapabilityDeniedError, true);
  assert.equal(error.code, 'SONUVI_REHEARSAL_DENIED');
  return true;
}

test('rehearsal capability policy defaults to deny and scopes synthetic writes', (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sonuvi-rehearsal-state-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const capabilities = rehearsalCapabilities(stateRoot);
  assert.equal(capabilities.rehearsal, true);
  assert.throws(() => capabilities.assertExternalMutation('mpd.write'), assertDenied);
  assert.throws(() => capabilities.assertExternalMutation('unclassified-adapter'), assertDenied);
  assert.throws(() => capabilities.assertExternalRead('upnp.read'), assertDenied);
  assert.throws(() => capabilities.assertBackgroundMutation('notification'), assertDenied);
  assert.equal(capabilities.assertStateWrite(path.join(stateRoot, 'data/fixture.json')), true);
  assert.throws(() => capabilities.assertStateWrite('/tmp/not-a-rehearsal-fixture'), assertDenied);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sonuvi-rehearsal-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(stateRoot, 'escape'));
  assert.throws(() => capabilities.assertStateWrite(path.join(stateRoot, 'escape', 'fixture.json')), assertDenied);
  assert.throws(
    () => createRuntimeCapabilities({ env: { SONUVI_EXECUTION_MODE: 'surprise' } }),
    /must be production or rehearsal/,
  );
});

test('production capabilities preserve normal integrations while rehearsal blocks the shared process helper', (t) => {
  const production = createRuntimeCapabilities({ env: {} });
  assert.equal(production.assertExternalMutation('mpd.write'), true);
  assert.equal(production.assertExternalRead('metadata.read'), true);
  assert.equal(production.assertBackgroundMutation('notification'), true);
  assert.equal(production.assertStateWrite('/any/normal/path'), true);

  const previousMode = process.env.SONUVI_EXECUTION_MODE;
  process.env.SONUVI_EXECUTION_MODE = 'rehearsal';
  t.after(() => {
    if (previousMode === undefined) delete process.env.SONUVI_EXECUTION_MODE;
    else process.env.SONUVI_EXECUTION_MODE = previousMode;
  });
  assert.throws(() => execFileStrict(process.execPath, ['--version']), assertDenied);
});

test('rehearsal HTTP backstop allows only safe methods', () => {
  const middleware = rehearsalReadOnlyMiddleware({ capabilities: rehearsalCapabilities() });
  let nextCalls = 0;
  const safeResponse = { status() { throw new Error('safe request should continue'); } };
  middleware({ method: 'GET' }, safeResponse, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);

  const response = {
    statusCode: 0,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  middleware({ method: 'POST' }, response, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'SONUVI_REHEARSAL_READ_ONLY');
});

test('core remote mutation adapters deny rehearsal side effects before network activity', async (t) => {
  const capabilities = rehearsalCapabilities();
  let fetchCalls = 0;
  let commandCalls = 0;
  let socketCalls = 0;

  const scrobbler = createLastfmScrobbler({
    apiKey: 'fixture-key',
    apiSecret: 'fixture-secret',
    sessionKey: 'fixture-session',
    capabilities,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('network must not be reached');
    },
  });
  await assert.rejects(
    () => scrobbler.submit({
      artist: 'Artist',
      title: 'Track',
      durationSec: 300,
      elapsedSec: 180,
      startedAtMs: Date.now() - 180000,
    }),
    assertDenied,
  );

  const apns = createApnsProvider({
    keyId: 'fixture-key-id',
    teamId: 'fixture-team-id',
    privateKey: 'fixture-private-key',
    topic: 'com.example.fixture',
    capabilities,
    request: async () => {
      fetchCalls += 1;
      return { status: 200, body: '', headers: {} };
    },
  });
  await assert.rejects(
    () => apns.send({ deviceToken: 'a'.repeat(64), payload: { aps: { alert: 'fixture' } } }),
    assertDenied,
  );

  const qobuz = createQobuzConnectController({
    sshUser: 'fixture-user',
    sshHost: 'fixture-host',
    capabilities,
    runCommand: async () => {
      commandCalls += 1;
      return { stdout: 'submitted\nreleased\nrestarted\nready\n' };
    },
  });
  await assert.rejects(() => qobuz.release(), assertDenied);

  const harmony = new HarmonyHubClient({
    host: 'fixture-host',
    hubId: 'fixture-hub',
    capabilities,
  });
  await assert.rejects(() => harmony.sendWithoutResponse('fixture-command'), assertDenied);
  await assert.rejects(() => harmony.connect(), assertDenied);

  const bridge = createLocalPibuzBridgeClient({
    capabilities,
    connectRequest: async () => {
      socketCalls += 1;
      return '{}';
    },
  });
  assert.throws(() => bridge.loadSavedQueue({}), assertDenied);
  assert.throws(() => bridge.getStatus('fixture-operation'), assertDenied);
  assert.throws(() => bridge.getOwnership(), assertDenied);

  const upnp = new UpnpControlPoint({ capabilities });
  await assert.rejects(
    () => upnp.transportAction('unregistered-device', 'Play', { InstanceID: 0, Speed: '1' }),
    assertDenied,
  );

  assert.equal(fetchCalls, 0);
  assert.equal(commandCalls, 0);
  assert.equal(socketCalls, 0);

  const previousMode = process.env.SONUVI_EXECUTION_MODE;
  process.env.SONUVI_EXECUTION_MODE = 'rehearsal';
  t.after(() => {
    if (previousMode === undefined) delete process.env.SONUVI_EXECUTION_MODE;
    else process.env.SONUVI_EXECUTION_MODE = previousMode;
  });
  await assert.rejects(() => mpdQueryRaw('play'), assertDenied);
});
