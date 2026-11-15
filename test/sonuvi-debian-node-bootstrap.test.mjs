import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

test('Debian bootstrap has only fixed preflight/install operations and no npm or source mutation', async () => {
  const source = await fs.readFile(new URL('../scripts/sonuvi-debian-node-bootstrap.sh', import.meta.url), 'utf8');
  assert.match(source, /only preflight or install is supported/);
  assert.match(source, /sonuvi\.debian-bootstrap-preflight\.v1/);
  assert.match(source, /\[ ! -r \/etc\/debian_version \] \|\| \[ ! -x \/usr\/bin\/apt-get \]/);
  assert.match(source, /nodejs ffmpeg python3 python3-mpd python3-mutagen python3-requests/);
  assert.match(source, /mpc flac curl openssh-client/);
  assert.match(source, /configured Debian repositories do not provide the required Node 20\.9\+ runtime/);
  const installBlock = source.slice(source.indexOf('/usr/bin/apt-get install'), source.indexOf('if ! /usr/bin/node -e'));
  assert.doesNotMatch(installBlock, /\bnpm\b/);
  assert.doesNotMatch(source, /add-apt-repository|sources\.list\.d\/.*>/);
});

test('Debian repository guard handles official cloud mirrors and rejects untrusted or disabled sources', async (t) => {
  const source = await fs.readFile(new URL('../scripts/sonuvi-debian-node-bootstrap.sh', import.meta.url), 'utf8');
  const checker = source.split("<<'SONUVI_APT_CHECK'\n")[1]?.split('\nSONUVI_APT_CHECK')[0];
  assert.ok(checker, 'test the exact embedded read-only guard');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-debian-bootstrap-sources-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'sources.list.d'));
  await fs.mkdir(path.join(root, 'mirrors'));
  const script = path.join(root, 'check.py');
  await fs.writeFile(script, checker.replace('Path("/etc/apt")', `Path(${JSON.stringify(root)})`));
  const stanza = (uri, extra = '') => `Types: deb deb-src\nURIs: ${uri}\nSuites: trixie trixie-updates trixie-backports\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n${extra}`;
  const cases = [
    ['cloud image mirror list', stanza('mirror+file:///etc/apt/mirrors/debian.list'), 'https://deb.debian.org/debian\n', true],
    ['direct trailing slash', stanza('http://deb.debian.org/debian/'), '', true],
    ['direct HTTPS', stanza('https://deb.debian.org/debian'), '', true],
    ['multiline deb822 URI', stanza('\n https://deb.debian.org/debian/'), '', true],
    ['commented official mirrors', stanza('mirror+file:///etc/apt/mirrors/debian.list'), '# Debian\nhttps://deb.debian.org/debian/ # archive\n', true],
    ['unreferenced mirror list', stanza('https://mirror.invalid/debian'), 'https://deb.debian.org/debian\n', false],
    ['foreign mirror', stanza('mirror+file:///etc/apt/mirrors/debian.list'), 'https://mirror.invalid/debian\n', false],
    ['mixed trusted and foreign mirrors', stanza('mirror+file:///etc/apt/mirrors/debian.list'), 'https://deb.debian.org/debian\nhttps://mirror.invalid/debian\n', false],
    ['empty mirror file', stanza('mirror+file:///etc/apt/mirrors/debian.list'), '# empty\n', false],
    ['different local path', stanza('mirror+file:///tmp/debian.list'), 'https://deb.debian.org/debian\n', false],
    ['remote mirror list', stanza('mirror+https://deb.debian.org/debian'), '', false],
    ['disabled stanza', stanza('https://deb.debian.org/debian', 'Enabled: no\n'), '', false],
    ['source only', stanza('https://deb.debian.org/debian').replace('deb deb-src', 'deb-src'), '', false],
    ['no main component', stanza('https://deb.debian.org/debian').replace('Components: main', 'Components: contrib'), '', false],
    ['host prefix spoof', stanza('https://deb.debian.org.evil.test/debian'), '', false],
    ['archive path prefix spoof', stanza('https://deb.debian.org/debian-evil'), '', false],
    ['userinfo spoof', stanza('https://deb.debian.org@evil.test/debian'), '', false],
  ];
  for (const [name, contents, mirrors, expected] of cases) {
    await t.test(name, async () => {
      await fs.writeFile(path.join(root, 'sources.list.d/debian.sources'), contents);
      await fs.writeFile(path.join(root, 'mirrors/debian.list'), mirrors);
      if (expected) await execFile('python3', [script]);
      else await assert.rejects(execFile('python3', [script]), error => error.code === 1);
    });
  }
  await fs.rm(path.join(root, 'sources.list.d/debian.sources'));
  for (const line of ['deb https://deb.debian.org/debian trixie main', 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://deb.debian.org/debian/ trixie main']) {
    await fs.writeFile(path.join(root, 'sources.list'), line + '\n');
    await execFile('python3', [script]);
  }
  await fs.writeFile(path.join(root, 'sources.list'), '# deb https://deb.debian.org/debian trixie main\n');
  await assert.rejects(execFile('python3', [script]), error => error.code === 1);
});
