import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { checkSonuviRestart, registerSonuviRestartRoutes, SONUVI_SERVICES } from '../src/lib/sonuvi-service-control.mjs';
import { runtimeDiagnostics, checkLocalListener } from '../src/lib/config-runtime-diagnostics.mjs';
import { registerConfigRuntimeAdminRoutes } from '../src/routes/config.runtime-admin.routes.mjs';
import { sanitizeRuntimeConfigUpdate, mergeRuntimeConfig } from '../src/lib/runtime-config-projection.mjs';
import { assertImmutableRuntimeConfig } from '../src/lib/runtime-config-security.mjs';
import { isPublicWebAsset } from '../src/lib/public-web-root.mjs';

const html = await fs.readFile(new URL('../config.html', import.meta.url), 'utf8');
test('required Config helper is included by the existing public asset allowlist', () => {
  assert.equal(isPublicWebAsset('scripts/config-editable.js'), true);
});
test('app shell and embedded config page bootstrap browser controller authentication', async () => {
  for (const page of ['app.html', 'config.html']) {
    const source = await fs.readFile(new URL('../' + page, import.meta.url), 'utf8');
    assert.match(source, /\/__controller\/config\.js/);
    assert.match(source, /scripts\/controller-browser-auth\.js/);
  }
});
const editable = await fs.readFile(new URL('../scripts/config-editable.js', import.meta.url), 'utf8');
function response() {
  return Object.assign(new EventEmitter(), { code: 200, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
}
function routes() {
  const map = new Map();
  return { map, get(p, h) { map.set('GET '+p, h); }, post(p, h) { map.set('POST '+p, h); } };
}
function extract(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a+start.length);
  assert.ok(a >= 0 && b > a, start); return html.slice(a, b);
}

test('master Settings uses owner-session transport and separate credential actions', async () => {
  assert.match(html, /mountMasterConfigurationEditor/);
  assert.match(html, /await globalThis\.SonuviControllerAuth\?\.ready/);
  assert.match(html, /fetch\('\/__controller\/configuration'/);
  assert.doesNotMatch(html, /configTrackKey|Raw configuration writes are disabled/);
  const editor=await fs.readFile(new URL('../scripts/master-configuration-editor.mjs',import.meta.url),'utf8');
  assert.match(editor,/draft\.saveRequest\(\)/);
  assert.match(editor,/\/plugins\/lastfm\//);
  assert.equal(isPublicWebAsset('scripts/master-configuration-editor.mjs'),true);
  assert.equal(isPublicWebAsset('scripts/master-configuration-draft.mjs'),true);
});

test('moOde plugin retains HTTPS display and maintenance guidance without claiming verification', async () => {
  const editor=await fs.readFile(new URL('../scripts/master-configuration-editor.mjs',import.meta.url),'utf8');
  assert.ok(editor.includes('https://sonuvi.local/display.html?mode=index&kiosk=1'));
  for(const file of ['/var/www/daemon/worker.php','/var/www/daemon/watchdog.sh','/usr/local/bin/rgb_moode_service.py'])assert.ok(editor.includes(file));
  assert.match(editor,/Remote target verification has not been performed/);
});

test('pairing uses the canonical resolver across HTTPS and direct HTTP, retaining explicit override', async () => {
  const pairing = await fs.readFile(new URL('../scripts/mobile-pairing-ui.js', import.meta.url), 'utf8');
  const start = pairing.indexOf('  function resolveApiBase()');
  const end = pairing.indexOf('  const apiBase =', start);
  for (const [url, canonical] of [['https://sonuvi.local/config.html', 'https://sonuvi.local'], ['http://sonuvi.local:8101/config.html', 'http://sonuvi.local:3101']]) {
    const context = vm.createContext({ location: new URL(url), URL, root: { dataset: {} }, text: x => String(x||'').trim(), NPArt: { apiBase: () => canonical } });
    vm.runInContext(pairing.slice(start,end), context);
    assert.equal(context.resolveApiBase(), canonical);
    context.root.dataset.apiBase = 'https://explicit.test/';
    assert.equal(context.resolveApiBase(), 'https://explicit.test');
  }
});

test('immutable Save route validates actual schema, rejects protected fields, and no-op preserves file bytes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-config-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const cfg = { nodes: [], ports: { api: 3101, ui: 8101 }, alexa: { enabled: false }, features: { podcasts: true }, display: { idleBrandLine: 'Before' }, paths: { musicLibraryRoot: '/retained' } };
  assertImmutableRuntimeConfig(cfg);
  await fs.writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
  const names = ['NOW_PLAYING_CONFIG_PATH', 'SONUVI_STATE_ROOT', 'SONUVI_SECRETS_ROOT', 'TRACK_KEY'];
  const prior = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, { NOW_PLAYING_CONFIG_PATH: file, SONUVI_STATE_ROOT: dir, SONUVI_SECRETS_ROOT: dir, TRACK_KEY: 'FIXTURE_PROTECTED_KEY' });
  t.after(() => { for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; } });
  const app = routes();
  registerConfigRuntimeAdminRoutes(app, { requireTrackKey: () => true, trackKey: 'FIXTURE_PROTECTED_KEY', log: { debug() {} } });
  const save = app.map.get('POST /config/runtime');
  const before = await fs.readFile(file, 'utf8');
  for (const config of [{ trackKey: '' }, { lastfm: { apiKey: '' } }, { notifications: { pushover: { token: '', userKey: '' } } }, { alexa: { routeWebhookUrl: '', stopWebhookUrl: '' } }]) {
    const res = response(); await save({ body: { config } }, res);
    assert.equal(res.code, 400);
    assert.equal(res.body.code, 'SONUVI_PROTECTED_CREDENTIALS');
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
  const noop = response(); await save({ body: { config: {} } }, noop);
  assert.equal(noop.code, 200); assert.equal(noop.body.changed, false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const changed = response(); await save({ body: { config: { display: { idleBrandLine: 'After' } } } }, changed);
  assert.equal(changed.code, 200); assert.equal(changed.body.changed, true);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assertImmutableRuntimeConfig(after);
  assert.deepEqual(after.paths, cfg.paths); assert.deepEqual(after.features, cfg.features);
  assert.equal(process.env.TRACK_KEY, 'FIXTURE_PROTECTED_KEY');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(changed.body), /FIXTURE_PROTECTED_KEY/);
  assert.equal(changed.body.config.paths.musicLibraryRoot, '/retained');

  const pathSave = response();
  await save({body:{config:{paths:{musicLibraryRoot:'/saved/music',moodeUsbMount:'/saved/media',piMountBase:'/saved/mount',podcastRoot:'/saved/podcasts'}}}}, pathSave);
  assert.equal(pathSave.code, 200);
  const disk = JSON.parse(await fs.readFile(file,'utf8'));
  const reread = response();
  await app.map.get('GET /config/runtime/admin')({},reread);
  assert.deepEqual(reread.body.config.paths,disk.paths);
  assert.deepEqual(reread.body.config.paths,pathSave.body.config.paths);
  const sameBytes = await fs.readFile(file,'utf8');
  const same = response();
  await save({body:{config:{paths:disk.paths}}},same);
  assert.equal(same.body.changed,false);
  assert.equal(await fs.readFile(file,'utf8'),sameBytes);
});

test('listener diagnostics distinguish an open local socket from a closed one', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  assert.equal(await checkLocalListener(port),true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await checkLocalListener(port),false);
  assert.equal(await checkLocalListener(-1),false);
});

