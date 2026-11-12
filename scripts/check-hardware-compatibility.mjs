#!/usr/bin/env node
// Read-only readiness check. Never imports or starts the API, prints credentials,
// writes configuration, or contacts MPD/Harmony. Linux --pid inspects the running API.
import fs from 'node:fs';
import { resolveHardwareCompatibility } from '../src/lib/hardware-compatibility.mjs';
const args = process.argv.slice(2);
try {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--pid', '--api-port'].includes(args[i]) || !/^\d+$/.test(args[i + 1] || '') || options[args[i]] !== undefined) throw new Error('Usage: check-hardware-compatibility.mjs [--pid API_PID] --api-port PORT');
    options[args[i]] = args[i + 1];
  }
  let env = process.env;
  if (options['--pid']) {
    env = Object.fromEntries(fs.readFileSync(`/proc/${options['--pid']}/environ`, 'utf8').split('\0').filter(s => s.includes('=')).map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
  }
  const config = resolveHardwareCompatibility({ env, apiHost: env.SONUVI_API_LISTEN_HOST, apiPort: Number(options['--api-port'] || env.PORT), trackKey: String(env.TRACK_KEY || '').trim() });
  console.log(JSON.stringify({ valid: true, enabled: config.enabled, trackKeyConfigured: Boolean(String(env.TRACK_KEY || '').trim()), ...(config.enabled ? { address: config.host, port: config.port, clients: config.clients, upstream: `127.0.0.1:${config.apiPort}` } : {}), note: 'Configuration validation only; does not prove listener reachability or physical playback.' }, null, 2));
} catch (error) {
  // Do not relay filesystem error text or input JSON, which could contain private material.
  const message = error?.code ? 'Unable to read the requested API process environment' : error.message;
  console.log(JSON.stringify({ valid: false, error: message }));
  process.exitCode = 1;
}
