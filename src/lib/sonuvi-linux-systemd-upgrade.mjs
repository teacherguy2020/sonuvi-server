import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const SONUVI_UPGRADE_SYSTEMD_UNITS = Object.freeze([
  'sonuvi-api.service',
  'sonuvi-web.service',
]);
export const SONUVI_UPGRADE_ADAPTER_BACKUP_CONTRACT = 'sonuvi.installed-upgrade-adapter-backup.v1';
export const SONUVI_UPGRADE_SYSTEMD_PATHS = Object.freeze({
  layoutRoot: '/opt/sonuvi',
  stateRoot: '/var/lib/sonuvi',
  unitRoot: '/etc/systemd/system',
});

const UNIT_PROPERTIES = Object.freeze([
  'Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'FragmentPath',
  'DropInPaths', 'UnitFileState', 'Environment', 'User', 'Group', 'ExecStart',
  'ExecStartPre', 'EnvironmentFiles', 'Restart', 'RestartUSec', 'Requires',
  'Wants', 'After', 'Before',
]);
const EFFECTIVE_PROPERTIES = Object.freeze([
  'User', 'Group', 'ExecStart', 'ExecStartPre', 'EnvironmentFiles', 'Restart',
  'RestartUSec', 'FragmentPath', 'DropInPaths', 'UnitFileState', 'Requires',
  'Wants', 'After', 'Before',
]);

function fail(code, cause = undefined) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.upgradeCode = code;
  return error;
}

function isReleaseId(value) {
  return /^sonuvi-[a-f0-9]{64}$/.test(String(value || ''));
}

function isTransactionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function parseProperties(stdout) {
  const result = Object.create(null);
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function normalizedEffectiveProperties(properties) {
  const result = Object.create(null);
  for (const property of EFFECTIVE_PROPERTIES) {
    const value = String(properties[property] || '');
    if (['DropInPaths', 'EnvironmentFiles', 'Requires', 'Wants', 'After', 'Before'].includes(property)) {
      result[property] = value.split(/\s+/).filter(Boolean).sort().join(' ');
    } else if (['ExecStart', 'ExecStartPre'].includes(property)) {
      // `systemctl show` appends runtime timestamps/PIDs/status to command
      // properties; those vary on every restart and are not unit settings.
      result[property] = value
        .replace(/ ; start_time=\[[^\]]*\]/g, '')
        .replace(/ ; stop_time=\[[^\]]*\]/g, '')
        .replace(/ ; pid=[^ ;}]*/g, '')
        .replace(/ ; code=[^ ;}]*/g, '')
        .replace(/ ; status=[^ ;}]*/g, '');
    } else {
      result[property] = value;
    }
  }
  result.Environment = String(properties.Environment || '')
    .split(/\s+/)
    .filter((entry) => entry && !entry.startsWith('SONUVI_RELEASE_ID=') && !entry.startsWith('SONUVI_RELEASE_ROOT='))
    .sort()
    .join(' ');
  return result;
}

function environmentValue(properties, name) {
  const found = String(properties.Environment || '').split(/\s+/)
    .filter((entry) => entry.startsWith(`${name}=`));
  return found.length === 1 ? found[0].slice(name.length + 1) : null;
}

function unitFileName(unit) {
  if (!SONUVI_UPGRADE_SYSTEMD_UNITS.includes(unit)) throw fail('upgrade_systemd_unit_invalid');
  return unit;
}

function unitFileFor(paths, unit) {
  return path.join(paths.unitRoot, unitFileName(unit));
}

function fileDigest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function statTrustedFile(filePath, ownerUID, { maxMode = 0o022 } = {}) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(resolved) !== resolved
      || stat.uid !== ownerUID || (stat.mode & maxMode) !== 0) {
      throw fail('upgrade_host_state_untrusted');
    }
  } catch (error) {
    if (error?.upgradeCode) throw error;
    throw fail('upgrade_host_state_unavailable', error);
  }
  return stat;
}

async function statTrustedDirectory(directory, ownerUID, { modeMask = 0o022 } = {}) {
  const resolved = path.resolve(directory);
  let stat;
  try {
    stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(resolved) !== resolved
      || stat.uid !== ownerUID || (stat.mode & modeMask) !== 0) {
      throw fail('upgrade_host_state_untrusted');
    }
  } catch (error) {
    if (error?.upgradeCode) throw error;
    throw fail('upgrade_host_state_unavailable', error);
  }
  return stat;
}

