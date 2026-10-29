import dgram from 'node:dgram';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { XMLParser } from 'fast-xml-parser';
import { runtimeCapabilities } from './runtime-capabilities.mjs';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const DEFAULT_SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaServer:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
];
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_HTTP_TIMEOUT_MS = 4500;
const DEFAULT_MAX_XML_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOAP_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_DISCOVERY_COOLDOWN_MS = 3000;

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  trimValues: true,
  parseTagValue: false,
  // UPnP devices are network input. Keep entity expansion disabled; the
  // small XML-escaped values used by SOAP/DIDL are decoded explicitly below.
  processEntities: false,
  allowBooleanAttributes: false,
};

const READ_ONLY_RENDERER_ACTIONS = new Set([
  'GetCurrentTransportActions',
  'GetDeviceCapabilities',
  'GetMediaInfo',
  'GetPositionInfo',
  'GetTransportInfo',
]);

const ALLOWED_AVTRANSPORT_ACTIONS = new Set([
  'SetAVTransportURI',
  'SetNextAVTransportURI',
  'Play',
  'Pause',
  'Stop',
  'Seek',
  'Next',
  'Previous',
  'GetTransportInfo',
  'GetPositionInfo',
  'GetCurrentTransportActions',
  'GetMediaInfo',
]);

const MUTATING_AVTRANSPORT_ACTIONS = new Set([
  'SetAVTransportURI',
  'SetNextAVTransportURI',
  'Play',
  'Pause',
  'Stop',
  'Seek',
  'Next',
  'Previous',
]);

const DEFAULT_MEDIA_ITEM_TTL_MS = 15 * 60 * 1000;

export class UpnpError extends Error {
  constructor(message, {
    code = 'UPNP_ERROR',
    status = 502,
    cause = undefined,
    details = undefined,
  } = {}) {
    super(String(message || 'UPnP operation failed'), { cause });
    this.name = 'UpnpError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function localName(key) {
  return String(key || '').replace(/^.*:/, '');
}

function directNamed(node, wanted) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const target = String(wanted || '').toLowerCase();
  return Object.entries(node)
    .filter(([key]) => !key.startsWith('@_') && localName(key).toLowerCase() === target)
    .flatMap(([, value]) => asArray(value));
}

function firstNamed(node, wanted) {
  return directNamed(node, wanted)[0] ?? null;
}

function attr(node, wanted) {
  if (!node || typeof node !== 'object') return '';
  const target = String(wanted || '').toLowerCase();
  const entry = Object.entries(node).find(([key]) => {
    if (!key.startsWith('@_')) return false;
    return localName(key.slice(2)).toLowerCase() === target;
  });
  return entry ? textValue(entry[1]) : '';
}

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function textValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return textValue(value[0]);
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, '#text')) return decodeXmlEntities(value['#text']);
    if (Object.prototype.hasOwnProperty.call(value, '#cdata')) return decodeXmlEntities(value['#cdata']);
    return '';
  }
  return decodeXmlEntities(String(value).trim());
}

function parseXml(xml, context = 'XML') {
  const raw = String(xml || '');
  if (!raw.trim()) throw new UpnpError(`${context} response was empty`, { code: 'UPNP_EMPTY_XML' });
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    throw new UpnpError(`${context} contains a forbidden DTD/entity declaration`, {
      code: 'UPNP_UNSAFE_XML',
      status: 502,
    });
  }
  try {
    return new XMLParser(XML_OPTIONS).parse(raw);
  } catch (error) {
    throw new UpnpError(`${context} could not be parsed`, {
      code: 'UPNP_MALFORMED_XML',
      status: 502,
      cause: error,
    });
  }
}

function parseInteger(value, fallback = null) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isSafeInteger(n) ? n : fallback;
}

function parseDurationSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const match = raw.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  return Number.isFinite(hours + minutes + seconds)
    ? (hours * 3600) + (minutes * 60) + seconds
    : null;
}

function resolveUrl(raw, baseUrl) {
  const value = textValue(raw);
  if (!value) return '';
  try {
    const url = new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function isTrustedPrivateAddress(address) {
  const raw = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!raw) return false;
  if (net.isIPv4(raw)) {
    const octets = raw.split('.').map(Number);
    const [a, b] = octets;
    if (a === 10 || a === 127 || a === 0) return a === 10;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(raw)) {
    if (raw === '::1' || raw === '::') return false;
    return raw.startsWith('fc') || raw.startsWith('fd') || raw.startsWith('fe80:');
  }
  return false;
}

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
}

/** Validate an advertised UPnP URL before a server-side request is made. */
export async function validateTrustedLocalUrl(rawUrl, {
  lookup = dns.lookup,
  allowedHostnames = [],
} = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    throw new UpnpError('UPnP URL is invalid', { code: 'UPNP_UNSAFE_URL', status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port === '0') {
    throw new UpnpError('UPnP URL is not an allowed local HTTP URL', { code: 'UPNP_UNSAFE_URL', status: 400 });
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new UpnpError('UPnP URL points to a loopback host', { code: 'UPNP_UNSAFE_URL', status: 400 });
  }
  if (net.isIP(hostname)) {
    if (!isTrustedPrivateAddress(hostname)) {
      throw new UpnpError('UPnP URL points outside the trusted local network', { code: 'UPNP_UNSAFE_URL', status: 400 });
    }
    return url;
  }

  const explicit = new Set(asArray(allowedHostnames).map(normalizeHostname).filter(Boolean));
  const localSuffix = hostname.endsWith('.local')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.home')
    || hostname.endsWith('.internal');
  if (localSuffix || explicit.has(hostname)) return url;

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new UpnpError('UPnP URL hostname could not be resolved safely', {
      code: 'UPNP_UNSAFE_URL',
      status: 400,
      cause: error,
    });
  }
  if (!Array.isArray(records) || records.length === 0 || records.some((record) => !isTrustedPrivateAddress(record?.address))) {
    throw new UpnpError('UPnP URL does not resolve exclusively to the trusted local network', {
      code: 'UPNP_UNSAFE_URL',
      status: 400,
    });
  }
  return url;
}

function responseHeadersToObject(message) {
  const lines = String(message || '').split(/\r?\n/);
  const firstLine = String(lines.shift() || '').trim();
  if (!/^HTTP\/1\.1\s+2\d\d\b/i.test(firstLine) && !/^HTTP\/1\.0\s+2\d\d\b/i.test(firstLine)) return null;
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    if (!key || Object.prototype.hasOwnProperty.call(headers, key)) continue;
    headers[key] = line.slice(index + 1).trim();
  }
  return headers;
}

export function parseSsdpResponse(message, remote = {}) {
  const headers = responseHeadersToObject(message);
  if (!headers) return null;
  const location = headers.location || '';
  if (!location || location.length > 2048) return null;
  let parsedLocation;
  try {
    parsedLocation = new URL(location);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsedLocation.protocol) || parsedLocation.username || parsedLocation.password) return null;
  return {
    location: parsedLocation.toString(),
    usn: String(headers.usn || '').slice(0, 512),
    st: String(headers.st || '').slice(0, 512),
    server: String(headers.server || '').slice(0, 512),
    cacheControl: String(headers['cache-control'] || '').slice(0, 512),
    remoteAddress: String(remote?.address || '').slice(0, 64),
    remotePort: Number(remote?.port || 0) || 0,
  };
}

function interfaceIsEligible(name, address) {
  const interfaceName = String(name || '').toLowerCase();
  if (!net.isIPv4(address) || !isTrustedPrivateAddress(address)) return false;
  if (/^(lo|docker|br-|veth|tailscale|zt|wg|tun|tap)/i.test(interfaceName)) return false;
  return true;
}

