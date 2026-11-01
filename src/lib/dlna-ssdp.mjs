import dgram from 'node:dgram';

import {
  CONNECTION_MANAGER_TYPE,
  CONTENT_DIRECTORY_TYPE,
  DLNA_DEVICE_TYPE,
} from './dlna-media-server.mjs';

const SSDP_GROUP = '239.255.255.250';
const SSDP_PORT = 1900;

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

function alive({ udn, baseUrl }) {
  return [
    'NOTIFY * HTTP/1.1',
    `HOST: ${SSDP_GROUP}:${SSDP_PORT}`,
    'CACHE-CONTROL: max-age=1800',
    `LOCATION: ${baseUrl}/dlna/device.xml`,
    'NT: upnp:rootdevice',
    'NTS: ssdp:alive',
    `USN: ${udn}::upnp:rootdevice`,
    '',
    '',
  ].join('\r\n');
}

/**
 * Join the multicast group explicitly. Some Linux UDP stacks accept a bind to
 * :1900 but do not deliver SSDP multicast to it until it joins the group.
 */
export async function startDlnaSsdpResponder({ udn, baseUrl, localAddress, log = console } = {}) {
  if (!String(udn || '').startsWith('uuid:') || !/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(String(baseUrl || '')) || !localAddress) {
    throw new Error('DLNA SSDP requires a UDN, private LAN media URL, and LAN interface');
  }
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (error) => log.warn?.('[dlna] SSDP socket error', error?.message || error));
  socket.on('message', (message, remote) => {
    const request = message.toString('utf8');
    if (!/^M-SEARCH \*/i.test(request) || !/MAN:\s*"ssdp:discover"/i.test(request)) return;
    const target = (request.match(/ST:\s*([^\r\n]+)/i) || [])[1]?.trim() || '';
    if (!['ssdp:all', 'upnp:rootdevice', DLNA_DEVICE_TYPE, CONTENT_DIRECTORY_TYPE, CONNECTION_MANAGER_TYPE].includes(target)) return;
    socket.send(response({ target, udn, baseUrl }), remote.port, remote.address);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(SSDP_PORT, () => { socket.off('error', reject); resolve(); });
  });
  socket.addMembership(SSDP_GROUP, localAddress);
  socket.setMulticastInterface(localAddress);
  socket.setMulticastTTL(2);
  socket.send(alive({ udn, baseUrl }), SSDP_PORT, SSDP_GROUP);
  return socket;
}
