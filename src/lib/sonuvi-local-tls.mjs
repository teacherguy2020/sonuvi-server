import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const LOCAL_TLS_CONTRACT = 'sonuvi.local-tls-trust.v1';
export const LOCAL_TLS_PORT = 8443;
const execute = promisify(execFile);
const runOpenSSL = args => execute('/usr/bin/openssl', args, { timeout: 30000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });

export function localTLSHostname(serverId) {
  if (!/^sonuvi-[A-Za-z0-9_-]{43}$/.test(serverId || '')) throw new Error('local_tls_identity_invalid');
  return `sonuvi-${crypto.createHash('sha256').update(serverId).digest('hex').slice(0,24)}.local`;
}

async function directory(target, ownerUID, mode, sharedGroup = null) {
  await fs.mkdir(target, { mode, recursive: true });
  const s = await fs.lstat(target);
  // Only the root-owned sticky configuration directory permits the service
  // group to create master-document replacements. Root-owned TLS files remain
  // protected from unlink/rename by the sticky bit. Private key roots stay strict.
  const sharedConfig = sharedGroup !== null && s.gid === sharedGroup
    && (s.mode & 0o1777) === 0o1770;
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== ownerUID || ((s.mode & 0o022) && !sharedConfig) || await fs.realpath(target) !== target) throw new Error('local_tls_directory_unsafe');
}

async function readProtected(file, ownerUID, maximum = 65536) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== ownerUID || (s.mode & 0o027) || s.size > maximum) throw new Error('local_tls_file_unsafe');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export function validateLocalTLSBundle(bundle, { now = Date.now(), serverId = bundle?.serverId, allowExpiredLeaf = false } = {}) {
  const hostname = localTLSHostname(serverId);
  if (!bundle || bundle.contract !== LOCAL_TLS_CONTRACT || bundle.serverId !== serverId || bundle.origin !== `https://${hostname}:${LOCAL_TLS_PORT}`) throw new Error('local_tls_bundle_invalid');
  const root = new crypto.X509Certificate(Buffer.from(bundle.anchorDER || '', 'base64'));
  const leaf = new crypto.X509Certificate(bundle.cert);
  if (!root.ca || leaf.ca || !root.verify(root.publicKey) || !leaf.verify(root.publicKey)
      || leaf.checkHost(hostname, { wildcards: false }) !== hostname
      || !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1')
      || !leaf.checkPrivateKey(crypto.createPrivateKey(bundle.key))
      || Date.parse(root.validFrom) > now || Date.parse(root.validTo) <= now
      || Date.parse(leaf.validFrom) > now || (!allowExpiredLeaf && Date.parse(leaf.validTo) <= now)) throw new Error('local_tls_certificate_invalid');
  return { hostname, expiresAt: new Date(leaf.validTo).toISOString() };
}

