#!/usr/bin/env node
import path from 'node:path';

import { verifyReleaseArtifact } from '../src/lib/release-artifact.mjs';
import {
  assertReleaseTargetRuntime,
  inspectExternalExecutables,
  inspectRemotePlaybackTopology,
  inspectReleaseRuntimeState,
} from '../src/lib/release-runtime-preflight.mjs';

function values(name) {
  const result = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) result.push(String(process.argv[index + 1] || '').trim());
  }
  return result;
}

function value(name) {
  return values(name).at(-1) || '';
}

function absolute(value, label) {
  const candidate = String(value || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(candidate);
}

const artifactRoot = absolute(value('--release-root') || process.env.SONUVI_RELEASE_ROOT || process.cwd(), 'release root');
const verified = await verifyReleaseArtifact({ artifactRoot });
const runtime = assertReleaseTargetRuntime({ manifest: verified.manifest });
const skipExecutables = process.argv.includes('--skip-external-executables');
const requireState = process.argv.includes('--require-runtime-state');
const requireRemotePlayback = process.argv.includes('--require-remote-playback');
const checks = {
  targetRuntime: runtime,
  externalExecutables: null,
  runtimeState: null,
  remotePlayback: null,
  sharp: null,
};

if (!skipExecutables) {
  const executables = await inspectExternalExecutables({ manifest: verified.manifest });
  if (!executables.ok) throw new Error(`required executables are unavailable: ${executables.missing.join(', ')}`);
  checks.externalExecutables = { ok: true, count: executables.required.length };
}

if (requireState) {
  const stateRoot = absolute(value('--state-root') || process.env.SONUVI_STATE_ROOT, 'SONUVI_STATE_ROOT');
  const configRoot = value('--config-root') || process.env.SONUVI_CONFIG_ROOT || '';
  const musicRoot = value('--music-root') || process.env.MUSIC_LIBRARY_ROOT || '';
  const sshIdentityPath = value('--ssh-identity') || process.env.MOODE_SSH_IDENTITY || '';
  const requiredFiles = values('--require-file').map((filePath) => ({
    label: 'required protected file',
    filePath: absolute(filePath, '--require-file'),
  }));
  const state = await inspectReleaseRuntimeState({
    stateRoot,
    configRoot,
    musicRoot,
    sshIdentityPath,
    requiredFiles,
  });
  if (!state.ok) throw new Error(`runtime state is not ready: ${state.errors.join('; ')}`);
  checks.runtimeState = { ok: true };
}

if (requireRemotePlayback) {
  const remote = inspectRemotePlaybackTopology({
    mpdHost: value('--mpd-host') || process.env.MPD_HOST,
    moodeSshHost: value('--moode-ssh-host') || process.env.MOODE_SSH_HOST,
  });
  if (!remote.ok) throw new Error(`remote playback topology is not ready: ${remote.errors.join('; ')}`);
  checks.remotePlayback = { ok: true };
}

const sharpModule = await import('sharp');
const sharp = sharpModule.default;
const transformed = await sharp({
  create: { width: 2, height: 2, channels: 3, background: { r: 12, g: 34, b: 56 } },
}).png().toBuffer();
if (!transformed.length) throw new Error('Sharp native transform returned no output');
checks.sharp = { ok: true, version: sharp.versions?.sharp || null };

process.stdout.write(`${JSON.stringify({
  releaseId: verified.releaseId,
  target: checks.targetRuntime.actual,
  checks,
}, null, 2)}\n`);
