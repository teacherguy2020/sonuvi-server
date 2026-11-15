import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runtimeStatePaths } from './runtime-state-paths.mjs';
import { writeJsonAtomically } from './atomic-file.mjs';
import { exportPortableConfiguration, validatePortableConfiguration } from './native-configuration-workspace.mjs';
import { mergeRuntimeConfig, validateRuntimeConfigShape } from './runtime-config-projection.mjs';
import { assertImmutableRuntimeConfig } from './runtime-config-security.mjs';
import { MASTER_FORMAT, validateMasterConfiguration, MasterConfigurationError } from './master-configuration.mjs';
import { legacyRuntimeConfiguration } from './master-configuration-migration.mjs';

export class NativeConfigurationOverlayError extends Error {
  constructor() { super('native_configuration_overlay_invalid'); this.code = 'native_configuration_overlay_invalid'; }
}
const overlayPath = paths => path.join(paths.dataRoot, 'native-configuration.json');

// Root-owned base configuration and administrator verifier remain read-only.
// Only portable application preferences may override the base in writable data.
export function readEffectiveRuntimeConfig(filePath, { paths = runtimeStatePaths() } = {}) {
  const cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if(cfg.format===MASTER_FORMAT){
    const errors=validateMasterConfiguration(cfg);
    if(errors.length)throw new MasterConfigurationError('configuration_invalid',422,errors);
    return legacyRuntimeConfiguration(cfg);
  }
  if (!paths.sharedStateEnabled || path.resolve(filePath) !== path.resolve(paths.configPath)) return cfg;
  let stat;
  try { stat = fs.lstatSync(overlayPath(paths)); }
  catch (error) { if (error.code === 'ENOENT') return cfg; throw new NativeConfigurationOverlayError(); }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error();
    const document = JSON.parse(fs.readFileSync(overlayPath(paths), 'utf8'));
    validatePortableConfiguration(document);
    const next = mergeRuntimeConfig(cfg, document.settings);
    assertImmutableRuntimeConfig(next);
    if (validateRuntimeConfigShape(next).length) throw new Error();
    return next;
  } catch { throw new NativeConfigurationOverlayError(); }
}

export async function writeNativeRuntimeConfig(next, { paths = runtimeStatePaths() } = {}) {
  const persisted=JSON.parse(fs.readFileSync(paths.configPath,'utf8'));
  if(persisted.format===MASTER_FORMAT)throw new MasterConfigurationError('configuration_master_api_required',409);
  if (!paths.sharedStateEnabled) return writeJsonAtomically(paths.configPath, next);
  const base = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
  const document = exportPortableConfiguration(next);
  validatePortableConfiguration(document);
  // Reject rather than discard any attempted change outside the allowlist.
  if (!isDeepStrictEqual(mergeRuntimeConfig(base, document.settings), next)) throw new NativeConfigurationOverlayError();
  assertImmutableRuntimeConfig(next);
  if (validateRuntimeConfigShape(next).length) throw new NativeConfigurationOverlayError();
  const directory = fs.lstatSync(paths.dataRoot);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new NativeConfigurationOverlayError();
  try {
    const stat = fs.lstatSync(overlayPath(paths));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeConfigurationOverlayError();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeJsonAtomically(overlayPath(paths), document);
}
