import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { checkSonuviRestart, registerSonuviRestartRoutes, SONUVI_SERVICES, SONUVI_RESTART_POLICY } from '../src/lib/sonuvi-service-control.mjs';

const services = ['sonuvi-api.service', 'sonuvi-web.service'];
const policyFor = () => SONUVI_RESTART_POLICY;
const active = 'LoadState=loaded\nActiveState=active\n';

test('restart availability checks only the coupled units and does not execute a restart', async () => {
  const calls = [];
  const result = await checkSonuviRestart(async (...args) => {
    calls.push(args); return { stdout: active };
  }, policyFor);
  assert.deepEqual(SONUVI_SERVICES, services);
  assert.deepEqual(calls.map(c => c[1][1]), services);
  assert.ok(calls.every(c => c[0] === '/usr/bin/systemctl' && c[1][0] === 'show'));
  assert.equal(result.available, true);
  assert.equal(result.permissionProbe, 'not-performed');
  assert.equal(calls.length, 2);
});

for (const absent of services) {
  test(`missing ${absent} fails before any restart`, async () => {
    const calls = [];
    await assert.rejects(checkSonuviRestart(async (cmd, args) => {
      calls.push([cmd,args]);
      return { stdout: args[1] === absent ? 'LoadState=not-found\nActiveState=inactive' : active };
    }, policyFor), /unavailable/);
    assert.ok(calls.every(([cmd,args]) => cmd === '/usr/bin/systemctl' && args[0] === 'show'));
  });
}

test('missing systemctl fails without sudo, PM2 or legacy fallback', async () => {
  let count = 0;
  await assert.rejects(checkSonuviRestart(async () => {
    count += 1; throw new Error('ENOENT');
  }, policyFor), /ENOENT/);
  assert.equal(count, 1);
});

test('missing operator policy fails before any command', async () => {
  let count = 0;
  await assert.rejects(checkSonuviRestart(async () => { count++; }, () => ''), /unavailable/);
  assert.equal(count, 0);
});

for (const route of ['/config/restart-api', '/config/restart-services']) {
  for (const scenario of ['unauthorized', 'accepted', 'denied', 'systemd-denied']) {
    test(`${route}: ${scenario}`, async () => {
      const routes = new Map(), calls = [], logs = [];
      const res = Object.assign(new EventEmitter(), {
        code: 200, status(code) { this.code = code; return this; },
        json(body) { this.body = body; return this; },
      });
      registerSonuviRestartRoutes({ get(p,h) { routes.set(p,h); }, post(p,h) { routes.set(p,h); } }, {
        requireTrackKey(req, response) {
          if (scenario !== 'unauthorized') return true;
          response.status(403).json({ ok: false }); return false;
        },
        policyFor: () => scenario === 'denied' ? '' : SONUVI_RESTART_POLICY,
        log: { error: m => logs.push(m) },
        async execFileP(cmd,args) {
          calls.push([cmd,args]);
          if (args.includes('restart') && scenario === 'systemd-denied') throw new Error('private subprocess output');
          return { stdout: active };
        },
      });
      await routes.get(route)({body:{}}, res);
      assert.equal(res.code, { unauthorized:403, accepted:202, denied:503, 'systemd-denied':202 }[scenario]);
      assert.ok(calls.every(([,args]) => !args.includes('restart')));
      if (res.code === 202) {
        assert.equal(res.body.restartAccepted, true);
        assert.equal(res.body.restartQueued, false);
        assert.equal(res.body.restarted, false);
        res.emit('finish');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls.at(-1), ['/usr/bin/systemctl', ['--no-ask-password','--no-block','restart',...services]]);
        assert.equal(calls.length, 3);
      } else assert.equal(calls.length, 0);
      assert.equal(logs.length, scenario === 'systemd-denied' ? 1 : 0);
      assert.doesNotMatch(JSON.stringify({body:res.body,logs}), /private subprocess output/);
      assert.doesNotMatch(JSON.stringify(calls), /sudo|pm2|now-playing/);
    });
  }
}

test('runtime-admin registers the shared Sonuvi restart routes exactly once', async () => {
  const source = await readFile(new URL('../src/routes/config.runtime-admin.routes.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/registerSonuviRestartRoutes\(app, \{ requireTrackKey, execFileP, log \}\)/g) || []).length, 1);
  assert.doesNotMatch(source, /now-playing(?:-web)?\.service|execFileP\('pm2'/);
});

for (const script of ['install.sh', 'deploy-pi5-files.sh']) {
  test(`${script} fails closed without external commands for all non-help invocations`, () => {
    const file = new URL('../scripts/' + script, import.meta.url);
    // Empty PATH proves no network, copies or service commands are needed.
    for (const args of [[], ['--ref', 'main'], ['--fresh'], ['--help', '--fresh'], ['src/config.mjs']]) {
      const result = spawnSync('/bin/bash', [file.pathname, ...args], { env: { PATH: '' }, encoding: 'utf8' });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /retired/);
      assert.doesNotMatch(result.stderr, /command not found/);
    }
    const help = spawnSync('/bin/bash', [file.pathname, '--help'], { env: { PATH: '' }, encoding: 'utf8' });
    assert.equal(help.status, 0);
  });
}

test('unit templates preserve release/state separation and boot dependencies', async () => {
  const units = await Promise.all(['api', 'web'].map(n => readFile(new URL('../ops/systemd/sonuvi-' + n + '.service.in', import.meta.url), 'utf8')));
  for (const unit of units) {
    assert.match(unit, /WorkingDirectory=\/opt\/sonuvi\/current/);
    assert.match(unit, /SONUVI_RELEASE_ROOT=\/opt\/sonuvi\/releases\/@RELEASE_ID@/);
    assert.match(unit, /ExecStartPre=.*verify-current-release\.mjs/);
    assert.match(unit, /WantedBy=multi-user\.target/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /NoNewPrivileges=true/);
    assert.doesNotMatch(unit, /WorkingDirectory=\/opt\/now-playing|now-playing(?:-web)?\.service|http\.server|pm2/);
  }
  assert.match(units[0], /RequiresMountsFor=@MUSIC_LIBRARY_ROOT@/);
  assert.match(units[0], /ReadWritePaths=\/var\/lib\/sonuvi/);
  assert.match(units[1], /Requires=sonuvi-api\.service/);
  assert.match(units[1], /SONUVI_WEB_PORT=8101/);
});

test('optional Echo Link unit uses release code and external protected environment', async () => {
  const unit = await readFile(new URL('../ops/systemd/echo-link-volume.service', import.meta.url), 'utf8');
  assert.match(unit, /EnvironmentFile=\/var\/lib\/sonuvi\/protected\/echo-link.env/);
  assert.match(unit, /\/opt\/sonuvi\/current\/integrations\/echo-link\/echo_link_volume.py/);
  assert.doesNotMatch(unit, /\/opt\/now-playing/);
});
