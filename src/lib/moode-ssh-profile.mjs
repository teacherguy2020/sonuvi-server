import path from 'node:path';

import { runtimeCapabilities } from './runtime-capabilities.mjs';
import { runtimeStatePaths } from './runtime-state-paths.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function absolutePath(value, label) {
  const candidate = text(value);
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(candidate);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export const MOODE_REMOTE_COMMANDS = Object.freeze({
  'audio-info-snapshot-read': { access: 'read', capability: 'ssh.read-diagnostics' },
  'audio-status': { access: 'read', capability: 'ssh.read-status' },
  'browse-index': { access: 'read', capability: 'ssh.read-browse' },
  'library-health-read': { access: 'read', capability: 'ssh.read-library' },
  diagnostics: { access: 'read', capability: 'ssh.read-diagnostics' },
  'queue-wizard-apply': { access: 'write', capability: 'ssh.queue-write' },
  'playlist-cover-push': { access: 'write', capability: 'ssh.file-transfer' },
  'podcast-library-write': { access: 'write', capability: 'ssh.podcast-write' },
  'sticker-backup': { access: 'write', capability: 'ssh.sticker-write' },
  'sticker-restore': { access: 'write', capability: 'ssh.sticker-write' },
  'peppy-display-config': { access: 'write', capability: 'ssh.display-write' },
  'qobuz-renderer-release': { access: 'write', capability: 'ssh.qobuz-lifecycle' },
});

export function resolveMoodeSshProfile({
  env = process.env,
  statePaths = runtimeStatePaths({ env }),
  profileDefaults = {},
} = {}) {
  const immutable = Boolean(statePaths.sharedStateEnabled);
  const user = text(env.MOODE_SSH_USER) || text(profileDefaults?.user) || 'moode';
  const host = text(env.MOODE_SSH_HOST) || text(profileDefaults?.host);

  if (!immutable) {
    return Object.freeze({
      immutable: false,
      user,
      host,
      argsFor(targetHost = host) {
        const target = text(targetHost);
        if (!target) throw new Error('moOde SSH host is required');
        return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${user}@${target}`];
      },
    });
  }

  const secretsRoot = absolutePath(statePaths.secretsRoot, 'SONUVI_SECRETS_ROOT');
  const sshRoot = absolutePath(env.SONUVI_MOODE_SSH_ROOT || path.join(secretsRoot, 'ssh'), 'SONUVI_MOODE_SSH_ROOT');
  if (!contained(secretsRoot, sshRoot)) {
    throw new Error('SONUVI_MOODE_SSH_ROOT must remain beneath SONUVI_SECRETS_ROOT');
  }
  const identityPath = absolutePath(
    env.SONUVI_MOODE_SSH_IDENTITY || path.join(sshRoot, 'moode_ed25519'),
    'SONUVI_MOODE_SSH_IDENTITY',
  );
  const knownHostsPath = absolutePath(
    env.SONUVI_MOODE_SSH_KNOWN_HOSTS || path.join(sshRoot, 'known_hosts'),
    'SONUVI_MOODE_SSH_KNOWN_HOSTS',
  );
  if (!contained(sshRoot, identityPath) || !contained(sshRoot, knownHostsPath)) {
    throw new Error('moOde SSH identity and known-hosts paths must remain beneath SONUVI_MOODE_SSH_ROOT');
  }

  const argsFor = (targetHost = host) => {
    const target = text(targetHost);
    if (!target) throw new Error('moOde SSH host is required');
    return [
      '-F', '/dev/null',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=6',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none',
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHostsPath}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-i', identityPath,
      `${user}@${target}`,
    ];
  };

  return Object.freeze({
    immutable: true,
    user,
    host,
    readOnlyProtocol: text(env.SONUVI_MOODE_READONLY_PROTOCOL),
    sshRoot,
    identityPath,
    knownHostsPath,
    argsFor,
  });
}

export function assertMoodeRemoteCommand(commandId, {
  capabilities = runtimeCapabilities(),
} = {}) {
  const command = MOODE_REMOTE_COMMANDS[String(commandId || '').trim()];
  if (!command) throw new Error('The requested moOde SSH command is not approved');
  if (command.access === 'write') capabilities.assertExternalMutation(command.capability);
  else capabilities.assertExternalRead(command.capability);
  return command;
}

/**
 * The root-managed identity profile is deliberately preparatory only. Until a
 * separately approved forced-command/dispatcher protocol exists on moOde,
 * immutable releases must not turn a local command ID into an unrestricted
 * remote shell invocation.
 */
export function assertMoodeRemoteTransport(commandId, {
  capabilities = runtimeCapabilities(),
  profile,
} = {}) {
  const command = assertMoodeRemoteCommand(commandId, { capabilities });
  if (profile?.immutable) {
    const error = new Error('Immutable Sonuvi SSH transport requires separately approved restricted remote authorization');
    error.name = 'MoodeSshTransportAuthorizationError';
    error.code = 'SONUVI_SSH_TRANSPORT_UNAUTHORIZED';
    throw error;
  }
  return command;
}

// This is intentionally separate from assertMoodeRemoteTransport. Existing
// shell-based callers remain denied in immutable releases even when a fixed
// read-only operation is enabled by an installed forced-command dispatcher.
export const MOODE_READONLY_OPERATIONS = Object.freeze({
  'audio-info-snapshot': 'audio-info-snapshot-read',
});

function deniedManagedTransport() {
  const error = new Error('Managed read-only moOde authorization is not configured');
  error.code = 'SONUVI_SSH_TRANSPORT_UNAUTHORIZED';
  return error;
}

export function moodeReadOnlyArgs(operation, {
  profile = resolveMoodeSshProfile(),
  capabilities = runtimeCapabilities(),
} = {}) {
  const commandId = Object.hasOwn(MOODE_READONLY_OPERATIONS, operation)
    ? MOODE_READONLY_OPERATIONS[operation]
    : null;
  if (!commandId) throw new Error('The requested moOde read-only operation is not approved');
  assertMoodeRemoteCommand(commandId, { capabilities });

  const host = text(profile?.host);
  const user = text(profile?.user);
  if (!profile?.immutable
    || profile.readOnlyProtocol !== 'v1'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(host)
    || !/^[a-z_][a-z0-9_-]*$/i.test(user)) {
    throw deniedManagedTransport();
  }

  return [
    '-n',
    '-T',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    ...profile.argsFor(),
    `sonuvi-readonly-v1 ${operation}`,
  ];
}

export function isManagedReadOnlyInvocation(command, args, options, {
  env = process.env,
  statePaths = runtimeStatePaths({ env }),
  profileDefaults = {},
} = {}) {
  if (command !== '/usr/bin/ssh' || !Array.isArray(args)) return false;
  if (options && typeof options === 'object'
    && (options.shell || options.env || options.uid != null || options.gid != null)) return false;

  try {
    const profile = resolveMoodeSshProfile({ env, statePaths, profileDefaults });
    return Object.keys(MOODE_READONLY_OPERATIONS).some((operation) => {
      const expected = moodeReadOnlyArgs(operation, { profile });
      return args.length === expected.length && args.every((value, index) => value === expected[index]);
    });
  } catch {
    return false;
  }
}
