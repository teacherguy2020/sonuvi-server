import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function repositoryPattern(source) {
  const match = source.match(/^official_debian_repository_pattern='([^']+)'$/m);
  assert.ok(match, 'bootstrap script must define its reviewed Debian repository pattern');
  return match[1];
}

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

test('Debian bootstrap accepts the canonical trailing-slash Debian URI and reports a safe repository rejection', async (t) => {
  const source = await fs.readFile(new URL('../scripts/sonuvi-debian-node-bootstrap.sh', import.meta.url), 'utf8');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-debian-bootstrap-sources-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const sources = path.join(root, 'debian.sources');
  await fs.writeFile(sources, 'Types: deb\nURIs: http://deb.debian.org/debian/\nSuites: trixie\nComponents: main\n');

  const matched = await execFile('grep', ['-E', repositoryPattern(source), sources]);
  assert.match(matched.stdout, /^URIs: http:\/\/deb\.debian\.org\/debian\/$/m);
  assert.match(source, /sonuvi_sftp_bootstrap:debian_repository_unrecognized/);

  await fs.writeFile(sources, 'Types: deb\nURIs: http://mirror.invalid/debian/\nSuites: trixie\nComponents: main\n');
  await assert.rejects(
    execFile('grep', ['-E', repositoryPattern(source), sources]),
    /Command failed/
  );
});
