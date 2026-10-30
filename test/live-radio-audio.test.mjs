import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createLiveRadioAudioProbe,
  isPublicInternetAddress,
  probeLiveRadioBytes,
  validateLiveRadioStreamUrl,
} from '../src/lib/live-radio-audio.mjs';

const activeJazz24 = {
  owner: 'server-mpd-current',
  active: true,
  kind: 'radio',
  url: 'https://stream.example.org/jazz24.aac',
  streamKey: '42:https://stream.example.org/jazz24.aac',
};

const aacProbe = {
  streams: [{
    codec_name: 'aac',
    profile: 'LC',
    sample_rate: '44100',
    channels: 2,
    bit_rate: '250000',
  }],
  format: { format_name: 'aac', bit_rate: '250000' },
};

function capabilities() {
  return { assertExternalRead() {} };
}

function publicUrlValidator(raw) {
  const url = new URL(raw);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    throw new Error('private target');
  }
  return url;
}

function aacResponse({ status = 200, headers = {} } = {}) {
  return new Response(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x1f, 0xfc]), {
    status,
    headers: {
      'content-type': 'audio/aac',
      'icy-br': '256',
      ...headers,
    },
  });
}

test('public-address policy rejects non-routable destinations before a live-radio request', async () => {
  assert.equal(isPublicInternetAddress('8.8.8.8'), true);
  assert.equal(isPublicInternetAddress('127.0.0.1'), false);
  assert.equal(isPublicInternetAddress('10.0.0.4'), false);
  assert.equal(isPublicInternetAddress('::1'), false);
  assert.equal(isPublicInternetAddress('::ffff:127.0.0.1'), false);

  await assert.rejects(
    validateLiveRadioStreamUrl('http://127.0.0.1/stream'),
    /not publicly routable/,
  );
  await assert.rejects(
    validateLiveRadioStreamUrl('https://radio.example.org/stream', {
      lookup: async () => [{ address: '10.0.0.4', family: 4 }],
    }),
    /public addresses/,
  );
  const accepted = await validateLiveRadioStreamUrl('https://radio.example.org/stream#fragment', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  });
  assert.equal(accepted.toString(), 'https://radio.example.org/stream');
});

test('bounded AAC/ICY probe returns verified stream facts with explicit live provenance', async () => {
  let fetchCount = 0;
  let byteProbeCount = 0;
  const probe = createLiveRadioAudioProbe({
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.range, 'bytes=0-65535');
      assert.equal(options.headers['icy-metadata'], '0');
      return aacResponse();
    },
    validateUrl: publicUrlValidator,
    probeBytes: async (bytes) => {
      byteProbeCount += 1;
      assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024);
      return aacProbe;
    },
    capabilities: capabilities(),
  });

  const result = await probe.get(activeJazz24);
  assert.equal(fetchCount, 1);
  assert.equal(byteProbeCount, 1);
  assert.equal(result.format, 'AAC-LC · 44.1 kHz · Stereo');
  assert.equal(result.codec, 'AAC-LC');
  assert.equal(result.codecStatus, 'verified');
  assert.equal(result.codecKind, 'lossy');
  assert.equal(result.container, 'AAC');
  assert.equal(result.sampleRateHz, 44100);
  assert.equal(result.channels, 2);
  assert.equal(result.bitDepth, undefined);
  assert.equal(result.bitDepthStatus, 'not-applicable');
  assert.equal(result.encodedBitrateBps, 256000);
  assert.equal(result.encodedBitrateProvenance, 'icy.header');
  assert.equal(result.provenance, 'live-upstream-probe');
  assert.equal(result.valueType, 'live-stream');
  assert.equal(result.verified, true);
});

test('ffprobe receives only the bounded byte sample, never an upstream URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonuvi-live-radio-ffprobe-'));
  try {
    const ffprobe = path.join(root, 'ffprobe-test');
    await writeFile(ffprobe, `#!/bin/sh
cat >/dev/null
printf '%s' '${JSON.stringify(aacProbe)}'
`);
    await chmod(ffprobe, 0o755);
    const inspect = probeLiveRadioBytes({ ffprobePath: ffprobe, timeoutMs: 1_000 });
    assert.deepEqual(await inspect(Buffer.from([0xff, 0xf1, 0x50, 0x80])), aacProbe);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('headers-only radio evidence stays partial and unverified when ffprobe cannot classify bytes', async () => {
  const probe = createLiveRadioAudioProbe({
    fetchImpl: async () => aacResponse(),
    validateUrl: publicUrlValidator,
    probeBytes: async () => ({ streams: [] }),
    capabilities: capabilities(),
  });

  const result = await probe.get(activeJazz24);
  assert.equal(result.format, 'AAC');
  assert.equal(result.codec, 'AAC');
  assert.equal(result.codecStatus, 'reported');
  assert.equal(result.sampleRateHz, undefined);
  assert.equal(result.channels, undefined);
  assert.equal(result.bitDepth, undefined);
  assert.equal(result.encodedBitrateBps, 256000);
  assert.equal(result.provenance, 'live-upstream-headers');
  assert.equal(result.valueType, 'live-stream');
  assert.equal(result.verified, false);
});

test('timeout/failure and unsafe redirects do not return authoritative live format data', async () => {
  const failed = createLiveRadioAudioProbe({
    fetchImpl: async () => { throw new Error('timeout'); },
    validateUrl: publicUrlValidator,
    capabilities: capabilities(),
  });
  assert.equal(await failed.get(activeJazz24), null);

  let fetchCount = 0;
  const redirectProbe = createLiveRadioAudioProbe({
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/private-stream' },
      });
    },
    validateUrl: publicUrlValidator,
    capabilities: capabilities(),
  });
  assert.equal(await redirectProbe.get(activeJazz24), null);
  assert.equal(fetchCount, 1, 'unsafe redirect target must not be fetched');
});

test('only an active server-owned MPD radio stream can start a probe', async () => {
  let fetchCount = 0;
  const probe = createLiveRadioAudioProbe({
    fetchImpl: async () => {
      fetchCount += 1;
      return aacResponse();
    },
    validateUrl: publicUrlValidator,
    probeBytes: async () => aacProbe,
    capabilities: capabilities(),
  });

  const rejected = [
    { url: activeJazz24.url },
    { ...activeJazz24, active: false },
    { ...activeJazz24, kind: 'qobuz' },
    { ...activeJazz24, kind: 'upnp' },
    { ...activeJazz24, url: 'file:///var/lib/mpd/music/track.flac' },
  ];
  for (const candidate of rejected) assert.equal(await probe.get(candidate), null);
  assert.equal(fetchCount, 0);
});

test('short cache coalesces concurrent reads and is invalidated by an MPD stream change', async () => {
  let now = 1_000;
  let fetchCount = 0;
  const probe = createLiveRadioAudioProbe({
    fetchImpl: async () => {
      fetchCount += 1;
      return aacResponse();
    },
    validateUrl: publicUrlValidator,
    probeBytes: async () => aacProbe,
    capabilities: capabilities(),
    now: () => now,
    cacheTtlMs: 5_000,
  });

  await Promise.all([probe.get(activeJazz24), probe.get(activeJazz24)]);
  assert.equal(fetchCount, 1);
  now += 1_000;
  await probe.get(activeJazz24);
  assert.equal(fetchCount, 1, 'same active stream uses short cache');

  await probe.get({ ...activeJazz24, streamKey: '43:https://stream.example.org/jazz24.aac' });
  assert.equal(fetchCount, 2, 'a different MPD stream identity invalidates cached evidence');
});
