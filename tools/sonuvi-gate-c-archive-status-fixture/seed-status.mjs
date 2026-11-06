import fs from 'node:fs/promises';

import { appendBootstrapAttemptEvent, writeBootstrapAttemptProgress } from '/var/lib/sonuvi-bootstrap/bootstrap-kit-v1/src/lib/sonuvi-bootstrap-progress.mjs';
import { readGateCTargetIdentity } from '/var/lib/sonuvi-bootstrap/bootstrap-kit-v1/src/lib/sonuvi-gate-c-target-preflight.mjs';

const attemptId = 'boot_fixture_archive_status_20261105';
const targetIdentity = await readGateCTargetIdentity();
const envelope = JSON.parse(await fs.readFile('/usr/local/share/sonuvi-fixture-release-envelope.json', 'utf8'));
const releaseId = envelope?.payload?.releaseId;
if (!/^sonuvi-[a-f0-9]{64}$/.test(String(releaseId || ''))) throw new Error('fixture release identity is invalid');

await writeBootstrapAttemptProgress({
  attemptId,
  targetIdentity,
  releaseId,
  phase: 'release_acquisition',
});
await appendBootstrapAttemptEvent({
  attemptId,
  targetIdentity,
  event: {
    requestId: attemptId,
    stage: 'release_acquisition',
    state: 'waiting',
    message: 'fixture release stage is ready',
    progress: 20,
  },
});
