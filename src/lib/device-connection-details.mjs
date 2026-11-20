import { isIP } from 'node:net';

export function directDeviceAddress(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const address = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!isIP(address) || address === '::1' || address === '::' || address === '0.0.0.0' || address.startsWith('127.')) return null;
  return address;
}

// Display hints only, never authentication or a physical-hardware identity.
// Retain coarse parsed names, not a potentially identifying raw User-Agent.
export function observedDeviceDetails(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 1024) : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrom(e|ium)\//.test(ua) ? 'Chrome / Chromium' : /Safari\//.test(ua) ? 'Safari' : null;
  const platform = /iPad/.test(ua) ? 'iPadOS' : /iPhone/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return { ...(browser ? { browser } : {}), ...(platform ? { platform } : {}) };
}

export function reportedDeviceDetails(body = {}) {
  const allowed = {
    deviceType: new Set(['iPhone', 'iPad', 'Apple TV', 'Browser', 'Other']),
    platform: new Set(['iOS', 'iPadOS', 'tvOS', 'macOS', 'Windows', 'Android', 'Linux', 'Unknown']),
  };
  const result = {};
  for (const key of ['deviceType', 'platform', 'osVersion', 'appVersion']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 80
      || /[\x00-\x1f\x7f]/.test(body[key]) || (allowed[key] && !allowed[key].has(body[key]))) throw new Error('device_metadata_invalid');
    result[key] = body[key].trim();
  }
  return result;
}

export function publicDeviceDetails(value = {}) {
  const result = {};
  for (const key of ['lastSeenAt', 'lastAddressSeenAt']) if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  if (directDeviceAddress(value.lastSeenAddress)) result.lastSeenAddress = value.lastSeenAddress;
  if (['direct', 'proxied'].includes(value.connectionKind)) result.connectionKind = value.connectionKind;
  if (['Edge', 'Firefox', 'Chrome / Chromium', 'Safari'].includes(value.browser)) result.browser = value.browser;
  try { Object.assign(result, reportedDeviceDetails(value)); } catch { /* Ignore invalid historical display hints. */ }
  return result;
}
