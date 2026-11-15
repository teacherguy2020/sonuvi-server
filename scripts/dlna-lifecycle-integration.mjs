#!/usr/bin/env node
// Run only in a disposable internal-network container, never on a production LAN.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import http from 'node:http';
import express from 'express';
import { createDlnaMediaServer } from '../src/lib/dlna-media-server.mjs';
import { startDlnaSsdpResponder } from '../src/lib/dlna-ssdp.mjs';
import { createDlnaRuntime } from '../src/lib/dlna-runtime.mjs';
import { installRuntimeShutdown } from '../src/lib/runtime-shutdown.mjs';
if(process.env.SONUVI_DISPOSABLE_MULTICAST_TEST!=='1')throw new Error('Use a disposable internal-network container');
const address=Object.values(os.networkInterfaces()).flat().find(v=>v.family==='IPv4'&&!v.internal)?.address;
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sonuvi-ssdp-'));
const port=19201,udnPath=path.join(temp,'identity.json');
const app=express();const media=createDlnaMediaServer({enabled:true,getBrowseIndex:async()=>({tracks:[],albums:[],artists:[]}),resolveFile:async()=>'',mountRoot:temp,identityPath:udnPath,localAddress:address,port,log:{info(){},warn(){}}});media.register(app,express);
let server,socket;
const runtime=createDlnaRuntime({enabled:true,listen:()=>new Promise((resolve,reject)=>{server=app.listen(port,address,()=>resolve(server));server.once('error',reject);}),initialize:()=>media.initialize(),startSsdp:async udn=>socket=await startDlnaSsdpResponder({udn,baseUrl:media.baseUrl,localAddress:address}),log:console});
const memberships=async()=> (await fs.readFile('/proc/net/igmp','utf8')).toUpperCase().includes('FAFFFFEF');
const udpClose=s=>new Promise(resolve=>s.close(resolve));
async function discover(){
 const client=dgram.createSocket('udp4');await new Promise(resolve=>client.bind(0,address,resolve));client.setMulticastInterface(address);client.setMulticastLoopback(true);
 try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('multicast response timed out')),3000);client.on('message',message=>{if(message.toString().startsWith('HTTP/1.1 200')){clearTimeout(timer);resolve(message.toString());}});client.send('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: upnp:rootdevice\r\n\r\n',1900,'239.255.255.250');});}finally{await udpClose(client);}
}
const results=[];
try{
 assert.equal(await memberships(),false,'isolated container starts without SSDP membership');
 for(let cycle=0;cycle<3;cycle++){
   assert.equal(await runtime.start(),true);assert.equal(runtime.status().status,'running');assert.equal(await memberships(),true);
   const descriptor=await fetch(media.baseUrl+'/dlna/device.xml');assert.equal(descriptor.status,200);assert.match(await descriptor.text(),/MediaServer/);
   assert.match(await discover(),new RegExp(`LOCATION: http://${address.replaceAll('.','\\.')}:${port}/dlna/device.xml`));
   let finish;const finished=new Promise(resolve=>{finish=resolve;});
   const shutdown=installRuntimeShutdown({cleanup:()=>runtime.stop(),exit:code=>finish(code)});
   process.kill(process.pid,cycle%2?'SIGINT':'SIGTERM');
   const timeout=setTimeout(()=>finish('signal-timeout'),5000);
   const exitCode=await finished;clearTimeout(timeout);shutdown.dispose();assert.equal(exitCode,0);
   assert.equal(runtime.status().status,'disabled');assert.equal(server.listening,false);assert.throws(()=>socket.address(),/not running|closed|Not running/i);assert.equal(await memberships(),false);
   // Exclusive rebinding proves the closed sockets no longer own TCP or UDP ports.
   const tcp=http.createServer();await new Promise((resolve,reject)=>{tcp.once('error',reject);tcp.listen(port,address,resolve);});await new Promise(resolve=>tcp.close(resolve));
   const udp=dgram.createSocket('udp4');await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(1900,resolve);});await udpClose(udp);
   results.push({cycle:cycle+1,discovery:'real multicast reply',shutdown:cycle%2?'SIGINT':'SIGTERM',tcpReleased:true,udpReleased:true,membershipReleased:true});
 }
 console.log(JSON.stringify({result:'PASS',scope:'internal-network Linux container, actual HTTP/UDP/multicast resources',results},null,2));
}finally{await runtime.stop();await fs.rm(temp,{recursive:true,force:true});}
