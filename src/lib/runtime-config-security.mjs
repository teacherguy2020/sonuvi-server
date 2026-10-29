function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const SECRET_FIELDS = Object.freeze({
  root: new Set([
    'trackKey',
    'mobileApiSecret',
    'mobileTrackIdSecret',
    'mobileApiEnrollmentCode',
    'appleMusicDeveloperToken',
    'appleMusicPrivateKey',
  ]),
  lastfm: new Set(['apiKey', 'apiSecret', 'sessionKey', 'token', 'secret']),
  pushover: new Set(['token', 'userKey']),
  apns: new Set(['keyId', 'teamId', 'privateKey', 'privateKeyPath', 'token']),
  appleMusic: new Set(['developerToken', 'keyId', 'teamId', 'privateKey', 'privateKeyPath']),
  qobuz: new Set(['apiKey', 'apiSecret', 'accessToken', 'refreshToken', 'password', 'token']),
  alexa: new Set([
    'clientSecret', 'accessToken', 'refreshToken', 'token',
    'skillId', 'routeWebhookUrl', 'stopWebhookUrl',
  ]),
});

const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  'projectName', 'environment', 'timezone', 'apiHost', 'apiNodeIp', 'deployment',
  'nodes', 'ports', 'display', 'features', 'mpd', 'moode', 'alexa',
  'notifications', 'paths', 'lastfm', 'runtime',
]);

const ALLOWED_OBJECT_FIELDS = Object.freeze({
  deployment: new Set(['sourceOfTruthNode', 'syncMethod']),
  node: new Set(['name', 'ip', 'role', 'sshUser']),
  ports: new Set(['api', 'ui']),
  display: new Set(['idleBrandLine', 'idleMessageLine']),
  features: new Set(['podcasts', 'ratings', 'radio', 'albumPersonnel', 'showAboutWhenNoPersonnel', 'moodeDisplayTakeover', 'lastfm', 'mpdscribbleControl']),
  mpd: new Set(['host', 'port']),
  moode: new Set(['sshHost', 'sshUser', 'baseUrl']),
  alexa: new Set([
    'enabled', 'publicDomain', 'webhookPath', 'artistAliases', 'albumAliases', 'playlistAliases',
    'unresolvedArtists', 'heardArtists', 'unresolvedAlbums', 'heardAlbums', 'unresolvedPlaylists', 'heardPlaylists',
  ]),
  notifications: new Set(['trackNotify', 'pushover', 'apns']),
  trackNotify: new Set(['enabled', 'pollMs', 'dedupeMs', 'alexaMaxAgeMs']),
  pushover: new Set(),
  apns: new Set(['topic', 'environment', 'tokensPath']),
  paths: new Set(['musicLibraryRoot', 'moodeUsbMount', 'piMountBase', 'podcastRoot', 'subscriptionsJson']),
  lastfm: new Set(['username', 'recentsReplaceRadio', 'recentsMode', 'period', 'topTracksWindowDays']),
  runtime: new Set(['publicBaseUrl', 'artCacheLimit', 'trackCacheDir', 'artCacheDir']),
  unresolved: new Set(['artist', 'album', 'playlist', 'key', 'count', 'createdAt', 'updatedAt', 'lastSource']),
  heard: new Set(['artist', 'album', 'playlist', 'key', 'source', 'status', 'resolvedTo', 'at']),
});

function fieldsAt(value, prefix, names, found) {
  const source = object(value);
  for (const name of names) {
    if (hasOwn(source, name)) found.push(`${prefix}.${name}`);
  }
}

export class SecretConfigFieldError extends Error {
  constructor({ context, fields }) {
    super(`${context} must not contain secret-bearing fields: ${fields.join(', ')}`);
    this.name = 'SecretConfigFieldError';
    this.fields = [...fields];
  }
}

