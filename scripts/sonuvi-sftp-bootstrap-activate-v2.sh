#!/bin/sh
# Fixed Gate C v2 bootstrap-kit replacement capsule. This source is reviewed,
# application-owned stdin. Candidate archive contents are data until the
# signature, digest, exact inventory, and trust-anchor continuity are verified.
set -eu
umask 077

contract='sonuvi.gate-c-bootstrap-kit-replacement.v1'
operation="${1:-invalid}"
request_operation_id="${2:-}"
request_target_identity="${3:-}"

fail() {
  code="$1"
  case "$operation" in
    replace_bootstrap_kit|recover_bootstrap_kit_replacement|rollback_bootstrap_kit) response_operation="$operation" ;;
    *) response_operation=invalid ;;
  esac
  response_operation_id='bkr_00000000-0000-4000-8000-000000000000'
  candidate_operation_id="$request_operation_id"
  case "$candidate_operation_id" in
    bkr_????????-????-4???-[89ab]???-????????????)
      candidate_uuid="${candidate_operation_id#bkr_}"
      case "$candidate_uuid" in *[!A-Fa-f0-9_-]*) ;; *) response_operation_id="$candidate_operation_id" ;; esac
      ;;
  esac
  response_target_identity='sonuvi-target-v1-0000000000000000000000000000000000000000000000000000000000000000'
  candidate_target_identity="$request_target_identity"
  case "$candidate_target_identity" in
    sonuvi-target-v1-*)
      target_suffix="${candidate_target_identity#sonuvi-target-v1-}"
      if [ "${#target_suffix}" -eq 64 ]; then
        case "$target_suffix" in *[!a-f0-9]*) ;; *) response_target_identity="$candidate_target_identity" ;; esac
      fi
      ;;
  esac
  printf 'sonuvi_bootstrap_kit_replacement_v1:%s\n' "$code" >&2
  printf '{"contract":"%s","operation":"%s","ok":false,"code":"%s","operationId":"%s","targetIdentity":"%s"}\n' \
    "$contract" "$response_operation" "$code" "$response_operation_id" "$response_target_identity"
  exit "${2:-1}"
}

case "$operation" in
  replace_bootstrap_kit) [ "$#" -eq 9 ] || fail invalid_arguments 64 ;;
  recover_bootstrap_kit_replacement) [ "$#" -eq 3 ] || fail invalid_arguments 64 ;;
  rollback_bootstrap_kit) [ "$#" -eq 5 ] || fail invalid_arguments 64 ;;
  *) fail invalid_arguments 64 ;;
esac
[ "$(id -u)" -eq 0 ] || fail root_authorization_required 77
[ -n "${SUDO_USER:-}" ] || fail sudo_user_invalid 77
case "$SUDO_USER" in *[!A-Za-z0-9_-]*|'') fail sudo_user_invalid 77 ;; esac

# The old active kit lives below this root-owned, non-user-writable directory.
# Create/validate the shared advisory lock before Node reads any mutable kit or
# helper path. Updated v2 stage/activate/recovery commands take this same lock.
base_root=/var/lib/sonuvi-bootstrap
[ -d "$base_root" ] && [ ! -L "$base_root" ] || fail bootstrap_root_invalid 68
[ "$(stat -c %u:%g:%a -- "$base_root")" = '0:0:700' ] || fail bootstrap_root_permissions_invalid 68
lock_file="$base_root/bootstrap-admission.lock"
[ ! -L "$lock_file" ] || fail bootstrap_admission_lock_invalid 68
if [ ! -e "$lock_file" ]; then
  (umask 077; set -C; : > "$lock_file") 2>/dev/null || [ -e "$lock_file" ] || fail bootstrap_admission_lock_invalid 68
fi
[ -f "$lock_file" ] && [ ! -L "$lock_file" ] || fail bootstrap_admission_lock_invalid 68
[ "$(stat -c %u:%g:%a:%h -- "$lock_file")" = '0:0:600:1' ] || fail bootstrap_admission_lock_invalid 68
[ -x /usr/bin/flock ] || fail bootstrap_admission_lock_unavailable 69
exec 9>>"$lock_file"
/usr/bin/flock -n 9 || fail operation_busy 75

