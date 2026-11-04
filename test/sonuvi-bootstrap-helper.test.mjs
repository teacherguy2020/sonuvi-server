import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AdministratorAuthority, requireAdministratorAuthorization } from '../src/lib/sonuvi-admin-authority.mjs';
import { bootstrapHelperDescriptor, processBootstrapJsonLine, verifyBootstrapHelperArtifact } from '../src/lib/sonuvi-bootstrap-helper.mjs';
import { FirstAdministratorEnrollment } from '../src/lib/sonuvi-bootstrap-security.mjs';

const attemptId = 'boot_0123456789abcdef'; const targetIdentity = 'machine_0123456789abcdef';
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-helper-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('bootstrap helper artifact requires an independently supplied trusted digest', async (t) => {
  const root = await fixture(t); const helper = path.join(root, 'helper.mjs'); await fs.writeFile(helper, 'fixed helper\n'); const digest = crypto.createHash('sha256').update(await fs.readFile(helper)).digest('hex');
  assert.equal((await verifyBootstrapHelperArtifact({ helperPath: helper, descriptor: bootstrapHelperDescriptor({ helperPath: '/usr/lib/sonuvi/bootstrap-helper.mjs', trustedSha256: digest }) })).verified, true);
  await fs.writeFile(helper, 'tampered\n'); await assert.rejects(verifyBootstrapHelperArtifact({ helperPath: helper, descriptor: { trustedSha256: digest } }), /integrity/);
});

test('JSON-lines helper has bounded fixed dispatch and reports timeout/interruption safely', async () => {
  const request = JSON.stringify({ version: 1, operation: 'status', attemptId, targetIdentity, payload: {} });
  const response = JSON.parse(await processBootstrapJsonLine(request, { dispatch: async () => ({ state: 'recoverable-incomplete' }) })); assert.equal(response.ok, true); assert.equal(response.state, 'recoverable-incomplete');
  const timed = JSON.parse(await processBootstrapJsonLine(request, { timeoutMs: 1, dispatch: () => new Promise(() => {}) })); assert.equal(timed.code, 'timeout');
  const invalid = JSON.parse(await processBootstrapJsonLine('{"operation":"shell"}', { dispatch: async () => ({}) })); assert.equal(invalid.code, 'invalid_request');
});

test('administrator authority persists separately from controller sessions and rejects invalid access', async (t) => {
  const root = await fixture(t); const enrollment = new FirstAdministratorEnrollment({ stateRoot: root }); const created = await enrollment.create({ attemptId, targetIdentity }); const authority = new AdministratorAuthority({ stateRoot: root }); const identity = await authority.initializeFromClaim({ enrollment, attemptId, targetIdentity, enrollmentToken: created.enrollmentToken, administratorDeviceId: 'device_0123456789abcdef', administratorPublicKey: 'public-key' });
  const token = await authority.issueAccessToken({ administratorId: identity.administratorId }); assert.equal((await requireAdministratorAuthorization({ authority, bearerToken: token })).role, 'administrator'); await assert.rejects(requireAdministratorAuthorization({ authority, bearerToken: 'mobile-token' }), /required/); await authority.revoke(); assert.equal(await authority.verifyAccessToken(token), null);
});