export class ImmutableConfigSchemaError extends Error {
  constructor({ context, fields }) {
    super(`${context} contains unsupported fields: ${fields.join(', ')}`);
    this.name = 'ImmutableConfigSchemaError';
    this.fields = [...fields];
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function pathFor(prefix, field) {
  return prefix ? `${prefix}.${field}` : field;
}

function inspectObject(value, prefix, allowed, found) {
  if (!isObject(value)) {
    found.push(prefix || '<root>');
    return;
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) found.push(pathFor(prefix, field));
  }
}

function inspectRecords(value, prefix, allowed, found) {
  if (!Array.isArray(value)) {
    found.push(prefix);
    return;
  }
  value.forEach((entry, index) => inspectObject(entry, `${prefix}[${index}]`, allowed, found));
}

/**
 * Only field names are reported. Values are intentionally never inspected,
 * serialized, or echoed in order to keep this validation safe for secrets.
 */
export function findSecretConfigFields(value) {
  const source = object(value);
  const found = [];
  for (const name of SECRET_FIELDS.root) {
    if (hasOwn(source, name)) found.push(name);
  }
  fieldsAt(source.lastfm, 'lastfm', SECRET_FIELDS.lastfm, found);
  fieldsAt(source.notifications?.pushover, 'notifications.pushover', SECRET_FIELDS.pushover, found);
  fieldsAt(source.notifications?.apns, 'notifications.apns', SECRET_FIELDS.apns, found);
  fieldsAt(source.appleMusic, 'appleMusic', SECRET_FIELDS.appleMusic, found);
  fieldsAt(source.qobuz, 'qobuz', SECRET_FIELDS.qobuz, found);
  fieldsAt(source.alexa, 'alexa', SECRET_FIELDS.alexa, found);
  return [...new Set(found)].sort();
}

/**
 * Immutable deployment configuration is intentionally a narrow non-secret
 * schema. Unknown fields are rejected instead of being retained for an
 * accidental future serializer or API surface.
 */
export function findUnsupportedImmutableConfigFields(value) {
  const found = [];
  inspectObject(value, '', ALLOWED_TOP_LEVEL_FIELDS, found);
  if (!isObject(value)) return [...new Set(found)].sort();

  const source = value;
  const objectRules = [
    ['deployment', ALLOWED_OBJECT_FIELDS.deployment],
    ['ports', ALLOWED_OBJECT_FIELDS.ports],
    ['display', ALLOWED_OBJECT_FIELDS.display],
    ['features', ALLOWED_OBJECT_FIELDS.features],
    ['mpd', ALLOWED_OBJECT_FIELDS.mpd],
    ['moode', ALLOWED_OBJECT_FIELDS.moode],
    ['alexa', ALLOWED_OBJECT_FIELDS.alexa],
    ['notifications', ALLOWED_OBJECT_FIELDS.notifications],
    ['paths', ALLOWED_OBJECT_FIELDS.paths],
    ['lastfm', ALLOWED_OBJECT_FIELDS.lastfm],
    ['runtime', ALLOWED_OBJECT_FIELDS.runtime],
  ];
  for (const [name, allowed] of objectRules) {
    if (hasOwn(source, name)) inspectObject(source[name], name, allowed, found);
  }
  if (hasOwn(source, 'nodes')) {
    if (!Array.isArray(source.nodes)) found.push('nodes');
    else source.nodes.forEach((node, index) => inspectObject(node, `nodes[${index}]`, ALLOWED_OBJECT_FIELDS.node, found));
  }

  const alexa = object(source.alexa);
  for (const name of ['artistAliases', 'albumAliases', 'playlistAliases']) {
    if (hasOwn(alexa, name) && !isObject(alexa[name])) found.push(`alexa.${name}`);
  }
  for (const name of ['unresolvedArtists', 'unresolvedAlbums', 'unresolvedPlaylists']) {
    if (hasOwn(alexa, name)) inspectRecords(alexa[name], `alexa.${name}`, ALLOWED_OBJECT_FIELDS.unresolved, found);
  }
  for (const name of ['heardArtists', 'heardAlbums', 'heardPlaylists']) {
    if (hasOwn(alexa, name)) inspectRecords(alexa[name], `alexa.${name}`, ALLOWED_OBJECT_FIELDS.heard, found);
  }

  const notifications = object(source.notifications);
  for (const [name, allowed] of [
    ['trackNotify', ALLOWED_OBJECT_FIELDS.trackNotify],
    ['pushover', ALLOWED_OBJECT_FIELDS.pushover],
    ['apns', ALLOWED_OBJECT_FIELDS.apns],
  ]) {
    if (hasOwn(notifications, name)) inspectObject(notifications[name], `notifications.${name}`, allowed, found);
  }
  return [...new Set(found)].sort();
}

export function assertNoSecretConfigFields(value, {
  context = 'mutable runtime configuration',
} = {}) {
  const fields = findSecretConfigFields(value);
  if (fields.length) {
    throw new SecretConfigFieldError({ context, fields });
  }
  return true;
}

export function assertImmutableRuntimeConfig(value, {
  context = 'immutable runtime configuration',
} = {}) {
  assertNoSecretConfigFields(value, { context });
  const fields = findUnsupportedImmutableConfigFields(value);
  if (fields.length) throw new ImmutableConfigSchemaError({ context, fields });
  return true;
}