/usr/bin/node --input-type=module - "$@" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CONTRACT = 'sonuvi.gate-c-bootstrap-kit-replacement.v1';
const OPERATIONS = new Set(['replace_bootstrap_kit', 'recover_bootstrap_kit_replacement', 'rollback_bootstrap_kit']);
const FAILURE_CODES = new Set([
  'atomic_exchange_unavailable', 'bootstrap_admission_lock_invalid', 'bootstrap_admission_lock_unavailable', 'bootstrap_replacement_failed', 'bootstrap_root_invalid', 'bootstrap_root_permissions_invalid', 'current_release_mismatch', 'exclusive_maintenance_required', 'invalid_arguments',
  'operation_busy', 'previous_bootstrap_mismatch', 'replacement_copy_failed', 'replacement_envelope_invalid', 'replacement_kit_archive_invalid',
  'replacement_kit_digest_invalid', 'replacement_kit_inventory_invalid', 'replacement_kit_size_invalid',
  'replacement_journal_failed', 'replacement_operation_conflict', 'replacement_promotion_failed', 'replacement_recovery_required', 'replacement_release_mismatch',
  'replacement_signature_invalid', 'replacement_target_mismatch', 'replacement_trust_anchor_mismatch',
  'root_authorization_required', 'server_release_recovery_pending', 'staging_directory_invalid',
  'staging_mode_invalid', 'staging_owner_invalid', 'staging_source_invalid', 'staging_source_missing', 'sudo_user_invalid',
]);
const FILES = Object.freeze([
  'etc/sonuvi/release-trust-anchors.json',
  'scripts/sonuvi-bootstrap-status.mjs',
  'scripts/sonuvi-debian-node-bootstrap.sh',
  'scripts/sonuvi-existing-install-upgrade.mjs',
  'scripts/sonuvi-first-install-activate.mjs',
  'scripts/sonuvi-release-stage.mjs',
  'scripts/sonuvi-target-preflight.sh',
  'src/lib/atomic-file.mjs',
  'src/lib/public-web-root.mjs',
  'src/lib/release-activation.mjs',
  'src/lib/release-artifact.mjs',
  'src/lib/runtime-capabilities.mjs',
  'src/lib/runtime-config-security.mjs',
  'src/lib/sonuvi-bootstrap-contract.mjs',
  'src/lib/sonuvi-bootstrap-progress.mjs',
  'src/lib/sonuvi-bootstrap-status.mjs',
  'src/lib/sonuvi-fresh-install.mjs',
  'src/lib/sonuvi-gate-c-existing-install-upgrade.mjs',
  'src/lib/sonuvi-gate-c-first-install.mjs',
  'src/lib/sonuvi-gate-c-release.mjs',
  'src/lib/sonuvi-gate-c-staging.mjs',
  'src/lib/sonuvi-gate-c-target-preflight.mjs',
  'src/lib/sonuvi-linux-systemd-upgrade.mjs',
]);
const MAX_KIT_BYTES = 16 * 1024 * 1024;
const ROOT = '/var/lib/sonuvi-bootstrap';
const ACTIVE = path.join(ROOT, 'bootstrap-kit-v2');
const REPLACEMENTS = path.join(ROOT, 'bootstrap-kit-replacements');
const TRUST_ROOT = '/etc/sonuvi';
const TRUST_FILE = path.join(TRUST_ROOT, 'release-trust-anchors.json');
const CURRENT_LINK = '/opt/sonuvi/current';
const argv = process.argv.slice(2);
const operation = argv[0] || 'invalid';
const operationIdPattern = /^bkr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releasePattern = /^sonuvi-[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const targetPattern = /^sonuvi-target-v1-[a-f0-9]{64}$/;

class GateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

let operationPhase = 'request';
const PHASE_FAILURE_CODES = Object.freeze({
  request: 'invalid_arguments',
  target: 'replacement_target_mismatch',
  root: 'bootstrap_root_invalid',
  replacement_root: 'replacement_recovery_required',
  journal: 'replacement_journal_failed',
  recovery_scan: 'replacement_recovery_required',
  trust_anchor: 'replacement_trust_anchor_mismatch',
  server_recovery: 'server_release_recovery_pending',
  maintenance: 'exclusive_maintenance_required',
  staging_home: 'staging_directory_invalid',
  envelope: 'replacement_envelope_invalid',
  previous_kit: 'previous_bootstrap_mismatch',
  staged_file: 'staging_source_invalid',
  copy: 'replacement_copy_failed',
  candidate: 'replacement_kit_inventory_invalid',
  promotion: 'replacement_promotion_failed',
  recovery: 'replacement_recovery_required',
  rollback: 'replacement_promotion_failed',
  previous_kit_root: 'bootstrap_root_invalid',
  previous_kit_marker: 'previous_bootstrap_mismatch',
  previous_kit_manifest: 'replacement_kit_inventory_invalid',
  previous_kit_tree: 'replacement_kit_inventory_invalid',
  previous_kit_trust_anchor: 'replacement_trust_anchor_mismatch',
  replacement_kit_root: 'replacement_kit_inventory_invalid',
  replacement_kit_marker: 'replacement_kit_inventory_invalid',
  replacement_kit_manifest: 'replacement_kit_inventory_invalid',
  replacement_kit_tree: 'replacement_kit_inventory_invalid',
  replacement_kit_trust_anchor: 'replacement_trust_anchor_mismatch',
});
function phase(value) { operationPhase = value; }
function fail(code) { throw new GateError(FAILURE_CODES.has(code) ? code : 'bootstrap_replacement_failed'); }
function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function canonicalJson(value) { return JSON.stringify(canonical(value)); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function validId(value) { return typeof value === 'string' && operationIdPattern.test(value); }
function validRelease(value) { return typeof value === 'string' && releasePattern.test(value); }
function validDigest(value) { return typeof value === 'string' && digestPattern.test(value); }
function validTarget(value) { return typeof value === 'string' && targetPattern.test(value); }
function modeOf(stat) { return stat.mode & 0o7777; }
function ownerIsRoot(stat) { return stat.uid === 0 && stat.gid === 0; }
function normalizedTrustAnchors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length < 1 || Object.keys(value).length > 32) fail('replacement_trust_anchor_mismatch');
  const normalized = new Map();
  for (const keyId of Object.keys(value).sort()) {
    const pem = value[keyId];
    if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(keyId) || typeof pem !== 'string' || pem.length > 16 * 1024) {
      fail('replacement_trust_anchor_mismatch');
    }
    let key;
    try { key = crypto.createPublicKey(pem); } catch { fail('replacement_trust_anchor_mismatch'); }
    if (key.asymmetricKeyType !== 'ed25519') fail('replacement_trust_anchor_mismatch');
    normalized.set(keyId, key.export({ type: 'spki', format: 'der' }));
  }
  return normalized;
}
function sameTrustAnchorSet(left, right) {
  const a = normalizedTrustAnchors(left);
  const b = normalizedTrustAnchors(right);
  if (a.size !== b.size) return false;
  for (const [keyId, keyBytes] of a) {
    const other = b.get(keyId);
    if (!other || keyBytes.length !== other.length || !crypto.timingSafeEqual(keyBytes, other)) return false;
  }
  return true;
}
function responseBase(state, journal, operationName = operation) {
  return {
    contract: CONTRACT,
    operation: operationName,
    ok: true,
    state,
    operationId: journal.operationId,
    targetIdentity: journal.targetIdentity,
    expectedServerReleaseId: journal.expectedServerReleaseId,
    previousBootstrapKitSHA256: journal.previousBootstrapKitSHA256,
    replacementReleaseId: journal.replacementReleaseId,
    replacementKitSHA256: journal.replacementKitSHA256,
  };
}
function failureResponse(code) {
  const responseOperation = OPERATIONS.has(operation) ? operation : 'invalid';
  return {
    contract: CONTRACT,
    operation: responseOperation,
    ok: false,
    code: FAILURE_CODES.has(code) ? code : 'bootstrap_replacement_failed',
    operationId: validId(argv[1]) ? argv[1] : 'bkr_00000000-0000-4000-8000-000000000000',
    targetIdentity: validTarget(argv[2]) ? argv[2] : 'sonuvi-target-v1-0000000000000000000000000000000000000000000000000000000000000000',
  };
}

async function requireEntry(filePath, { kind, uid = 0, gid = 0, mode } = {}) {
  let stat;
  try { stat = await fs.lstat(filePath); } catch { fail('bootstrap_root_invalid'); }
  if (stat.isSymbolicLink() || !ownerIsRoot(stat) || (uid !== 0 && stat.uid !== uid)) fail('bootstrap_root_invalid');
  if (kind === 'directory' && !stat.isDirectory()) fail('bootstrap_root_invalid');
  if (kind === 'file' && !stat.isFile()) fail('bootstrap_root_invalid');
  if (mode !== undefined && modeOf(stat) !== mode) fail('bootstrap_root_invalid');
  return stat;
}

async function anchorContext() {
  await requireEntry(TRUST_ROOT, { kind: 'directory', mode: 0o755 });
  await requireEntry(TRUST_FILE, { kind: 'file', mode: 0o644 });
  const anchorBytes = await fs.readFile(TRUST_FILE);
  let anchors;
  try { anchors = JSON.parse(anchorBytes.toString('utf8')); } catch { fail('replacement_trust_anchor_mismatch'); }
  normalizedTrustAnchors(anchors);
  return { anchorBytes, anchors };
}

function normalizeMetadata(input) {
  if (!sameKeys(input, ['artifact', 'bootstrap', 'contract', 'expiresAt', 'issuedAt', 'manifestSha256', 'releaseId', 'target'])
    || input.contract !== 'sonuvi.gate-c-release-metadata.v1'
    || !sameKeys(input.target, ['architecture', 'os'])
    || input.target.os !== 'linux' || input.target.architecture !== 'arm64'
    || !sameKeys(input.artifact, ['bytes', 'format', 'sha256'])
    || input.artifact.format !== 'sonuvi.release-tar.v1'
    || !Number.isSafeInteger(input.artifact.bytes) || input.artifact.bytes < 1 || input.artifact.bytes > 8 * 1024 * 1024 * 1024
    || !sameKeys(input.bootstrap, ['sha256', 'version']) || input.bootstrap.version !== 2
    || typeof input.issuedAt !== 'string' || !Number.isFinite(Date.parse(input.issuedAt))
    || typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))
    || Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)
    || !validRelease(input.releaseId) || !validDigest(input.manifestSha256)
    || !validDigest(input.artifact.sha256) || !validDigest(input.bootstrap.sha256)) fail('replacement_envelope_invalid');
  return {
    contract: input.contract,
    releaseId: input.releaseId,
    manifestSha256: input.manifestSha256,
    target: { os: 'linux', architecture: 'arm64' },
    artifact: { format: input.artifact.format, sha256: input.artifact.sha256, bytes: input.artifact.bytes },
    bootstrap: { version: 2, sha256: input.bootstrap.sha256 },
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
}

