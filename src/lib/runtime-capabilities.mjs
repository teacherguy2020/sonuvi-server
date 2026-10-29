import fs from 'node:fs';
import path from 'node:path';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXECUTION_MODE_NAMES = ['SONUVI_EXECUTION_MODE', 'NOW_PLAYING_EXECUTION_MODE'];

function text(value) {
  return String(value ?? '').trim();
}

function configured(env, names) {
  for (const name of names) {
    const value = text(env?.[name]);
    if (value) return value;
  }
  return '';
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function normalizedCapability(value) {
  const capability = text(value).replace(/[^a-z0-9._-]/gi, '');
  return capability || 'unclassified';
}

export class CapabilityDeniedError extends Error {
  constructor(capability) {
    super('This operation is disabled in Sonuvi rehearsal mode');
    this.name = 'CapabilityDeniedError';
    this.code = 'SONUVI_REHEARSAL_DENIED';
    this.capability = normalizedCapability(capability);
  }
}

/**
 * Rehearsal is an explicit, fail-closed execution mode for disposable
 * candidate runs. Production remains the default for backwards compatibility,
 * but an unrecognized explicit mode aborts rather than silently allowing live
 * integrations.
 */
export function resolveExecutionMode({ env = process.env } = {}) {
  const requested = configured(env, EXECUTION_MODE_NAMES).toLowerCase();
  if (!requested || requested === 'production') return 'production';
  if (requested === 'rehearsal' || requested === 'read-only') return 'rehearsal';
  throw new Error('SONUVI_EXECUTION_MODE must be production or rehearsal');
}

export function createRuntimeCapabilities({ env = process.env } = {}) {
  const mode = resolveExecutionMode({ env });
  const rehearsal = mode === 'rehearsal';
  const rehearsalStateRoot = text(env?.SONUVI_REHEARSAL_STATE_ROOT);

  const deny = (capability) => {
    throw new CapabilityDeniedError(capability);
  };

  return Object.freeze({
    mode,
    rehearsal,

    assertExternalMutation(capability) {
      if (rehearsal) deny(capability);
      return true;
    },

    assertExternalRead(capability) {
      if (rehearsal && text(env?.SONUVI_REHEARSAL_ALLOW_EXTERNAL_READ) !== '1') {
        deny(capability);
      }
      return true;
    },

    assertBackgroundMutation(capability) {
      if (rehearsal) deny(`background.${normalizedCapability(capability)}`);
      return true;
    },

    assertStateWrite(targetPath) {
      if (!rehearsal) return true;
      if (!rehearsalStateRoot || !path.isAbsolute(rehearsalStateRoot)) {
        deny('filesystem.state-write');
      }
      const root = path.resolve(rehearsalStateRoot);
      const requested = text(targetPath);
      if (!requested) deny('filesystem.state-write');
      const target = path.resolve(requested);
      if (!target || !contained(root, target)) deny('filesystem.state-write');

      // A lexical prefix alone is insufficient: an existing symlink below a
      // rehearsal root could redirect a write to host state. The rehearsal
      // root is intentionally pre-created by the transient-unit harness, so
      // fail closed if it is absent, not a real directory, or contains a
      // symlink on the requested path.
      try {
        const rootStat = fs.lstatSync(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) deny('filesystem.state-write');
        const realpath = fs.realpathSync.native || fs.realpathSync;
        if (realpath(root) !== root) deny('filesystem.state-write');

        let current = root;
        for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
          current = path.join(current, segment);
          try {
            if (fs.lstatSync(current).isSymbolicLink()) deny('filesystem.state-write');
          } catch (error) {
            if (error?.code === 'ENOENT') break;
            deny('filesystem.state-write');
          }
        }
      } catch (error) {
        if (error instanceof CapabilityDeniedError) throw error;
        deny('filesystem.state-write');
      }
      return true;
    },
  });
}

export function runtimeCapabilities(options = {}) {
  return createRuntimeCapabilities(options);
}

/**
 * This is a deliberately broad HTTP backstop for a rehearsal candidate. It
 * is not the primary protection: adapters also assert capabilities immediately
 * before their external write boundary.
 */
export function rehearsalReadOnlyMiddleware({ capabilities = runtimeCapabilities() } = {}) {
  return (req, res, next) => {
    if (!capabilities.rehearsal || SAFE_METHODS.has(String(req?.method || 'GET').toUpperCase())) {
      return next();
    }
    return res.status(503).json({
      ok: false,
      error: 'Candidate rehearsal accepts read-only requests only',
      code: 'SONUVI_REHEARSAL_READ_ONLY',
    });
  };
}
