#!/usr/bin/env node
// H4C.4A containment probe. It starts only generic Node mocks from an already
// local image; it never reads, mounts, or launches a Sonuvi artifact.
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { H4C4A_RUNTIME_IMAGE } from './lib/h4c4a-rehearsal.mjs';

const execFile = promisify(execFileCallback);
const image = H4C4A_RUNTIME_IMAGE;

function value(name) {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function absolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

async function docker(args) {
  const result = await execFile('docker', args, { maxBuffer: 1024 * 1024 });
  return String(result.stdout || '').trim();
}

function commonRunArgs() {
  return [
    'run', '--rm', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--pids-limit', '32', '--memory', '64m', '--memory-swap', '64m', '--cpus', '0.25', '--user', 'node',
  ];
}

const scratchParent = absolute(required('--scratch-parent'), 'scratch parent');
const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
const network = `sonuvi-h4c4a-probe-${suffix}`;
const server = `${network}-server`;
let scratch = '';

async function cleanup() {
  await docker(['rm', '--force', server]).catch(() => {});
  await docker(['network', 'rm', network]).catch(() => {});
  if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}

try {
  const parentStat = await fs.lstat(scratchParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('scratch parent must be a real directory');
  await docker(['image', 'inspect', image]);
  scratch = await fs.mkdtemp(path.join(scratchParent, 'sonuvi-h4c4a-probe-'));
  const releaseFixture = path.join(scratch, 'synthetic-release');
  const stateFixture = path.join(scratch, 'synthetic-state');
  await fs.mkdir(releaseFixture, { mode: 0o755 });
  await fs.mkdir(stateFixture, { mode: 0o777 });
  await fs.writeFile(path.join(releaseFixture, 'sentinel.txt'), 'synthetic-release-only\n', { mode: 0o444 });

  await docker(['network', 'create', '--internal', '--driver', 'bridge', network]);
  const networkInspect = JSON.parse(await docker(['network', 'inspect', network]))[0];
  if (networkInspect.Internal !== true || networkInspect.Driver !== 'bridge') {
    throw new Error('internal Docker bridge was not created as requested');
  }

  const serverProgram = "const http=require('node:http');http.createServer((req,res)=>res.end('synthetic-peer')).listen(39101,'0.0.0.0');";
  await docker([
    ...commonRunArgs(), '-d', '--name', server, '--network', network, '--network-alias', 'synthetic-api',
    image, 'node', '-e', serverProgram,
  ]);
  const serverInspect = JSON.parse(await docker(['inspect', server]))[0];
  const container = {
    networkMode: serverInspect.HostConfig.NetworkMode,
    readOnlyRootfs: serverInspect.HostConfig.ReadonlyRootfs,
    privileged: serverInspect.HostConfig.Privileged,
    pidMode: serverInspect.HostConfig.PidMode,
    ipcMode: serverInspect.HostConfig.IpcMode,
    bindMountCount: (serverInspect.HostConfig.Binds || []).length,
    dockerSocketMounted: (serverInspect.Mounts || []).some((mount) => mount.Destination === '/var/run/docker.sock'),
  };
  const privatePid = container.pidMode === '' || container.pidMode === 'private';
  const privateIpc = container.ipcMode === '' || container.ipcMode === 'private';
  if (container.networkMode !== network || !container.readOnlyRootfs || container.privileged || !privatePid || !privateIpc || container.bindMountCount || container.dockerSocketMounted) {
    throw new Error('generic mock did not meet the requested containment profile');
  }

  const clientProgram = [
    "const fs=require('node:fs');const http=require('node:http');const os=require('node:os');const dns=require('node:dns').promises;",
    "const route=fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').slice(1);",
    "const defaultRoute=route.some((line)=>line.trim().split(/\\s+/)[1]==='00000000');",
    "const peer=new Promise((resolve,reject)=>http.get({host:'synthetic-api',port:39101,path:'/'},(res)=>{let body='';res.on('data',(c)=>body+=c);res.on('end',()=>resolve(body));}).on('error',reject));",
    "const externalDns=Promise.race([dns.lookup('example.invalid').then(()=>true).catch(()=>false),new Promise((resolve)=>setTimeout(()=>resolve(false),2000))]);",
    "Promise.all([peer,externalDns]).then(([body,externalDnsResolved])=>process.stdout.write(JSON.stringify({peer:body,defaultRoute,externalDnsResolved,dockerSocket:fs.existsSync('/var/run/docker.sock'),interfaces:Object.keys(os.networkInterfaces()).sort()}))).catch((error)=>{console.error(error);process.exit(1);});",
  ].join('');
  const client = JSON.parse(await docker([...commonRunArgs(), '--network', network, image, 'node', '-e', clientProgram]));
  if (client.peer !== 'synthetic-peer' || client.defaultRoute || client.externalDnsResolved || client.dockerSocket || !client.interfaces.includes('eth0')) {
    throw new Error('internal bridge did not prove peer-only routing');
  }

  const noneProgram = [
    "const fs=require('node:fs');const os=require('node:os');",
    "const route=fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').slice(1);",
    "const defaultRoute=route.some((line)=>line.trim().split(/\\s+/)[1]==='00000000');",
    "process.stdout.write(JSON.stringify({defaultRoute,dockerSocket:fs.existsSync('/var/run/docker.sock'),interfaces:Object.keys(os.networkInterfaces()).sort()}));",
  ].join('');
  const none = JSON.parse(await docker([...commonRunArgs(), '--network', 'none', image, 'node', '-e', noneProgram]));
  if (none.defaultRoute || none.dockerSocket || none.interfaces.some((name) => name !== 'lo')) {
    throw new Error('network=none mock exposed a route or non-loopback interface');
  }

  const mountProgram = [
    "const fs=require('node:fs');",
    "const sentinel=fs.readFileSync('/opt/sonuvi/release/sentinel.txt','utf8').trim();",
    "fs.writeFile('/opt/sonuvi/release/must-not-write.txt','nope',(releaseError)=>{",
    "fs.writeFile('/var/lib/sonuvi-rehearsal/state-write.txt','ok',(stateError)=>{",
    "process.stdout.write(JSON.stringify({sentinel,releaseWriteDenied:Boolean(releaseError),stateWritable:!stateError,dockerSocket:fs.existsSync('/var/run/docker.sock')}));",
    "});});",
  ].join('');
  const mounts = JSON.parse(await docker([
    ...commonRunArgs(), '--network', 'none',
    '--mount', `type=bind,src=${releaseFixture},dst=/opt/sonuvi/release,readonly`,
    '--mount', `type=bind,src=${stateFixture},dst=/var/lib/sonuvi-rehearsal`,
    image, 'node', '-e', mountProgram,
  ]));
  if (mounts.sentinel !== 'synthetic-release-only' || !mounts.releaseWriteDenied || !mounts.stateWritable || mounts.dockerSocket) {
    throw new Error('read-only release or disposable-state mount behavior is unsafe');
  }

  const runtime = JSON.parse(await docker([
    ...commonRunArgs(), '--network', 'none', image, 'node', '-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})',
  ]));
  if (runtime.version !== 'v20.20.1' || runtime.platform !== 'linux' || runtime.arch !== 'arm64') {
    throw new Error('cached rehearsal runtime is not the required Linux ARM64 Node 20.20.1 image');
  }

  process.stdout.write(`${JSON.stringify({
    validated: true,
    image,
    runtime,
    internalNetwork: { driver: networkInspect.Driver, internal: networkInspect.Internal, peerOnly: true, externalDnsResolutionDenied: true },
    noNetwork: { loopbackOnly: true },
    mounts: { releaseReadOnly: true, disposableStateWritable: true },
    container,
  }, null, 2)}\n`);
} finally {
  await cleanup();
}