async function defaultSystemctl(args) {
  try {
    return await execFile('/usr/bin/systemctl', args, {
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
  } catch (error) {
    // Never propagate systemctl stderr: it can include local paths or unit text.
    throw fail('upgrade_systemd_operation_failed', error);
  }
}

async function defaultCopyPreservingMetadata(source, destination) {
  try {
    await execFile('/usr/bin/cp', ['--preserve=all', '--', source, destination], {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
    });
  } catch (error) {
    throw fail('upgrade_metadata_preservation_failed', error);
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function ensureRootDirectory(directory, ownerUID) {
  const stat = await statTrustedDirectory(directory, ownerUID);
  return stat;
}

function releaseBoundUnitContents(content, expectedPreviousReleaseId, nextReleaseId) {
  const rows = String(content).split(/(?<=\n)/);
  const counts = { root: 0, id: 0 };
  const output = rows.map((row) => {
    const newline = row.endsWith('\n') ? '\n' : '';
    const body = newline ? row.slice(0, -1) : row;
    if (body.startsWith('Environment=SONUVI_RELEASE_ROOT=')) {
      counts.root += 1;
      if (body !== `Environment=SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${expectedPreviousReleaseId}`) {
        throw fail('upgrade_unit_release_binding_invalid');
      }
      return `Environment=SONUVI_RELEASE_ROOT=/opt/sonuvi/releases/${nextReleaseId}${newline}`;
    }
    if (body.startsWith('Environment=SONUVI_RELEASE_ID=')) {
      counts.id += 1;
      if (body !== `Environment=SONUVI_RELEASE_ID=${expectedPreviousReleaseId}`) {
        throw fail('upgrade_unit_release_binding_invalid');
      }
      return `Environment=SONUVI_RELEASE_ID=${nextReleaseId}${newline}`;
    }
    return row;
  });
  if (counts.root !== 1 || counts.id !== 1) throw fail('upgrade_unit_release_binding_invalid');
  return output.join('');
}

function checkpointForUpgrade({ transactionId, previousReleaseId, candidateReleaseId, phase, startedAt, completedAt = null }) {
  return {
    contract: 'sonuvi.release-activation.v1',
    transactionId,
    phase,
    candidateReleaseId,
    previousReleaseId,
    startedAt,
    completedAt,
    rollback: null,
  };
}

async function writeFilePreservingMetadata({ source, destination, content, copyPreservingMetadata }) {
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `.${path.basename(destination)}.sonuvi-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    await copyPreservingMetadata(source, temporary);
    const handle = await fs.open(temporary, 'r+');
    try {
      await handle.truncate(0);
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
    await syncDirectory(parent);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    if (error?.upgradeCode) throw error;
    throw fail('upgrade_host_state_write_failed', error);
  }
}

async function restoreFilePreservingMetadata({ source, destination, copyPreservingMetadata }) {
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `.${path.basename(destination)}.sonuvi-restore-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    await copyPreservingMetadata(source, temporary);
    await fs.rename(temporary, destination);
    await syncDirectory(parent);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw fail('upgrade_backup_restore_failed', error);
  }
}

function parseEnvironment(buffer) {
  const values = new Map();
  for (const item of Buffer.from(buffer).toString('utf8').split('\0')) {
    const index = item.indexOf('=');
    if (index <= 0) continue;
    const key = item.slice(0, index);
    if (key === 'SONUVI_RELEASE_ID' || key === 'SONUVI_RELEASE_ROOT') values.set(key, item.slice(index + 1));
  }
  return values;
}

async function defaultReadProcessEnvironment(pid) {
  try {
    return await fs.readFile(`/proc/${pid}/environ`);
  } catch (error) {
    throw fail('upgrade_process_identity_unavailable', error);
  }
}

async function defaultFetchJson(url) {
  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(3_000) });
  } catch (error) {
    throw fail('upgrade_health_unavailable', error);
  }
  if (!response.ok) throw fail('upgrade_health_unavailable');
  const length = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > 16 * 1024) throw fail('upgrade_health_response_invalid');
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw fail('upgrade_health_response_invalid', error);
  }
  if (Buffer.byteLength(text) > 16 * 1024) throw fail('upgrade_health_response_invalid');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw fail('upgrade_health_response_invalid', error);
  }
}