test('runtime diagnostics separate local paths, MPD, and restricted remote paths without invoking SSH', async () => {
  const commands = [], inspected = [];
  const result = await runtimeDiagnostics({ mpd: { host: 'moode.test' }, paths: { musicLibraryRoot: '/remote/music', moodeUsbMount: '/remote/usb', piMountBase: '/local/library', podcastRoot: '/local/podcasts' } }, {
    environment: { SONUVI_STATE_ROOT: '/state', SONUVI_SECRETS_ROOT: '/state/protected' },
    execFileP: async (cmd, args) => { commands.push([cmd,args]); return { stdout: '' }; },
    stat: async p => { inspected.push(p); return { isDirectory: () => true }; },
    access: async () => {}, checkListener: async () => true,
  });
  assert.deepEqual(commands.map(c => c[0]), ['mpc']);
  assert.deepEqual(inspected, ['/local/library','/local/podcasts']);
  assert.equal(result.mpdOk, true);
  assert.equal(result.ssh.status, 'restricted');
  assert.equal(result.ssh.identityReadable, true);
  assert.ok(result.pathChecks.filter(p => p.scope === 'remote').every(p => p.status === 'restricted'));
  assert.doesNotMatch(JSON.stringify(result), /\/remote\/|\/local\/|moode_ed25519/);
});