function verifyEnvelope(encoded, anchors) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{16,87382}$/.test(encoded)) fail('replacement_envelope_invalid');
  let envelopeBytes;
  let envelope;
  try {
    envelopeBytes = Buffer.from(encoded, 'base64url');
    if (envelopeBytes.length > 64 * 1024 || envelopeBytes.toString('base64url') !== encoded) fail('replacement_envelope_invalid');
    envelope = JSON.parse(envelopeBytes.toString('utf8'));
  } catch { fail('replacement_envelope_invalid'); }
  if (!sameKeys(envelope, ['contract', 'keyId', 'payload', 'signature'])
    || envelope.contract !== 'sonuvi.gate-c-release-envelope.v1'
    || typeof envelope.keyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(envelope.keyId)
    || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{80,256}$/.test(envelope.signature)) fail('replacement_envelope_invalid');
  const signatureBytes = Buffer.from(envelope.signature, 'base64url');
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64url') !== envelope.signature) fail('replacement_envelope_invalid');
  const publicKeyPem = anchors[envelope.keyId];
  if (typeof publicKeyPem !== 'string') fail('replacement_signature_invalid');
  const metadata = normalizeMetadata(envelope.payload);
  let key;
  let signatureValid = false;
  try {
    key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') fail('replacement_signature_invalid');
    signatureValid = crypto.verify(null, Buffer.from(canonicalJson(metadata), 'utf8'), key, Buffer.from(envelope.signature, 'base64url'));
  } catch { fail('replacement_signature_invalid'); }
  if (!signatureValid || Date.parse(metadata.expiresAt) <= Date.now()) fail('replacement_signature_invalid');
  return { envelope, metadata };
}

async function currentTargetIdentity() {
  const machinePath = '/etc/machine-id';
  let stat;
  try { stat = await fs.lstat(machinePath); } catch { fail('replacement_target_mismatch'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0) fail('replacement_target_mismatch');
  const machine = (await fs.readFile(machinePath, 'utf8')).trim();
  if (!/^[a-f0-9]{32}$/.test(machine)) fail('replacement_target_mismatch');
  return `sonuvi-target-v1-${crypto.createHash('sha256').update(`sonuvi.gate-c.target.v1:${machine}`, 'utf8').digest('hex')}`;
}

async function currentRelease(expectedReleaseId) {
  await requireEntry('/opt/sonuvi', { kind: 'directory', mode: 0o755 });
  await requireEntry('/opt/sonuvi/releases', { kind: 'directory' });
  const linkStat = await fs.lstat(CURRENT_LINK).catch(() => null);
  if (!linkStat || !linkStat.isSymbolicLink() || linkStat.uid !== 0 || linkStat.gid !== 0) fail('current_release_mismatch');
  if (await fs.readlink(CURRENT_LINK) !== `releases/${expectedReleaseId}`) fail('current_release_mismatch');
  const releaseRoot = path.join('/opt/sonuvi/releases', expectedReleaseId);
  await requireEntry(releaseRoot, { kind: 'directory' });
  if (await fs.realpath(CURRENT_LINK) !== await fs.realpath(releaseRoot)) fail('current_release_mismatch');
  const manifestPath = path.join(releaseRoot, 'release-manifest.json');
  const manifestStat = await fs.lstat(manifestPath).catch(() => null);
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink() || !ownerIsRoot(manifestStat) || (modeOf(manifestStat) & 0o022)) fail('current_release_mismatch');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { fail('current_release_mismatch'); }
  if (manifest?.releaseId !== expectedReleaseId) fail('current_release_mismatch');
}

async function assertNoServerReleaseRecovery() {
  const checkpointRoot = '/var/lib/sonuvi/checkpoints';
  const lockPath = path.join(checkpointRoot, 'release-activation.lock');
  if (await fs.lstat(lockPath).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : true)) fail('server_release_recovery_pending');
  const statePath = path.join(checkpointRoot, 'release-upgrade-state.json');
  const stateStat = await fs.lstat(statePath).catch((error) => error?.code === 'ENOENT' ? null : fail('server_release_recovery_pending'));
  if (!stateStat) return;
  if (!stateStat.isFile() || stateStat.isSymbolicLink() || stateStat.uid !== 0 || stateStat.gid !== 0) fail('server_release_recovery_pending');
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch { fail('server_release_recovery_pending'); }
  if (state?.contract !== 'sonuvi.release-activation.v1'
    || !['committed', 'rolled-back', 'recovered'].includes(state.phase)) fail('server_release_recovery_pending');
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory && directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort();
}
const KIT_TREE = Object.freeze([
  'bootstrap-kit-manifest.json',
  ...FILES,
  ...expectedDirectories(FILES),
]);

const SAFE_EXTRACT_PY = `import json, os, posixpath, sys, tarfile
archive_path, destination, expected_json = sys.argv[1:4]
expected = set(json.loads(expected_json))
expected_dirs = set()
for item in expected:
    parent = posixpath.dirname(item)
    while parent and parent != '.':
        expected_dirs.add(parent)
        parent = posixpath.dirname(parent)
expected_files = expected - expected_dirs
if not expected or len(expected) > 128:
    raise SystemExit(2)
os.mkdir(destination, 0o700)
with tarfile.open(archive_path, mode='r:') as archive:
    members = archive.getmembers()
    if not members or len(members) != len(expected) or len(members) > 128:
        raise SystemExit(3)
    seen = set()
    normalized = []
    total = 0
    for member in members:
        name = member.name
        if not name or name.startswith('/') or '\\\\' in name or '\\x00' in name or member.pax_headers:
            raise SystemExit(4)
        if member.isdir() and name.endswith('/'):
            name = name[:-1]
        if posixpath.normpath(name) != name or name in ('.', '..') or any(part in ('', '.', '..') for part in name.split('/')):
            raise SystemExit(5)
        if name in seen or name not in expected:
            raise SystemExit(6)
        if member.isdir():
            if name not in expected_dirs or member.mode != 0o700:
                raise SystemExit(7)
            normalized.append((member, name, True))
        elif member.isfile():
            if name not in expected_files or member.mode != 0o600:
                raise SystemExit(8)
            if member.size < 0 or member.size > 16 * 1024 * 1024:
                raise SystemExit(9)
            total += member.size
            if total > 32 * 1024 * 1024:
                raise SystemExit(10)
            normalized.append((member, name, False))
        else:
            raise SystemExit(11)
        if member.uid < 0 or member.gid < 0 or member.uid > 2147483647 or member.gid > 2147483647:
            raise SystemExit(12)
        seen.add(name)
    if seen != expected:
        raise SystemExit(13)
    for member, name, is_directory in sorted(normalized, key=lambda item: (not item[2], item[1])):
        target = os.path.join(destination, *name.split('/'))
        if is_directory:
            os.mkdir(target, 0o700)
            os.chown(target, 0, 0)
            continue
        parent = os.path.dirname(target)
        if not os.path.isdir(parent) or os.path.islink(parent):
            raise SystemExit(14)
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(15)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            remaining = member.size
            with os.fdopen(fd, 'wb', closefd=False) as output:
                while remaining:
                    chunk = source.read(min(65536, remaining))
                    if not chunk:
                        raise SystemExit(16)
                    output.write(chunk)
                    remaining -= len(chunk)
                output.flush()
                os.fsync(fd)
            os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
            source.close()
os.chown(destination, 0, 0)
os.chmod(destination, 0o700)
for current, dirs, files in os.walk(destination, topdown=False, followlinks=False):
    for name in dirs:
        target = os.path.join(current, name)
        os.chown(target, 0, 0)
        os.chmod(target, 0o700)
    fd = os.open(current, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
`;