async function fetchHealthJson(fetchJson, url) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      if (error?.upgradeCode !== 'upgrade_health_unavailable') throw error;
      lastError = error;
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || fail('upgrade_health_unavailable');
}

function backupDirectory(paths, transactionId) {
  if (!isTransactionId(transactionId)) throw fail('upgrade_transaction_identity_invalid');
  return path.join(paths.stateRoot, 'checkpoints', 'release-upgrade-backups', transactionId);
}

function backupDocumentValid(value, context) {
  if (!value || value.contract !== SONUVI_UPGRADE_ADAPTER_BACKUP_CONTRACT
    || value.transactionId !== context.transactionId
    || value.attemptId !== context.attemptId
    || value.targetIdentity !== context.targetIdentity
    || value.previousReleaseId !== context.previous.releaseId
    || value.candidateReleaseId !== context.candidate.releaseId
    || !value.units || !value.activationCheckpoint) {
    throw fail('upgrade_backup_invalid');
  }
  return value;
}

/**
 * Linux/systemd adapter for the existing release transaction. It changes only
 * the release-bound environment lines in the two installed units and the
 * release-specific startup checkpoint. All other unit bytes, drop-ins,
 * enablement, identity/configuration, and authority files remain untouched.
 */
export function createLinuxSystemdUpgradeAdapter({
  paths: configuredPaths = SONUVI_UPGRADE_SYSTEMD_PATHS,
  ownerUID = 0,
  runSystemctl = defaultSystemctl,
  copyPreservingMetadata = defaultCopyPreservingMetadata,
  readProcessEnvironment = defaultReadProcessEnvironment,
  fetchJson = defaultFetchJson,
  now = () => new Date().toISOString(),
} = {}) {
  const paths = Object.freeze({
    layoutRoot: path.resolve(configuredPaths.layoutRoot),
    stateRoot: path.resolve(configuredPaths.stateRoot),
    unitRoot: path.resolve(configuredPaths.unitRoot),
  });
  const checkpoints = path.join(paths.stateRoot, 'checkpoints');
  const startupCheckpoint = path.join(checkpoints, 'release-activation-state.json');

  async function show(unit) {
    unitFileName(unit);
    const result = await runSystemctl(['show', '--no-pager', `--property=${UNIT_PROPERTIES.join(',')}`, unit]);
    const properties = parseProperties(result?.stdout);
    if (properties.Id !== unit || properties.LoadState !== 'loaded'
      || properties.FragmentPath !== unitFileFor(paths, unit)) {
      throw fail('upgrade_systemd_unit_unavailable');
    }
    return properties;
  }

  async function verifyProcessRelease(unit, properties, expectedReleaseId) {
    if (properties.ActiveState !== 'active' || properties.SubState !== 'running'
      || !/^[1-9][0-9]*$/.test(properties.MainPID || '')) {
      throw fail('upgrade_service_not_running');
    }
    const environment = parseEnvironment(await readProcessEnvironment(properties.MainPID));
    if (environment.get('SONUVI_RELEASE_ID') !== expectedReleaseId
      || environment.get('SONUVI_RELEASE_ROOT') !== `/opt/sonuvi/releases/${expectedReleaseId}`
      || environmentValue(properties, 'SONUVI_RELEASE_ID') !== expectedReleaseId
      || environmentValue(properties, 'SONUVI_RELEASE_ROOT') !== `/opt/sonuvi/releases/${expectedReleaseId}`) {
      throw fail('upgrade_running_release_identity_mismatch');
    }
  }

  async function readSnapshot(context, { persist = false } = {}) {
    const previousReleaseId = context.previous.releaseId;
    const candidateReleaseId = context.candidate.releaseId;
    const files = Object.create(null);
    const systemd = Object.create(null);
    for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
      const unitPath = unitFileFor(paths, unit);
      const stat = await statTrustedFile(unitPath, ownerUID);
      const content = await fs.readFile(unitPath);
      if (releaseBoundUnitContents(content.toString('utf8'), previousReleaseId, candidateReleaseId) === content.toString('utf8')) {
        throw fail('upgrade_unit_release_binding_invalid');
      }
      const properties = await show(unit);
      if (properties.ActiveState !== 'active' || properties.SubState !== 'running') throw fail('upgrade_services_not_active');
      if (!properties.UnitFileState || properties.UnitFileState === 'masked') throw fail('upgrade_service_enablement_invalid');
      await verifyProcessRelease(unit, properties, previousReleaseId);
      files[unit] = { source: unitPath, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, sha256: fileDigest(content) };
      systemd[unit] = normalizedEffectiveProperties(properties);
    }
    const checkpointStat = await statTrustedFile(startupCheckpoint, ownerUID);
    const checkpointBytes = await fs.readFile(startupCheckpoint);
    let checkpoint;
    try { checkpoint = JSON.parse(checkpointBytes.toString('utf8')); } catch { throw fail('upgrade_startup_checkpoint_invalid'); }
    if (checkpoint?.contract !== 'sonuvi.release-activation.v1' || checkpoint.phase !== 'committed'
      || checkpoint.candidateReleaseId !== previousReleaseId) throw fail('upgrade_startup_checkpoint_invalid');
    const activationCheckpoint = {
      source: startupCheckpoint,
      mode: checkpointStat.mode & 0o7777,
      uid: checkpointStat.uid,
      gid: checkpointStat.gid,
      sha256: fileDigest(checkpointBytes),
    };
    const snapshot = { files, systemd, activationCheckpoint };
    if (persist) await persistSnapshot(context, snapshot);
    return snapshot;
  }

  async function persistSnapshot(context, snapshot) {
    await ensureRootDirectory(checkpoints, ownerUID);
    const parent = path.join(checkpoints, 'release-upgrade-backups');
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await ensureRootDirectory(parent, ownerUID);
    const directory = backupDirectory(paths, context.transactionId);
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    await ensureRootDirectory(directory, ownerUID);
    try {
      const fileNames = Object.create(null);
      for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
        const backupFile = path.join(directory, unit);
        await copyPreservingMetadata(snapshot.files[unit].source, backupFile);
        const copied = await fs.readFile(backupFile);
        if (fileDigest(copied) !== snapshot.files[unit].sha256) throw fail('upgrade_backup_integrity_invalid');
        fileNames[unit] = unit;
      }
      const activationBackup = path.join(directory, 'release-activation-state.json');
      await copyPreservingMetadata(startupCheckpoint, activationBackup);
      const checkpointBytes = await fs.readFile(activationBackup);
      if (fileDigest(checkpointBytes) !== snapshot.activationCheckpoint.sha256) throw fail('upgrade_backup_integrity_invalid');
      const descriptor = {
        contract: SONUVI_UPGRADE_ADAPTER_BACKUP_CONTRACT,
        transactionId: context.transactionId,
        attemptId: context.attemptId,
        targetIdentity: context.targetIdentity,
        previousReleaseId: context.previous.releaseId,
        candidateReleaseId: context.candidate.releaseId,
        units: Object.fromEntries(SONUVI_UPGRADE_SYSTEMD_UNITS.map((unit) => [unit, {
          file: fileNames[unit],
          sha256: snapshot.files[unit].sha256,
          mode: snapshot.files[unit].mode,
          uid: snapshot.files[unit].uid,
          gid: snapshot.files[unit].gid,
          effective: snapshot.systemd[unit],
        }])),
        activationCheckpoint: {
          file: 'release-activation-state.json',
          sha256: snapshot.activationCheckpoint.sha256,
          mode: snapshot.activationCheckpoint.mode,
          uid: snapshot.activationCheckpoint.uid,
          gid: snapshot.activationCheckpoint.gid,
        },
      };
      const descriptorPath = path.join(directory, 'backup.json');
      const handle = await fs.open(descriptorPath, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(descriptor)}\n`); await handle.sync(); } finally { await handle.close(); }
      await fs.chown(descriptorPath, ownerUID, 0);
      await fs.chmod(descriptorPath, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      // An incomplete snapshot is inert: services are not stopped until the
      // descriptor has been fully written and fsynced.
      if (error?.upgradeCode) throw error;
      throw fail('upgrade_backup_write_failed', error);
    }
  }

  async function readBackup(context) {
    const directory = backupDirectory(paths, context.transactionId);
    try {
      await ensureRootDirectory(directory, ownerUID);
      const descriptorPath = path.join(directory, 'backup.json');
      const stat = await statTrustedFile(descriptorPath, ownerUID, { maxMode: 0o077 });
      if ((stat.mode & 0o777) !== 0o600) throw fail('upgrade_backup_invalid');
      const value = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
      const descriptor = backupDocumentValid(value, context);
      for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
        const entry = descriptor.units[unit];
        if (!entry || entry.file !== unit || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw fail('upgrade_backup_invalid');
        const backupFile = path.join(directory, unit);
        await statTrustedFile(backupFile, entry.uid, { maxMode: 0o000 });
        if (fileDigest(await fs.readFile(backupFile)) !== entry.sha256) throw fail('upgrade_backup_integrity_invalid');
      }
      const checkpointFile = path.join(directory, 'release-activation-state.json');
      await statTrustedFile(checkpointFile, descriptor.activationCheckpoint.uid, { maxMode: 0o000 });
      if (fileDigest(await fs.readFile(checkpointFile)) !== descriptor.activationCheckpoint.sha256) throw fail('upgrade_backup_integrity_invalid');
      return { directory, descriptor };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.upgradeCode) throw error;
      throw fail('upgrade_backup_invalid', error);
    }
  }

  async function checkpointFor(context, phase) {
    const backup = await readBackup(context);
    if (!backup) throw fail('upgrade_backup_unavailable');
    const startedAt = context.activationStartedAt || context.transactionStartedAt || now();
    const state = checkpointForUpgrade({
      transactionId: context.transactionId,
      previousReleaseId: context.previous.releaseId,
      candidateReleaseId: context.candidate.releaseId,
      phase,
      startedAt,
      completedAt: phase === 'committed' ? now() : null,
    });
    const original = path.join(backup.directory, 'release-activation-state.json');
    await writeFilePreservingMetadata({
      source: original,
      destination: startupCheckpoint,
      content: `${JSON.stringify(state, null, 2)}\n`,
      copyPreservingMetadata,
    });
  }

  async function assertEffectiveConfiguration(properties, descriptor, unit) {
    const expected = descriptor.units[unit].effective;
    const actual = normalizedEffectiveProperties(properties);
    const changed = EFFECTIVE_PROPERTIES.filter((name) => actual[name] !== expected[name]);
    if (changed.length) {
      const error = fail('upgrade_effective_unit_configuration_changed');
      // These are fixed systemd property names only; values may contain local
      // configuration and are deliberately excluded from diagnostics.
      error.message = `upgrade_effective_unit_configuration_changed:${changed.join(',')}`;
      throw error;
    }
  }

  async function stopServices() {
    for (const unit of [...SONUVI_UPGRADE_SYSTEMD_UNITS].reverse()) {
      try { await runSystemctl(['stop', unit]); } catch (error) { throw fail('upgrade_service_stop_failed', error); }
    }
    for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
      const properties = await show(unit);
      if (properties.ActiveState !== 'inactive' || properties.SubState !== 'dead') throw fail('upgrade_services_not_quiescent');
    }
  }

  async function startServices() {
    // A failed candidate start can exhaust systemd's start-rate limit. Clear
    // only per-unit failure counters before starting the verified candidate
    // or restoring the previous release; this does not alter unit files or
    // enablement.
    for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
      try { await runSystemctl(['reset-failed', unit]); } catch (error) { throw fail('upgrade_systemd_reset_failed', error); }
    }
    for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
      try { await runSystemctl(['start', unit]); } catch (error) { throw fail('upgrade_service_start_failed', error); }
    }
  }

  async function rewriteUnits(context, descriptor) {
    for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
      const target = unitFileFor(paths, unit);
      await statTrustedFile(target, ownerUID);
      const current = await fs.readFile(target, 'utf8');
      if (fileDigest(Buffer.from(current)) !== descriptor.units[unit].sha256) {
        throw fail('upgrade_unit_changed_during_transaction');
      }
      const next = releaseBoundUnitContents(current, context.previous.releaseId, context.candidate.releaseId);
      await writeFilePreservingMetadata({ source: target, destination: target, content: next, copyPreservingMetadata });
      const stat = await fs.lstat(target);
      if (stat.uid !== descriptor.units[unit].uid || stat.gid !== descriptor.units[unit].gid
        || (stat.mode & 0o7777) !== descriptor.units[unit].mode) throw fail('upgrade_unit_permissions_changed');
    }
  }

  async function restoreSnapshot(context, backup) {
    await stopServices();
    for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
      const entry = backup.descriptor.units[unit];
      await restoreFilePreservingMetadata({
        source: path.join(backup.directory, entry.file),
        destination: unitFileFor(paths, unit),
        copyPreservingMetadata,
      });
    }
    await restoreFilePreservingMetadata({
      source: path.join(backup.directory, backup.descriptor.activationCheckpoint.file),
      destination: startupCheckpoint,
      copyPreservingMetadata,
    });
    try { await runSystemctl(['daemon-reload']); } catch (error) { throw fail('upgrade_systemd_reload_failed', error); }
    await startServices();
    for (const unit of SONUVI_UPGRADE_SYSTEMD_UNITS) {
      const properties = await show(unit);
      await assertEffectiveConfiguration(properties, backup.descriptor, unit);
      await verifyProcessRelease(unit, properties, context.previous.releaseId);
    }
  }

  return Object.freeze({
    async prepare(context) {
      const previousReleaseId = context.previous?.releaseId;
      const candidateReleaseId = context.candidate?.releaseId;
      if (!isReleaseId(previousReleaseId) || !isReleaseId(candidateReleaseId) || previousReleaseId === candidateReleaseId) {
        throw fail('upgrade_release_identity_invalid');
      }
      await readSnapshot(context, { persist: true });
      await stopServices();
      return Object.freeze({ quiesced: true });
    },

    async restart(context) {
      const backup = await readBackup(context);
      if (!backup) throw fail('upgrade_backup_unavailable');
      const startup = await fs.readFile(startupCheckpoint, 'utf8').then(JSON.parse).catch(() => null);
      if (startup?.contract !== 'sonuvi.release-activation.v1' || startup.phase !== 'pointer-switched'
        || startup.candidateReleaseId !== context.candidate.releaseId) {
        await checkpointFor(context, 'pointer-switched');
      }
      await rewriteUnits(context, backup.descriptor);
      try { await runSystemctl(['daemon-reload']); } catch (error) { throw fail('upgrade_systemd_reload_failed', error); }
      await startServices();
      await checkpointFor(context, 'services-restarted');
    },

    async verify(context) {
      const backup = await readBackup(context);
      if (!backup) throw fail('upgrade_backup_unavailable');
      const unit = `sonuvi-${context.service}.service`;
      unitFileName(unit);
      const properties = await show(unit);
      await assertEffectiveConfiguration(properties, backup.descriptor, unit);
      await verifyProcessRelease(unit, properties, context.expectedReleaseId);
      if (context.service === 'web' && context.expectedReleaseId === context.candidate.releaseId) {
        await checkpointFor(context, 'services-verified');
      }
      return Object.freeze({ releaseId: context.expectedReleaseId });
    },

    async health(context) {
      const unit = `sonuvi-${context.service}.service`;
      unitFileName(unit);
      const properties = await show(unit);
      await verifyProcessRelease(unit, properties, context.expectedReleaseId);
      const value = context.service === 'api'
        ? await fetchHealthJson(fetchJson, 'http://127.0.0.1:3101/health')
        : await fetchHealthJson(fetchJson, 'http://127.0.0.1:8101/release.json');
      const releaseId = context.service === 'api'
        ? value?.release?.releaseId
        : value?.releaseId;
      const valid = context.service === 'api'
        ? value?.contract === 'sonuvi.health.v1' && value?.ok === true
          && value?.release?.mode === 'immutable-release' && releaseId === context.expectedReleaseId
        : value?.contract === 'sonuvi.release-web-identity.v1' && releaseId === context.expectedReleaseId;
      if (!valid) throw fail('upgrade_health_identity_mismatch');
      if (context.service === 'web' && context.expectedReleaseId === context.candidate.releaseId) {
        await checkpointFor(context, 'health-passed');
      }
      return Object.freeze({ ok: true, releaseId });
    },

    async commit(context) {
      await checkpointFor(context, 'committed');
    },

    async rollback(context) {
      const backup = await readBackup(context);
      if (!backup) return Object.freeze({ restored: false, reason: 'no-host-changes-recorded' });
      backupDocumentValid(backup.descriptor, context);
      await restoreSnapshot(context, backup);
      return Object.freeze({ restored: true, previousReleaseId: context.previous.releaseId });
    },
  });
}

export { fail as sonuviUpgradeFailure };
