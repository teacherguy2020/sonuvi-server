import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RELEASE_MANIFEST_CONTRACT } from '../src/lib/release-artifact.mjs';
import { publicRuntimeReleaseIdentity, resolveRuntimePublicWebRoot, resolveRuntimeReleaseIdentity } from '../src/lib/release-runtime.mjs';

test('release runtime identity fails closed for an incomplete or mismatched immutable-release environment', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-release-runtime-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const releaseId = `sonuvi-${'a'.repeat(64)}`;
  const manifestPath = path.join(root, 'release-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({ contract: RELEASE_MANIFEST_CONTRACT, releaseId }));
  await fs.mkdir(path.join(root, 'public'));

  assert.deepEqual(resolveRuntimeReleaseIdentity({ cwd: root, env: {} }), {
    mode: 'legacy-checkout', releaseId: null, manifestPath: null,
  });
  assert.throws(() => resolveRuntimeReleaseIdentity({ cwd: root, env: { SONUVI_RELEASE_ID: releaseId } }), /SONUVI_RELEASE_MANIFEST/);
  assert.throws(() => resolveRuntimeReleaseIdentity({ cwd: root, env: { SONUVI_RELEASE_ID: releaseId, SONUVI_RELEASE_MANIFEST: path.join(root, 'missing.json') } }), /unavailable/);
  assert.deepEqual(resolveRuntimeReleaseIdentity({ cwd: root, env: { SONUVI_RELEASE_MANIFEST: manifestPath } }), {
    mode: 'immutable-release', releaseId, manifestPath,
  });
  assert.deepEqual(resolveRuntimeReleaseIdentity({ cwd: root, env: { SONUVI_RELEASE_ID: releaseId, SONUVI_RELEASE_MANIFEST: manifestPath } }), {
    mode: 'immutable-release', releaseId, manifestPath,
  });
  assert.deepEqual(
    publicRuntimeReleaseIdentity(resolveRuntimeReleaseIdentity({ cwd: root, env: { SONUVI_RELEASE_MANIFEST: manifestPath } })),
    { mode: 'immutable-release', releaseId },
  );
  assert.equal(resolveRuntimePublicWebRoot({ cwd: root, env: { SONUVI_PUBLIC_WEB_ROOT: path.join(root, 'public') } }), path.join(root, 'public'));
  assert.equal(resolveRuntimePublicWebRoot({ cwd: root, env: { SONUVI_RELEASE_MANIFEST: manifestPath } }), path.join(root, 'public'));
  assert.throws(
    () => resolveRuntimePublicWebRoot({ cwd: root, env: { SONUVI_RELEASE_MANIFEST: manifestPath, SONUVI_PUBLIC_WEB_ROOT: root } }),
    /must be this immutable release public directory/,
  );
  assert.throws(() => resolveRuntimePublicWebRoot({ cwd: root, env: { SONUVI_PUBLIC_WEB_ROOT: 'relative-public' } }), /absolute/);
});
