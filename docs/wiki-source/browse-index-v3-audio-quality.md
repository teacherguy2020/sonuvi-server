---
title: Browse Index v3 audio quality
---

# Browse Index v3 audio quality

Browse Index v3 embeds verified source-file audio facts in the existing MPD
library JSON. It does not create a second catalog, run quality work from a
browse request, or claim playback/output characteristics.

## Schema

The existing `artists`, `albums`, and `tracks` arrays remain. The schema is
`now-playing.browse-index.v3`.

Track example:

```json
{
  "audioQuality": {
    "status": "verified",
    "verificationStatus": "verified",
    "provenance": "ffprobe.source-file",
    "badgeEligibility": "hi-res",
    "codec": "FLAC",
    "codecKind": "lossless",
    "bitDepth": 24,
    "sampleRateHz": 96000,
    "channels": 2,
    "sourceRevision": {
      "sizeBytes": 12345678,
      "modifiedMs": 1793529735000,
      "mpdLastModified": "2026-11-01T03:31:28.000Z",
      "probeVersion": 2
    }
  }
}
```

Pending/failed records fail closed with `badgeEligibility: "none"`. Failed
records retain only a safe reason and bounded `retryAfter`; raw ffprobe output
is neither stored nor exposed.

Album example:

```json
{
  "audioQuality": {
    "trackCount": 10,
    "verifiedTrackCount": 10,
    "pendingTrackCount": 0,
    "failedTrackCount": 0,
    "lossyTrackCount": 0,
    "losslessTrackCount": 0,
    "hiResTrackCount": 10,
    "verificationStatus": "complete",
    "badgeEligibility": "hi-res"
  }
}
```

Hi-Res requires every track to be verified lossless, at least 24-bit, and at
least 88.2 kHz. Lossless requires every track to be verified standard
lossless. Mixed, lossy, unknown, pending, and failed albums get no badge.

## Maintenance and migration

A normal rebuild upgrades v2 in place. The builder reads MPD metadata and
per-file `Last-Modified` revisions, preserves unchanged v3 records, writes an
atomic pending v3 index immediately, then enriches in bounded 24-track
background batches. Each batch is atomically persisted, so interrupted work
resumes from the stored pending records.

Existing `source-audio-cache.json` records are reused when their size/mtime
fingerprint is valid; they do not invoke ffprobe again. Failed results have a
bounded retry window. Stored quality is added to existing mobile catalog and
search responses without breaking older clients.

## Safe production upgrade

1. Validate and deploy the Server release through immutable activation only.
2. Back up the current Browse Index/cache read-only before the first v3 build.
3. Do not change moOde, MPD configuration, music files, playback, or queues.
4. Observe `GET /config/browse/stats` audio-quality counts while batches run.
5. Confirm representative albums and browse responsiveness before any badge UI
   work. Roll back the Server release if health or catalog shape regresses.

## Validation

Tests cover FLAC 16/44.1, 24/48, 24/96, 24/192, AAC/MP3, unreadable files,
strict album rollups, cache reuse, retry, no lazy browse probe, one-file
incremental rechecks, resume after interruption, and a 9,000-track fixture.

Last updated: 2026-11-01
