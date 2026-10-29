import fs from 'node:fs';

function text(value) {
  return String(value ?? '').trim();
}

const LASTFM_NAMES = Object.freeze([
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'LASTFM_SESSION_KEY',
]);

function parseEnvironment(textValue) {
  const values = {};
  for (const line of String(textValue || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(LASTFM_API_KEY|LASTFM_API_SECRET|LASTFM_SESSION_KEY)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * Immutable releases may source Last.fm values only from their protected
 * environment file or their process environment. A read error is deliberately
 * equivalent to a missing credential: Last.fm becomes unavailable without
 * leaking a path, value, or filesystem error to unrelated features.
 */
export function loadProtectedLastfmEnvironment({
  statePaths,
  env = process.env,
  readFileSync = fs.readFileSync,
} = {}) {
  const values = {};
  for (const name of LASTFM_NAMES) values[name] = text(env?.[name]);
  if (!statePaths?.sharedStateEnabled || LASTFM_NAMES.every((name) => values[name])) {
    return Object.freeze(values);
  }

  let fileValues = {};
  try {
    fileValues = parseEnvironment(readFileSync(statePaths.lastfmEnvPath, 'utf8'));
  } catch {
    // Missing/unreadable protected credentials fail closed for this feature.
  }
  for (const name of LASTFM_NAMES) {
    if (!values[name]) values[name] = text(fileValues[name]);
  }
  return Object.freeze(values);
}
