import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { FirstAdministratorEnrollment } from '../src/lib/sonuvi-bootstrap-security.mjs';
import { authorizeFirstController } from '../src/lib/sonuvi-first-controller-handoff.mjs';
import { buildGateB2ReadinessPackage } from '../src/lib/sonuvi-gate-b2-package.mjs';

const attemptId = 'boot_0123456789abcdef'; const targetIdentity = 'machine_0123456789abcdef';
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-b2-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
test('first-controller handoff requires an administrator and reuses mobile-only bearer scope', async (t) => {
  const root = await fixture(t); const enrollment = new FirstAdministratorEnrollment({ stateRoot: root }); const issued = await enrollment.create({ attemptId, targetIdentity }); const authority = new AdministratorAuthority({ stateRoot: root }); const admin = await authority.initializeFromClaim({ enrollment, attemptId, targetIdentity, enrollmentToken: issued.enrollmentToken, administratorDeviceId: 'device_admin_0123456789', administratorPublicKey: 'admin-key' }); const adminToken = await authority.issueAccessToken({ administratorId: admin.administratorId });
  const handoff = await authorizeFirstController({ authority, administratorToken: adminToken, mobileApiSecret: 'fixture-mobile-secret', controllerDeviceId: 'controller_0123456789', stateRoot: root }); assert.equal(handoff.scope, 'mobile-api'); assert.equal(handoff.accessToken.includes(adminToken), false); await assert.rejects(authorizeFirstController({ authority, administratorToken: 'controller-token', mobileApiSecret: 'fixture-mobile-secret', controllerDeviceId: 'controller_0123456789', stateRoot: root }), /required/);
});
test('B2 package manifest hashes fixed package inputs without executing them', async (t) => {
  const root = await fixture(t); const helper = path.join(root, 'helper.mjs'); const lock = path.join(root, 'package-lock.json'); const unit = path.join(root, 'unit.service.in'); await Promise.all([fs.writeFile(helper, 'helper'), fs.writeFile(lock, 'lock'), fs.writeFile(unit, 'unit')]); const built = await buildGateB2ReadinessPackage({ outputPath: path.join(root, 'candidate', 'manifest.json'), helperPath: helper, lockfilePath: lock, serviceTemplatePaths: [unit] }); assert.equal(built.manifest.contract, 'sonuvi.gate-b2-package.v1'); assert.equal(built.manifest.files.length, 3);
});