export function getLocalDiscoveryInterfaces({ names = undefined } = {}) {
  const requested = asArray(names ?? String(process.env.UPNP_DISCOVERY_INTERFACES || '').split(','))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const wanted = requested.length ? new Set(requested) : null;
  const interfaces = [];
  for (const [name, records] of Object.entries(os.networkInterfaces())) {
    if (wanted && !wanted.has(name)) continue;
    for (const record of records || []) {
      const address = String(record?.address || '').trim();
      if (record?.internal || !interfaceIsEligible(name, address)) continue;
      interfaces.push({ name, address, family: 'IPv4' });
    }
  }
  if (interfaces.length || wanted) return interfaces;
  return [{ name: 'default', address: '0.0.0.0', family: 'IPv4' }];
}

function ssdpMessage(searchTarget) {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 1',
    `ST: ${searchTarget}`,
    '',
    '',
  ].join('\r\n');
}

function discoverOnInterface(interfaceInfo, {
  socketFactory = (type) => dgram.createSocket(type),
  searchTargets = DEFAULT_SEARCH_TARGETS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let socket = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    try {
      socket = socketFactory('udp4');
      socket.on('message', (message, remote) => {
        const parsed = parseSsdpResponse(message.toString('utf8'), remote);
        if (!parsed) return;
        const key = parsed.location.toLowerCase();
        if (!found.has(key)) found.set(key, { ...parsed, interface: interfaceInfo.name });
      });
      socket.on('error', () => finish());
      socket.bind({ address: interfaceInfo.address, port: 0, exclusive: true }, () => {
        for (const target of asArray(searchTargets).slice(0, 8)) {
          const payload = Buffer.from(ssdpMessage(String(target || '').trim()), 'utf8');
          if (!payload.length) continue;
          try {
            socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_ADDRESS, () => {});
          } catch {
            // A failed target does not invalidate responses already received.
          }
        }
      });
    } catch {
      finish();
    }
  });
}

