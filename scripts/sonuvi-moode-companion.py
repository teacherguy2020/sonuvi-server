#!/usr/bin/env python3
"""Explicit optional companion enrollment; root-only export, authenticated SSH transfer, root-only import.
Never selects a display or changes ALSA, playback, queue, or unrelated SSH authorization.
"""
import argparse,datetime,hashlib,ipaddress,json,os,pwd,re,secrets,shutil,subprocess,tempfile
from pathlib import Path
from urllib.parse import urlsplit
HERE=Path(__file__).resolve().parent.parent
CONTRACT='sonuvi.moode-companion.v1'
MODES=('player','peppy','visualizer','kiosk')
def run(*args,**kw): return subprocess.check_output(list(args),stderr=subprocess.PIPE,**kw)
def origin(value):
 u=urlsplit(value)
 if u.scheme!='https' or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment or not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?',value) or (u.port is not None and not 1<=u.port<=65535): raise ValueError('Canonical HTTPS origin required')
 return value.rstrip('/')
def validate(b):
 if b.get('contract')!=CONTRACT: raise ValueError('Wrong enrollment contract')
 origin(b['origin']);ipaddress.ip_address(b['sourceAddress']);ipaddress.ip_address(b['moodeAddress'])
 if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+',b['displayPublicKey']): raise ValueError('Invalid display key')
 if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}',b['peppyToken']): raise ValueError('Invalid token')
 if len(b['caPEM'])>16384 or b['caPEM'].count('BEGIN CERTIFICATE')!=1: raise ValueError('One public CA required')
 return b
def regular(p):
 if p.is_symlink() or not p.is_file(): raise ValueError('Nonregular file: '+str(p))
