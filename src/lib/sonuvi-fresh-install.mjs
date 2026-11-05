import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomically } from './atomic-file.mjs';
import { assertImmutableRuntimeConfig } from './runtime-config-security.mjs';
import { bootstrapEvent } from './sonuvi-bootstrap-contract.mjs';

export const FRESH_INSTALL_STATE_CONTRACT = 'sonuvi.fresh-install-state.v1';
export const FRESH_INSTALL_JOURNAL_CONTRACT = 'sonuvi.fresh-install-journal.v1';
export const FreshInstallClassification = Object.freeze({ FRESH_ELIGIBLE: 'fresh_eligible', ALREADY_INSTALLED: 'already_installed', INCOMPLETE_INSTALLATION: 'incomplete_installation', UNSUPPORTED_HOST: 'unsupported_host', CONFLICTING_INSTALLATION: 'conflicting_installation', REQUIRES_RECOVERY: 'requires_recovery' });
const REQUIRED_SHARED_DIRECTORIES = Object.freeze(['config', 'data', 'cache', 'protected', 'logs', 'checkpoints', 'install']);
const SENSITIVE_FIELD = /(?:password|secret|token|private.?key|credential|authorization)/i;
function absolute(value, label) { const raw = String(value || '').trim(); if (!raw || !path.isAbsolute(raw)) throw new Error(`${label} must be an absolute path`); return path.resolve(raw); }
function safeIdentity(value) { const identity = String(value || '').trim(); if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(identity)) throw new Error('server identity is invalid'); return identity; }
async function statOrNull(filePath) { try { return await fs.lstat(filePath); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } }
async function existingState(layoutRoot, stateRoot) {
  try { const [layout, state] = await Promise.all([statOrNull(layoutRoot), statOrNull(stateRoot)]); if (!layout && !state) return { kind: 'absent' }; if ((layout && !layout.isDirectory()) || (state && !state.isDirectory())) return { kind: 'inaccessible' }; const current = layout && await statOrNull(path.join(layoutRoot, 'current')); const config = state && await statOrNull(path.join(stateRoot, 'config', 'now-playing.config.json')); if (current?.isSymbolicLink() && config?.isFile()) return { kind: 'installed' }; return { kind: 'partial' }; } catch (error) { return { kind: 'inaccessible', error: error?.code || 'inspection_failed' }; }
}
/** Conservative preflight: an unreadable location is never interpreted as empty. */
export async function classifyFreshInstallHost({ layoutRoot, stateRoot, platform = process.platform, architecture = process.arch, hasSystemd = false, uid = typeof process.getuid === 'function' ? process.getuid() : null, availableBytes = 0, minimumBytes = 2 * 1024 * 1024 * 1024, conflictingServices = [], conflictingPorts = [] } = {}) {
  const layout = absolute(layoutRoot, 'release layout root'); const state = absolute(stateRoot, 'state root'); const facts = { platform, architecture, hasSystemd: Boolean(hasSystemd), uid, availableBytes, minimumBytes };
  if (platform !== 'linux' || architecture !== 'arm64' || !hasSystemd) return Object.freeze({ classification: FreshInstallClassification.UNSUPPORTED_HOST, facts });
  if (uid !== 0) return Object.freeze({ classification: FreshInstallClassification.REQUIRES_RECOVERY, facts, reason: 'privileged installer adapter required' });
  if (!Number.isFinite(availableBytes) || availableBytes < minimumBytes) return Object.freeze({ classification: FreshInstallClassification.REQUIRES_RECOVERY, facts, reason: 'insufficient disk capacity' });
  if (conflictingServices.length || conflictingPorts.length) return Object.freeze({ classification: FreshInstallClassification.CONFLICTING_INSTALLATION, facts, conflictingServices: [...conflictingServices], conflictingPorts: [...conflictingPorts] });
  const existing = await existingState(layout, state); const classification = existing.kind === 'absent' ? FreshInstallClassification.FRESH_ELIGIBLE : existing.kind === 'installed' ? FreshInstallClassification.ALREADY_INSTALLED : existing.kind === 'partial' ? FreshInstallClassification.INCOMPLETE_INSTALLATION : FreshInstallClassification.REQUIRES_RECOVERY;
  return Object.freeze({ classification, facts, existing });
}
export function freshRuntimeConfig({ serverIdentity, timezone = 'UTC', apiPort = 3101, webPort = 8101 } = {}) {
  const identity = safeIdentity(serverIdentity); const config = { projectName: 'sonuvi', environment: 'fresh-install', timezone, apiHost: '127.0.0.1', apiNodeIp: '127.0.0.1', nodes: [{ name: identity, ip: '127.0.0.1', role: 'both', sshUser: 'sonuvi' }], ports: { api: apiPort, ui: webPort }, deployment: { sourceOfTruthNode: identity, syncMethod: 'local' }, mpd: { host: '127.0.0.1', port: 6600 }, alexa: { enabled: false, publicDomain: '', webhookPath: '/alexa' }, paths: { musicLibraryRoot: '/var/lib/sonuvi/empty-library', podcastRoot: '/var/lib/sonuvi/empty-library/podcasts', subscriptionsJson: './subscriptions.json' }, features: { podcasts: false, ratings: false, radio: true }, notifications: { trackNotify: { enabled: false, pollMs: 3000, dedupeMs: 15000, alexaMaxAgeMs: 21600000 }, pushover: {}, apns: { topic: '', environment: 'auto', tokensPath: 'var/mobile-push-tokens.json' } } };
  assertImmutableRuntimeConfig(config, { context: 'fresh installation configuration' }); return Object.freeze(config);
}

