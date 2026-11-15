import os from 'node:os';
import { spawn } from 'node:child_process';
import { localTLSHostname, LOCAL_TLS_PORT } from './sonuvi-local-tls.mjs';

export function localAdvertisementAddresses(interfaces) {
  return [...new Set(Object.entries(interfaces).filter(([name]) => !/^(lo|docker|veth|br-|tun|tap|utun)/.test(name))
    .flatMap(([,rows]) => rows || []).filter(row => !row.internal && row.family === 'IPv4')
    .map(row => row.address).filter(address => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)))].sort();
}

/** Standard Avahi tools own mDNS/DNS-SD; no custom multicast protocol. The
 * advertised address and identity are discovery hints, never enrollment proof.
 * No changes to host names, router settings, firewall or public DNS.
 */
export function startLocalAdvertisement({ serverId, interfaces = os.networkInterfaces,
  launch = (file,args) => spawn(file,args,{stdio:'ignore',shell:false}), onUnavailable = () => {}, intervalMS = 30000 } = {}) {
  const hostname = localTLSHostname(serverId);
  const origin = `https://${hostname}:${LOCAL_TLS_PORT}`;
  let processes = [], signature = '', stopped = false, failed = false;
  const retire = () => { for (const child of processes) child.kill('SIGTERM'); processes = []; };
  const update = () => {
    if (stopped) return;
    const addresses = localAdvertisementAddresses(interfaces());
    const next = addresses.join(',');
    if (next === signature && !failed) return;
    retire(); signature = next; failed = false;
    if (!addresses.length) { onUnavailable(); return; }
    const start = (file,args) => {
      const child = launch(file,args); processes.push(child);
      const unavailable = () => { if (!stopped && processes.includes(child)) { failed = true; onUnavailable(); } };
      child.once('error',unavailable); child.once('exit',unavailable);
    };
    for (const address of addresses) start('/usr/bin/avahi-publish-address',['-R',hostname,address]);
    start('/usr/bin/avahi-publish-service',['-H',hostname,`Sonuvi ${hostname.slice(7,13)}`,'_sonuvi._tcp',String(LOCAL_TLS_PORT),`url=${origin}`,`browserUrl=https://${hostname}:8444`,`serverId=${serverId}`]);
  };
  update(); const timer = setInterval(update,intervalMS); timer.unref();
  return {update,stop(){stopped=true;clearInterval(timer);retire();}};
}