function validEnvelopeArgument(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,87382}$/.test(value)) fail('replacement_envelope_invalid');
  return value;
}

function parseReplacementArgs() {
  if (operation !== 'replace_bootstrap_kit' || argv.length !== 9) fail('invalid_arguments');
  const [, opId, target, expectedServer, previousKit, replacementRelease, replacementKit, rawBytes, encodedEnvelope] = argv;
  if (!validId(opId) || !validTarget(target) || !validRelease(expectedServer) || !validDigest(previousKit)
    || !validRelease(replacementRelease) || !validDigest(replacementKit)
    || !/^[1-9][0-9]{0,7}$/.test(rawBytes) || Number(rawBytes) > MAX_KIT_BYTES) fail('invalid_arguments');
  return {
    operationId: opId,
    targetIdentity: target,
    expectedServerReleaseId: expectedServer,
    previousBootstrapKitSHA256: previousKit,
    replacementReleaseId: replacementRelease,
    replacementKitSHA256: replacementKit,
    replacementKitBytes: Number(rawBytes),
    encodedEnvelope: validEnvelopeArgument(encodedEnvelope),
    signedEnvelopeSHA256: sha256(Buffer.from(encodedEnvelope, 'base64url')),
  };
}

async function assertRootTree(rootPath, expectedMarker, anchorBytes) {
  const treeLabel = rootPath === ACTIVE ? 'previous_kit' : 'replacement_kit';
  phase(`${treeLabel}_root`);
  await requireEntry(rootPath, { kind: 'directory', mode: 0o700 });
  const manifestPath = path.join(rootPath, 'bootstrap-kit-manifest.json');
  const markerPath = path.join(rootPath, '.sonuvi-bootstrap-kit-v2.sha256');
  phase(`${treeLabel}_manifest`);
  await requireEntry(manifestPath, { kind: 'file', mode: 0o600 });
  phase(`${treeLabel}_marker`);
  await requireEntry(markerPath, { kind: 'file', mode: 0o600 });
  const marker = (await fs.readFile(markerPath, 'utf8')).trim();
  if (!validDigest(marker) || (expectedMarker && marker !== expectedMarker)) fail('previous_bootstrap_mismatch');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { fail('replacement_kit_inventory_invalid'); }
  if (!sameKeys(manifest, ['contract', 'files', 'keyId', 'releaseId', 'target', 'version'])
    || manifest.contract !== 'sonuvi.gate-c-bootstrap-kit.v2' || manifest.version !== 2
    || !validRelease(manifest.releaseId) || !manifest.target || !sameKeys(manifest.target, ['architecture', 'os'])
    || manifest.target.os !== 'linux' || manifest.target.architecture !== 'arm64'
    || typeof manifest.keyId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(manifest.keyId)
    || !Array.isArray(manifest.files) || manifest.files.length !== FILES.length) fail('replacement_kit_inventory_invalid');
  const actual = [];
  const visited = [];
  phase(`${treeLabel}_tree`);
  async function walk(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(directory, entry.name);
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !ownerIsRoot(stat)) fail('replacement_kit_inventory_invalid');
      if (stat.isDirectory()) {
        if (modeOf(stat) !== 0o700) fail('replacement_kit_inventory_invalid');
        visited.push(child);
        await walk(filePath, child);
      } else if (stat.isFile()) {
        if (modeOf(stat) !== 0o600 || stat.nlink !== 1) fail('replacement_kit_inventory_invalid');
        visited.push(child);
        if (child === '.sonuvi-bootstrap-kit-v2.sha256' || child === 'bootstrap-kit-manifest.json') continue;
        const bytes = await fs.readFile(filePath);
        actual.push({ path: child, bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        fail('replacement_kit_inventory_invalid');
      }
    }
  }
  await walk(rootPath);
  actual.sort((a, b) => a.path.localeCompare(b.path));
  const expectedTree = [...FILES, 'bootstrap-kit-manifest.json', '.sonuvi-bootstrap-kit-v2.sha256', ...expectedDirectories(FILES)].sort();
  if (JSON.stringify(visited.sort()) !== JSON.stringify(expectedTree)) fail('replacement_kit_inventory_invalid');
  const manifestFiles = manifest.files.map((file) => {
    if (!sameKeys(file, ['bytes', 'path', 'sha256']) || !FILES.includes(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !validDigest(file.sha256)) fail('replacement_kit_inventory_invalid');
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(manifestFiles) !== JSON.stringify(actual)
    || JSON.stringify(actual.map((file) => file.path)) !== JSON.stringify(FILES)) fail('replacement_kit_inventory_invalid');
  phase(`${treeLabel}_trust_anchor`);
  if (!Object.hasOwn(JSON.parse(anchorBytes.toString('utf8')), manifest.keyId)) fail('replacement_trust_anchor_mismatch');
  const kitAnchorPath = path.join(rootPath, 'etc/sonuvi/release-trust-anchors.json');
  await requireEntry(kitAnchorPath, { kind: 'file', mode: 0o600 });
  let kitAnchors;
  try { kitAnchors = JSON.parse(await fs.readFile(kitAnchorPath, 'utf8')); } catch { fail('replacement_trust_anchor_mismatch'); }
  if (!sameTrustAnchorSet(JSON.parse(anchorBytes.toString('utf8')), kitAnchors)) fail('replacement_trust_anchor_mismatch');
  return { marker, manifest };
}

async function sourceHome() {
  const sudoUser = process.env.SUDO_USER || '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sudoUser)) fail('sudo_user_invalid');
  let uid;
  let gid;
  let passwd;
  try {
    uid = Number(execFileSync('/usr/bin/id', ['-u', sudoUser], { encoding: 'utf8' }).trim());
    gid = Number(execFileSync('/usr/bin/id', ['-g', sudoUser], { encoding: 'utf8' }).trim());
    passwd = execFileSync('/usr/bin/getent', ['passwd', sudoUser], { encoding: 'utf8' }).trim();
  } catch { fail('sudo_user_invalid'); }
  if (!Number.isSafeInteger(uid) || uid < 1 || Number(process.env.SUDO_UID) !== uid
    || !Number.isSafeInteger(gid) || gid < 1 || Number(process.env.SUDO_GID) !== gid) fail('sudo_user_invalid');
  const fields = passwd.split(':');
  if (fields.length < 7 || fields[0] !== sudoUser || !path.isAbsolute(fields[5])) fail('staging_directory_invalid');
  const home = await fs.realpath(fields[5]).catch(() => null);
  if (!home || home !== fields[5] || home === '/') fail('staging_directory_invalid');
  const { constants } = await import('node:fs');
  const handles = [];
  const openDirectory = async (parent, child, { first = false } = {}) => {
    const candidate = first ? child : `/proc/self/fd/${parent.fd}/${child}`;
    const handle = await fs.open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      .catch(() => fail('staging_directory_invalid'));
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await handle.close();
      fail('staging_directory_invalid');
    }
    handles.push(handle);
    return handle;
  };
  const homeHandle = await openDirectory(null, home, { first: true });
  const homeStat = await homeHandle.stat();
  if (homeStat.uid !== uid || homeStat.gid !== gid) fail('staging_owner_invalid');
  let parent = homeHandle;
  for (const component of ['.local', 'share', 'sonuvi-bootstrap-v2']) {
    parent = await openDirectory(parent, component);
    const stat = await parent.stat();
    if (stat.uid !== uid || stat.gid !== gid || modeOf(stat) !== 0o700) fail('staging_owner_invalid');
  }
  return { home, uid, gid, directoryHandle: parent, handles };
}

async function copyStagedArchive(sourceHandle, destination, expectedBytes, expectedDigest, ownerUID, ownerGID) {
  const { constants } = await import('node:fs');
  let destinationHandle;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.uid !== ownerUID || before.gid !== ownerGID) fail('staging_owner_invalid');
    if (modeOf(before) !== 0o600) fail('staging_mode_invalid');
    if (before.size !== expectedBytes) fail('replacement_kit_size_invalid');
    destinationHandle = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const hash = crypto.createHash('sha256');
    let offset = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (offset < expectedBytes) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
      if (bytesRead <= 0) fail('replacement_kit_size_invalid');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(chunk, written, bytesRead - written, offset + written);
        if (result.bytesWritten <= 0) fail('replacement_kit_archive_invalid');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || hash.digest('hex') !== expectedDigest) fail('replacement_kit_digest_invalid');
    await destinationHandle.chown(0, 0);
    await destinationHandle.chmod(0o600);
    await destinationHandle.sync();
  } finally {
    await destinationHandle?.close().catch(() => {});
  }
}

