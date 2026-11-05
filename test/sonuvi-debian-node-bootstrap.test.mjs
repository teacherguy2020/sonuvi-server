import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Debian bootstrap has only fixed preflight/install operations and no npm or source mutation', async () => {
  const source = await fs.readFile(new URL('../scripts/sonuvi-debian-node-bootstrap.sh', import.meta.url), 'utf8');
  assert.match(source, /only preflight or install is supported/);
  assert.match(source, /sonuvi\.debian-bootstrap-preflight\.v1/);
  assert.match(source, /nodejs ffmpeg python3 python3-mpd python3-mutagen python3-requests/);
  assert.match(source, /mpc flac curl openssh-client/);
  assert.match(source, /configured Debian repositories do not provide the required Node 20\.9\+ runtime/);
  const installBlock = source.slice(source.indexOf('/usr/bin/apt-get install'), source.indexOf('if ! /usr/bin/node -e'));
  assert.doesNotMatch(installBlock, /\bnpm\b/);
  assert.doesNotMatch(source, /add-apt-repository|sources\.list\.d\/.*>/);
});
