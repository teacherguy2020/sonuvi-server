#!/usr/bin/env node
import { AdministratorAuthority } from '../src/lib/sonuvi-admin-authority.mjs';
import { provisionFixedLocalTLS } from '../src/lib/sonuvi-target-installer.mjs';

// Fixed root-only maintenance, no caller paths, URLs, identities or commands.
if (process.getuid?.() !== 0 || process.argv.length !== 2) {
  process.stderr.write('Explicit root-only local TLS maintenance is required.\n');
  process.exitCode=77;
} else {
  try {
    const stateRoot='/var/lib/sonuvi';
    const authority=new AdministratorAuthority({stateRoot});
    const result=await provisionFixedLocalTLS({stateRoot,serverId:(await authority.ownership()).serverId});
    process.stdout.write(JSON.stringify({ok:true,renewed:result.renewed})+'\n');
  } catch {
    process.stderr.write('Local TLS renewal failed; existing trust material was not replaced.\n');
    process.exitCode=1;
  }
}
