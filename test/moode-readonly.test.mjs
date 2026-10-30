import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  isManagedReadOnlyInvocation,
  moodeReadOnlyArgs,
  resolveMoodeSshProfile,
} from '../src/lib/moode-ssh-profile.mjs';
import {
  MoodeReadUnavailableError,
  readMoodeAudioInfoSnapshot,
} from '../src/lib/moode-readonly.mjs';

const environment = {
  SONUVI_STATE_ROOT: '/opt/sonuvi/shared',
  SONUVI_SECRETS_ROOT: '/etc/sonuvi',
  SONUVI_MOODE_READONLY_PROTOCOL: 'v1',
  MOODE_SSH_HOST: '10.0.0.254',
  MOODE_SSH_USER: 'moode',
};

const successfulPayload = {
  contract: 'sonuvi.moode-readonly.v1',
  ok: true,
  operation: 'audio-info-snapshot',
  snapshot: {
    capturedAt: '2026-10-30T13:16:01Z',
    audioInfoHtml: '<div class="h5">Input / Output</div>',
    alsaProbe: 'CARD\tcard2\tDAC\nPCM\t/proc/asound/card2/pcm0p\tcard2\tDAC\tUSB Audio\tRUNNING',
    mpd: {
      state: 'play',
      source: 'USB/SamsungMoode/Album/01 - Track.flac',
      decoded: { sampleRateHz: 96000, bitDepth: 24, bitDepthKind: 'integer', channels: 2 },
    },
    collection: {
      session: { status: 'available' },
      rendererReport: { status: 'available' },
      mpd: { status: 'available' },
      alsa: { status: 'available' },
    },
  },
};

test('managed audio snapshot SSH invocation is exact and rejects altered argv', () => {
  const profile = resolveMoodeSshProfile({ env: environment });
  const args = moodeReadOnlyArgs('audio-info-snapshot', { profile });

  assert.equal(args.at(-1), 'sonuvi-readonly-v1 audio-info-snapshot');
  assert.equal(args.includes('-T'), true);
  assert.equal(args.includes('ClearAllForwardings=yes'), true);
  assert.equal(args.includes('PermitLocalCommand=no'), true);
  assert.equal(isManagedReadOnlyInvocation('/usr/bin/ssh', args, {}, { env: environment }), true);
  assert.equal(isManagedReadOnlyInvocation('ssh', args, {}, { env: environment }), false);
  assert.equal(isManagedReadOnlyInvocation('/usr/bin/ssh', [...args, 'bash -lc id'], {}, { env: environment }), false);
  assert.equal(isManagedReadOnlyInvocation('/usr/bin/ssh', args, { shell: true }, { env: environment }), false);
  assert.throws(() => moodeReadOnlyArgs('audio-info-snapshot; id', { profile }), /not approved/);
  assert.throws(
    () => moodeReadOnlyArgs('audio-info-snapshot', {
      profile: resolveMoodeSshProfile({ env: { ...environment, SONUVI_MOODE_READONLY_PROTOCOL: '' } }),
    }),
    (error) => error?.code === 'SONUVI_SSH_TRANSPORT_UNAUTHORIZED',
  );
});

test('audio snapshot client accepts only the fixed dispatcher response and never supplies a child environment', async () => {
  const calls = [];
  const snapshot = await readMoodeAudioInfoSnapshot({
    environment,
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify(successfulPayload) };
    },
  });

  assert.equal(snapshot.mpd.decoded.sampleRateHz, 96000);
  assert.equal(snapshot.collection.rendererReport.status, 'available');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/ssh');
  assert.equal(calls[0].args.at(-1), 'sonuvi-readonly-v1 audio-info-snapshot');
  assert.equal(Object.hasOwn(calls[0].options, 'env'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /PHPSESSID|sessionid/i);
});

