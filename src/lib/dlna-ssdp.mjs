import dgram from 'node:dgram';

import {
  CONNECTION_MANAGER_TYPE,
  CONTENT_DIRECTORY_TYPE,
  DLNA_DEVICE_TYPE,
  isPrivateLanAddress,
} from './dlna-media-server.mjs';

const SSDP_GROUP = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_MAX_AGE_SECONDS = 1800;
const SSDP_ALIVE_INTERVAL_MS = 15 * 60 * 1000;
function validSsdpEndpoint(udn, baseUrl, localAddress) {
  try { const url = new URL(String(baseUrl || '')); return /^uuid:[0-9a-f-]{36}$/i.test(String(udn || '')) && isPrivateLanAddress(localAddress) && url.protocol === 'http:' && url.hostname === String(localAddress || '').trim() && isPrivateLanAddress(url.hostname) && /^[1-9]\d{0,4}$/.test(url.port) && Number(url.port) <= 65535; }
  catch { return false; }
}


export function parseSsdpSearchTarget(request) {
  if (!/^M-SEARCH \*/i.test(request) || !/(?:^|\r?\n)MAN:\s*"ssdp:discover"/i.test(request)) return '';
  return (request.match(/(?:^|\r?\n)ST:\s*([^\r\n]+)/i) || [])[1]?.trim() || '';
}

function response({ target, udn, baseUrl }) {
  return [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'EXT:',
    `LOCATION: ${baseUrl}/dlna/device.xml`,
    'SERVER: Sonuvi/1.0 UPnP/1.1 SonuviMediaServer/1.0',
    `ST: ${target}`,
    `USN: ${udn}::${target}`,
    '',
    '',
  ].join('\r\n');
}

export function ssdpAliveAnnouncements({ udn, baseUrl }) {
  const identities = [
    { target: 'upnp:rootdevice', usn: `${udn}::upnp:rootdevice` },
    { target: udn, usn: udn },
    { target: DLNA_DEVICE_TYPE, usn: `${udn}::${DLNA_DEVICE_TYPE}` },
    { target: CONTENT_DIRECTORY_TYPE, usn: `${udn}::${CONTENT_DIRECTORY_TYPE}` },
    { target: CONNECTION_MANAGER_TYPE, usn: `${udn}::${CONNECTION_MANAGER_TYPE}` },
  ];
  return identities.map(({ target, usn }) => [
    'NOTIFY * HTTP/1.1',
    `HOST: ${SSDP_GROUP}:${SSDP_PORT}`,
    `CACHE-CONTROL: max-age=${SSDP_MAX_AGE_SECONDS}`,
    `LOCATION: ${baseUrl}/dlna/device.xml`,
    `NT: ${target}`,
    'NTS: ssdp:alive',
    `USN: ${usn}`,
    '',
    '',
  ].join('\r\n'));
}

/**
 * Join the multicast group explicitly. Some Linux UDP stacks accept a bind to
 * :1900 but do not deliver SSDP multicast to it until it joins the group.
 */
export async function startDlnaSsdpResponder({ udn, baseUrl, localAddress, log = console } = {}) {
  if (!validSsdpEndpoint(udn, baseUrl, localAddress)) {
    throw new Error('DLNA SSDP requires a UDN, private LAN media URL, and LAN interface');
  }
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (error) => log.warn?.('[dlna] SSDP socket error', error?.message || error));
  socket.on('message', (message, remote) => {
    const request = message.toString('utf8');
    const target = parseSsdpSearchTarget(request);
    if (!['ssdp:all', 'upnp:rootdevice', DLNA_DEVICE_TYPE, CONTENT_DIRECTORY_TYPE, CONNECTION_MANAGER_TYPE].includes(target)) return;
    socket.send(response({ target, udn, baseUrl }), remote.port, remote.address);
  });
  try {
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(SSDP_PORT, () => { socket.off('error', reject); resolve(); });
  });
  socket.addMembership(SSDP_GROUP, localAddress);
  socket.setMulticastInterface(localAddress);
  socket.setMulticastTTL(2);
  const announce = () => {
    for (const message of ssdpAliveAnnouncements({ udn, baseUrl })) socket.send(message, SSDP_PORT, SSDP_GROUP);
  };
  announce();
  const refresh = setInterval(announce, SSDP_ALIVE_INTERVAL_MS);
  refresh.unref();
  socket.once('close', () => clearInterval(refresh));
  return socket;
  } catch (error) {
    try { socket.close(); } catch {}
    throw error;
  }
}
