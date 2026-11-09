import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  archiveGateCUpgradeBootstrapKit,
  createGateCUpgradeBootstrapKit,
  GATE_C_UPGRADE_BOOTSTRAP_KIT_CONTRACT,
  GATE_C_UPGRADE_BOOTSTRAP_KIT_EXTRACTED_TREE,
  GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES,
  verifyGateCUpgradeBootstrapKit,
} from '../src/lib/sonuvi-gate-c-upgrade-bootstrap-kit.mjs';

const releaseId = `sonuvi-${'e'.repeat(64)}`;

test('version-2 bootstrap package adds only the fixed installed-upgrade entrypoint and transaction closure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-upgrade-bootstrap-kit-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = 'fixture-upgrade-key';
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const created = await createGateCUpgradeBootstrapKit({
    sourceRoot: path.resolve('.'),
    outputRoot: path.join(root, 'kit-v2'),
    releaseId,
    keyId,
    trustedAnchors: { [keyId]: publicKey },
  });
  assert.equal(created.manifest.contract, GATE_C_UPGRADE_BOOTSTRAP_KIT_CONTRACT);
  assert.equal(created.manifest.version, 2);
  assert.deepEqual(created.manifest.files.map((entry) => entry.path), GATE_C_UPGRADE_BOOTSTRAP_KIT_FILES);
  assert.ok(created.manifest.files.some((entry) => entry.path === 'scripts/sonuvi-existing-install-upgrade.mjs'));
  assert.ok(created.manifest.files.some((entry) => entry.path === 'src/lib/sonuvi-linux-systemd-upgrade.mjs'));
  assert.equal((await fs.readFile(path.join(created.root, 'etc/sonuvi/release-trust-anchors.json'), 'utf8')).includes('PRIVATE KEY'), false);

  const archive = path.join(root, 'sonuvi-bootstrap-kit-v2.tar');
  const result = await archiveGateCUpgradeBootstrapKit({ kitRoot: created.root, archivePath: archive });
  assert.ok(result.bytes > 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await verifyGateCUpgradeBootstrapKit({ kitRoot: created.root })).releaseId, releaseId);

  const capsule = await fs.readFile(path.resolve('scripts/sonuvi-sftp-bootstrap-activate-v2.sh'), 'utf8');
  const expectedTree = capsule.match(/expected_tree='([\s\S]*?)'/)?.[1];
  assert.ok(expectedTree, 'v2 activation capsule has an explicit extracted-tree allowlist');
  assert.deepEqual(expectedTree.split('\n'), GATE_C_UPGRADE_BOOTSTRAP_KIT_EXTRACTED_TREE);

  await fs.writeFile(path.join(created.root, 'unexpected-file'), 'must be rejected');
  await assert.rejects(verifyGateCUpgradeBootstrapKit({ kitRoot: created.root }), /unexpected|inventory|digest/);
});
