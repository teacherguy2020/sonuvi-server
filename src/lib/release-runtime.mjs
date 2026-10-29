import fs from 'node:fs';
import path from 'node:path';

import { RELEASE_MANIFEST_CONTRACT } from './release-artifact.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function requiredAbsolutePath(value, label) {
  const candidate = text(value);
  if (!candidate || !path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(candidate);
}

/**
 * A release service opts in with SONUVI_RELEASE_ID and a manifest path. Legacy
 * checkout operation keeps its historical behaviour when neither is set.
 */
export function resolveRuntimeReleaseIdentity({ cwd = process.cwd(), env = process.env } = {}) {
  const requestedReleaseId = text(env?.SONUVI_RELEASE_ID);
  const requestedManifest = text(env?.SONUVI_RELEASE_MANIFEST);
  if (!requestedReleaseId && !requestedManifest) {
    return Object.freeze({ mode: 'legacy-checkout', releaseId: null, manifestPath: null });
  }
  if (requestedReleaseId && !requestedManifest) throw new Error('SONUVI_RELEASE_MANIFEST is required with SONUVI_RELEASE_ID');
  const manifestPath = requiredAbsolutePath(requestedManifest, 'SONUVI_RELEASE_MANIFEST');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('configured release manifest is unavailable or invalid');
  }
  if (manifest?.contract !== RELEASE_MANIFEST_CONTRACT || !/^sonuvi-[a-f0-9]{64}$/.test(String(manifest.releaseId || ''))) {
    throw new Error('configured release manifest is not a valid immutable release');
  }
  if (requestedReleaseId && manifest.releaseId !== requestedReleaseId) {
    throw new Error('configured release manifest does not match SONUVI_RELEASE_ID');
  }
  const releaseRoot = fs.realpathSync(path.dirname(manifestPath));
  const workingDirectory = fs.realpathSync(path.resolve(cwd));
  if (workingDirectory !== releaseRoot) {
    throw new Error('release manifest must belong to the service working directory');
  }
  return Object.freeze({ mode: 'immutable-release', releaseId: manifest.releaseId, manifestPath });
}

/**
 * The API health endpoint is intentionally public enough for Caddy's paired
 * activation check. Keep the filesystem manifest location private even though
 * the release identity itself is safe to expose.
 */
export function publicRuntimeReleaseIdentity(identity) {
  const resolved = identity || resolveRuntimeReleaseIdentity();
  return Object.freeze({
    mode: resolved.mode,
    releaseId: resolved.releaseId,
  });
}

export function resolveRuntimePublicWebRoot({ cwd = process.cwd(), env = process.env } = {}) {
  const configured = text(env?.SONUVI_PUBLIC_WEB_ROOT);
  const identity = resolveRuntimeReleaseIdentity({ cwd, env });
  if (identity.mode === 'immutable-release') {
    const releaseRoot = fs.realpathSync(path.resolve(cwd));
    const expected = fs.realpathSync(path.join(releaseRoot, 'public'));
    if (!configured) return expected;
    const candidate = fs.realpathSync(requiredAbsolutePath(configured, 'SONUVI_PUBLIC_WEB_ROOT'));
    if (candidate !== expected) throw new Error('SONUVI_PUBLIC_WEB_ROOT must be this immutable release public directory');
    return candidate;
  }
  if (configured) return requiredAbsolutePath(configured, 'SONUVI_PUBLIC_WEB_ROOT');
  return path.resolve(cwd);
}
