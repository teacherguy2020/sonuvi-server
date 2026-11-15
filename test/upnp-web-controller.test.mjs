import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const shellFiles = ['controller.html', 'controller-tablet.html', 'controller-mobile.html'];
const nowPlayingFiles = ['controller-now-playing.html', 'controller-now-playing-tablet.html', 'controller-now-playing-grid.html'];

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Music Sources is wired into all controller shells and their pane maps', async () => {
  const pages = await Promise.all(shellFiles.map(read));
  for (const source of pages) {
    assert.match(source, /data-page="kiosk-upnp\.html"/);
    assert.match(source, /controller-upnp\.html/);
    assert.match(source, /upnp-now-playing\.js/);
  }
});

test('controller shells use the same-origin API through portless HTTPS', async () => {
  const pages = await Promise.all(shellFiles.map(read));
  for (const source of pages) {
    assert.match(source, /location\.origin/);
    assert.match(source, /location\.port\s*===\s*['\"]443['\"]/);
  }
});

test('standalone Now Playing pages load the source-aware UPnP transport bridge', async () => {
  const pages = await Promise.all(nowPlayingFiles.map(read));
  for (const source of pages) assert.match(source, /upnp-now-playing\.js\?v=/);
});

test('controller refresh paths preserve the UPnP unsupported-control guard', async () => {
  const pages = await Promise.all(['controller.html', 'controller-tablet.html', 'controller-mobile.html'].map(read));
  for (const source of pages) {
    assert.match(source, /upnp-sonuvi-active/);
    assert.match(source, /upnpUnsupported/);
    assert.match(source, /!upnpControlsActive \|\| !upnpUnsupported/);
  }
});

test('UPnP controller page exposes provider-neutral browsing, search, queue, and source-safe artwork', async () => {
  const page = await read('controller-upnp.html');
  assert.match(page, /Music Sources/);
  assert.match(page, /\/upnp\/devices/);
  assert.match(page, /\/browse/);
  assert.match(page, /\/search/);
  assert.match(page, /\/upnp\/queues/);
  assert.match(page, /Add visible tracks/);
  assert.match(page, /media-items\/\$\{encodeURIComponent\(ref\)\}\/artwork/);
  assert.match(page, /capabilities\?approved=1&probeState=1/);
  assert.doesNotMatch(page, /item\.artworkUrl\s*\)/);
  assert.doesNotMatch(page, /resource\.uri/);
  assert.match(page, /textContent/);
  assert.match(page, /QOBUZ_AUTH_REQUIRED/);
  assert.match(page, /qobuzAccountSection/);
  assert.match(page, /UPNP_REQUEST_TIMEOUT/);
});

test('Qobuz plugin retains account limitations, owner status and guarded session release', async () => {
  const page = await read('scripts/master-configuration-editor.mjs');
  const routes = await read('src/routes/config.qobuz-account.routes.mjs');
  assert.match(page, /id='qobuzAccountSection'/);
  assert.match(page, /id='qobuzAccountConnectBtn';connect.disabled=true/);
  assert.match(page, /plugins\/qobuz\/account\/status/);
  assert.match(page, /qobuzSessionReleaseBtn/);
  assert.match(page, /plugins\/qobuz\/session\/release/);
  assert.match(page, /Do not enter a Qobuz password or token/);
  assert.match(routes, /lastVerifiedAt: null/);
  assert.match(routes, /QOBUZ_RELEASE_UNCONFIRMED/);
  assert.doesNotMatch(routes, /user_auth_token/);
});

test('Now Playing UPnP bridge intercepts only Sonuvi UPnP transport actions', async () => {
  const script = await read('scripts/upnp-now-playing.js');
  assert.match(script, /upnp-sonuvi/);
  assert.match(script, /queueOwnsUpnp/);
  assert.match(script, /nowPlayingAvailable/);
  assert.match(script, /both reads fail/);
  assert.match(script, /addEventListener\('click'.*true\)/s);
  assert.match(script, /\/upnp\/queue/);
  assert.match(script, /revision/);
  assert.match(script, /btn-play/);
  assert.match(script, /btn-seek-back-inline/);
  assert.doesNotMatch(script, /CurrentURI/);
  assert.doesNotMatch(script, /resource\.uri/);
});

test('UPnP server exposes read-only current queue and mediated artwork routes', async () => {
  const routes = await read('src/routes/upnp.routes.mjs');
  assert.match(routes, /app\.get\('\/upnp\/queue'/);
  assert.match(routes, /app\.get\('\/upnp\/media-items\/:selectionRef\/artwork'/);
  assert.match(routes, /mutationExecuted: false/);
  assert.match(routes, /approvedRendererCapabilities/);
  assert.match(routes, /QOBUZ_AUTH_REQUIRED/);
});

test('UPnP Now Playing preserves source artwork identity after current-art caching', async () => {
  const api = await read('moode-nowplaying-api.mjs');
  assert.match(api, /upnpNowPlaying\.displayArtUrl\s*=\s*rawArtUrl/);
  assert.match(api, /older Qobuz\/MPD cache entry/);
});