export async function discoverSsdp({
  interfaces = getLocalDiscoveryInterfaces(),
  socketFactory,
  searchTargets = DEFAULT_SEARCH_TARGETS,
  timeoutMs = Number(process.env.UPNP_DISCOVERY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
} = {}) {
  const selected = asArray(interfaces).filter((value) => value && typeof value === 'object');
  if (!selected.length) return [];
  const batches = await Promise.all(selected.map((interfaceInfo) => discoverOnInterface(interfaceInfo, {
    socketFactory,
    searchTargets,
    timeoutMs,
  })));
  const unique = new Map();
  for (const batch of batches) {
    for (const response of batch) {
      const key = String(response.location || '').toLowerCase();
      if (key && !unique.has(key)) unique.set(key, response);
    }
  }
  return [...unique.values()];
}

function serviceVersion(serviceType) {
  const match = String(serviceType || '').match(/:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function deviceRoles(deviceType) {
  const value = String(deviceType || '').toLowerCase();
  const roles = [];
  if (value.includes(':mediaserver:')) roles.push('media-server');
  if (value.includes(':mediarenderer:')) roles.push('media-renderer');
  return roles;
}

function makeDeviceId(udn) {
  return createHash('sha256').update(String(udn || '')).digest('hex').slice(0, 24);
}

function parseServiceNode(serviceNode, baseUrl) {
  const serviceType = textValue(firstNamed(serviceNode, 'serviceType'));
  const serviceId = textValue(firstNamed(serviceNode, 'serviceId'));
  return {
    serviceType,
    serviceId,
    version: serviceVersion(serviceType),
    scpdUrl: resolveUrl(firstNamed(serviceNode, 'SCPDURL'), baseUrl),
    controlUrl: resolveUrl(firstNamed(serviceNode, 'controlURL'), baseUrl),
    eventSubUrl: resolveUrl(firstNamed(serviceNode, 'eventSubURL'), baseUrl),
  };
}

function parseDeviceNode(deviceNode, baseUrl, devices, parentUdn = '') {
  const deviceBase = textValue(firstNamed(deviceNode, 'URLBase')) || baseUrl;
  const deviceType = textValue(firstNamed(deviceNode, 'deviceType'));
  const udn = textValue(firstNamed(deviceNode, 'UDN'));
  const servicesNode = firstNamed(deviceNode, 'serviceList');
  const services = directNamed(servicesNode, 'service').map((service) => parseServiceNode(service, deviceBase));
  const record = {
    id: makeDeviceId(udn),
    udn,
    parentUdn,
    deviceType,
    version: serviceVersion(deviceType),
    roles: deviceRoles(deviceType),
    friendlyName: textValue(firstNamed(deviceNode, 'friendlyName')),
    manufacturer: textValue(firstNamed(deviceNode, 'manufacturer')),
    manufacturerUrl: resolveUrl(firstNamed(deviceNode, 'manufacturerURL'), deviceBase),
    modelDescription: textValue(firstNamed(deviceNode, 'modelDescription')),
    modelName: textValue(firstNamed(deviceNode, 'modelName')),
    modelNumber: textValue(firstNamed(deviceNode, 'modelNumber')),
    serialNumber: textValue(firstNamed(deviceNode, 'serialNumber')),
    presentationUrl: resolveUrl(firstNamed(deviceNode, 'presentationURL'), deviceBase),
    baseUrl: deviceBase,
    services: services.filter((service) => service.serviceType && service.controlUrl),
  };
  if (udn) devices.push(record);

  const embeddedList = firstNamed(deviceNode, 'deviceList');
  for (const embedded of directNamed(embeddedList, 'device')) {
    parseDeviceNode(embedded, deviceBase, devices, udn);
  }
}

export function parseDeviceDescription(xml, { location = '' } = {}) {
  const parsed = parseXml(xml, 'UPnP device description');
  const root = firstNamed(parsed, 'root') || parsed;
  const rootBase = textValue(firstNamed(root, 'URLBase')) || String(location || '');
  const rootDevice = firstNamed(root, 'device');
  if (!rootDevice) {
    throw new UpnpError('UPnP device description has no device element', {
      code: 'UPNP_INVALID_DESCRIPTION',
      status: 502,
    });
  }
  const devices = [];
  parseDeviceNode(rootDevice, rootBase, devices);
  // The UPnP schema normally places embedded devices under the root device's
  // deviceList. A few implementations expose a root-level deviceList; accept
  // it as well without treating arbitrary descendants as devices.
  for (const embedded of directNamed(firstNamed(root, 'deviceList'), 'device')) {
    parseDeviceNode(embedded, rootBase, devices, textValue(firstNamed(rootDevice, 'UDN')));
  }
  if (!devices.length) {
    throw new UpnpError('UPnP device description has no UDN', {
      code: 'UPNP_INVALID_DESCRIPTION',
      status: 502,
    });
  }
  return {
    specVersion: textValue(firstNamed(root, 'specVersion')),
    devices,
  };
}

export function parseServiceDescription(xml) {
  const parsed = parseXml(xml, 'UPnP service description');
  const root = firstNamed(parsed, 'scpd') || parsed;
  const actionList = firstNamed(root, 'actionList');
  const actions = directNamed(actionList, 'action').map((actionNode) => {
    const argumentList = firstNamed(actionNode, 'argumentList');
    const args = directNamed(argumentList, 'argument').map((argumentNode) => ({
      name: textValue(firstNamed(argumentNode, 'name')),
      direction: textValue(firstNamed(argumentNode, 'direction')).toLowerCase(),
      relatedStateVariable: textValue(firstNamed(argumentNode, 'relatedStateVariable')),
    })).filter((argument) => argument.name);
    return {
      name: textValue(firstNamed(actionNode, 'name')),
      arguments: args,
    };
  }).filter((action) => action.name);
  const stateTable = firstNamed(root, 'serviceStateTable');
  const stateVariables = directNamed(stateTable, 'stateVariable').map((node) => ({
    name: textValue(firstNamed(node, 'name')),
    dataType: textValue(firstNamed(node, 'dataType')),
    sendEvents: attr(node, 'sendEvents') || 'no',
  })).filter((entry) => entry.name);
  return {
    specVersion: textValue(firstNamed(root, 'specVersion')),
    actions,
    actionNames: actions.map((action) => action.name),
    stateVariables,
  };
}

function resourceFormat(protocolInfo) {
  const parts = String(protocolInfo || '').split(':');
  return {
    mimeType: parts[2] || '',
    additionalInfo: parts.slice(3).join(':') || '',
  };
}

function parseResource(resourceNode) {
  const uri = textValue(resourceNode);
  const protocolInfo = attr(resourceNode, 'protocolInfo');
  const format = resourceFormat(protocolInfo);
  return {
    uri: /^https?:\/\//i.test(uri) ? uri : '',
    protocolInfo,
    mimeType: format.mimeType,
    protocolAdditionalInfo: format.additionalInfo,
    duration: attr(resourceNode, 'duration'),
    durationSeconds: parseDurationSeconds(attr(resourceNode, 'duration')),
    size: parseInteger(attr(resourceNode, 'size')),
    bitrate: parseInteger(attr(resourceNode, 'bitrate')),
    sampleFrequency: parseInteger(attr(resourceNode, 'sampleFrequency')),
    bitsPerSample: parseInteger(attr(resourceNode, 'bitsPerSample')),
    audioChannels: parseInteger(attr(resourceNode, 'nrAudioChannels')),
    resolution: attr(resourceNode, 'resolution'),
  };
}

function firstTextChild(node, names) {
  for (const name of names) {
    const value = textValue(firstNamed(node, name));
    if (value) return value;
  }
  return '';
}

function normalizedGenres(node) {
  const values = [];
  const seen = new Set();
  for (const value of directNamed(node, 'genre').map(textValue)) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values.join(' | ');
}

export function parseDidlLite(xml) {
  const parsed = parseXml(xml, 'DIDL-Lite metadata');
  const didl = firstNamed(parsed, 'DIDL-Lite') || parsed;
  const nodes = [
    ...directNamed(didl, 'container').map((node) => ({ node, kind: 'container' })),
    ...directNamed(didl, 'item').map((node) => ({ node, kind: 'item' })),
  ];
  return nodes.map(({ node, kind }) => {
    const resources = directNamed(node, 'res').map(parseResource);
    const artists = directNamed(node, 'artist').map(textValue).filter(Boolean);
    const artworkUrl = firstTextChild(node, ['albumArtURI', 'icon']);
    const duration = firstTextChild(node, ['duration']) || resources.find((resource) => resource.duration)?.duration || '';
    return {
      kind,
      id: attr(node, 'id'),
      parentId: attr(node, 'parentID'),
      refId: attr(node, 'refID'),
      restricted: attr(node, 'restricted'),
      title: firstTextChild(node, ['title']),
      creator: firstTextChild(node, ['creator']),
      artist: artists[0] || '',
      artists,
      albumArtist: firstTextChild(node, ['albumArtist']),
      album: firstTextChild(node, ['album']),
      genre: normalizedGenres(node),
      trackNumber: parseInteger(firstTextChild(node, ['originalTrackNumber'])),
      class: firstTextChild(node, ['class']),
      artworkUrl,
      duration,
      durationSeconds: parseDurationSeconds(duration),
      resources,
    };
  });
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXmlAttribute(value) {
  return escapeXml(value);
}

function resourceDuration(resource, item) {
  const value = String(resource?.duration || item?.duration || '').trim();
  return value;
}

function protocolInfoParts(value) {
  const parts = String(value || '').split(':');
  return {
    protocol: String(parts[0] || '').trim().toLowerCase(),
    network: String(parts[1] || '').trim().toLowerCase(),
    mimeType: String(parts[2] || '').trim().toLowerCase(),
    additionalInfo: parts.slice(3).join(':').trim().toLowerCase(),
  };
}

function protocolPartMatches(actual, advertised) {
  const left = String(actual || '').trim().toLowerCase();
  const right = String(advertised || '').trim().toLowerCase();
  return right === '*' || !right || left === right;
}

function protocolInfoMatches(resourceProtocolInfo, sinkProtocolInfo) {
  const resource = protocolInfoParts(resourceProtocolInfo);
  const sink = protocolInfoParts(sinkProtocolInfo);
  if (!resource.protocol || !resource.mimeType || !sink.protocol || !sink.mimeType) return false;
  return protocolPartMatches(resource.protocol, sink.protocol)
    && protocolPartMatches(resource.network, sink.network)
    && protocolPartMatches(resource.mimeType, sink.mimeType)
    && protocolPartMatches(resource.additionalInfo, sink.additionalInfo);
}

function uriFingerprint(raw) {
  try {
    const url = new URL(String(raw || ''));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Build the small DIDL-Lite document that AVTransport expects alongside a
 * trusted ContentDirectory resource. The document is generated from the
 * normalized item rather than accepting client-supplied XML.
 */
export function buildDidlLiteMetadata(item, resource = null) {
  const selectedResource = resource || item?.resources?.find((candidate) => candidate?.uri);
  if (!item || item.kind !== 'item' || !item.id || !selectedResource?.uri) {
    throw new UpnpError('UPnP media item metadata is incomplete', {
      code: 'UPNP_INVALID_MEDIA_ITEM',
      status: 400,
    });
  }

  const attributes = [
    `id="${escapeXmlAttribute(item.id)}"`,
    `parentID="${escapeXmlAttribute(item.parentId || '-1')}"`,
    `restricted="${escapeXmlAttribute(item.restricted || '1')}"`,
  ];
  if (item.refId) attributes.push(`refID="${escapeXmlAttribute(item.refId)}"`);

  const resourceAttributes = [
    ['protocolInfo', selectedResource.protocolInfo],
    ['duration', resourceDuration(selectedResource, item)],
    ['size', selectedResource.size],
    ['bitrate', selectedResource.bitrate],
    ['sampleFrequency', selectedResource.sampleFrequency],
    ['bitsPerSample', selectedResource.bitsPerSample],
    ['nrAudioChannels', selectedResource.audioChannels],
    ['resolution', selectedResource.resolution],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`)
    .join(' ');

  const children = [];
  if (item.title) children.push(`<dc:title>${escapeXml(item.title)}</dc:title>`);
  if (item.creator) children.push(`<dc:creator>${escapeXml(item.creator)}</dc:creator>`);
  if (item.artist) children.push(`<upnp:artist>${escapeXml(item.artist)}</upnp:artist>`);
  if (item.albumArtist) children.push(`<upnp:albumArtist>${escapeXml(item.albumArtist)}</upnp:albumArtist>`);
  if (item.album) children.push(`<upnp:album>${escapeXml(item.album)}</upnp:album>`);
  if (Number.isSafeInteger(item.trackNumber)) {
    children.push(`<upnp:originalTrackNumber>${item.trackNumber}</upnp:originalTrackNumber>`);
  }
  if (item.artworkUrl) children.push(`<upnp:albumArtURI>${escapeXml(item.artworkUrl)}</upnp:albumArtURI>`);
  children.push(`<upnp:class>${escapeXml(item.class || 'object.item.audioItem.musicTrack')}</upnp:class>`);
  children.push(`<res${resourceAttributes ? ` ${resourceAttributes}` : ''}>${escapeXml(selectedResource.uri)}</res>`);

  return [
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"',
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">',
    `<item ${attributes.join(' ')}>${children.join('')}</item>`,
    '</DIDL-Lite>',
  ].join('');
}

export function buildSoapEnvelope(serviceType, action, argumentsObject = {}) {
  const args = Object.entries(argumentsObject || {})
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${escapeXml(action)} xmlns:u="${escapeXml(serviceType)}">${args}</u:${escapeXml(action)}>`,
    '</s:Body>',
    '</s:Envelope>',
  ].join('');
}

function findFirstDescendant(node, wanted) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findFirstDescendant(child, wanted);
      if (found != null) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (localName(key).toLowerCase() === String(wanted || '').toLowerCase()) return value;
    const found = findFirstDescendant(value, wanted);
    if (found != null) return found;
  }
  return null;
}

export function parseSoapResponse(xml, action) {
  const parsed = parseXml(xml, `UPnP ${action} response`);
  const fault = findFirstDescendant(parsed, 'Fault');
  if (fault) {
    const code = textValue(findFirstDescendant(fault, 'errorCode'));
    const description = textValue(findFirstDescendant(fault, 'errorDescription'));
    throw new UpnpError(`UPnP SOAP fault${code ? ` ${code}` : ''}${description ? `: ${description}` : ''}`, {
      code: 'UPNP_SOAP_FAULT',
      status: 502,
    });
  }
  const responseNode = findFirstDescendant(parsed, `${action}Response`);
  if (!responseNode) {
    throw new UpnpError(`UPnP SOAP response did not contain ${action}Response`, {
      code: 'UPNP_INVALID_SOAP_RESPONSE',
      status: 502,
    });
  }
  const output = {};
  for (const [key, value] of Object.entries(responseNode || {})) {
    if (key.startsWith('@_')) continue;
    output[localName(key)] = textValue(value);
  }
  return output;
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new UpnpError('UPnP response exceeded the size limit', { code: 'UPNP_RESPONSE_TOO_LARGE', status: 502 });
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value || []);
        total += chunk.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new UpnpError('UPnP response exceeded the size limit', { code: 'UPNP_RESPONSE_TOO_LARGE', status: 502 });
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
  if (typeof response?.arrayBuffer === 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new UpnpError('UPnP response exceeded the size limit', { code: 'UPNP_RESPONSE_TOO_LARGE', status: 502 });
    }
    return bytes.toString('utf8');
  }
  const text = typeof response?.text === 'function' ? await response.text() : '';
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new UpnpError('UPnP response exceeded the size limit', { code: 'UPNP_RESPONSE_TOO_LARGE', status: 502 });
  }
  return String(text || '');
}

async function readResponseBytes(response, maxBytes) {
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  if (contentLength > maxBytes) {
    throw new UpnpError('UPnP response exceeded the size limit', { code: 'UPNP_RESPONSE_TOO_LARGE', status: 502 });
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value || []);
        total += chunk.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          throw new UpnpError('UPnP response exceeded the size limit', { code: 'UPNP_RESPONSE_TOO_LARGE', status: 502 });
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }
  if (typeof response?.arrayBuffer === 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new UpnpError('UPnP response exceeded the size limit', { code: 'UPNP_RESPONSE_TOO_LARGE', status: 502 });
    }
    return bytes;
  }
  throw new UpnpError('UPnP binary response could not be read', { code: 'UPNP_HTTP_ERROR', status: 502 });
}