test('audio snapshot client uses the configured endpoint when the immutable unit supplies only the protocol marker', async () => {
  const environmentWithoutEndpoint = { ...environment };
  delete environmentWithoutEndpoint.MOODE_SSH_HOST;
  delete environmentWithoutEndpoint.MOODE_SSH_USER;
  let invokedArgs = null;

  const snapshot = await readMoodeAudioInfoSnapshot({
    environment: environmentWithoutEndpoint,
    profileDefaults: { host: '10.0.0.254', user: 'moode' },
    execute: async (_command, args) => {
      invokedArgs = args;
      return { stdout: JSON.stringify(successfulPayload) };
    },
  });

  assert.equal(snapshot.collection.session.status, 'available');
  assert.equal(invokedArgs.at(-2), 'moode@10.0.0.254');
  assert.equal(invokedArgs.at(-1), 'sonuvi-readonly-v1 audio-info-snapshot');
});

test('audio snapshot client fails closed for denied, malformed, and oversized responses', async () => {
  await assert.rejects(
    readMoodeAudioInfoSnapshot({
      environment,
      execute: async () => {
        const error = new Error('denied');
        error.stdout = JSON.stringify({ ok: false, code: 'SONUVI_OPERATION_DENIED' });
        throw error;
      },
    }),
    (error) => error instanceof MoodeReadUnavailableError && error.code === 'SONUVI_OPERATION_DENIED',
  );

  await assert.rejects(
    readMoodeAudioInfoSnapshot({
      environment,
      execute: async () => ({ stdout: JSON.stringify({ ...successfulPayload, operation: 'diagnostics' }) }),
    }),
    (error) => error instanceof MoodeReadUnavailableError,
  );

  await assert.rejects(
    readMoodeAudioInfoSnapshot({
      environment,
      execute: async () => ({
        stdout: JSON.stringify({
          ...successfulPayload,
          snapshot: { ...successfulPayload.snapshot, audioInfoHtml: 'x'.repeat(512 * 1024 + 1) },
        }),
      }),
    }),
    (error) => error instanceof MoodeReadUnavailableError,
  );
});

test('tracked dispatcher is fixed-command only and includes no session identifier in its output schema', () => {
  const dispatcherPath = path.resolve('ops/moode-overrides/sonuvi-readonly/dispatcher.py');
  const dispatcher = fs.readFileSync(dispatcherPath, 'utf8');
  assert.match(dispatcher, /sonuvi-readonly-v1 audio-info-snapshot/);
  assert.match(dispatcher, /SSH_ORIGINAL_COMMAND/);
  assert.match(dispatcher, /No caller input is used/);
  assert.match(dispatcher, /PHPSESSID=/);
  assert.match(dispatcher, /never included in the\n    # response/);
  assert.doesNotMatch(dispatcher, /shell=True/);

  const redaction = spawnSync('python3', [
    '-c',
    'import runpy,sys; module=runpy.run_path(sys.argv[1]); print(module["redact_session_identifier"]("report session-token-123", "session-token-123"))',
    dispatcherPath,
  ], { encoding: 'utf8' });
  assert.equal(redaction.status, 0);
  assert.equal(redaction.stdout.trim(), 'report [redacted]');
});

test('tracked dispatcher preserves established operations and denies injected commands before collection', () => {
  const dispatcherPath = path.resolve('ops/moode-overrides/sonuvi-readonly/dispatcher.py');
  const dispatcher = fs.readFileSync(dispatcherPath, 'utf8');
  assert.match(dispatcher, /sonuvi-readonly-v1 radio-catalog/);
  assert.match(dispatcher, /sonuvi-readonly-v1 diagnostics/);
  assert.match(dispatcher, /sonuvi-readonly-v1 audio-info-snapshot/);

  const result = spawnSync('python3', [dispatcherPath], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin',
      SSH_ORIGINAL_COMMAND: 'sonuvi-readonly-v1 audio-info-snapshot; id',
    },
  });
  assert.equal(result.status, 126);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'SONUVI_OPERATION_DENIED',
  });
  assert.equal(result.stderr, '');
});
