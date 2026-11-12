import fs from 'node:fs';
import path from 'node:path';

/** Read only the installer-owned, non-secret source description. Never expose
 * mount credentials, arbitrary config fields or infer a drive from its path. */
export function readManagedMusicSource({ stateRoot = '/var/lib/sonuvi', ownerUID = 0 } = {}) {
  let handle;
  try {
    if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot) return null;
    const configRoot = path.join(stateRoot, 'config');
    if (fs.realpathSync(configRoot) !== configRoot) return null;
    handle = fs.openSync(path.join(stateRoot, 'config', 'music-setup.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.uid !== ownerUID || (stat.mode & 0o022) || stat.nlink !== 1 || stat.size > 65536) return null;
    const record = JSON.parse(fs.readFileSync(handle, 'utf8'));
    if (!['ready', 'restarting'].includes(record.state)
      || typeof record.share !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _().-]{0,79}$/.test(record.share) || record.share.endsWith('.') || record.share.includes('..')
      || typeof record.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(record.host) || record.host.includes('..')) return null;
    return { kind: 'network-share', name: record.share, host: record.host,
      mountPath: path.join(stateRoot, 'music'), access: 'read-only' };
  } catch { return null; }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}