export async function requestTextBounded(url, {
  fetchImpl = globalThis.fetch,
  validateUrl = validateTrustedLocalUrl,
  method = 'GET',
  headers = {},
  body = undefined,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_XML_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new UpnpError('Fetch is unavailable', { code: 'UPNP_FETCH_UNAVAILABLE' });
  const validated = await validateUrl(String(url || ''));
  const targetUrl = validated instanceof URL ? validated.toString() : String(validated || url);
  if (body != null && Buffer.byteLength(String(body), 'utf8') > DEFAULT_MAX_REQUEST_BYTES) {
    throw new UpnpError('UPnP request exceeded the size limit', { code: 'UPNP_REQUEST_TOO_LARGE', status: 400 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || DEFAULT_HTTP_TIMEOUT_MS));
  let response;
  try {
    response = await fetchImpl(targetUrl, {
      method,
      headers: { 'User-Agent': 'Sonuvi-UPnP-ControlPoint/1.0', ...headers },
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new UpnpError(`UPnP HTTP request failed: ${error?.message || String(error)}`, {
      code: error?.name === 'AbortError' ? 'UPNP_TIMEOUT' : 'UPNP_HTTP_ERROR',
      status: 502,
      cause: error,
    });
  }
  try {
    if (Number(response?.status || 0) >= 300 && Number(response?.status || 0) < 400) {
      throw new UpnpError('UPnP redirects are not followed', { code: 'UPNP_UNSAFE_REDIRECT', status: 502 });
    }
    if (!response?.ok) {
      throw new UpnpError(`UPnP HTTP request returned ${response?.status || 0}`, {
        code: 'UPNP_HTTP_STATUS',
        status: 502,
      });
    }
    return await readResponseText(response, Math.max(1, Number(maxBytes) || DEFAULT_MAX_XML_BYTES));
  } catch (error) {
    if (error instanceof UpnpError) throw error;
    throw new UpnpError(`UPnP response read failed: ${error?.message || String(error)}`, {
      code: error?.name === 'AbortError' ? 'UPNP_TIMEOUT' : 'UPNP_HTTP_ERROR',
      status: 502,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestBytesBounded(url, {
  fetchImpl = globalThis.fetch,
  validateUrl = validateTrustedLocalUrl,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  maxBytes = 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new UpnpError('Fetch is unavailable', { code: 'UPNP_FETCH_UNAVAILABLE' });
  const validated = await validateUrl(String(url || ''));
  const targetUrl = validated instanceof URL ? validated.toString() : String(validated || url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || DEFAULT_HTTP_TIMEOUT_MS));
  let response;
  try {
    response = await fetchImpl(targetUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Sonuvi-UPnP-ControlPoint/1.0' },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new UpnpError(`UPnP artwork request failed: ${error?.message || String(error)}`, {
      code: error?.name === 'AbortError' ? 'UPNP_TIMEOUT' : 'UPNP_HTTP_ERROR',
      status: 502,
      cause: error,
    });
  }
  try {
    if (Number(response?.status || 0) >= 300 && Number(response?.status || 0) < 400) {
      throw new UpnpError('UPnP redirects are not followed', { code: 'UPNP_UNSAFE_REDIRECT', status: 502 });
    }
    if (!response?.ok) {
      throw new UpnpError(`UPnP artwork request returned ${response?.status || 0}`, {
        code: 'UPNP_HTTP_STATUS',
        status: 502,
      });
    }
    return {
      bytes: await readResponseBytes(response, Math.max(1, Number(maxBytes) || 1024 * 1024)),
      contentType: String(response?.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase(),
    };
  } catch (error) {
    if (error instanceof UpnpError) throw error;
    throw new UpnpError(`UPnP artwork response read failed: ${error?.message || String(error)}`, {
      code: error?.name === 'AbortError' ? 'UPNP_TIMEOUT' : 'UPNP_HTTP_ERROR',
      status: 502,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

function serviceMatches(service, suffix) {
  return String(service?.serviceType || '').toLowerCase().includes(`:${String(suffix || '').toLowerCase()}:`);
}

function highestVersionService(device, suffix) {
  return (device?.services || [])
    .filter((service) => serviceMatches(service, suffix))
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null;
}

function actionByName(description, name) {
  return (description?.actions || []).find((action) => String(action.name).toLowerCase() === String(name).toLowerCase()) || null;
}

function splitCapabilities(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function sanitizeUri(raw) {
  try {
    const url = new URL(String(raw || ''));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function sameUpnpResourceUri(left, right) {
  const a = uriFingerprint(left);
  const b = uriFingerprint(right);
  return Boolean(a && b && a === b);
}

function publicService(service, description = null) {
  return {
    serviceType: service.serviceType,
    serviceId: service.serviceId,
    version: service.version,
    scpdUrl: service.scpdUrl,
    controlUrl: service.controlUrl,
    eventSubUrl: service.eventSubUrl,
    actions: description?.actionNames || undefined,
  };
}

export function publicDevice(device) {
  return {
    id: device.id,
    udn: device.udn,
    parentUdn: device.parentUdn || '',
    deviceType: device.deviceType,
    version: device.version,
    roles: [...(device.roles || [])],
    friendlyName: device.friendlyName,
    manufacturer: device.manufacturer,
    modelDescription: device.modelDescription,
    modelName: device.modelName,
    modelNumber: device.modelNumber,
    location: device.location,
    services: (device.services || []).map((service) => publicService(service)),
    discoveredAt: device.discoveredAt || null,
  };
}

export class UpnpControlPoint {
  constructor({
    fetchImpl = globalThis.fetch,
    capabilities = runtimeCapabilities(),
    socketFactory,
    interfaces = undefined,
    validateUrl = validateTrustedLocalUrl,
    lookup = dns.lookup,
    discoveryTimeoutMs = Number(process.env.UPNP_DISCOVERY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    httpTimeoutMs = Number(process.env.UPNP_HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS),
    maxXmlBytes = Number(process.env.UPNP_MAX_XML_BYTES || DEFAULT_MAX_XML_BYTES),
    maxSoapBytes = Number(process.env.UPNP_MAX_SOAP_BYTES || DEFAULT_MAX_SOAP_BYTES),
    discoveryCooldownMs = Number(process.env.UPNP_DISCOVERY_COOLDOWN_MS || DEFAULT_DISCOVERY_COOLDOWN_MS),
  } = {}) {
    this.capabilities = capabilities;
    this.fetchImpl = (...args) => {
      this.capabilities.assertExternalRead('upnp.read');
      return fetchImpl(...args);
    };
    this.socketFactory = socketFactory;
    this.interfaces = interfaces;
    this.lookup = lookup;
    this.validateUrl = (url) => validateUrl(url, { lookup });
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.httpTimeoutMs = httpTimeoutMs;
    this.maxXmlBytes = maxXmlBytes;
    this.maxSoapBytes = maxSoapBytes;
    this.discoveryCooldownMs = discoveryCooldownMs;
    this.devices = new Map();
    this.scpdCache = new Map();
    this.mediaItemRegistry = new Map();
    this.mediaItemTtlMs = DEFAULT_MEDIA_ITEM_TTL_MS;
    this.lastDiscoveryAt = 0;
    this.lastDiscoveryResult = null;
  }

  listDevices({ role = '' } = {}) {
    const wanted = String(role || '').trim().toLowerCase();
    return [...this.devices.values()]
      .filter((device) => !wanted || device.roles.includes(wanted))
      .map(publicDevice);
  }

  getDevice(deviceId) {
    const key = String(deviceId || '').trim();
    const device = this.devices.get(key);
    if (!device) {
      throw new UpnpError('UPnP device is not registered', { code: 'UPNP_NOT_FOUND', status: 404 });
    }
    return device;
  }

  _purgeMediaItems(now = Date.now()) {
    for (const [selectionRef, entry] of this.mediaItemRegistry.entries()) {
      if (!entry || entry.expiresAt <= now) this.mediaItemRegistry.delete(selectionRef);
    }
  }

  _rememberMediaItems(deviceId, items, { objectId = '', source = 'browse' } = {}) {
    const device = this.getDevice(deviceId);
    const now = Date.now();
    this._purgeMediaItems(now);
    return (Array.isArray(items) ? items : []).map((item) => {
      if (!item || item.kind !== 'item') return { ...item, selectionRef: '' };
      const selectionRef = randomBytes(18).toString('base64url');
      this.mediaItemRegistry.set(selectionRef, {
        selectionRef,
        deviceId: device.id,
        deviceUdn: device.udn,
        deviceLocation: device.location,
        objectId: String(objectId || ''),
        source: String(source || 'browse'),
        item: JSON.parse(JSON.stringify(item)),
        storedAt: now,
        expiresAt: now + this.mediaItemTtlMs,
      });
      return { ...item, selectionRef };
    });
  }

  /** Resolve an item only if it was returned by a recent trusted Browse/Search. */
  getTrustedMediaItem(selectionRef) {
    const key = String(selectionRef || '').trim();
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(key)) {
      throw new UpnpError('A trusted UPnP media-item reference is required', {
        code: 'UPNP_INVALID_MEDIA_ITEM',
        status: 400,
      });
    }
    this._purgeMediaItems();
    const entry = this.mediaItemRegistry.get(key);
    if (!entry) {
      throw new UpnpError('UPnP media item is stale or was not discovered by Sonuvi', {
        code: 'UPNP_STALE_MEDIA_ITEM',
        status: 409,
      });
    }
    const device = this.devices.get(entry.deviceId);
    if (!device || device.udn !== entry.deviceUdn || device.location !== entry.deviceLocation) {
      this.mediaItemRegistry.delete(key);
      throw new UpnpError('UPnP media item belongs to a stale device description', {
        code: 'UPNP_STALE_MEDIA_ITEM',
        status: 409,
      });
    }
    return {
      ...JSON.parse(JSON.stringify(entry.item)),
      selectionRef: entry.selectionRef,
      mediaServerId: entry.deviceId,
      mediaServerUdn: entry.deviceUdn,
      mediaServerLocation: entry.deviceLocation,
      browseObjectId: entry.objectId,
      discoveredFrom: entry.source,
      discoveredAt: new Date(entry.storedAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  /**
   * Return artwork for a trusted Browse/Search item without exposing the
   * media-server URL to browser clients. The item reference is revalidated
   * against the current device description before the bounded image fetch.
   */
  async fetchTrustedArtwork(selectionRef) {
    const item = this.getTrustedMediaItem(selectionRef);
    if (!item.artworkUrl) {
      throw new UpnpError('UPnP item has no artwork', { code: 'UPNP_ARTWORK_NOT_FOUND', status: 404 });
    }
    const mediaServer = this.getDevice(item.mediaServerId);
    let mediaServerUrl;
    let artworkUrl;
    try {
      mediaServerUrl = new URL(String(mediaServer.location || ''));
      artworkUrl = await this.validateUrl(item.artworkUrl);
      if (!await this._sameTrustedHost(mediaServerUrl.hostname, artworkUrl.hostname)) {
        throw new Error('artwork host differs from media server host');
      }
    } catch {
      throw new UpnpError('UPnP artwork is not a trusted local resource', {
        code: 'UPNP_UNSAFE_URL',
        status: 403,
      });
    }
    const result = await requestBytesBounded(artworkUrl.toString(), {
      fetchImpl: this.fetchImpl,
      validateUrl: this.validateUrl,
      timeoutMs: this.httpTimeoutMs,
      maxBytes: 2 * 1024 * 1024,
    });
    if (!/^image\/(?:jpeg|png|gif|webp|avif|bmp)$/.test(result.contentType)) {
      throw new UpnpError('UPnP artwork did not return a supported image type', {
        code: 'UPNP_ARTWORK_INVALID',
        status: 502,
      });
    }
    return result;
  }

  async discover({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.lastDiscoveryResult && now - this.lastDiscoveryAt < this.discoveryCooldownMs) {
      return this.lastDiscoveryResult;
    }
    this.capabilities.assertExternalRead('upnp.discovery');
    const responses = await discoverSsdp({
      interfaces: this.interfaces || getLocalDiscoveryInterfaces(),
      socketFactory: this.socketFactory,
      timeoutMs: this.discoveryTimeoutMs,
    });
    const failures = [];
    const seenDescriptions = new Set();
    for (const response of responses) {
      const location = String(response.location || '').trim();
      if (!location || seenDescriptions.has(location)) continue;
      seenDescriptions.add(location);
      try {
        const xml = await requestTextBounded(location, {
          fetchImpl: this.fetchImpl,
          validateUrl: this.validateUrl,
          timeoutMs: this.httpTimeoutMs,
          maxBytes: this.maxXmlBytes,
        });
        const parsed = parseDeviceDescription(xml, { location });
        for (const device of parsed.devices) {
          device.location = location;
          device.discoveredAt = new Date().toISOString();
          device.ssdp = {
            usn: response.usn,
            st: response.st,
            server: response.server,
            remoteAddress: response.remoteAddress,
          };
          this.devices.set(device.id, device);
        }
      } catch (error) {
        failures.push({
          location,
          code: error?.code || 'UPNP_DISCOVERY_ERROR',
          error: error?.message || String(error),
        });
      }
    }
    this.lastDiscoveryAt = Date.now();
    this.lastDiscoveryResult = {
      ok: true,
      responseCount: responses.length,
      devices: this.listDevices(),
      failures,
      discoveredAt: new Date(this.lastDiscoveryAt).toISOString(),
    };
    return this.lastDiscoveryResult;
  }

  async _serviceDescription(service) {
    if (!service?.scpdUrl) {
      throw new UpnpError('UPnP service has no SCPD URL', { code: 'UPNP_INVALID_SERVICE', status: 502 });
    }
    const key = service.scpdUrl;
    const cached = this.scpdCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.description;
    const xml = await requestTextBounded(service.scpdUrl, {
      fetchImpl: this.fetchImpl,
      validateUrl: this.validateUrl,
      timeoutMs: this.httpTimeoutMs,
      maxBytes: this.maxXmlBytes,
    });
    const description = parseServiceDescription(xml);
    this.scpdCache.set(key, { description, expiresAt: Date.now() + 5 * 60 * 1000 });
    return description;
  }

  async _soap(service, action, args = {}) {
    if (!service?.controlUrl || !service?.serviceType) {
      throw new UpnpError('UPnP service cannot accept SOAP requests', { code: 'UPNP_INVALID_SERVICE', status: 502 });
    }
    const body = buildSoapEnvelope(service.serviceType, action, args);
    const responseXml = await requestTextBounded(service.controlUrl, {
      fetchImpl: this.fetchImpl,
      validateUrl: this.validateUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${service.serviceType}#${action}"`,
      },
      body,
      timeoutMs: this.httpTimeoutMs,
      maxBytes: this.maxSoapBytes,
    });
    return parseSoapResponse(responseXml, action);
  }

  async mediaServerCapabilities(deviceId) {
    const device = this.getDevice(deviceId);
    if (!device.roles.includes('media-server')) {
      throw new UpnpError('Device is not a UPnP media server', { code: 'UPNP_WRONG_DEVICE_ROLE', status: 400 });
    }
    const service = highestVersionService(device, 'ContentDirectory');
    if (!service) throw new UpnpError('Media server has no ContentDirectory service', { code: 'UPNP_UNSUPPORTED', status: 409 });
    const description = await this._serviceDescription(service);
    const result = {
      device: publicDevice(device),
      service: publicService(service, description),
      browse: Boolean(actionByName(description, 'Browse')),
      search: Boolean(actionByName(description, 'Search')),
      actions: description.actionNames,
      searchCapabilities: [],
      sortCapabilities: [],
    };
    for (const [action, outputKey] of [['GetSearchCapabilities', 'searchCapabilities'], ['GetSortCapabilities', 'sortCapabilities']]) {
      if (!actionByName(description, action)) continue;
      try {
        const output = await this._soap(service, action);
        result[outputKey] = splitCapabilities(output[action === 'GetSearchCapabilities' ? 'SearchCaps' : 'SortCaps']);
      } catch (error) {
        result[`${outputKey}Error`] = error?.code || 'UPNP_PROBE_FAILED';
      }
    }
    return result;
  }

  async browse(deviceId, {
    objectId = '0',
    browseFlag = 'BrowseDirectChildren',
    filter = '*',
    startingIndex = 0,
    requestedCount = 100,
    sortCriteria = '',
  } = {}) {
    const device = this.getDevice(deviceId);
    if (!device.roles.includes('media-server')) {
      throw new UpnpError('Device is not a UPnP media server', { code: 'UPNP_WRONG_DEVICE_ROLE', status: 400 });
    }
    const service = highestVersionService(device, 'ContentDirectory');
    if (!service) throw new UpnpError('Media server has no ContentDirectory service', { code: 'UPNP_UNSUPPORTED', status: 409 });
    const description = await this._serviceDescription(service);
    if (!actionByName(description, 'Browse')) {
      throw new UpnpError('Media server does not advertise ContentDirectory Browse', { code: 'UPNP_UNSUPPORTED', status: 409 });
    }
    const safeObjectId = String(objectId ?? '').trim();
    if (!safeObjectId || safeObjectId.length > 512 || /[\u0000-\u001f]/.test(safeObjectId)) {
      throw new UpnpError('Invalid UPnP object ID', { code: 'UPNP_BAD_REQUEST', status: 400 });
    }
    const flag = String(browseFlag || 'BrowseDirectChildren').trim();
    if (!['BrowseMetadata', 'BrowseDirectChildren'].includes(flag)) {
      throw new UpnpError('Invalid UPnP BrowseFlag', { code: 'UPNP_BAD_REQUEST', status: 400 });
    }
    const start = Math.max(0, Math.min(10_000_000, parseInteger(startingIndex, 0)));
    const count = Math.max(0, Math.min(500, parseInteger(requestedCount, 100)));
    const output = await this._soap(service, 'Browse', {
      ObjectID: safeObjectId,
      BrowseFlag: flag,
      Filter: String(filter || '*').slice(0, 2048),
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: String(sortCriteria || '').slice(0, 512),
    });
    const items = this._rememberMediaItems(
      deviceId,
      output.Result ? parseDidlLite(output.Result) : [],
      { objectId: safeObjectId, source: 'browse' },
    );
    return {
      device: publicDevice(device),
      objectId: safeObjectId,
      browseFlag: flag,
      startingIndex: start,
      requestedCount: count,
      numberReturned: parseInteger(output.NumberReturned, items.length) ?? items.length,
      totalMatches: parseInteger(output.TotalMatches, items.length) ?? items.length,
      updateId: output.UpdateID || '',
      items,
    };
  }

  async search(deviceId, {
    containerId = '0',
    searchCriteria = '',
    filter = '*',
    startingIndex = 0,
    requestedCount = 100,
    sortCriteria = '',
  } = {}) {
    const device = this.getDevice(deviceId);
    if (!device.roles.includes('media-server')) {
      throw new UpnpError('Device is not a UPnP media server', { code: 'UPNP_WRONG_DEVICE_ROLE', status: 400 });
    }
    const service = highestVersionService(device, 'ContentDirectory');
    if (!service) throw new UpnpError('Media server has no ContentDirectory service', { code: 'UPNP_UNSUPPORTED', status: 409 });
    const description = await this._serviceDescription(service);
    if (!actionByName(description, 'Search')) {
      throw new UpnpError('Media server does not advertise ContentDirectory Search', { code: 'UPNP_UNSUPPORTED', status: 409 });
    }
    const criteria = String(searchCriteria || '').trim();
    if (!criteria || criteria.length > 2048 || /[\u0000-\u001f]/.test(criteria)) {
      throw new UpnpError('A bounded UPnP search criteria value is required', { code: 'UPNP_BAD_REQUEST', status: 400 });
    }
    const start = Math.max(0, Math.min(10_000_000, parseInteger(startingIndex, 0)));
    const count = Math.max(0, Math.min(500, parseInteger(requestedCount, 100)));
    const output = await this._soap(service, 'Search', {
      ContainerID: String(containerId || '0').slice(0, 512),
      SearchCriteria: criteria,
      Filter: String(filter || '*').slice(0, 2048),
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: String(sortCriteria || '').slice(0, 512),
    });
    const items = this._rememberMediaItems(
      deviceId,
      output.Result ? parseDidlLite(output.Result) : [],
      { objectId: String(containerId || '0'), source: 'search' },
    );
    return {
      device: publicDevice(device),
      containerId: String(containerId || '0'),
      searchCriteria: criteria,
      startingIndex: start,
      requestedCount: count,
      numberReturned: parseInteger(output.NumberReturned, items.length) ?? items.length,
      totalMatches: parseInteger(output.TotalMatches, items.length) ?? items.length,
      updateId: output.UpdateID || '',
      items,
    };
  }

  async _hostAddresses(hostname) {
    const host = normalizeHostname(hostname);
    if (!host) return [];
    if (net.isIP(host)) return [host];
    try {
      const records = await this.lookup(host, { all: true, verbatim: true });
      return [...new Set((Array.isArray(records) ? records : [])
        .map((record) => String(record?.address || '').trim())
        .filter((address) => isTrustedPrivateAddress(address)))];
    } catch {
      return [];
    }
  }

  async _sameTrustedHost(left, right) {
    const a = normalizeHostname(left);
    const b = normalizeHostname(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const [leftAddresses, rightAddresses] = await Promise.all([
      this._hostAddresses(a),
      this._hostAddresses(b),
    ]);
    const rightSet = new Set(rightAddresses);
    return leftAddresses.some((address) => rightSet.has(address));
  }

  async rendererPlaybackCapabilities(deviceId, {
    expectedHost = process.env.UPNP_MOODE_RENDERER_HOST || '10.0.0.254',
  } = {}) {
    const device = this.getDevice(deviceId);
    if (!device.roles.includes('media-renderer')) {
      throw new UpnpError('Device is not a UPnP media renderer', {
        code: 'UPNP_WRONG_DEVICE_ROLE',
        status: 400,
      });
    }

    let location;
    try {
      location = new URL(String(device.location || ''));
    } catch {
      throw new UpnpError('Renderer has no valid discovery location', {
        code: 'UPNP_UNTRUSTED_RENDERER',
        status: 409,
      });
    }
    const expectedHosts = String(expectedHost || '')
      .split(',')
      .map(normalizeHostname)
      .filter(Boolean);
    if (expectedHosts.length && !expectedHosts.includes(normalizeHostname(location.hostname))) {
      throw new UpnpError('Renderer is not the approved moOde UPnP renderer host', {
        code: 'UPNP_UNTRUSTED_RENDERER',
        status: 403,
      });
    }

    const avTransport = highestVersionService(device, 'AVTransport');
    const connectionManager = highestVersionService(device, 'ConnectionManager');
    if (!avTransport || !connectionManager) {
      throw new UpnpError('Renderer lacks the required AVTransport or ConnectionManager service', {
        code: 'UPNP_UNSUPPORTED',
        status: 409,
      });
    }
    const [avDescription, connectionDescription, inspection] = await Promise.all([
      this._serviceDescription(avTransport),
      this._serviceDescription(connectionManager),
      this.inspectRenderer(deviceId, { probeState: true }),
    ]);
    const required = ['SetAVTransportURI', 'Play'];
    const missing = required.filter((name) => !actionByName(avDescription, name));
    if (missing.length) {
      throw new UpnpError('Renderer does not advertise the required single-track actions', {
        code: 'UPNP_UNSUPPORTED',
        status: 409,
      });
    }
    if (!actionByName(connectionDescription, 'GetProtocolInfo') || !inspection.protocolInfo.available) {
      throw new UpnpError('Renderer protocol capabilities are unavailable', {
        code: 'UPNP_UNSUPPORTED',
        status: 409,
      });
    }
    return {
      device: publicDevice(device),
      inspection,
      avTransportActions: [...avDescription.actionNames],
      connectionManagerActions: [...connectionDescription.actionNames],
    };
  }

  async prepareMediaItemForPlayback(mediaItem, rendererId, {
    expectedRendererHost = process.env.UPNP_MOODE_RENDERER_HOST || '10.0.0.254',
  } = {}) {
    const item = mediaItem && typeof mediaItem === 'object' ? mediaItem : null;
    if (!item || item.kind !== 'item' || !item.id || !item.mediaServerId) {
      throw new UpnpError('A trusted UPnP audio item is required', {
        code: 'UPNP_INVALID_MEDIA_ITEM',
        status: 400,
      });
    }
    const mediaServer = this.getDevice(item.mediaServerId);
    if (!mediaServer.roles.includes('media-server')) {
      throw new UpnpError('Selected UPnP item is not from a registered media server', {
        code: 'UPNP_INVALID_MEDIA_ITEM',
        status: 409,
      });
    }
    const renderer = await this.rendererPlaybackCapabilities(rendererId, {
      expectedHost: expectedRendererHost,
    });
    let mediaServerUrl;
    try {
      mediaServerUrl = new URL(String(mediaServer.location || ''));
    } catch {
      throw new UpnpError('Selected media server has no valid discovery location', {
        code: 'UPNP_STALE_MEDIA_ITEM',
        status: 409,
      });
    }

    let safeArtworkUrl = '';
    if (item.artworkUrl) {
      try {
        const validatedArtwork = await this.validateUrl(item.artworkUrl);
        if (await this._sameTrustedHost(mediaServerUrl.hostname, validatedArtwork.hostname)) {
          safeArtworkUrl = validatedArtwork.toString();
        }
      } catch {
        // Artwork is optional. Do not allow an untrusted artwork reference to
        // become a server-side fetch or renderer metadata dependency.
      }
    }
    const safeItem = { ...item, artworkUrl: safeArtworkUrl };

    const candidates = [];
    for (const resource of Array.isArray(item.resources) ? item.resources : []) {
      if (!resource?.uri || !resource.protocolInfo || !resource.mimeType) continue;
      if (!String(resource.mimeType).toLowerCase().startsWith('audio/')) continue;
      if (!renderer.inspection.protocolInfo.sink.some((sink) => protocolInfoMatches(resource.protocolInfo, sink))) continue;
      try {
        const validated = await this.validateUrl(resource.uri);
        if (!await this._sameTrustedHost(mediaServerUrl.hostname, validated.hostname)) continue;
        candidates.push({ ...resource, uri: validated.toString() });
      } catch {
        // An unsafe or malformed resource is never passed to AVTransport.
      }
    }
    if (!candidates.length) {
      throw new UpnpError('Selected item has no renderer-compatible trusted audio resource', {
        code: 'UPNP_UNSUPPORTED_RESOURCE',
        status: 409,
      });
    }
    const resource = candidates[0];
    return {
      item: JSON.parse(JSON.stringify(safeItem)),
      resource,
      metadata: buildDidlLiteMetadata(safeItem, resource),
      mediaServer: publicDevice(mediaServer),
      renderer,
    };
  }

  /**
   * The only public SOAP transport entry point. It is deliberately limited to
   * the single-track allowlist; callers cannot turn this into a generic SOAP
   * proxy or address another service.
   */
  async transportAction(deviceId, action, args = {}) {
    const name = String(action || '').trim();
    if (!ALLOWED_AVTRANSPORT_ACTIONS.has(name)) {
      throw new UpnpError('UPnP transport action is not allowed', {
        code: 'UPNP_ACTION_NOT_ALLOWED',
        status: 400,
      });
    }
    if (MUTATING_AVTRANSPORT_ACTIONS.has(name)) {
      this.capabilities.assertExternalMutation('upnp.renderer-control');
    }
    const device = this.getDevice(deviceId);
    if (!device.roles.includes('media-renderer')) {
      throw new UpnpError('Device is not a UPnP media renderer', {
        code: 'UPNP_WRONG_DEVICE_ROLE',
        status: 400,
      });
    }
    const service = highestVersionService(device, 'AVTransport');
    if (!service) throw new UpnpError('Renderer has no AVTransport service', { code: 'UPNP_UNSUPPORTED', status: 409 });
    const description = await this._serviceDescription(service);
    if (!actionByName(description, name)) {
      throw new UpnpError('Renderer does not advertise this transport action', {
        code: 'UPNP_UNSUPPORTED',
        status: 409,
      });
    }

    const input = args && typeof args === 'object' ? args : {};
    const keys = Object.keys(input);
    const expectedKeys = {
      SetAVTransportURI: ['InstanceID', 'CurrentURI', 'CurrentURIMetaData'],
      SetNextAVTransportURI: ['InstanceID', 'NextURI', 'NextURIMetaData'],
      Play: ['InstanceID', 'Speed'],
      Pause: ['InstanceID'],
      Stop: ['InstanceID'],
      Seek: ['InstanceID', 'Unit', 'Target'],
      Next: ['InstanceID'],
      Previous: ['InstanceID'],
      GetTransportInfo: ['InstanceID'],
      GetPositionInfo: ['InstanceID'],
      GetCurrentTransportActions: ['InstanceID'],
      GetMediaInfo: ['InstanceID'],
    }[name];
    if (!expectedKeys || keys.some((key) => !expectedKeys.includes(key))) {
      throw new UpnpError('UPnP transport arguments are invalid', {
        code: 'UPNP_BAD_REQUEST',
        status: 400,
      });
    }
    if (name === 'SetAVTransportURI') {
      if (keys.length !== 3 || !String(input.CurrentURI || '').trim() || !String(input.CurrentURIMetaData || '').trim()) {
        throw new UpnpError('SetAVTransportURI requires trusted media metadata', {
          code: 'UPNP_BAD_REQUEST',
          status: 400,
        });
      }
    } else if (name === 'SetNextAVTransportURI') {
      const nextUri = String(input.NextURI || '').trim();
      const nextMetadata = String(input.NextURIMetaData || '').trim();
      // An empty pair is the narrowly-scoped internal clear operation. A
      // non-empty next resource must carry DIDL metadata just like the
      // current-resource operation; callers never provide a raw URL through
      // an HTTP route.
      if (keys.length !== 3 || (Boolean(nextUri) !== Boolean(nextMetadata))) {
        throw new UpnpError('SetNextAVTransportURI requires a complete media resource or an empty clear pair', {
          code: 'UPNP_BAD_REQUEST',
          status: 400,
        });
      }
    } else if (name === 'Play') {
      if (keys.length !== 2 || String(input.Speed || '') !== '1') {
        throw new UpnpError('Play requires the normal speed argument', {
          code: 'UPNP_BAD_REQUEST',
          status: 400,
        });
      }
    } else if (name === 'Seek') {
      const target = String(input.Target || '').trim();
      if (keys.length !== 3
        || String(input.Unit || '').trim() !== 'REL_TIME'
        || !/^\d{1,5}:[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(target)) {
        throw new UpnpError('Seek requires a bounded REL_TIME target', {
          code: 'UPNP_BAD_REQUEST',
          status: 400,
        });
      }
    } else if (keys.length !== 1 || !Object.prototype.hasOwnProperty.call(input, 'InstanceID')) {
      throw new UpnpError('UPnP transport arguments are invalid', {
        code: 'UPNP_BAD_REQUEST',
        status: 400,
      });
    }
    if (MUTATING_AVTRANSPORT_ACTIONS.has(name) && Number(input.InstanceID) !== 0) {
      throw new UpnpError('Only AVTransport instance 0 is supported', {
        code: 'UPNP_BAD_REQUEST',
        status: 400,
      });
    }
    return this._soap(service, name, input);
  }

  async inspectRenderer(deviceId, { probeState = true } = {}) {
    const device = this.getDevice(deviceId);
    if (!device.roles.includes('media-renderer')) {
      throw new UpnpError('Device is not a UPnP media renderer', { code: 'UPNP_WRONG_DEVICE_ROLE', status: 400 });
    }
    const serviceEntries = [];
    const descriptions = new Map();
    for (const suffix of ['AVTransport', 'RenderingControl', 'ConnectionManager']) {
      const service = highestVersionService(device, suffix);
      if (!service) continue;
      try {
        const description = await this._serviceDescription(service);
        descriptions.set(service.serviceType, description);
        serviceEntries.push(publicService(service, description));
      } catch (error) {
        serviceEntries.push({ ...publicService(service), descriptionError: error?.code || 'UPNP_SCPD_FAILED' });
      }
    }

    const result = {
      device: publicDevice(device),
      services: serviceEntries,
      readOnly: true,
      playbackMutationAvailable: false,
      protocolInfo: { available: false, source: [], sink: [] },
      readOnlyState: {},
    };
    const connection = highestVersionService(device, 'ConnectionManager');
    const connectionDescription = connection ? descriptions.get(connection.serviceType) : null;
    if (connection && connectionDescription && actionByName(connectionDescription, 'GetProtocolInfo')) {
      try {
        const output = await this._soap(connection, 'GetProtocolInfo');
        result.protocolInfo = {
          available: true,
          source: splitCapabilities(output.Source),
          sink: splitCapabilities(output.Sink),
        };
      } catch (error) {
        result.protocolInfo.error = error?.code || 'UPNP_PROBE_FAILED';
      }
    }

    if (!probeState) return result;
    const avTransport = highestVersionService(device, 'AVTransport');
    const avDescription = avTransport ? descriptions.get(avTransport.serviceType) : null;
    if (!avTransport || !avDescription) return result;
    const probes = [
      ['GetTransportInfo', 'transport'],
      ['GetPositionInfo', 'position'],
      ['GetMediaInfo', 'media'],
      ['GetCurrentTransportActions', 'currentActions'],
    ];
    for (const [action, key] of probes) {
      if (!READ_ONLY_RENDERER_ACTIONS.has(action) || !actionByName(avDescription, action)) continue;
      try {
        const output = await this._soap(avTransport, action, { InstanceID: 0 });
        if (key === 'transport') {
          result.readOnlyState.transport = {
            state: output.CurrentTransportState || '',
            status: output.CurrentTransportStatus || '',
            speed: output.CurrentSpeed || '',
          };
        } else if (key === 'position') {
          result.readOnlyState.position = {
            track: parseInteger(output.Track),
            trackDuration: output.TrackDuration || '',
            relativeTime: output.RelTime || '',
            absoluteTime: output.AbsTime || '',
          };
        } else if (key === 'media') {
          result.readOnlyState.media = {
            numberOfTracks: parseInteger(output.NrTracks),
            mediaDuration: output.MediaDuration || '',
            currentUri: sanitizeUri(output.CurrentURI),
            nextUri: sanitizeUri(output.NextURI),
            currentMetadataPresent: Boolean(output.CurrentURIMetaData),
            nextMetadataPresent: Boolean(output.NextURIMetaData),
          };
        } else {
          result.readOnlyState.currentActions = splitCapabilities(output.Actions);
        }
      } catch (error) {
        result.readOnlyState[`${key}Error`] = error?.code || 'UPNP_PROBE_FAILED';
      }
    }
    return result;
  }

  async describeDevice(deviceId) {
    const device = this.getDevice(deviceId);
    const services = [];
    for (const service of device.services || []) {
      try {
        services.push(publicService(service, await this._serviceDescription(service)));
      } catch (error) {
        services.push({ ...publicService(service), descriptionError: error?.code || 'UPNP_SCPD_FAILED' });
      }
    }
    return { ...publicDevice(device), services };
  }
}

export const upnpConstants = Object.freeze({
  SSDP_ADDRESS,
  SSDP_PORT,
  DEFAULT_SEARCH_TARGETS: [...DEFAULT_SEARCH_TARGETS],
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
});