/**
 * A newly installed Server needs its own mobile-token signing secrets, not a
 * copied Track Key or production configuration. This file is root-only; the
 * service receives its values through systemd's existing EnvironmentFile.
 */
export async function initializeFreshMobileEnvironment({ stateRoot } = {}) {
  const root = absolute(stateRoot, 'state root');
  const protectedRoot = path.join(root, 'protected');
  const stat = await fs.lstat(protectedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('protected environment path is invalid');
  const file = path.join(protectedRoot, 'now-playing.env');
  try { await fs.lstat(file); throw new Error('fresh mobile environment already exists'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const lines = [
    'MOBILE_API_ENABLED=1',
    `MOBILE_API_SECRET=${crypto.randomBytes(32).toString('base64url')}`,
    `MOBILE_TRACK_ID_SECRET=${crypto.randomBytes(32).toString('base64url')}`,
  ];
  await fs.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  return Object.freeze({ environmentPath: file });
}
/** Create only Sonuvi-owned directories. Existing partial state is rejected. */
export async function initializeFreshHostLayout({ layoutRoot, stateRoot, serverIdentity, config = null } = {}) {
  const layout = absolute(layoutRoot, 'release layout root'); const state = absolute(stateRoot, 'state root'); const inspection = await classifyFreshInstallHost({ layoutRoot: layout, stateRoot: state, platform: 'linux', architecture: 'arm64', hasSystemd: true, uid: 0, availableBytes: Number.MAX_SAFE_INTEGER }); if (inspection.classification !== FreshInstallClassification.FRESH_ELIGIBLE) throw new Error(`fresh layout initialization refused: ${inspection.classification}`);
  await fs.mkdir(path.join(layout, 'releases'), { recursive: true, mode: 0o755 }); for (const directory of REQUIRED_SHARED_DIRECTORIES) await fs.mkdir(path.join(state, directory), { recursive: true, mode: 0o700 }); const resolvedConfig = config || freshRuntimeConfig({ serverIdentity }); assertImmutableRuntimeConfig(resolvedConfig, { context: 'fresh installation configuration' }); const configPath = path.join(state, 'config', 'now-playing.config.json'); await writeJsonAtomically(configPath, resolvedConfig, { mode: 0o600 }); await fs.mkdir(path.join(state, 'empty-library', 'podcasts'), { recursive: true, mode: 0o700 }); return Object.freeze({ layoutRoot: layout, stateRoot: state, configPath, journalPath: path.join(state, 'install', 'journal.jsonl'), statePath: path.join(state, 'install', 'state.json') });
}
function redacted(value) { if (!value || typeof value !== 'object') return value; if (Array.isArray(value)) return value.map(redacted); return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_FIELD.test(key) ? '[redacted]' : redacted(item)])); }
export async function appendFreshInstallJournal({ journalPath, attemptId, targetIdentity, event } = {}) { const target = absolute(journalPath, 'journal path'); if (!String(attemptId || '').trim() || !String(targetIdentity || '').trim()) throw new Error('attempt ID and target identity are required'); const normalized = bootstrapEvent(event); const record = Object.freeze({ contract: FRESH_INSTALL_JOURNAL_CONTRACT, eventId: crypto.randomUUID(), attemptId: String(attemptId), targetIdentity: String(targetIdentity), ...redacted(normalized) }); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); const handle = await fs.open(target, 'a', 0o600); try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); } return record; }
export async function writeFreshInstallState({ statePath, state } = {}) { const target = absolute(statePath, 'installation state path'); if (state?.contract !== FRESH_INSTALL_STATE_CONTRACT) throw new Error('installation state contract is invalid'); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeJsonAtomically(target, redacted(state), { mode: 0o600 }); }
export async function readFreshInstallJournal({ journalPath } = {}) { const target = absolute(journalPath, 'journal path'); try { return Object.freeze((await fs.readFile(target, 'utf8')).split('\n').filter(Boolean).map((line) => Object.freeze(JSON.parse(line)))); } catch (error) { if (error?.code === 'ENOENT') return Object.freeze([]); throw error; } }
export function renderFreshSystemdUnits({ apiTemplate, webTemplate, releaseId, serviceAccount = 'sonuvi', musicLibraryRoot = '/var/lib/sonuvi/empty-library' } = {}) { if (!/^sonuvi-[a-f0-9]{64}$/.test(String(releaseId || ''))) throw new Error('release ID is invalid'); for (const [label, value] of Object.entries({ serviceAccount, musicLibraryRoot })) if (!String(value).trim() || /[\r\n@]/.test(String(value))) throw new Error(`${label} is unsafe for a systemd template`); const replace = (template) => String(template).replaceAll('@SERVICE_ACCOUNT@', serviceAccount).replaceAll('@RELEASE_ID@', releaseId).replaceAll('@MUSIC_LIBRARY_ROOT@', musicLibraryRoot); return Object.freeze({ 'sonuvi-api.service': replace(apiTemplate), 'sonuvi-web.service': replace(webTemplate) }); }

/**
 * Idempotently materialize only the two reviewed unit files. The privileged
 * transport owns daemon-reload/enable/start; this function deliberately has
 * no shell or systemctl capability.
 */
export async function provisionFreshSystemdUnits({ unitRoot, units } = {}) {
  const root = absolute(unitRoot, 'systemd unit root');
  if (!units || typeof units !== 'object') throw new Error('rendered units are required');
  const expected = ['sonuvi-api.service', 'sonuvi-web.service'];
  if (Object.keys(units).sort().join(',') !== expected.join(',')) throw new Error('only approved Sonuvi units may be provisioned');
  await fs.mkdir(root, { recursive: true, mode: 0o755 });
  const results = [];
  for (const name of expected) {
    const target = path.join(root, name);
    const content = String(units[name] || '');
    const existing = await fs.readFile(target, 'utf8').catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing !== null && existing !== content) throw new Error(`refusing to overwrite a different systemd unit: ${name}`);
    if (existing === null) await fs.writeFile(target, content, { mode: 0o644 });
    results.push(Object.freeze({ name, changed: existing === null }));
  }
  return Object.freeze(results);
}
