import assert from 'node:assert/strict';
import test from 'node:test';

import {
  audioQualityIndexCounts,
  audioQualitySummaryForTracks,
  badgeEligibilityForSourceAudio,
  failedAudioQuality,
  pendingAudioQuality,
  verifiedAudioQuality,
} from '../src/lib/browse-index-quality.mjs';

function verified(sourceAudio) {
  return { audioQuality: verifiedAudioQuality({
    sourceAudio,
    sourceRevision: { sizeBytes: 100, modifiedMs: 10, probeVersion: 2 },
    verifiedAt: '2026-11-01T00:00:00.000Z',
  }) };
}

test('quality badges use the strict lossless and hi-res thresholds', () => {
  assert.equal(badgeEligibilityForSourceAudio({ codecKind: 'lossless', bitDepth: 16, sampleRateHz: 44_100 }), 'lossless');
  assert.equal(badgeEligibilityForSourceAudio({ codecKind: 'lossless', bitDepth: 24, sampleRateHz: 48_000 }), 'lossless');
  assert.equal(badgeEligibilityForSourceAudio({ codecKind: 'lossless', bitDepth: 24, sampleRateHz: 96_000 }), 'hi-res');
  assert.equal(badgeEligibilityForSourceAudio({ codecKind: 'lossless', bitDepth: 24, sampleRateHz: 192_000 }), 'hi-res');
  assert.equal(badgeEligibilityForSourceAudio({ codecKind: 'lossy', bitDepth: 24, sampleRateHz: 96_000 }), 'none');
  assert.equal(badgeEligibilityForSourceAudio({ codecKind: 'unknown', bitDepth: 24, sampleRateHz: 192_000 }), 'none');
});

test('album quality summaries fail closed for mixed, lossy, pending, and failed tracks', () => {
  const cdTrack = verified({ codec: 'FLAC', codecKind: 'lossless', bitDepth: 16, sampleRateHz: 44_100, channels: 2 });
  const hiResTrack = verified({ codec: 'FLAC', codecKind: 'lossless', bitDepth: 24, sampleRateHz: 96_000, channels: 2 });
  const lossyTrack = verified({ codec: 'AAC-LC', codecKind: 'lossy', sampleRateHz: 44_100, channels: 2 });

  const lossless = audioQualitySummaryForTracks([cdTrack, cdTrack]);
  assert.equal(lossless.verificationStatus, 'complete');
  assert.equal(lossless.badgeEligibility, 'lossless');

  const hiRes = audioQualitySummaryForTracks([hiResTrack, hiResTrack]);
  assert.equal(hiRes.verificationStatus, 'complete');
  assert.equal(hiRes.badgeEligibility, 'hi-res');

  for (const tracks of [
    [cdTrack, hiResTrack],
    [cdTrack, lossyTrack],
    [cdTrack, { audioQuality: pendingAudioQuality() }],
    [cdTrack, { audioQuality: failedAudioQuality({ reason: 'probe-failed' }) }],
  ]) {
    const summary = audioQualitySummaryForTracks(tracks);
    assert.equal(summary.badgeEligibility, 'none');
  }
});

test('quality counts report actual verified, pending, lossy, hi-res, lossless, and failed records', () => {
  const counts = audioQualityIndexCounts([
    verified({ codec: 'FLAC', codecKind: 'lossless', bitDepth: 16, sampleRateHz: 44_100 }),
    verified({ codec: 'FLAC', codecKind: 'lossless', bitDepth: 24, sampleRateHz: 96_000 }),
    verified({ codec: 'MP3', codecKind: 'lossy', sampleRateHz: 44_100 }),
    { audioQuality: pendingAudioQuality() },
    { audioQuality: failedAudioQuality({ reason: 'source-unavailable' }) },
  ]);
  assert.deepEqual(counts, {
    totalTracks: 5,
    verifiedTracks: 3,
    pendingTracks: 1,
    failedTracks: 1,
    lossyTracks: 1,
    losslessTracks: 1,
    hiResTracks: 1,
    unknownTracks: 0,
  });
});
