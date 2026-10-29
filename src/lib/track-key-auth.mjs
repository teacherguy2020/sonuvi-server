import crypto from 'node:crypto';

function text(value) {
  return String(value ?? '').trim();
}

export function hasConfiguredTrackKey(value) {
  return Boolean(text(value));
}

/**
 * Compare operator credentials without making a configured key's prefix or
 * length observable through ordinary equality timing. Missing credentials are
 * never valid.
 */
export function isAuthorizedTrackKey(expected, supplied) {
  const configured = text(expected);
  const provided = text(supplied);
  if (!configured || !provided) return false;
  const configuredBytes = Buffer.from(configured);
  const providedBytes = Buffer.from(provided);
  return configuredBytes.length === providedBytes.length
    && crypto.timingSafeEqual(configuredBytes, providedBytes);
}
