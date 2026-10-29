import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MPD_HOST, MOODE_SSH_HOST, MOODE_SSH_USER } from '../config.mjs';
import { runtimeStatePaths } from '../lib/runtime-state-paths.mjs';

const execFileP = promisify(execFile);

function sshArgsFor(user, host, extra = []) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    ...extra,
    `${user}@${host}`,
  ];
}

function shQuoteArg(s) {
  const v = String(s ?? '');
  return `'${v.replace(/'/g, `'"'"'`)}'`;
}

export function resolveStickerBackupDirectory({ env = process.env, statePaths = runtimeStatePaths({ env }) } = {}) {
  const configured = String(env.MPD_STICKER_BACKUP_DIR || '').trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('MPD_STICKER_BACKUP_DIR must be an absolute path');
    return path.resolve(configured);
  }
  return statePaths.sharedStateEnabled
    ? path.join(statePaths.protectedRoot, 'sticker-backups')
    : '/home/brianwis/backups/sticker-backups';
}

async function sshBashLc({ user, host, script, timeoutMs = 20000, maxBuffer = 10 * 1024 * 1024 }) {
  return execFileP('ssh', [...sshArgsFor(user, host), 'bash', '-lc', shQuoteArg(String(script || ''))], {
    timeout: timeoutMs,
    maxBuffer,
  });
}

export function registerConfigRatingsStickerRoutes(app, deps) {
  const { requireTrackKey } = deps;

  app.get('/config/ratings/sticker-status', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const stickerPath = String(process.env.MPD_STICKER_PATH || '/var/lib/mpd/sticker.sql');
      const pQ = shQuoteArg(stickerPath);
      const script = [
        `if [ -f ${pQ} ]; then sz=$(wc -c < ${pQ} 2>/dev/null || echo 0); echo "FOUND|${stickerPath}|$sz"; exit 0; fi`,
        `if sudo test -f ${pQ} 2>/dev/null; then sz=$(sudo wc -c < ${pQ} 2>/dev/null || echo 0); echo "FOUND|${stickerPath}|$sz"; exit 0; fi`,
        `echo "MISSING|${stickerPath}|0"`,
      ].join('; ');

      const { stdout } = await sshBashLc({ user: String(MOODE_SSH_USER || 'moode'), host: String(MOODE_SSH_HOST || MPD_HOST || 'moode.local'), script, timeoutMs: 12000 });
      const raw = String(stdout || '').trim();
      const line = raw.split(/\r?\n/).map((x) => x.trim()).find((x) => x.startsWith('FOUND|') || x.startsWith('MISSING|')) || raw;
      const [state = 'MISSING', pathOut = stickerPath, sz = '0'] = String(line || '').split('|');

      if (state !== 'FOUND') {
        return res.json({ ok: true, exists: false, path: pathOut || stickerPath, size: 0 });
      }

      const size = Number(sz || 0) || 0;
      return res.json({ ok: true, exists: true, path: pathOut || stickerPath, size });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/ratings/sticker-backup', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;

      const sshUser = String(MOODE_SSH_USER || 'moode');
      const sshHost = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local');
      const stickerPath = String(process.env.MPD_STICKER_PATH || '/var/lib/mpd/sticker.sql');
      const backupDir = resolveStickerBackupDirectory();
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const backupPath = path.join(backupDir, `sticker-${ts}.sql`);

      await fs.mkdir(backupDir, { recursive: true });

      // Verify source exists on moOde first.
      const pQ = shQuoteArg(stickerPath);
      const verifyScript = `if [ -f ${pQ} ] || sudo test -f ${pQ} 2>/dev/null; then echo OK; else echo MISSING; fi`;
      const { stdout: checkOut } = await sshBashLc({ user: sshUser, host: sshHost, script: verifyScript, timeoutMs: 10000 });
      if (!String(checkOut || '').includes('OK')) {
        return res.status(400).json({ ok: false, error: `Sticker DB not found at ${stickerPath}` });
      }

      // Pull the sticker DB to the API/Web host backup directory.
      await execFileP('scp', [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        `${sshUser}@${sshHost}:${stickerPath}`,
        backupPath,
      ], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });

      return res.json({ ok: true, stickerPath, backupPath });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.get('/config/ratings/sticker-backups', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const backupDir = resolveStickerBackupDirectory();
      await fs.mkdir(backupDir, { recursive: true });
      const names = (await fs.readdir(backupDir).catch(() => [])).filter((n) => /\.sql$/i.test(n));
      const stats = await Promise.all(names.map(async (n) => {
        const p = path.join(backupDir, n);
        const st = await fs.stat(p).catch(() => null);
        return st ? { path: p, name: n, size: Number(st.size || 0), mtimeMs: Number(st.mtimeMs || 0) } : null;
      }));
      const backups = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50).map(({ mtimeMs, ...rest }) => rest);
      return res.json({ ok: true, backupDir, backups });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/config/ratings/sticker-restore', async (req, res) => {
    try {
      if (!requireTrackKey(req, res)) return;
      const sshUser = String(MOODE_SSH_USER || 'moode');
      const sshHost = String(MOODE_SSH_HOST || MPD_HOST || 'moode.local');
      const stickerPath = String(process.env.MPD_STICKER_PATH || '/var/lib/mpd/sticker.sql');
      const backupPath = String(req.body?.backupPath || '').trim();
      if (!backupPath) return res.status(400).json({ ok: false, error: 'backupPath is required' });

      await fs.access(backupPath).catch(() => { throw new Error(`Backup file not found: ${backupPath}`); });

      const remoteTmp = `/tmp/sticker-restore-${Date.now()}.sql`;
      await execFileP('scp', [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        backupPath,
        `${sshUser}@${sshHost}:${remoteTmp}`,
      ], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });

      const pQ = shQuoteArg(stickerPath);
      const tQ = shQuoteArg(remoteTmp);
      const script = [
        `if ! test -f ${tQ}; then echo "MISSING_TMP"; exit 3; fi`,
        `sudo cp -a ${tQ} ${pQ}`,
        `sudo chown mpd:audio ${pQ} >/dev/null 2>&1 || true`,
        `sudo chmod 664 ${pQ} >/dev/null 2>&1 || true`,
        `rm -f ${tQ} >/dev/null 2>&1 || true`,
        `echo OK`,
      ].join('; ');
      const { stdout } = await sshBashLc({ user: sshUser, host: sshHost, script, timeoutMs: 15000 });
      const out = String(stdout || '').trim();
      if (!out.includes('OK')) return res.status(400).json({ ok: false, error: `Restore failed for ${backupPath}` });

      return res.json({ ok: true, stickerPath, backupPath });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
