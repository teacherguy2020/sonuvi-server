import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function template(relative) {
  return fs.readFile(path.join(root, relative), 'utf8');
}

test('candidate API systemd unit models the Pi5 remote-MPD and CIFS topology without local MPD paths', async () => {
  const api = await template('ops/systemd/now-playing.service.h3.template');
  assert.match(api, /RequiresMountsFor=@MUSIC_LIBRARY_ROOT@/);
  assert.match(api, /Environment=MUSIC_LIBRARY_ROOT=@MUSIC_LIBRARY_ROOT@/);
  assert.match(api, /Environment=PI4_MOUNT_BASE=@MUSIC_LIBRARY_ROOT@/);
  assert.match(api, /ReadOnlyPaths=\/opt\/sonuvi\/current @MUSIC_LIBRARY_ROOT@/);
  assert.match(api, /ReadWritePaths=\/opt\/sonuvi\/shared/);
  assert.match(api, /Environment=HOME=\/opt\/sonuvi\/shared\/protected\/ssh-home/);
  assert.doesNotMatch(api, /\/var\/lib\/mpd/);
  assert.doesNotMatch(api, /mpd\.service/);
});

test('candidate web unit remains loopback-only and read-only while depending on the API service', async () => {
  const web = await template('ops/systemd/now-playing-web.service.h3.template');
  assert.match(web, /Requires=now-playing\.service/);
  assert.match(web, /SONUVI_WEB_PORT=8101/);
  assert.match(web, /ReadOnlyPaths=\/opt\/sonuvi\/current \/opt\/sonuvi\/shared\/checkpoints/);
  assert.match(web, /ProtectSystem=strict/);
  assert.match(web, /ProtectHome=true/);
});

test('candidate Caddy configuration keeps traffic gated until the non-secret release sentinel exists', async () => {
  const caddy = await template('ops/caddy/sonuvi.caddyfile.h3.template');
  assert.match(caddy, /\{\$SONUVI_CADDY_HOSTNAME:sonuvi\.local\}/);
  assert.match(caddy, /@public_traffic_open file \/opt\/sonuvi\/shared\/checkpoints\/public-traffic-open\.json/);
  assert.match(caddy, /respond "Sonuvi release activation in progress" 503/);
  assert.match(caddy, /@api path .*\/health/);
  assert.match(caddy, /\/favorites\/toggle/);
  assert.match(caddy, /\/queue\/advance\*/);
  assert.match(caddy, /\/track \/track\/\*/);
  assert.match(caddy, /\/config\*/);
  assert.match(caddy, /\/v1\/mobile\*/);
  assert.match(caddy, /\/upnp\* \/recent\*/);
  assert.match(caddy, /reverse_proxy @api 127\.0\.0\.1:3101/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8101/);
  assert.match(caddy, /respond @private 404/);
  assert.doesNotMatch(caddy, /\/_debug/);
  assert.doesNotMatch(caddy, /\/integrations\//);
  assert.doesNotMatch(caddy, /root \/opt\/now-playing/);
});