async function closeSourceHome(user) {
  for (const handle of [...(user?.handles || [])].reverse()) await handle.close().catch(() => {});
}

async function stagedArchiveHandle(user, digest) {
  const { constants } = await import('node:fs');
  const name = `sonuvi-bootstrap-kit-v2-${digest}.tar`;
  const source = `/proc/self/fd/${user.directoryHandle.fd}/${name}`;
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
    fail(error?.code === 'ELOOP' ? 'staging_source_invalid' : 'staging_source_missing');
  });
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    fail('staging_source_invalid');
  }
  return handle;
}

async function assertNoHistoricalHelpers() {
  const helperPattern = /\/var\/lib\/sonuvi-bootstrap\/bootstrap-kit-v2\/scripts\/(?:sonuvi-release-stage\.mjs|sonuvi-existing-install-upgrade\.mjs|sonuvi-first-install-activate\.mjs|sonuvi-bootstrap-status\.mjs|sonuvi-debian-node-bootstrap\.sh)/;
  // Historical fixed capsules are supplied on stdin, so their command lines do
  // not contain a capsule path. Their legacy argument framing is still
  // recognizable as /bin/sh -s -- <digest> <byte-count>.
  const legacyCapsulePattern = /(?:^|\s)(?:\/bin\/sh|sh) -s -- [a-f0-9]{64} [0-9]{1,8}(?:\s|$)/;
  const processEntries = await fs.readdir('/proc').catch(() => fail('exclusive_maintenance_required'));
  for (const entry of processEntries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const command = await fs.readFile(`/proc/${entry}/cmdline`).catch(() => null);
    if (!command || command.length === 0) continue;
    const commandLine = command.toString('utf8').replaceAll('\0', ' ');
    if (helperPattern.test(commandLine) || legacyCapsulePattern.test(commandLine)) fail('exclusive_maintenance_required');
  }
}

async function extractCandidate(archive, destination) {
  const expectedTree = ['bootstrap-kit-manifest.json', ...FILES, ...expectedDirectories(FILES)];
  try {
    execFileSync('/usr/bin/python3', ['-c', SAFE_EXTRACT_PY, archive, destination, JSON.stringify(expectedTree)], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 30_000,
    });
  } catch { fail('replacement_kit_archive_invalid'); }
}

