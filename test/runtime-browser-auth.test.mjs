import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const redirectOnlyPages = new Set([
  'kiosk-albums.html', 'kiosk-artists.html', 'kiosk-genres.html', 'kiosk-now-playing.html',
  'kiosk-playlists.html', 'kiosk-podcasts.html', 'kiosk-queue-wizard.html', 'kiosk-queue.html', 'kiosk-radio.html',
]);

test('browser surfaces use a local credential accessor instead of server Track Key disclosure', async () => {
  const entries = await fs.readdir(root);
  const htmlPages = entries.filter((name) => name.endsWith('.html'));
  for (const page of htmlPages) {
    const source = await fs.readFile(path.join(root, page), 'utf8');
    if (!redirectOnlyPages.has(page)) {
      assert.match(source, /scripts\/runtime-auth\.js/);
    }
    assert.doesNotMatch(source, /config\?\.trackKey|config\.trackKey|fullConfig/);
  }

  const scripts = await fs.readdir(path.join(root, 'scripts'));
  for (const script of scripts.filter((name) => name.endsWith('.js'))) {
    const source = await fs.readFile(path.join(root, 'scripts', script), 'utf8');
    assert.doesNotMatch(source, /config\?\.trackKey|config\.trackKey|fullConfig/);
  }

  const helper = await fs.readFile(path.join(root, 'scripts', 'runtime-auth.js'), 'utf8');
  assert.match(helper, /nowplaying\.trackkey/);
  assert.doesNotMatch(helper, /fetch\s*\(/);

  const configPage = await fs.readFile(path.join(root, 'config.html'), 'utf8');
  assert.match(configPage, /\/config\/runtime\/admin/);
  assert.match(configPage, /Raw configuration writes are disabled/);
});
