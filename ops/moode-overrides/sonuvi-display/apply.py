#!/usr/bin/python3
"""Root-owned fixed display operation; only the four sudoers literals are admitted."""
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.parse import urlsplit
MODES = ('player', 'peppy', 'visualizer', 'kiosk')
APP = re.compile(r'--app=(?:"[^"\n]*"|[^\s\\]+)')
def target_url(origin, mode):
    if mode not in MODES:
        raise ValueError('Invalid mode')
    u = urlsplit(origin)
    if (u.scheme != 'https' or not u.hostname or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment
            or not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?/?', origin)):
        raise ValueError('Invalid canonical origin')
    base = origin.rstrip('/')
    return base + ('/kiosk.html' if mode == 'kiosk' else '/display.html?mode=' + mode + '&kiosk=1')
def updated_startup(source, url):
    if len(APP.findall(source)) != 1:
        raise ValueError('Expected exactly one browser app target')
    return APP.sub(lambda _: '--app="' + url + '"', source)
def write_atomic(file, data):
    info = file.stat()
    temp = file.with_name(file.name + '.sonuvi-display-tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, info.st_mode & 0o777)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(temp, info.st_uid, info.st_gid)
        os.replace(temp, file)
    finally:
        if temp.exists():
            temp.unlink()
def browser_matches(url, proc=Path('/proc')):
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            if args and b'chromium' in args[0] and ('--app=' + url).encode() in args:
                return True
        except (OSError, PermissionError):
            pass
    return False
def apply(mode):
    url = target_url(json.loads(Path('/etc/sonuvi-display.json').read_text())['origin'], mode)
    startup = Path('/home/moode/.xinitrc')
    if startup.is_symlink():
        raise ValueError('Startup symlink refused')
    original = startup.read_text()
    replacement = updated_startup(original, url)
    db = sqlite3.connect('/var/local/www/db/moode-sqlite3.db', timeout=10)
    def value(name):
        row = db.execute('SELECT value FROM cfg_system WHERE param=?', (name,)).fetchone()
        if row is None:
            raise ValueError('Missing display setting')
        return row[0]
    if value('local_display') != '1' or value('peppy_display') != '0':
        raise ValueError('Local browser display must be enabled')
    old_url = value('local_display_url')
    changed = False
    try:
        write_atomic(startup, replacement)
        changed = True
        db.execute('UPDATE cfg_system SET value=? WHERE param=?', (url, 'local_display_url'))
        db.commit()
        subprocess.run(['/usr/bin/systemctl', 'restart', 'localdisplay.service'], check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(40):
            if browser_matches(url) and value('local_display_url') == url and startup.read_text() == replacement:
                return {'contract':'sonuvi.moode-display.v1','ok':True,'verified':True,'mode':mode,'url':url}
            time.sleep(0.5)
        raise RuntimeError('Display startup not verified')
    except Exception:
        db.rollback()
        if changed:
            write_atomic(startup, original)
            db.execute('UPDATE cfg_system SET value=? WHERE param=?', (old_url, 'local_display_url'))
            db.commit()
            subprocess.run(['/usr/bin/systemctl', 'restart', 'localdisplay.service'], check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise
    finally:
        db.close()
if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in MODES:
            raise ValueError('Invalid display operation')
        with open('/run/lock/sonuvi-display.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = apply(sys.argv[1])
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'contract':'sonuvi.moode-display.v1','ok':False,'verified':False,'error':'Display switch or readback failed'}))
        sys.exit(1)
