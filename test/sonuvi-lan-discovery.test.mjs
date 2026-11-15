import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { localAdvertisementAddresses, startLocalAdvertisement } from '../src/lib/sonuvi-lan-discovery.mjs';
const row=address=>({address,family:'IPv4',internal:false});
test('Avahi advertisement follows LAN address changes and never publishes secrets or VPN/container addresses', t => {
  let interfaces={eth0:[row('192.168.50.10')],tun0:[row('10.5.6.7')],docker0:[row('172.17.0.1')],lo:[{...row('127.0.0.1'),internal:true}]};
  assert.deepEqual(localAdvertisementAddresses(interfaces),['192.168.50.10']);
  const calls=[],children=[];
  const runtime=startLocalAdvertisement({serverId:'sonuvi-'+'a'.repeat(43),interfaces:()=>interfaces,launch:(file,args)=>{calls.push([file,args]);const child=new EventEmitter();child.killed=false;child.kill=()=>{child.killed=true;};children.push(child);return child;}});
  t.after(()=>runtime.stop());
  assert.equal(calls.length,2);assert.equal(calls[0][0],'/usr/bin/avahi-publish-address');
  assert.equal(calls[1][0],'/usr/bin/avahi-publish-service');assert.ok(calls[1][1].includes('_sonuvi._tcp'));
  assert.doesNotMatch(JSON.stringify(calls),/password|token|PRIVATE KEY|192\.168\.50\.10.*192\.168\.50\.10/);
  runtime.update();assert.equal(calls.length,2);
  interfaces={eth0:[row('192.168.50.11')]};runtime.update();assert.equal(calls.length,4);assert.equal(children[0].killed,true);
  children[2].emit('exit',1);runtime.update();assert.equal(calls.length,6);
  runtime.stop();assert.equal(children.at(-1).killed,true);
});