async function writeMarker(candidateRoot, digest) {
  const markerPath = path.join(candidateRoot, '.sonuvi-bootstrap-kit-v2.sha256');
  const handle = await fs.open(markerPath, 'wx', 0o600).catch(() => fail('replacement_kit_inventory_invalid'));
  try { await handle.writeFile(`${digest}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fs.chown(markerPath, 0, 0);
  await fs.chmod(markerPath, 0o600);
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJournal(operationRoot, journal) {
  const target = path.join(operationRoot, 'journal.json');
  const temporary = path.join(operationRoot, `.journal-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fs.chown(temporary, 0, 0);
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, target);
  await syncDirectory(operationRoot);
}

async function writeInitialJournal(operationRoot, journal) {
  const temporary = path.join(REPLACEMENTS, `.journal-${journal.operationId}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600).catch(() => fail('replacement_operation_conflict'));
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
    await handle.sync();
    await handle.chown(0, 0);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await syncDirectory(REPLACEMENTS);
  try {
    await fs.mkdir(operationRoot, { mode: 0o700 });
  } catch {
    await fs.unlink(temporary).catch(() => {});
    fail('replacement_operation_conflict');
  }
  await fs.chown(operationRoot, 0, 0);
  await fs.chmod(operationRoot, 0o700);
  await syncDirectory(REPLACEMENTS);
  await fs.rename(temporary, path.join(operationRoot, 'journal.json'));
  await syncDirectory(operationRoot);
}

function validateJournal(value, expectedId) {
  if (!sameKeys(value, [
    'contract', 'createdAt', 'expectedServerReleaseId', 'operationId', 'previousBootstrapKitSHA256',
    'replacementKitBytes', 'replacementKitSHA256', 'replacementReleaseId', 'signedEnvelopeSHA256', 'state', 'targetIdentity', 'updatedAt',
  ]) || value.contract !== CONTRACT || value.operationId !== expectedId || !validId(value.operationId)
    || !validTarget(value.targetIdentity) || !validRelease(value.expectedServerReleaseId)
    || !validDigest(value.previousBootstrapKitSHA256) || !validRelease(value.replacementReleaseId)
    || !validDigest(value.replacementKitSHA256) || !validDigest(value.signedEnvelopeSHA256) || !Number.isSafeInteger(value.replacementKitBytes)
    || value.replacementKitBytes < 1 || value.replacementKitBytes > MAX_KIT_BYTES
    || !['aborted_before_promotion', 'committed', 'prepared', 'preparing', 'promoted', 'rollback_prepared', 'rolled_back'].includes(value.state)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) fail('replacement_recovery_required');
  return value;
}

async function readJournal(operationId) {
  const operationRoot = path.join(REPLACEMENTS, operationId);
  const directory = await fs.lstat(operationRoot).catch((error) => error?.code === 'ENOENT' ? null : fail('replacement_recovery_required'));
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink() || !ownerIsRoot(directory) || modeOf(directory) !== 0o700)) fail('replacement_recovery_required');
  const journalPath = path.join(operationRoot, 'journal.json');
  let stat = await fs.lstat(journalPath).catch((error) => error?.code === 'ENOENT' ? null : fail('replacement_recovery_required'));
  if (!directory && !stat) {
    const initialPath = path.join(REPLACEMENTS, `.journal-${operationId}.tmp`);
    const initial = await fs.lstat(initialPath).catch((error) => error?.code === 'ENOENT' ? null : fail('replacement_recovery_required'));
    if (!initial) return { operationRoot, journal: null };
    if (!initial.isFile() || initial.isSymbolicLink() || !ownerIsRoot(initial) || modeOf(initial) !== 0o600) fail('replacement_recovery_required');
    let initialValue;
    try { initialValue = validateJournal(JSON.parse(await fs.readFile(initialPath, 'utf8')), operationId); } catch { fail('replacement_recovery_required'); }
    await fs.mkdir(operationRoot, { mode: 0o700 }).catch(() => fail('replacement_recovery_required'));
    await fs.chown(operationRoot, 0, 0);
    await fs.chmod(operationRoot, 0o700);
    await syncDirectory(REPLACEMENTS);
    await fs.rename(initialPath, journalPath);
    await syncDirectory(operationRoot);
    stat = await fs.lstat(journalPath);
    return { operationRoot, journal: initialValue };
  }
  if (!directory) fail('replacement_recovery_required');
  if (!stat) {
    const initialPath = path.join(REPLACEMENTS, `.journal-${operationId}.tmp`);
    const initial = await fs.lstat(initialPath).catch((error) => error?.code === 'ENOENT' ? null : fail('replacement_recovery_required'));
    if (!initial || !initial.isFile() || initial.isSymbolicLink() || !ownerIsRoot(initial) || modeOf(initial) !== 0o600) fail('replacement_recovery_required');
    let initialValue;
    try { initialValue = validateJournal(JSON.parse(await fs.readFile(initialPath, 'utf8')), operationId); } catch { fail('replacement_recovery_required'); }
    await fs.rename(initialPath, journalPath);
    await syncDirectory(operationRoot);
    return { operationRoot, journal: initialValue };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !ownerIsRoot(stat) || modeOf(stat) !== 0o600) fail('replacement_recovery_required');
  let value;
  try { value = JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch { fail('replacement_recovery_required'); }
  return { operationRoot, journal: validateJournal(value, operationId) };
}

async function unresolvedOperations() {
  const entries = await fs.readdir(REPLACEMENTS, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : fail('replacement_recovery_required'));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !validId(entry.name)) fail('replacement_recovery_required');
    const { journal } = await readJournal(entry.name);
    if (!journal) fail('replacement_recovery_required');
    if (!['aborted_before_promotion', 'committed', 'rolled_back'].includes(journal.state)) fail('replacement_recovery_required');
  }
}

async function ensureReplacementRoot() {
  const stat = await fs.lstat(REPLACEMENTS).catch((error) => error?.code === 'ENOENT' ? null : fail('replacement_recovery_required'));
  if (!stat) {
    await fs.mkdir(REPLACEMENTS, { mode: 0o700 });
    await fs.chown(REPLACEMENTS, 0, 0);
    await fs.chmod(REPLACEMENTS, 0o700);
    await syncDirectory(ROOT);
  } else if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerIsRoot(stat) || modeOf(stat) !== 0o700) {
    fail('replacement_recovery_required');
  }
}

async function assertCurrentKit(digest, anchorBytes) {
  const result = await assertRootTree(ACTIVE, digest, anchorBytes);
  return result.manifest;
}

async function assertServerTarget(targetIdentity, serverReleaseId) {
  if (await currentTargetIdentity() !== targetIdentity) fail('replacement_target_mismatch');
  await currentRelease(serverReleaseId);
}

async function serverReleaseDoesNotMatch(expectedReleaseId) {
  try {
    await currentRelease(expectedReleaseId);
    return false;
  } catch (error) {
    if (error instanceof GateError && error.code === 'current_release_mismatch') return true;
    throw error;
  }
}

async function copyStagedKitToTransaction(request, operationRoot, ownerUID) {
  const user = await sourceHome();
  const source = await stagedArchiveHandle(user, request.replacementKitSHA256);
  const archive = path.join(operationRoot, 'incoming.tar');
  try {
    await copyStagedArchive(source, archive, request.replacementKitBytes, request.replacementKitSHA256, ownerUID, user.gid);
  } finally {
    await source.close().catch(() => {});
    await closeSourceHome(user);
  }
  return archive;
}

function verifySignedCandidate(request, anchors) {
  const { envelope, metadata } = verifyEnvelope(request.encodedEnvelope, anchors);
  if (metadata.releaseId !== request.replacementReleaseId
    || metadata.bootstrap.sha256 !== request.replacementKitSHA256
    || metadata.bootstrap.version !== 2
    || metadata.releaseId === request.expectedServerReleaseId) fail('replacement_release_mismatch');
  return { envelope, metadata };
}

function makeJournal(request, state, createdAt = new Date().toISOString()) {
  const updatedAt = new Date().toISOString();
  return {
    contract: CONTRACT,
    operationId: request.operationId,
    targetIdentity: request.targetIdentity,
    expectedServerReleaseId: request.expectedServerReleaseId,
    previousBootstrapKitSHA256: request.previousBootstrapKitSHA256,
    replacementReleaseId: request.replacementReleaseId,
    replacementKitSHA256: request.replacementKitSHA256,
    replacementKitBytes: request.replacementKitBytes,
    signedEnvelopeSHA256: request.signedEnvelopeSHA256,
    state,
    createdAt,
    updatedAt,
  };
}

async function transition(operationRoot, journal, state) {
  const updated = { ...journal, state, updatedAt: new Date().toISOString() };
  await writeJournal(operationRoot, updated);
  return updated;
}

const EXCHANGE_PY = `import ctypes, errno, os, sys
left, right = sys.argv[1:3]
left_stat = os.lstat(left)
right_stat = os.lstat(right)
if not os.path.isdir(left) or os.path.islink(left) or not os.path.isdir(right) or os.path.islink(right):
    raise SystemExit(20)
if left_stat.st_dev != right_stat.st_dev:
    raise SystemExit(21)
libc = ctypes.CDLL(None, use_errno=True)
try:
    renameat2 = libc.renameat2
except AttributeError:
    raise SystemExit(errno.ENOSYS)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
result = renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2)
if result != 0:
    raise SystemExit(ctypes.get_errno() or 1)
for parent in {os.path.dirname(left), os.path.dirname(right)}:
    fd = os.open(parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
`;

async function exchangeDirectories(left, right) {
  await requireEntry(left, { kind: 'directory', mode: 0o700 });
  await requireEntry(right, { kind: 'directory', mode: 0o700 });
  try {
    execFileSync('/usr/bin/python3', ['-c', EXCHANGE_PY, left, right], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000 });
  } catch (error) {
    const stderr = Buffer.from(error?.stderr || '').toString('utf8');
    if ([22, 38, 95].includes(error?.status) || stderr.includes('ENOSYS')) fail('atomic_exchange_unavailable');
    if (error?.status === 20 || error?.status === 21) fail('replacement_recovery_required');
    fail('bootstrap_replacement_failed');
  }
}

async function assertMarker(directory, digest, { expectedReleaseId } = {}) {
  const marker = path.join(directory, '.sonuvi-bootstrap-kit-v2.sha256');
  await requireEntry(marker, { kind: 'file', mode: 0o600 });
  if ((await fs.readFile(marker, 'utf8')).trim() !== digest) fail('replacement_recovery_required');
  const anchors = await fs.readFile(TRUST_FILE);
  const verified = await assertRootTree(directory, digest, anchors);
  if (expectedReleaseId && verified.manifest.releaseId !== expectedReleaseId) fail('replacement_recovery_required');
  return verified;
}

async function replaceKit(request) {
  phase('replacement_root');
  await ensureReplacementRoot();
  phase('target');
  await assertServerTarget(request.targetIdentity, request.expectedServerReleaseId);
  phase('journal');
  const { operationRoot, journal: existing } = await readJournal(request.operationId);
  if (existing) {
    const sameBinding = existing.targetIdentity === request.targetIdentity
      && existing.expectedServerReleaseId === request.expectedServerReleaseId
      && existing.previousBootstrapKitSHA256 === request.previousBootstrapKitSHA256
      && existing.replacementReleaseId === request.replacementReleaseId
      && existing.replacementKitSHA256 === request.replacementKitSHA256
      && existing.replacementKitBytes === request.replacementKitBytes
      && existing.signedEnvelopeSHA256 === request.signedEnvelopeSHA256;
    if (!sameBinding) fail('replacement_operation_conflict');
    if (existing.state === 'committed') {
      const { anchorBytes } = await anchorContext();
      await assertMarker(ACTIVE, existing.replacementKitSHA256);
      await assertMarker(path.join(operationRoot, 'previous'), existing.previousBootstrapKitSHA256);
      return responseBase('already_replaced', existing);
    }
    if (existing.state === 'rolled_back') {
      await anchorContext();
      await assertMarker(ACTIVE, existing.previousBootstrapKitSHA256);
      return responseBase('already_rolled_back', existing);
    }
    if (existing.state === 'aborted_before_promotion') {
      const { anchorBytes } = await anchorContext();
      await assertMarker(ACTIVE, existing.previousBootstrapKitSHA256);
      return responseBase('aborted_before_promotion', existing);
    }
    fail('replacement_recovery_required');
  }
  phase('recovery_scan');
  await unresolvedOperations();
  phase('trust_anchor');
  const { anchorBytes, anchors } = await anchorContext();
  phase('server_recovery');
  await assertNoServerReleaseRecovery();
  // The historical fixed helpers predate this lock. Refuse a first transition
  // while any of those fixed privileged operations is still running; the
  // operator must also provide an exclusive maintenance window.
  phase('maintenance');
  await assertNoHistoricalHelpers();
  phase('staging_home');
  const user = await sourceHome();
  phase('envelope');
  const verified = verifySignedCandidate(request, anchors);
  phase('previous_kit');
  await assertCurrentKit(request.previousBootstrapKitSHA256, anchorBytes);
  phase('staged_file');
  const candidateHandle = await stagedArchiveHandle(user, request.replacementKitSHA256);
  const candidateStat = await candidateHandle.stat();
  await candidateHandle.close();
  await closeSourceHome(user);
  if (!candidateStat.isFile() || candidateStat.uid !== user.uid || candidateStat.gid !== user.gid) fail('staging_owner_invalid');
  if (modeOf(candidateStat) !== 0o600) fail('staging_mode_invalid');
  if (candidateStat.size !== request.replacementKitBytes) fail('replacement_kit_size_invalid');
  if (request.replacementKitSHA256 !== verified.metadata.bootstrap.sha256) fail('replacement_kit_digest_invalid');

  const created = new Date().toISOString();
  let journal = makeJournal(request, 'preparing', created);
  try { await writeInitialJournal(operationRoot, journal); } catch (error) {
    if (error instanceof GateError) throw error;
    fail('replacement_journal_failed');
  }
  const incoming = path.join(operationRoot, 'incoming.tar');
  const candidateRoot = path.join(operationRoot, 'candidate');
  let failureStage = 'copy';
  try {
    phase('copy');
    await copyStagedKitToTransaction(request, operationRoot, user.uid);
    phase('candidate');
    failureStage = 'candidate';
    await extractCandidate(incoming, candidateRoot);
    await fs.chown(candidateRoot, 0, 0);
    await fs.chmod(candidateRoot, 0o700);
    await writeMarker(candidateRoot, request.replacementKitSHA256);
    const candidateInfo = await assertRootTree(candidateRoot, request.replacementKitSHA256, anchorBytes);
    if (candidateInfo.manifest.releaseId !== request.replacementReleaseId
      || candidateInfo.manifest.keyId !== verified.envelope.keyId) fail('replacement_release_mismatch');
    await syncDirectory(candidateRoot);
    phase('journal');
    failureStage = 'journal';
    journal = await transition(operationRoot, journal, 'prepared');
    phase('promotion');
    failureStage = 'promotion';
    await exchangeDirectories(ACTIVE, candidateRoot);
    // After RENAME_EXCHANGE, ACTIVE is the verified candidate and candidateRoot
    // is the byte-for-byte old kit. This marker makes recovery unambiguous.
    await assertMarker(ACTIVE, request.replacementKitSHA256);
    await assertMarker(candidateRoot, request.previousBootstrapKitSHA256);
    journal = await transition(operationRoot, journal, 'promoted');
    const previousRoot = path.join(operationRoot, 'previous');
    await fs.rename(candidateRoot, previousRoot);
    await syncDirectory(operationRoot);
    await assertMarker(previousRoot, request.previousBootstrapKitSHA256);
    await assertMarker(ACTIVE, request.replacementKitSHA256);
    journal = await transition(operationRoot, journal, 'committed');
    return responseBase('replaced', journal);
  } catch (error) {
    if (error instanceof GateError) throw error;
    fail(failureStage === 'copy' ? 'replacement_copy_failed'
      : failureStage === 'promotion' ? 'replacement_promotion_failed'
        : failureStage === 'candidate' ? 'replacement_kit_inventory_invalid'
          : 'replacement_journal_failed');
  }
}

async function recoverReplacement(opId, targetIdentity) {
  phase('recovery');
  await ensureReplacementRoot();
  if (await currentTargetIdentity() !== targetIdentity) fail('replacement_target_mismatch');
  await assertNoHistoricalHelpers();
  const { operationRoot, journal: existingJournal } = await readJournal(opId);
  let journal = existingJournal;
  if (!journal) {
    const { anchorBytes } = await anchorContext();
    await assertRootTree(ACTIVE, null, anchorBytes);
    return {
      contract: CONTRACT,
      operation,
      ok: true,
      state: 'no_recovery_required',
      operationId: opId,
      targetIdentity,
    };
  }
  if (journal.targetIdentity !== targetIdentity) fail('replacement_target_mismatch');
  const { anchorBytes } = await anchorContext();
  const candidate = path.join(operationRoot, 'candidate');
  const previous = path.join(operationRoot, 'previous');
  const activeMarker = await fs.readFile(path.join(ACTIVE, '.sonuvi-bootstrap-kit-v2.sha256'), 'utf8').then((value) => value.trim()).catch(() => '');
  const candidateMarker = await fs.readFile(path.join(candidate, '.sonuvi-bootstrap-kit-v2.sha256'), 'utf8').then((value) => value.trim()).catch(() => '');
  const previousMarker = await fs.readFile(path.join(previous, '.sonuvi-bootstrap-kit-v2.sha256'), 'utf8').then((value) => value.trim()).catch(() => '');

  if (journal.state === 'committed') {
    await assertMarker(ACTIVE, journal.replacementKitSHA256);
    await assertMarker(previous, journal.previousBootstrapKitSHA256);
    return responseBase('already_replaced', journal);
  }
  if (journal.state === 'rolled_back') {
    await assertMarker(ACTIVE, journal.previousBootstrapKitSHA256);
    await assertMarker(previous, journal.replacementKitSHA256);
    return responseBase('already_rolled_back', journal);
  }
  if (journal.state === 'aborted_before_promotion') {
    await assertMarker(ACTIVE, journal.previousBootstrapKitSHA256);
    return responseBase('aborted_before_promotion', journal);
  }
  if (journal.state === 'rollback_prepared') {
    if (activeMarker === journal.replacementKitSHA256 && previousMarker === journal.previousBootstrapKitSHA256) {
      await assertMarker(ACTIVE, journal.replacementKitSHA256, { expectedReleaseId: journal.replacementReleaseId });
      await assertMarker(previous, journal.previousBootstrapKitSHA256);
      journal = await transition(operationRoot, journal, 'committed');
      return responseBase('already_replaced', journal);
    }
    if (activeMarker === journal.previousBootstrapKitSHA256 && previousMarker === journal.replacementKitSHA256) {
      await assertMarker(ACTIVE, journal.previousBootstrapKitSHA256);
      await assertMarker(previous, journal.replacementKitSHA256);
      if (await serverReleaseRecoveryPending() || await serverReleaseDoesNotMatch(journal.expectedServerReleaseId)) {
        await exchangeDirectories(ACTIVE, previous);
        await assertMarker(ACTIVE, journal.replacementKitSHA256);
        await assertMarker(previous, journal.previousBootstrapKitSHA256);
        journal = await transition(operationRoot, journal, 'committed');
        return responseBase('committed_after_interruption', journal);
      }
      journal = await transition(operationRoot, journal, 'rolled_back');
      return responseBase('rolled_back', journal);
    }
    fail('replacement_recovery_required');
  }
  if (activeMarker === journal.previousBootstrapKitSHA256) {
    // The exchange did not occur. Keep the old active kit and preserve all
    // candidate/incoming evidence under this operation's root-owned directory.
    await assertMarker(ACTIVE, journal.previousBootstrapKitSHA256);
    journal = await transition(operationRoot, journal, 'aborted_before_promotion');
    return responseBase('aborted_before_promotion', journal);
  }
  if (activeMarker === journal.replacementKitSHA256) {
    if (candidateMarker === journal.previousBootstrapKitSHA256 && !previousMarker) {
      await assertMarker(candidate, journal.previousBootstrapKitSHA256);
      await fs.rename(candidate, previous);
      await syncDirectory(operationRoot);
    }
    await assertMarker(ACTIVE, journal.replacementKitSHA256);
    await assertMarker(previous, journal.previousBootstrapKitSHA256);
    journal = await transition(operationRoot, journal, 'committed');
    return responseBase('committed_after_interruption', journal);
  }
  fail('replacement_recovery_required');
}

async function serverReleaseRecoveryPending() {
  const lockPath = '/var/lib/sonuvi/checkpoints/release-activation.lock';
  if (await fs.lstat(lockPath).then(() => true).catch((error) => error?.code === 'ENOENT' ? false : true)) return true;
  const statePath = '/var/lib/sonuvi/checkpoints/release-upgrade-state.json';
  const stat = await fs.lstat(statePath).catch((error) => error?.code === 'ENOENT' ? null : true);
  if (stat === true) return true;
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0) return true;
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return state?.contract !== 'sonuvi.release-activation.v1' || !['committed', 'rolled-back', 'recovered'].includes(state.phase);
  } catch { return true; }
}

async function rollbackReplacement(opId, targetIdentity, expectedReplacement, expectedPrevious) {
  phase('rollback');
  await ensureReplacementRoot();
  if (await currentTargetIdentity() !== targetIdentity) fail('replacement_target_mismatch');
  await assertNoServerReleaseRecovery();
  await assertNoHistoricalHelpers();
  const { operationRoot, journal: existingJournal } = await readJournal(opId);
  let journal = existingJournal;
  if (!journal || journal.targetIdentity !== targetIdentity) fail('replacement_recovery_required');
  if (journal.replacementKitSHA256 !== expectedReplacement || journal.previousBootstrapKitSHA256 !== expectedPrevious) {
    fail('replacement_operation_conflict');
  }
  const { anchorBytes } = await anchorContext();
  const previous = path.join(operationRoot, 'previous');
  if (journal.state === 'rolled_back') {
    await assertMarker(ACTIVE, expectedPrevious);
    await assertMarker(previous, expectedReplacement);
    return responseBase('already_rolled_back', journal);
  }
  if (journal.state !== 'committed') fail('replacement_recovery_required');
  await assertServerTarget(targetIdentity, journal.expectedServerReleaseId);
  await assertMarker(ACTIVE, expectedReplacement);
  await assertMarker(previous, expectedPrevious);
  journal.state = 'rollback_prepared';
  journal.updatedAt = new Date().toISOString();
  await writeJournal(operationRoot, journal);
  await exchangeDirectories(ACTIVE, previous);
  await assertMarker(ACTIVE, expectedPrevious);
  await assertMarker(previous, expectedReplacement);
  journal = await transition(operationRoot, journal, 'rolled_back');
  return responseBase('rolled_back', journal);
}

async function main() {
  phase('request');
  if (process.getuid?.() !== 0) fail('root_authorization_required');
  if (!OPERATIONS.has(operation)) fail('invalid_arguments');
  const target = argv[2];
  phase('target');
  if (!validTarget(target) || await currentTargetIdentity() !== target) fail('replacement_target_mismatch');
  phase('root');
  await requireEntry(ROOT, { kind: 'directory', mode: 0o700 });
  phase('replacement_root');
  await ensureReplacementRoot();
  if (operation === 'replace_bootstrap_kit') {
    const request = parseReplacementArgs();
    const { journal } = await readJournal(request.operationId);
    if (journal?.state === 'committed'
      && journal.targetIdentity === request.targetIdentity
      && journal.expectedServerReleaseId === request.expectedServerReleaseId
      && journal.previousBootstrapKitSHA256 === request.previousBootstrapKitSHA256
      && journal.replacementReleaseId === request.replacementReleaseId
      && journal.replacementKitSHA256 === request.replacementKitSHA256
      && journal.replacementKitBytes === request.replacementKitBytes
      && journal.signedEnvelopeSHA256 === request.signedEnvelopeSHA256) {
      const { anchorBytes } = await anchorContext();
      await assertMarker(ACTIVE, request.replacementKitSHA256);
      await assertMarker(path.join(REPLACEMENTS, request.operationId, 'previous'), request.previousBootstrapKitSHA256);
      return responseBase('already_replaced', journal);
    }
    return replaceKit(request);
  }
  if (operation === 'recover_bootstrap_kit_replacement') {
    if (argv.length !== 3 || !validId(argv[1])) fail('invalid_arguments');
    return recoverReplacement(argv[1], target);
  }
  if (operation === 'rollback_bootstrap_kit') {
    if (argv.length !== 5 || !validId(argv[1]) || !validDigest(argv[3]) || !validDigest(argv[4])) fail('invalid_arguments');
    return rollbackReplacement(argv[1], target, argv[3], argv[4]);
  }
  fail('invalid_arguments');
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = FAILURE_CODES.has(error?.code) ? error.code : (PHASE_FAILURE_CODES[operationPhase] || 'bootstrap_replacement_failed');
  process.stderr.write(`sonuvi_bootstrap_kit_replacement_v1:${code}:${operationPhase}\n`);
  process.stdout.write(`${JSON.stringify(failureResponse(code))}\n`);
  process.exitCode = 1;
}
NODE
