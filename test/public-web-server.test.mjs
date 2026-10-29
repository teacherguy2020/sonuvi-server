import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPublicWebRoot } from '../src/lib/public-web-root.mjs';
import { createPublicWebServer } from '../src/lib/public-web-server.mjs';

async function write(root, relative, content = 'fixture') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function request(server, pathname, method = 'GET') {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: address.port, path: pathname, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('public web server serves only H2 allowlisted regular files with no traversal or directory fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-public-server-'));
  const source = path.join(root, 'source');
  const publicRoot = path.join(root, 'public');
  const outside = path.join(root, 'outside-secret.txt');
  await fs.mkdir(source);
  await write(source, 'index.html', '<!doctype html><title>Public</title>');
  await write(source, 'scripts/index.js', 'window.public = true;');
  await write(source, 'icons/icon-192.png', 'public icon');
  await write(source, '.env', 'SECRET_SENTINEL');
  await write(source, 'src/server.mjs', 'private');
  await write(root, 'outside-secret.txt', 'outside');
  await fs.symlink(outside, path.join(source, 'icons-link.png'));
  await buildPublicWebRoot({ sourceRoot: source, outputRoot: publicRoot });
  await write(publicRoot, '.env', 'late private file');
  await fs.symlink(outside, path.join(publicRoot, 'icons', 'late-escape.png'));
  const server = await createPublicWebServer({ publicRoot });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const rootResponse = await request(server, '/');
  assert.equal(rootResponse.statusCode, 200);
  assert.match(rootResponse.body, /Public/);
  assert.equal((await request(server, '/scripts/index.js?v=1')).statusCode, 200);
  assert.equal((await request(server, '/.env')).statusCode, 404);
  assert.equal((await request(server, '/%2e%2e/.env')).statusCode, 404);
  assert.equal((await request(server, '/src/server.mjs')).statusCode, 404);
  assert.equal((await request(server, '/icons/late-escape.png')).statusCode, 404);
  assert.equal((await request(server, '/scripts/')).statusCode, 404);
  assert.equal((await request(server, '/index.html', 'POST')).statusCode, 405);
});

test('generated public root preserves the declared PWA manifest, start URL, and icons', async (t) => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-public-pwa-'));
  const publicRoot = path.join(temporary, 'public');
  await buildPublicWebRoot({ sourceRoot: repositoryRoot, outputRoot: publicRoot });
  const server = await createPublicWebServer({ publicRoot });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const manifestResponse = await request(server, '/manifest.webmanifest');
  assert.equal(manifestResponse.statusCode, 200);
  const manifest = JSON.parse(manifestResponse.body);
  assert.equal(manifest.start_url, '/app.html');
  assert.equal((await request(server, manifest.start_url)).statusCode, 200);
  for (const icon of manifest.icons) {
    assert.equal((await request(server, icon.src)).statusCode, 200, icon.src);
  }
  const app = await fs.readFile(path.join(publicRoot, 'app.html'), 'utf8');
  assert.match(app, /rel="manifest"[^>]+manifest\.webmanifest/);
});
