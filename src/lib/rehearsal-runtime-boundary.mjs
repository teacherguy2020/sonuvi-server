import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

import { MOODE_SSH_HOST, MOODE_SSH_USER } from '../config.mjs';
import { isManagedReadOnlyInvocation } from './moode-ssh-profile.mjs';
import { runtimeCapabilities } from './runtime-capabilities.mjs';
import { runtimeStatePaths } from './runtime-state-paths.mjs';

const INSTALL_KEY = Symbol.for('sonuvi.rehearsal-runtime-boundary.v1');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RAW_IMMUTABLE_SSH_COMMANDS = new Set(['ssh', 'scp', 'sftp']);
const CONFIGURED_MOODE_SSH_PROFILE = Object.freeze({
  host: MOODE_SSH_HOST,
  user: MOODE_SSH_USER,
});

function commandName(value) {
  return path.basename(String(value || 'external-command')).trim() || 'external-command';
}

function targetPath(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString();
  return '';
}

function writesByOpenFlag(flag) {
  if (typeof flag === 'number') {
    const writeMask = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC;
    return Boolean(flag & writeMask);
  }
  return /[wa+]/.test(String(flag || 'r'));
}

function guardPaths(capabilities, values) {
  for (const value of values) capabilities.assertStateWrite(targetPath(value));
}

function replace(container, name, replacement) {
  if (typeof container?.[name] !== 'function') return;
  container[name] = replacement;
}

function wrapPathMethod(container, name, capabilities, indices, { openFlagIndex = null } = {}) {
  const original = container?.[name];
  if (typeof original !== 'function') return;
  replace(container, name, function guardedRuntimeWrite(...args) {
    if (openFlagIndex !== null && !writesByOpenFlag(args[openFlagIndex])) {
      return original.apply(this, args);
    }
    guardPaths(capabilities, indices.map((index) => args[index]));
    return original.apply(this, args);
  });
}

function installStateWriteBoundary({ capabilities, fsModule }) {
  for (const name of [
    'appendFile', 'appendFileSync', 'writeFile', 'writeFileSync',
    'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
    'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'truncate', 'truncateSync',
    'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync',
    'lchmod', 'lchmodSync', 'lchown', 'lchownSync', 'lutimes', 'lutimesSync',
    'createWriteStream',
  ]) wrapPathMethod(fsModule, name, capabilities, [0]);

  for (const name of ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync']) {
    wrapPathMethod(fsModule, name, capabilities, [0, 1]);
  }
  for (const name of ['open', 'openSync']) wrapPathMethod(fsModule, name, capabilities, [0], { openFlagIndex: 1 });

  for (const name of ['symlink', 'symlinkSync']) {
    const original = fsModule?.[name];
    if (typeof original !== 'function') continue;
    replace(fsModule, name, function deniedRehearsalSymlink() {
      capabilities.assertStateWrite('');
      return original.apply(this, arguments);
    });
  }

  const promises = fsModule?.promises;
  if (!promises) return;
  for (const name of [
    'appendFile', 'writeFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'mkdtemp',
    'truncate', 'chmod', 'chown', 'utimes', 'lchmod', 'lchown', 'lutimes',
  ]) wrapPathMethod(promises, name, capabilities, [0]);
  for (const name of ['rename', 'copyFile', 'cp', 'link']) wrapPathMethod(promises, name, capabilities, [0, 1]);
  wrapPathMethod(promises, 'open', capabilities, [0], { openFlagIndex: 1 });
  if (typeof promises.symlink === 'function') {
    replace(promises, 'symlink', function deniedRehearsalSymlink() {
      capabilities.assertStateWrite('');
      return promises.symlink.apply(this, arguments);
    });
  }
}

function installProcessBoundary({ capabilities, statePaths, childProcessModule, profileDefaults, environment }) {
  function assertProcessAllowed(command, method, args) {
    const executable = commandName(command);
    if (capabilities.rehearsal) capabilities.assertExternalMutation(`process.${executable}`);
    if (statePaths.sharedStateEnabled && RAW_IMMUTABLE_SSH_COMMANDS.has(executable)) {
      if (method === 'execFile' && isManagedReadOnlyInvocation(command, args[0], args[1], {
        env: environment,
        statePaths,
        profileDefaults,
      })) return;
      throw new Error('Raw SSH/SCP transport is disabled; only configured fixed read-only moOde operations are authorized');
    }
  }

  for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync', 'fork']) {
    const original = childProcessModule?.[name];
    if (typeof original !== 'function') continue;
    const guarded = function guardedRuntimeProcess(command, ...args) {
      assertProcessAllowed(command, name, args);
      return original.call(this, command, ...args);
    };
    const customPromisify = original[promisify.custom];
    if (typeof customPromisify === 'function') {
      // Node's exec/execFile promise contract includes { stdout, stderr },
      // rejection output and .child. Keep it, but never expose an unguarded
      // custom function that could bypass rehearsal or immutable SSH checks.
      Object.defineProperty(guarded, promisify.custom, {
        configurable: true,
        value: function guardedRuntimePromise(command, ...args) {
          assertProcessAllowed(command, name, args);
          return customPromisify.call(this, command, ...args);
        },
      });
    }
    replace(childProcessModule, name, guarded);
  }
}

function installFetchBoundary({ capabilities, globalObject }) {
  const originalFetch = globalObject?.fetch;
  if (typeof originalFetch !== 'function') return;
  globalObject.fetch = function guardedRuntimeFetch(input, init = {}) {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) capabilities.assertExternalRead('network.fetch');
    else capabilities.assertExternalMutation('network.fetch');
    return originalFetch.call(this, input, init);
  };
}

/**
 * Installs a rehearsal-only process boundary before legacy modules capture
 * Node built-ins. Immutable production profiles additionally reject raw SSH
 * and SCP until a restricted remote-command protocol is separately approved.
 */
export function installRehearsalRuntimeBoundary({
  environment = process.env,
  capabilities = runtimeCapabilities({ env: environment }),
  statePaths = runtimeStatePaths({ env: environment }),
  childProcessModule = childProcess,
  fsModule = fs,
  globalObject = globalThis,
  moodeProfileDefaults = CONFIGURED_MOODE_SSH_PROFILE,
} = {}) {
  if (globalObject[INSTALL_KEY]) return globalObject[INSTALL_KEY];
  const requiresProcessBoundary = capabilities.rehearsal || statePaths.sharedStateEnabled;
  if (requiresProcessBoundary) {
    installProcessBoundary({
      capabilities,
      statePaths,
      childProcessModule,
      profileDefaults: moodeProfileDefaults,
      environment,
    });
  }
  if (capabilities.rehearsal) {
    installStateWriteBoundary({ capabilities, fsModule });
    installFetchBoundary({ capabilities, globalObject });
  }
  if (requiresProcessBoundary || capabilities.rehearsal) syncBuiltinESMExports();
  const result = Object.freeze({
    installed: requiresProcessBoundary || capabilities.rehearsal,
    rehearsal: capabilities.rehearsal,
    immutable: statePaths.sharedStateEnabled,
  });
  Object.defineProperty(globalObject, INSTALL_KEY, { value: result, configurable: false, enumerable: false });
  return result;
}

installRehearsalRuntimeBoundary();
