import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSourceAudioProbe, normalizeSourceAudioProbe } from '../src/lib/source-audio.mjs';

test('normalizes verified source-file audio properties and omits unavailable values', () => {
  assert.deepEqual(normalizeSourceAudioProbe({
    streams: [{ sample_rate: '96000', bits_per_raw_sample: '24', channels: 2 }],
  }), { sampleRateHz: 96000, bitDepth: 24, channels: 2 });
  assert.deepEqual(normalizeSourceAudioProbe({
    streams: [{ sample_rate: '44100', bits_per_sample: '16', channels: 2 }],
  }), { sampleRateHz: 44100, channels: 2 });
  assert.equal(normalizeSourceAudioProbe({ streams: [] }), null);
});

test('normalizes codec-aware source semantics without treating lossy decoder precision as source depth', () => {
  assert.deepEqual(normalizeSourceAudioProbe({
    streams: [{
      codec_name: 'aac',
      profile: 'LC',
      sample_rate: '44100',
      channels: 2,
      bits_per_sample: '32',
      bit_rate: '270000',
    }],
    format: { format_name: 'mov,mp4,m4a', bit_rate: '270000' },
  }), {
    sampleRateHz: 44100,
    channels: 2,
    codec: 'AAC-LC',
    codecKind: 'lossy',
    bitDepthStatus: 'not-applicable',
    container: 'M4A',
    encodedBitrateBps: 270000,
    encodedBitrateStatus: 'reported',
    encodedBitrateProvenance: 'ffprobe.stream',
  });

  assert.deepEqual(normalizeSourceAudioProbe({
    streams: [{
      codec_name: 'flac',
      sample_rate: '96000',
      channels: 2,
      bits_per_raw_sample: '24',
      bit_rate: '4200000',
    }],
    format: { format_name: 'flac' },
  }), {
    sampleRateHz: 96000,
    bitDepth: 24,
    channels: 2,
    codec: 'FLAC',
    codecKind: 'lossless',
    bitDepthStatus: 'verified',
    bitDepthKind: 'integer',
    container: 'FLAC',
    encodedBitrateBps: 4200000,
    encodedBitrateStatus: 'reported',
    encodedBitrateProvenance: 'ffprobe.stream',
  });

  assert.deepEqual(normalizeSourceAudioProbe({
    streams: [{
      codec_name: 'alac',
      sample_rate: '96000',
      channels: 2,
      bits_per_raw_sample: '24',
      bit_rate: '4200000',
    }],
    format: { format_name: 'mov,mp4,m4a' },
  }), {
    sampleRateHz: 96000,
    bitDepth: 24,
    channels: 2,
    codec: 'ALAC',
    codecKind: 'lossless',
    bitDepthStatus: 'verified',
    bitDepthKind: 'integer',
    container: 'M4A',
    encodedBitrateBps: 4200000,
    encodedBitrateStatus: 'reported',
    encodedBitrateProvenance: 'ffprobe.stream',
  });

  assert.deepEqual(normalizeSourceAudioProbe({
    streams: [{ codec_name: 'pcm_s24le', sample_rate: '48000', channels: 2 }],
    format: { format_name: 'aiff' },
  }), {
    sampleRateHz: 48000,
    bitDepth: 24,
    channels: 2,
    codec: 'PCM_S24LE',
    codecKind: 'lossless',
    bitDepthStatus: 'verified',
    bitDepthKind: 'integer',
    container: 'AIFF',
  });

  assert.deepEqual(normalizeSourceAudioProbe({
    streams: [{ codec_name: 'future_codec', sample_rate: '48000', channels: 2, bits_per_sample: '24' }],
    format: { format_name: 'custom' },
  }), {
    sampleRateHz: 48000,
    channels: 2,
    codec: 'FUTURE_CODEC',
    codecKind: 'unknown',
    bitDepthStatus: 'unavailable',
    container: 'CUSTOM',
  });
});

test('probes a source file once and reuses the stat-keyed cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonuvi-source-audio-'));
  try {
    const media = path.join(root, 'America Undefined.flac');
    const ffprobe = path.join(root, 'ffprobe-test');
    await writeFile(media, 'test source');
    await writeFile(ffprobe, '#!/bin/sh\nprintf \'{"streams":[{"sample_rate":"96000","bits_per_raw_sample":"24","channels":2}]}\'\n');
    await chmod(ffprobe, 0o755);
    const probe = createSourceAudioProbe({
      resolveFile: async () => media,
      cachePath: path.join(root, 'cache.json'),
      ffprobePath: ffprobe,
    });
    const expected = { sampleRateHz: 96000, bitDepth: 24, channels: 2 };
    assert.deepEqual(await probe.get('America Undefined.flac'), expected);
    assert.deepEqual(await probe.get('America Undefined.flac'), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reuses a valid legacy source-audio cache entry without running ffprobe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonuvi-source-audio-migration-'));
  try {
    const media = path.join(root, 'track.flac');
    const cachePath = path.join(root, 'cache.json');
    await writeFile(media, 'test source');
    const mediaStat = await stat(media);
    await writeFile(cachePath, JSON.stringify({
      version: 1,
      files: {
        'track.flac': {
          probeVersion: 2,
          sizeBytes: mediaStat.size,
          modifiedMs: mediaStat.mtimeMs,
          sourceAudio: { codec: 'FLAC', codecKind: 'lossless', bitDepth: 24, sampleRateHz: 96_000, channels: 2 },
        },
      },
    }), 'utf8');
    let calls = 0;
    const probe = createSourceAudioProbe({
      resolveFile: async () => media,
      cachePath,
      runExecFile: async () => { calls += 1; throw new Error('must not probe'); },
    });
    const record = await probe.getRecord('track.flac');
    assert.equal(record.status, 'verified');
    assert.equal(record.sourceAudio.codec, 'FLAC');
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source probe fails closed for inaccessible files and ffprobe failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonuvi-source-audio-failure-'));
  try {
    const media = path.join(root, 'track.m4a');
    await writeFile(media, 'test source');

    const inaccessible = createSourceAudioProbe({
      resolveFile: async () => '',
      cachePath: path.join(root, 'inaccessible-cache.json'),
    });
    assert.equal(await inaccessible.get('track.m4a'), null);

    const ffprobeFailure = createSourceAudioProbe({
      resolveFile: async () => media,
      cachePath: path.join(root, 'failure-cache.json'),
      ffprobePath: path.join(root, 'missing-ffprobe'),
    });
    assert.equal(await ffprobeFailure.get('track.m4a'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed source probes are cached with a bounded retry window', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonuvi-source-audio-retry-'));
  try {
    const media = path.join(root, 'track.flac');
    await writeFile(media, 'test source');
    let clock = Date.parse('2026-11-01T00:00:00.000Z');
    let calls = 0;
    const probe = createSourceAudioProbe({
      resolveFile: async () => media,
      cachePath: path.join(root, 'retry-cache.json'),
      runExecFile: async () => {
        calls += 1;
        throw new Error('ffprobe unavailable');
      },
      now: () => clock,
      retryDelayMs: 60_000,
    });

    const first = await probe.getRecord('track.flac');
    const second = await probe.getRecord('track.flac');
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'failed');
    assert.equal(calls, 1);

    clock += 60_000;
    const retried = await probe.getRecord('track.flac');
    assert.equal(retried.status, 'failed');
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
