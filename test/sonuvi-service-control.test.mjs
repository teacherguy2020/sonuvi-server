import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { queueSonuviRestart, registerSonuviRestartRoutes } from '../src/lib/sonuvi-service-control.mjs';

const services = ['sonuvi-api.service', 'sonuvi-web.service'];

test('queues the coupled Sonuvi units only, and does not claim completed restart', async () => {
  const calls = [];
  const result = await queueSonuviRestart(async (...args) => {
    calls.push(args);
    return { stdout: 'loaded\n' };
  });
  assert.deepEqual(calls.slice(0, 2).map(c => c[1][1]), services);
  assert.deepEqual(calls[2], ['sudo', ['-n', 'systemctl', '--no-block', 'restart', ...services], { timeout: 5000 }]);
  assert.equal(result.restartQueued, true);
  assert.equal(result.restarted, false);
  assert.deepEqual(result.services, services);
  assert.equal(calls.length, 3);
});

for (const absent of services) {
  test(`missing ${absent} fails before any restart`, async () => {
    const calls = [];
    await assert.rejects(queueSonuviRestart(async (cmd, args) => {
      calls.push(cmd);
      return { stdout: args[1] === absent ? 'not-found\n' : 'loaded\n' };
    }), /not installed/);
    assert.ok(calls.every(c => c === 'systemctl'));
  });
}

test('missing systemctl fails without PM2 or legacy fallback', async () => {
  let count = 0;
  await assert.rejects(queueSonuviRestart(async () => {
    count += 1; throw new Error('ENOENT');
  }), /ENOENT/);
  assert.equal(count, 1);
});

test('permission failure produces no retry or fallback', async () => {
  const calls = [];
  await assert.rejects(queueSonuviRestart(async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'sudo') throw new Error('not permitted');
    return { stdout: 'loaded' };
  }), /not permitted/);
  assert.equal(calls.length, 3);
  assert.ok(!JSON.stringify(calls).includes('now-playing'));
  assert.ok(!JSON.stringify(calls).includes('pm2'));
});

for (const route of ['/config/restart-api', '/config/restart-services']) {
  for (const scenario of ['unauthorized', 'queued', 'denied']) {
    test(`${route}: ${scenario}`, async () => {
      const routes = new Map();
      let commands = 0;
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      registerSonuviRestartRoutes({ post(p, h) { routes.set(p, h); } }, {
        requireTrackKey(req, response) {
          if (scenario !== 'unauthorized') return true;
          response.status(403).json({ ok: false }); return false;
        },
        async execFileP(cmd) {
          commands += 1;
          if (cmd === 'sudo' && scenario === 'denied') throw new Error('private subprocess output');
          return { stdout: 'loaded' };
        },
      });
      await routes.get(route)({}, res);
      assert.equal(res.code, { unauthorized: 403, queued: 202, denied: 503 }[scenario]);
      assert.equal(commands, scenario === 'unauthorized' ? 0 : 3);
      assert.ok(!JSON.stringify(res.body).includes('private subprocess output'));
      if (scenario === 'queued') assert.equal(res.body.restartQueued, true);
      if (scenario === 'denied') assert.equal(res.body.restartQueued, false);
    });
  }
}

test('runtime-admin registers only the shared Sonuvi restart routes', async () => {
  const source = await readFile(new URL('../src/routes/config.runtime-admin.routes.mjs', import.meta.url), 'utf8');
  assert.match(source, /registerSonuviRestartRoutes\(app, \{ requireTrackKey, execFileP \}\)/);
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
