import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPublicWebRoot,
  normalizePublicRequestPath,
  resolvePublicWebAsset,
} from '../src/lib/public-web-root.mjs';

async function write(root, relative, content = 'fixture') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

test('public web root copies only allowlisted regular assets and rejects private paths', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-public-root-'));
  const source = path.join(temp, 'source');
  const output = path.join(temp, 'public');
  const outside = path.join(temp, 'outside-secret.txt');
  await fs.mkdir(source);
  await write(source, 'index.html', '<!doctype html>');
  await write(source, 'scripts/index.js', 'window.fixture = true;');
  await write(source, 'scripts/lastfm-authorize.mjs', 'private cli');
  await write(source, 'styles/hero.css', 'body{}');
  await write(source, 'icons/icon-192.png', 'png');
  await write(source, 'assets/fonts/test.ttf', 'font');
  await write(source, 'assets/peppy/catalog.json', '{}');
  await write(source, '.env', 'SECRET=never-public');
  await write(source, 'config/now-playing.config.json', '{"secret":true}');
  await write(source, 'src/private.mjs', 'export default null;');
  await write(source, 'data/library-browse-index.json', '{}');
  await write(temp, 'outside-secret.txt', 'outside');
  await fs.symlink(outside, path.join(source, 'icons', 'escape.png'));

  try {
    const built = await buildPublicWebRoot({ sourceRoot: source, outputRoot: output });
    assert.ok(built.files.includes('index.html'));
    assert.ok(built.files.includes('scripts/index.js'));
    assert.ok(built.files.includes('assets/peppy/catalog.json'));
    assert.equal(await fs.readFile(path.join(output, 'index.html'), 'utf8'), '<!doctype html>');
    assert.equal((await fs.readdir(output)).some((name) => name.startsWith('.')), false);
    assert.equal(JSON.stringify(built.manifest).includes(source), false);
    for (const blocked of ['.env', 'config/now-playing.config.json', 'src/private.mjs', 'data/library-browse-index.json', 'scripts/lastfm-authorize.mjs', 'icons/escape.png']) {
      await assert.rejects(fs.access(path.join(output, blocked)));
    }

    assert.equal(normalizePublicRequestPath('/'), 'index.html');
    assert.equal(normalizePublicRequestPath('/scripts/index.js?v=1'), 'scripts/index.js');
    assert.equal(normalizePublicRequestPath('/.env'), '');
    assert.equal(normalizePublicRequestPath('/%2e%2e/.env'), '');
    assert.equal(normalizePublicRequestPath('/scripts/lastfm-authorize.mjs'), '');
    assert.equal(normalizePublicRequestPath('/config/now-playing.config.json'), '');
    assert.equal(await resolvePublicWebAsset({ publicRoot: output, requestPath: '/index.html' }), path.join(output, 'index.html'));
    assert.equal(await resolvePublicWebAsset({ publicRoot: output, requestPath: '/config/now-playing.config.json' }), null);

    await fs.symlink(outside, path.join(output, 'icons', 'late-escape.png'));
    assert.equal(await resolvePublicWebAsset({ publicRoot: output, requestPath: '/icons/late-escape.png' }), null);
    await assert.rejects(buildPublicWebRoot({ sourceRoot: source, outputRoot: output }), /already exists/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
