function text(value) {
  return String(value || '').trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isoOrEmpty(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function copySourceRevision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const revision = {
    sizeBytes: positiveInteger(value.sizeBytes),
    modifiedMs: Number.isFinite(Number(value.modifiedMs)) && Number(value.modifiedMs) >= 0
      ? Number(value.modifiedMs)
      : null,
    mpdLastModified: isoOrEmpty(value.mpdLastModified),
    probeVersion: positiveInteger(value.probeVersion),
  };
  return Object.values(revision).some((item) => item !== null && item !== '') ? revision : null;
}

export function badgeEligibilityForSourceAudio(sourceAudio) {
  const kind = text(sourceAudio?.codecKind).toLowerCase();
  if (kind !== 'lossless') return 'none';
  const bitDepth = positiveInteger(sourceAudio?.bitDepth);
  const sampleRateHz = positiveInteger(sourceAudio?.sampleRateHz);
  if (bitDepth >= 24 && sampleRateHz >= 88_200) return 'hi-res';
  return 'lossless';
}

export function pendingAudioQuality({ sourceRevision = null, reason = 'not-yet-analyzed' } = {}) {
  return {
    status: 'pending',
    verificationStatus: 'pending',
    reason: text(reason) || 'not-yet-analyzed',
    provenance: 'library-maintenance',
    badgeEligibility: 'none',
    ...(copySourceRevision(sourceRevision) ? { sourceRevision: copySourceRevision(sourceRevision) } : {}),
  };
}

export function failedAudioQuality({ sourceRevision = null, reason = 'probe-failed', retryAfter = '' } = {}) {
  const retry = isoOrEmpty(retryAfter);
  return {
    status: 'failed',
    verificationStatus: 'failed',
    reason: text(reason) || 'probe-failed',
    provenance: 'library-maintenance',
    badgeEligibility: 'none',
    ...(retry ? { retryAfter: retry } : {}),
    ...(copySourceRevision(sourceRevision) ? { sourceRevision: copySourceRevision(sourceRevision) } : {}),
  };
}

export function verifiedAudioQuality({ sourceAudio, sourceRevision = null, verifiedAt = new Date().toISOString() } = {}) {
  const source = sourceAudio && typeof sourceAudio === 'object' && !Array.isArray(sourceAudio)
    ? sourceAudio
    : {};
  const codecKind = text(source.codecKind).toLowerCase() || 'unknown';
  const verified = {
    status: 'verified',
    verificationStatus: 'verified',
    provenance: 'ffprobe.source-file',
    badgeEligibility: badgeEligibilityForSourceAudio(source),
    codec: text(source.codec) || null,
    codecKind,
    container: text(source.container) || null,
    bitDepth: positiveInteger(source.bitDepth),
    bitDepthStatus: text(source.bitDepthStatus) || 'unavailable',
    sampleRateHz: positiveInteger(source.sampleRateHz),
    channels: positiveInteger(source.channels),
    encodedBitrateBps: positiveInteger(source.encodedBitrateBps),
    encodedBitrateStatus: text(source.encodedBitrateStatus) || 'unavailable',
    encodedBitrateProvenance: text(source.encodedBitrateProvenance) || null,
    verifiedAt: isoOrEmpty(verifiedAt) || new Date().toISOString(),
  };
  const revision = copySourceRevision(sourceRevision);
  if (revision) verified.sourceRevision = revision;
  return verified;
}

export function sourceAudioFromQuality(quality) {
  if (text(quality?.verificationStatus) !== 'verified') return null;
  const source = {};
  for (const key of [
    'codec', 'codecKind', 'container', 'bitDepth', 'bitDepthStatus',
    'sampleRateHz', 'channels', 'encodedBitrateBps',
    'encodedBitrateStatus', 'encodedBitrateProvenance',
  ]) {
    if (quality[key] !== null && quality[key] !== undefined && quality[key] !== '') source[key] = quality[key];
  }
  return Object.keys(source).length ? source : null;
}

export function audioQualityNeedsEnrichment(quality, now = Date.now()) {
  const status = text(quality?.verificationStatus || quality?.status);
  if (status === 'pending' || !status) return true;
  if (status !== 'failed') return false;
  const retryAt = Date.parse(String(quality?.retryAfter || ''));
  return !Number.isFinite(retryAt) || retryAt <= Number(now);
}

export function audioQualitySummaryForTracks(tracks) {
  const rows = Array.isArray(tracks) ? tracks : [];
  const summary = {
    trackCount: rows.length,
    verifiedTrackCount: 0,
    pendingTrackCount: 0,
    failedTrackCount: 0,
    lossyTrackCount: 0,
    losslessTrackCount: 0,
    hiResTrackCount: 0,
    unknownTrackCount: 0,
    verificationStatus: 'incomplete',
    badgeEligibility: 'none',
  };

  const badges = new Set();
  for (const track of rows) {
    const quality = track?.audioQuality;
    const status = text(quality?.verificationStatus || quality?.status);
    if (status === 'verified') {
      summary.verifiedTrackCount += 1;
      const badge = text(quality?.badgeEligibility) || 'none';
      badges.add(badge);
      if (badge === 'hi-res') summary.hiResTrackCount += 1;
      else if (badge === 'lossless') summary.losslessTrackCount += 1;
      else if (text(quality?.codecKind) === 'lossy') summary.lossyTrackCount += 1;
      else summary.unknownTrackCount += 1;
    } else if (status === 'failed') {
      summary.failedTrackCount += 1;
    } else {
      summary.pendingTrackCount += 1;
    }
  }

  if (summary.trackCount > 0 && summary.verifiedTrackCount === summary.trackCount) {
    summary.verificationStatus = 'complete';
    if (badges.size === 1 && badges.has('hi-res')) summary.badgeEligibility = 'hi-res';
    if (badges.size === 1 && badges.has('lossless')) summary.badgeEligibility = 'lossless';
  }
  return summary;
}

export function audioQualityIndexCounts(tracks) {
  const rows = Array.isArray(tracks) ? tracks : [];
  const counts = {
    totalTracks: rows.length,
    verifiedTracks: 0,
    pendingTracks: 0,
    failedTracks: 0,
    lossyTracks: 0,
    losslessTracks: 0,
    hiResTracks: 0,
    unknownTracks: 0,
  };
  for (const track of rows) {
    const quality = track?.audioQuality;
    const status = text(quality?.verificationStatus || quality?.status);
    if (status === 'verified') {
      counts.verifiedTracks += 1;
      const badge = text(quality?.badgeEligibility) || 'none';
      if (badge === 'hi-res') counts.hiResTracks += 1;
      else if (badge === 'lossless') counts.losslessTracks += 1;
      else if (text(quality?.codecKind) === 'lossy') counts.lossyTracks += 1;
      else counts.unknownTracks += 1;
    } else if (status === 'failed') {
      counts.failedTracks += 1;
    } else {
      counts.pendingTracks += 1;
    }
  }
  return counts;
}
