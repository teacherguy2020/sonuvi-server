import { readEffectiveRuntimeConfig, NativeConfigurationOverlayError } from '../lib/native-configuration-store.mjs';
import fs from 'node:fs';
import { MasterConfigurationError } from '../lib/master-configuration.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';
import {
  assertImmutableRuntimeConfig,
  ImmutableConfigSchemaError,
  SecretConfigFieldError,
} from '../lib/runtime-config-security.mjs';

function configPaths() {
  return runtimeStatePaths();
}

function assertConfig(cfg) {
  const errors = [];

  if (!Array.isArray(cfg.nodes) || cfg.nodes.length < 1) {
    errors.push('nodes must be a non-empty array');
  }

  if (!cfg.ports || typeof cfg.ports.api !== 'number' || typeof cfg.ports.ui !== 'number') {
    errors.push('ports.api and ports.ui must be numbers');
  }

  if (!cfg[Symbol.for('sonuvi.master.document')] && cfg.alexa?.enabled && !cfg.alexa?.publicDomain) {
    errors.push('alexa.publicDomain is required when alexa.enabled = true');
  }

  if (errors.length) {
    throw new Error(`Invalid config: ${errors.join('; ')}`);
  }

  return cfg;
}

export function loadConfig(customPath = configPaths().configPath) {
  const paths = configPaths();
  const { exampleConfigPath, configPath } = paths;
  if (!fs.existsSync(customPath)) {
    throw new Error(
      `Config not found at ${customPath}. Copy ${exampleConfigPath} to ${configPath} and edit it.`
    );
  }

  const cfg = readEffectiveRuntimeConfig(customPath, { paths });
  if (paths.sharedStateEnabled && !cfg[Symbol.for('sonuvi.master.document')]) {
    assertImmutableRuntimeConfig(cfg, { context: 'immutable runtime configuration' });
  }
  return assertConfig(cfg);
}

export function loadConfigOrNull(customPath) {
  try {
    return loadConfig(customPath);
  } catch (error) {
    if(error instanceof MasterConfigurationError)throw error;
    if (configPaths().sharedStateEnabled
      && (error instanceof SecretConfigFieldError || error instanceof ImmutableConfigSchemaError || error instanceof NativeConfigurationOverlayError)) {
      throw error;
    }
    return null;
  }
}
