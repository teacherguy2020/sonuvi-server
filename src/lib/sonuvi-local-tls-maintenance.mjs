import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
export const TLS_RENEW_SERVICE='sonuvi-local-tls-renew.service';
export const TLS_RENEW_TIMER='sonuvi-local-tls-renew.timer';

export const TLS_RENEW_UNITS=Object.freeze({
  [TLS_RENEW_SERVICE]: `[Unit]\nDescription=Renew Sonuvi private LAN TLS certificate\nConditionPathExists=/var/lib/sonuvi/config/local-tls.json\nConditionPathExists=/opt/sonuvi/current/release-manifest.json\n[Service]\nType=oneshot\nUser=root\nWorkingDirectory=/opt/sonuvi/current\nExecStartPre=/usr/bin/node /opt/sonuvi/current/scripts/verify-current-release.mjs\nExecStart=/usr/bin/node /opt/sonuvi/current/scripts/sonuvi-local-tls-renew.mjs\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\nReadWritePaths=/var/lib/sonuvi/protected/local-tls /var/lib/sonuvi/config\n`,
  [TLS_RENEW_TIMER]: `[Unit]\nDescription=Daily Sonuvi private LAN certificate maintenance\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\nUnit=${TLS_RENEW_SERVICE}\n[Install]\nWantedBy=timers.target\n`
});

/** Separate, fixed auxiliary lifecycle; never broadens the two application
 * service control endpoints or exposes privileged renewal through HTTP.
 */
export function localTLSMaintenance({unitRoot='/etc/systemd/system',run=args=>execute('/usr/bin/systemctl',args,{timeout:30000})}={}) {
  if (!path.isAbsolute(unitRoot)) throw new Error('tls_unit_root_invalid');
  return {
    async prepare() {
      await fs.mkdir(unitRoot,{recursive:true,mode:0o755});
      for(const [name,content] of Object.entries(TLS_RENEW_UNITS)) {
        const target=path.join(unitRoot,name);
        let existing;try {const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('tls_unit_unsafe');existing=await fs.readFile(target,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
        if(existing!==undefined&&existing!==content)throw new Error('tls_unit_conflict');
        if(existing===undefined)await fs.writeFile(target,content,{flag:'wx',mode:0o644});
      }
    },
    async start() { await run(['enable','--now',TLS_RENEW_TIMER]); },
    async stop() { await run(['disable','--now',TLS_RENEW_TIMER]); await run(['stop',TLS_RENEW_SERVICE]); }
  };
}