export async function readLocalTLSBundle({ stateRoot = '/var/lib/sonuvi', ownerUID = 0, now = Date.now(), allowExpiredLeaf = false } = {}) {
  const file = path.join(stateRoot, 'config', 'local-tls.json');
  let raw;
  try { raw = await readProtected(file, ownerUID); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const bundle = JSON.parse(raw);
  validateLocalTLSBundle(bundle, { now, allowExpiredLeaf });
  return bundle;
}

/** Returns public material only; possession of this JSON is not trust proof. */
export function localTrustRecord(bundle) {
  return { contract: LOCAL_TLS_CONTRACT, serverId: bundle.serverId, origin: bundle.origin, anchorDER: bundle.anchorDER };
}

/** Fixed privileged installer/renewal operation; never expose as a claim API.
 * Each Server keeps its own root key. Leaf rotation atomically replaces one
 * service-readable bundle; no private keys are returned or logged.
 */
export async function provisionLocalTLS({ stateRoot = '/var/lib/sonuvi', serverId,
  getuid = () => process.getuid?.(), ownerUID = 0, serviceGID = 0,
  openssl = runOpenSSL, now = () => Date.now() } = {}) {
  if (getuid() !== 0) throw new Error('explicit_root_authorization_required');
  if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot || !Number.isInteger(serviceGID) || serviceGID < 0) throw new Error('local_tls_configuration_invalid');
  const hostname = localTLSHostname(serverId);
  const protectedRoot = path.join(stateRoot, 'protected');
  const root = path.join(protectedRoot, 'local-tls');
  const config = path.join(stateRoot, 'config');
  await directory(protectedRoot, ownerUID, 0o700);
  await directory(root, ownerUID, 0o700);
  await directory(config, ownerUID, 0o750, serviceGID);
  const lockFile = path.join(root, 'provision.lock');
  const lock = await fs.open(lockFile, 'wx', 0o600);
  let staging;
  try {
    const current = await readLocalTLSBundle({ stateRoot, ownerUID, now: now(), allowExpiredLeaf: true });
    if (current) {
      validateLocalTLSBundle(current, { serverId, now: now(), allowExpiredLeaf: true });
      if (Date.parse(new crypto.X509Certificate(current.cert).validTo) - now() > 30 * 86400000) return { renewed: false, trust: localTrustRecord(current) };
    }
    const authority = path.join(root, 'authority');
    let hasAuthority = true;
    try { await fs.lstat(authority); } catch (error) { if (error.code === 'ENOENT') hasAuthority = false; else throw error; }
    if (current && !hasAuthority) throw new Error('local_tls_authority_missing');
    staging = await fs.mkdtemp(path.join(root, 'generation-'));
    const rootConfig = `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Sonuvi ${hostname}\n[ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nnameConstraints=critical,permitted;DNS:${hostname},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0\n`;
    const rootKey = path.join(authority, 'root.key'), rootCert = path.join(authority, 'root.pem');
    if (!hasAuthority) {
      const candidate = path.join(staging, 'authority');
      await fs.mkdir(candidate, { mode: 0o700 });
      await fs.writeFile(path.join(staging, 'root.cnf'), rootConfig, { mode: 0o600 });
      await openssl(['req','-new','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-pkeyopt','ec_param_enc:named_curve','-nodes','-sha256','-days','3650','-config',path.join(staging,'root.cnf'),'-keyout',path.join(candidate,'root.key'),'-out',path.join(candidate,'root.pem')]);
      await fs.chmod(path.join(candidate,'root.key'), 0o600);
      await fs.chmod(path.join(candidate,'root.pem'), 0o600);
      await fs.writeFile(path.join(candidate,'identity.json'), JSON.stringify({serverId}), { mode: 0o600 });
      await fs.rename(candidate, authority);
    }
    await directory(authority, ownerUID, 0o700);
    if (JSON.parse(await readProtected(path.join(authority,'identity.json'), ownerUID)).serverId !== serverId) throw new Error('local_tls_identity_changed');
    const anchor = new crypto.X509Certificate(await readProtected(rootCert, ownerUID));
    const key = crypto.createPrivateKey(await readProtected(rootKey, ownerUID));
    if (!anchor.ca || !anchor.checkPrivateKey(key) || !anchor.verify(anchor.publicKey) || Date.parse(anchor.validTo) <= now() + 90*86400000) throw new Error('local_tls_authority_invalid');
    if (current && current.anchorDER !== anchor.raw.toString('base64')) throw new Error('local_tls_authority_changed');
    const leafKey = path.join(staging,'leaf.key'), csr = path.join(staging,'leaf.csr'), leafCert = path.join(staging,'leaf.pem');
    const ext = path.join(staging,'leaf.cnf');
    await fs.writeFile(ext, `[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`, { mode: 0o600 });
    await openssl(['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-pkeyopt','ec_param_enc:named_curve','-nodes','-sha256','-subj',`/CN=${hostname}`,'-keyout',leafKey,'-out',csr]);
    await openssl(['x509','-req','-in',csr,'-CA',rootCert,'-CAkey',rootKey,'-set_serial','0x'+crypto.randomBytes(16).toString('hex'),'-days','90','-sha256','-extfile',ext,'-extensions','leaf','-out',leafCert]);
    const bundle = { contract: LOCAL_TLS_CONTRACT, serverId, origin: `https://${hostname}:${LOCAL_TLS_PORT}`, anchorDER: anchor.raw.toString('base64'), cert: await fs.readFile(leafCert,'utf8'), key: await fs.readFile(leafKey,'utf8') };
    validateLocalTLSBundle(bundle, { serverId, now: now() });
    const temporary = path.join(config, `local-tls.${crypto.randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary,'wx',0o600);
      try { await file.writeFile(JSON.stringify(bundle)); await file.chown(ownerUID,serviceGID); await file.chmod(0o640); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temporary,path.join(config,'local-tls.json'));
      const dir = await fs.open(config,'r'); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await fs.unlink(temporary).catch(error => { if(error.code !== 'ENOENT') throw error; }); }
    return { renewed: true, trust: localTrustRecord(bundle) };
  } finally {
    if (staging) await fs.rm(staging,{recursive:true,force:true});
    await lock.close(); await fs.unlink(lockFile);
  }
}
