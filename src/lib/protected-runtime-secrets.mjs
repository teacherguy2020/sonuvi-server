import fs from 'node:fs';

function text(value) {
  return String(value ?? '').trim();
}

const LASTFM_NAMES = Object.freeze([
  'LASTFM_API_KEY',
  'LASTFM_API_SECRET',
  'LASTFM_SESSION_KEY',
  'LASTFM_USERNAME',
]);

function parseEnvironment(textValue) {
  const values = {};
  for (const line of String(textValue || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(LASTFM_API_KEY|LASTFM_API_SECRET|LASTFM_SESSION_KEY|LASTFM_USERNAME)\s*=\s*(.*?)\s*$/);
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
  if (!statePaths?.sharedStateEnabled) {
    return Object.freeze(values);
  }

  let fileValues = {};
  let ownerManaged = false;
  try {
    const contents=readFileSync(statePaths.lastfmEnvPath, 'utf8');
    ownerManaged=String(contents).split(/\r?\n/).includes('# sonuvi-lastfm-admin-v1');
    fileValues = parseEnvironment(contents);
  } catch {
    // Missing/unreadable protected credentials fail closed for this feature.
  }
  // Explicit owner edits supersede legacy files/environment without modifying them.
  if (statePaths.lastfmAdminEnvPath && statePaths.lastfmAdminEnvPath !== statePaths.lastfmEnvPath) {
    try {
      const contents = readFileSync(statePaths.lastfmAdminEnvPath, 'utf8');
      if (String(contents).split(/\r?\n/).includes('# sonuvi-lastfm-admin-v1')) {
        fileValues = {...fileValues, ...parseEnvironment(contents)};
        ownerManaged = true;
      }
    } catch { /* No owner edits yet; retain legacy configuration. */ }
  }
  for (const name of LASTFM_NAMES) {
    if (ownerManaged && Object.hasOwn(fileValues,name)) values[name]=text(fileValues[name]);
    else if (!values[name]) values[name] = text(fileValues[name]);
  }
  Object.defineProperty(values,'ownerManaged',{value:ownerManaged,enumerable:false});
  return Object.freeze(values);
}
