import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  archiveGateCBootstrapKit,
  createGateCBootstrapKit,
  GATE_C_BOOTSTRAP_KIT_EXTRACTED_TREE,
  GATE_C_BOOTSTRAP_KIT_FILES,
  verifyGateCBootstrapKit,
} from '../src/lib/sonuvi-gate-c-bootstrap-kit.mjs';

const execFile = promisify(execFileCallback);
const releaseId = `sonuvi-${'b'.repeat(64)}`;
const keyId = 'sonuvi-gate-c-kit-test';
const anchors = Object.freeze({ [keyId]: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA1111111111111111111111111111111111111111111=\n-----END PUBLIC KEY-----\n' });

async function temporary(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sonuvi-gate-c-kit-${label}-`));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

async function buildKit(t, label = 'build') {
  const root = await temporary(t, label);
  const kitRoot = path.join(root, 'kit');
  const built = await createGateCBootstrapKit({
    sourceRoot: path.resolve('.'),
    outputRoot: kitRoot,
    releaseId,
    keyId,
    trustedAnchors: anchors,
  });
  return { root, kitRoot, built };
}

async function extractedTree(archive, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await execFile('tar', ['--extract', '--file', archive, '--directory', destination]);
  const entries = ['.'];
  async function visit(directory, relative = '') {
    const names = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of names) {
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      entries.push(`./${child}`);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), child);
    }
  }
  await visit(destination);
  return entries.sort();
}

function capsuleTree(source) {
  const match = source.match(/expected_tree='([\s\S]*?)'/);
  assert.ok(match, 'activation capsule must carry an explicit allowlist');
  return match[1].split('\n').filter(Boolean).sort();
}

test('bootstrap kit includes durable status closure and exactly matches capsule allowlist', async (t) => {
  const { root, kitRoot, built } = await buildKit(t, 'inventory');
  assert.equal(built.manifest.files.some((entry) => entry.path === 'scripts/sonuvi-bootstrap-status.mjs'), true);
  for (const required of [
    'src/lib/sonuvi-bootstrap-status.mjs',
    'src/lib/sonuvi-bootstrap-progress.mjs',
    'src/lib/sonuvi-fresh-install.mjs',
    'src/lib/atomic-file.mjs',
    'src/lib/runtime-capabilities.mjs',
  ]) {
    assert.equal(built.manifest.files.some((entry) => entry.path === required), true, `${required} must ship with status`);
  }
  assert.deepEqual(built.manifest.files.map((entry) => entry.path), GATE_C_BOOTSTRAP_KIT_FILES);
  const archive = await archiveGateCBootstrapKit({ kitRoot, archivePath: path.join(root, 'sonuvi-bootstrap-kit-v1.tar') });
  assert.match(archive.sha256, /^[a-f0-9]{64}$/);
  const extracted = await extractedTree(archive.archivePath, path.join(root, 'extracted'));
  assert.deepEqual(extracted, GATE_C_BOOTSTRAP_KIT_EXTRACTED_TREE);
  const capsule = await fs.readFile(path.resolve('scripts/sonuvi-sftp-bootstrap-activate-v1.sh'), 'utf8');
  assert.deepEqual(capsuleTree(capsule), GATE_C_BOOTSTRAP_KIT_EXTRACTED_TREE);
});

test('bootstrap kit verifier rejects unexpected files, symlinks, malformed manifests, and altered payloads', async (t) => {
  const unexpected = await buildKit(t, 'unexpected');
  await fs.writeFile(path.join(unexpected.kitRoot, 'unexpected.txt'), 'not allowed');
  await assert.rejects(verifyGateCBootstrapKit({ kitRoot: unexpected.kitRoot }), /inventory/);

  const symlink = await buildKit(t, 'symlink');
  await fs.symlink('/outside-kit', path.join(symlink.kitRoot, 'src', 'lib', 'escape-link'));
  await assert.rejects(verifyGateCBootstrapKit({ kitRoot: symlink.kitRoot }), /not a regular file/);

  const malformed = await buildKit(t, 'malformed');
  const manifestPath = path.join(malformed.kitRoot, 'bootstrap-kit-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.target.architecture = 'amd64';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyGateCBootstrapKit({ kitRoot: malformed.kitRoot }), /target/);

  const altered = await buildKit(t, 'altered');
  await fs.writeFile(path.join(altered.kitRoot, 'scripts', 'sonuvi-bootstrap-status.mjs'), 'altered');
  await assert.rejects(verifyGateCBootstrapKit({ kitRoot: altered.kitRoot }), /integrity/);
});

test('real capsule promotes the actual packaged kit and rejects an unexpected archive entry', { skip: process.env.SONUVI_GATE_C_RUN_DOCKER_FIXTURE === '1' ? false : 'set SONUVI_GATE_C_RUN_DOCKER_FIXTURE=1 for isolated Debian ARM64 capsule acceptance' }, async (t) => {
  const { root, kitRoot } = await buildKit(t, 'capsule');
  const builtArchive = await archiveGateCBootstrapKit({ kitRoot, archivePath: path.join(root, 'sonuvi-bootstrap-kit-v1.tar') });
  const packagedArchive = String(process.env.SONUVI_GATE_C_PACKAGED_BOOTSTRAP_KIT || '').trim();
  const archive = packagedArchive
    ? Object.freeze({ archivePath: path.resolve(packagedArchive) })
    : builtArchive;
  const packagedStat = await fs.lstat(archive.archivePath);
  assert.equal(packagedStat.isFile() && !packagedStat.isSymbolicLink(), true, 'capsule input must be a regular archive');
  const capsule = path.resolve('scripts/sonuvi-sftp-bootstrap-activate-v1.sh');

  async function runCapsule({ archivePath, expectedExit, requiredOutput = '' }) {
    const bytes = (await fs.stat(archivePath)).size;
    const digest = crypto.createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
    const fixture = await fs.mkdtemp(path.join(root, 'fixture-'));
    await fs.copyFile(archivePath, path.join(fixture, 'kit.tar'));
    const result = await execFile('docker', [
      'run', '--rm', '--platform', 'linux/arm64', '--network', 'none',
      '--mount', `type=bind,src=${fixture},dst=/fixture,readonly`,
      '--mount', `type=bind,src=${capsule},dst=/capsule,readonly`,
      'debian:bookworm-slim', '/bin/sh', '-ec', [
        'useradd --create-home --shell /usr/sbin/nologin sonuvi-test',
        'install -d -o sonuvi-test -g sonuvi-test -m 700 /home/sonuvi-test/.local /home/sonuvi-test/.local/share /home/sonuvi-test/.local/share/sonuvi-bootstrap-v1',
        'install -o sonuvi-test -g sonuvi-test -m 600 /fixture/kit.tar /home/sonuvi-test/.local/share/sonuvi-bootstrap-v1/sonuvi-bootstrap-kit-v1.tar',
        'printf fixture-machine-id > /etc/machine-id',
        'set +e',
        `SUDO_USER=sonuvi-test /bin/sh /capsule ${digest} ${bytes} >/tmp/stdout 2>/tmp/stderr`,
        'result=$?',
        'set -e',
        `if [ "$result" -ne ${expectedExit} ]; then cat /tmp/stderr >&2; exit 1; fi`,
        requiredOutput ? `grep -q ${JSON.stringify(requiredOutput)} /tmp/stderr` : 'test -f /var/lib/sonuvi-bootstrap/bootstrap-kit-v1/.sonuvi-bootstrap-kit-v1.sha256',
      ].join('\n'),
    ]);
    return result;
  }

  await runCapsule({ archivePath: archive.archivePath, expectedExit: 82 });

  const invalidRoot = path.join(root, 'invalid-kit');
  await fs.mkdir(invalidRoot, { recursive: true, mode: 0o700 });
  await execFile('tar', ['--extract', '--file', archive.archivePath, '--directory', invalidRoot]);
  await fs.writeFile(path.join(invalidRoot, 'unexpected.txt'), 'not allowed');
  const invalidArchive = path.join(root, 'unexpected.tar');
  await execFile('tar', ['--format=ustar', '--create', '--file', invalidArchive, '--directory', invalidRoot, '.']);
  await runCapsule({ archivePath: invalidArchive, expectedExit: 69, requiredOutput: 'bootstrap_kit_entries_invalid' });
});