def backup(base):
 p=Path(base)/('companion-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+secrets.token_hex(3));p.mkdir(parents=True,mode=0o700);return p
def write(p,data,mode=0o644,uid=0,gid=0,b=None):
 p=Path(p)
 missing=[];parent=p.parent
 while not parent.exists():missing.append(parent);parent=parent.parent
 for directory in reversed(missing):directory.mkdir(mode=0o755);directory.chmod(0o755)
 if p.parent.resolve()!=p.parent: raise ValueError('Symlinked parent')
 data=data.encode() if isinstance(data,str) else data
 if p.exists() or p.is_symlink():
  regular(p)
  if p.read_bytes()==data and p.stat().st_mode&0o777==mode and p.stat().st_uid==uid and p.stat().st_gid==gid:return False
  if b:
   dest=b/str(p).lstrip('/');dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(p,dest);dest.chmod(0o600)
 fd,name=tempfile.mkstemp(prefix='.companion-',dir=p.parent)
 try:
  os.fchmod(fd,mode);os.fchown(fd,uid,gid)
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(name,p)
 finally:
  if os.path.exists(name):os.unlink(name)
 return True
def verified_https(canonical,ca,address):
 u=urlsplit(canonical);run('openssl','x509','-in',str(ca),'-noout')
 return run('curl','--fail','--silent','--show-error','--max-time','10','--cacert',str(ca),'--resolve',u.hostname+':'+str(u.port or 443)+':'+address,canonical+'/release.json')
def server_export(a):
 canonical=origin(a.origin);address=str(ipaddress.ip_address(a.server_address));moode=str(ipaddress.ip_address(a.moode_address));ca=Path(a.ca_file);regular(ca);verified_https(canonical,ca,'127.0.0.1')
 protected=Path('/var/lib/sonuvi/protected')
 if protected.resolve()!=protected or protected.stat().st_uid!=0 or protected.stat().st_mode&0o022:raise ValueError('Unsafe protected state')
 account=pwd.getpwnam('sonuvi');b=backup('/var/lib/sonuvi/checkpoints/companion-enrollment')
 keydir=protected/'display-ssh';keydir.mkdir(mode=0o700,exist_ok=True)
 if keydir.resolve()!=keydir:raise ValueError('Unsafe key directory')
 os.chown(keydir,account.pw_uid,account.pw_gid);keydir.chmod(0o700);key=keydir/'display_ed25519'
 if not key.exists():run('ssh-keygen','-q','-t','ed25519','-N','','-C','sonuvi-display-companion','-f',str(key))
 regular(key);key.chmod(0o600);os.chown(key,account.pw_uid,account.pw_gid);public=' '.join(run('ssh-keygen','-y','-f',str(key),text=True).split()[:2])
 # Host key must come from an already authenticated administrative SSH read.
 known=a.moode_host_key.strip().split()
 if len(known)<2 or known[0]!='ssh-ed25519' or not re.fullmatch(r'[A-Za-z0-9+/=]+',known[1]):raise ValueError('Verified ED25519 host key required')
 write(keydir/'known_hosts',moode+' '+' '.join(known[:2])+'\n',0o600,account.pw_uid,account.pw_gid,b)
 token=protected/'peppy-ingest-token'
 if token.exists():regular(token);value=token.read_text().strip()
 else:value=secrets.token_urlsafe(32)
 bundle=validate(dict(contract=CONTRACT,origin=canonical,sourceAddress=address,moodeAddress=moode,displayPublicKey=public,peppyToken=value,caPEM=ca.read_text()))
 write(token,value+'\n',0o640,0,account.pw_gid,b)
 write('/etc/systemd/system/sonuvi-web.service.d/peppy-ingest.conf','[Service]\nEnvironment=SONUVI_PEPPY_TOKEN_FILE='+str(token)+'\n',b=b)
 write('/etc/systemd/system/sonuvi-api.service.d/display-switch.conf','[Service]\nEnvironment=SONUVI_MOODE_DISPLAY_PROTOCOL=v1\nEnvironment=SONUVI_CONTROLLER_WEB_ORIGIN='+canonical+'\n',b=b)
 output=protected/'moode-companion-enrollment.json';write(output,json.dumps(bundle)+'\n',0o600,b=b);run('systemctl','daemon-reload')
 print(json.dumps(dict(prepared=True,bundle=str(output),backup=str(b),restartRequired=['sonuvi-api','sonuvi-web'],companionEnrollmentRequired=True)))
def authorized_keys(existing,b):
 key=b['displayPublicKey'].split()[1];rows=existing.splitlines();matching=[r for r in rows if key in r.split()]
 if any('/usr/local/libexec/sonuvi-display-dispatch' not in r for r in matching):raise ValueError('Key already grants unrelated access')
 rows=[r for r in rows if key not in r.split()];rows.append('from="'+b['sourceAddress']+'",restrict,command="/usr/local/libexec/sonuvi-display-dispatch" '+b['displayPublicKey']);return '\n'.join(rows)+'\n'
def patched_meter(text):
 plain='requests.put(self.url, json=d)';secure="requests.put(self.url, json=d, headers={'Authorization': 'Bearer ' + open('/etc/sonuvi-peppy-token').read().strip()}, verify='/etc/ssl/certs/ca-certificates.crt', timeout=0.5)"
 text=text.replace(plain,secure)
 if secure not in text:raise ValueError('Unsupported PeppyMeter sender')
 return text
def moode_import(a):
 p=Path(a.bundle);regular(p)
 if p.stat().st_uid!=0 or p.stat().st_mode&0o077:raise ValueError('Bundle must be root-owned mode0600')
 v=validate(json.loads(p.read_text()));account=pwd.getpwnam('moode');meter=Path('/opt/peppymeter/httpinterface.py');text=patched_meter(meter.read_text())
 for f in ['/etc/peppymeter/config.txt','/etc/peppyspectrum/config.txt','/home/moode/.xinitrc','/var/local/www/db/moode-sqlite3.db']:regular(Path(f))
 for binary in ['openssl','certutil','curl','update-ca-certificates','visudo']:
  if not shutil.which(binary):raise ValueError('Missing companion prerequisite: '+binary)
 resources={'/usr/local/libexec/sonuvi-display-dispatch':'sonuvi-display/dispatcher.py','/usr/local/libexec/sonuvi-display-apply':'sonuvi-display/apply.py','/usr/local/bin/nowplaying-peppy-targets.sh':'usr/local/bin/nowplaying-peppy-targets.sh','/usr/local/bin/peppy-spectrum-bridge.py':'usr/local/bin/peppy-spectrum-bridge.py','/etc/systemd/system/peppy-spectrum-bridge.service':'etc/systemd/system/peppy-spectrum-bridge.service','/etc/systemd/system/nowplaying-peppy-targets.service':'etc/systemd/system/nowplaying-peppy-targets.service'}
 contents={target:(HERE/'ops/moode-overrides'/source).read_bytes() for target,source in resources.items()}
 with tempfile.TemporaryDirectory() as d:
  ca=Path(d)/'ca.crt';ca.write_text(v['caPEM']);verified_https(v['origin'],ca,v['sourceAddress'])
 keys=Path('/home/moode/.ssh/authorized_keys');newkeys=authorized_keys(keys.read_text() if keys.exists() else '',v);b=backup('/var/local/sonuvi-companion-backups');queue=run('mpc','-f','%id%','playlist');write(b/'queue-before.txt',queue,0o600)
 sudo='moode ALL=(root) NOPASSWD: '+', '.join('/usr/local/libexec/sonuvi-display-apply '+m for m in MODES)+'\n'
 with tempfile.NamedTemporaryFile(mode='w') as f:f.write(sudo);f.flush();run('visudo','-cf',f.name)
 for target,content in contents.items():write(target,content,0o644 if target.endswith('.service') else 0o755,b=b)
 write('/etc/sonuvi-display.json',json.dumps({'origin':v['origin']})+'\n',b=b);write('/etc/sonuvi-peppy-token',v['peppyToken']+'\n',0o600,b=b);write(keys,newkeys,0o600,account.pw_uid,account.pw_gid,b);write('/etc/sudoers.d/sonuvi-display',sudo,0o440,b=b)
 ca=Path('/usr/local/share/ca-certificates/sonuvi-companion.crt');write(ca,v['caPEM'],b=b);run('update-ca-certificates')
 nss=Path('/home/moode/.pki/nssdb');nss.mkdir(parents=True,exist_ok=True,mode=0o700);os.chown(nss,account.pw_uid,account.pw_gid)
 if not (nss/'cert9.db').exists():run('sudo','-u','moode','certutil','-N','--empty-password','-d','sql:'+str(nss))
 nick='Sonuvi companion '+hashlib.sha256(v['caPEM'].encode()).hexdigest()[:16]
 if nick not in run('sudo','-u','moode','certutil','-L','-d','sql:'+str(nss),text=True):run('sudo','-u','moode','certutil','-A','-d','sql:'+str(nss),'-n',nick,'-t','C,,','-i',str(ca))
 write(meter,text,meter.stat().st_mode&0o777,b=b)
 for file in ['/etc/peppymeter/config.txt','/etc/peppyspectrum/config.txt']:
  dst=b/file.lstrip('/');dst.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(file,dst)
 run('bash','/usr/local/bin/nowplaying-peppy-targets.sh');run('systemctl','daemon-reload');run('systemctl','enable','peppy-spectrum-bridge.service','nowplaying-peppy-targets.service');run('systemctl','restart','peppymeter.service','peppy-spectrum-bridge.service')
 run('curl','--fail','--silent','--show-error','--max-time','10',v['origin']+'/release.json')
 print(json.dumps(dict(enrolled=True,origin=v['origin'],backup=str(b),tlsVerified=True,queueIDsUnchanged=queue==run('mpc','-f','%id%','playlist'),displaySelectionUnchanged=True,browserRestartRequired=True,audioPrerequisite='Enable PeppyALSA through stock moOde if not already enabled')))
def main():
 if os.getuid()!=0:raise SystemExit('Explicit root authorization required')
 os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True);server=sub.add_parser('server-export')
 for name in ['origin','ca-file','server-address','moode-address','moode-host-key']:server.add_argument('--'+name,required=True)
 moode=sub.add_parser('moode-import');moode.add_argument('--bundle',required=True);a=p.parse_args();(server_export if a.command=='server-export' else moode_import)(a)
if __name__=='__main__':main()