for (const scenario of ['accepted', 'unauthorized', 'denied', 'inactive', 'injected-target']) {
  test('restart route: '+scenario, async () => {
    const app = routes(), calls = [];
    registerSonuviRestartRoutes(app, {
      requireTrackKey: (_req,res) => { if (scenario === 'unauthorized') { res.status(403).json({ok:false}); return false; } return true; },
      policyFor: async () => scenario === 'denied' ? undefined : 'sonuvi-pair-polkit-v1',
      execFileP: async (cmd,args) => {
        calls.push([cmd,args]);
        return { stdout: 'LoadState=loaded\nActiveState='+ (scenario === 'inactive' ? 'inactive' : 'active') };
      },
    });
    const res = response();
    await app.map.get('POST /config/restart-services')({ body: scenario === 'injected-target' ? { unit: 'now-playing.service' } : {} }, res);
    assert.equal(res.code, { accepted:202, unauthorized:403, denied:503, inactive:503, 'injected-target':400 }[scenario]);
    assert.ok(!calls.some(([,args]) => args.includes('restart') && args.includes('--no-block')));
    if (scenario === 'accepted') {
      assert.equal(res.body.restarted, false);
      assert.equal(res.body.restartQueued, false);
      res.emit('finish');
      assert.deepEqual(calls.at(-1), ['/usr/bin/systemctl', ['--no-ask-password','--no-block','restart', ...SONUVI_SERVICES]]);
    }
    assert.doesNotMatch(JSON.stringify(calls), /sudo|pm2|now-playing/);
    assert.doesNotMatch(JSON.stringify(res.body), /private failure/);
  });
}

test('Polkit rule authorizes only exact user, action, units and restart verb', async () => {
  const source = (await fs.readFile(new URL('../ops/polkit/50-sonuvi-restart.rules.in', import.meta.url), 'utf8')).replaceAll('@SERVICE_USER@','service-fixture');
  let rule;
  vm.runInNewContext(source, { polkit: { Result: { YES: 'yes' }, addRule: r => { rule = r; } } });
  for (const unit of [...SONUVI_SERVICES, 'now-playing.service','now-playing-web.service','caddy.service','sshd.service']) {
    for (const verb of ['restart','start','stop','enable','reload']) {
      for (const user of ['service-fixture','other-user']) {
        const action = { id: 'org.freedesktop.systemd1.manage-units', lookup: key => ({unit,verb})[key] };
        assert.equal(rule(action, {user}), user === 'service-fixture' && verb === 'restart' && SONUVI_SERVICES.includes(unit) ? 'yes' : undefined);
      }
    }
  }
  assert.equal(rule({ id: 'org.freedesktop.login1.reboot', lookup: () => 'restart' }, {user:'service-fixture'}), undefined);
});

test('active route implementation has no legacy or PM2 restart fallback', async () => {
  const source = await fs.readFile(new URL('../src/routes/config.runtime-admin.routes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /now-playing(?:-web)?\.service|execFileP\('pm2'/);
  assert.match(source, /registerSonuviRestartRoutes\(app/);
});
