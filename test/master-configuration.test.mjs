import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeMasterConfiguration, validateMasterConfiguration, createMasterConfigurationStore, configurationRevision } from '../src/lib/master-configuration.mjs';
import { planMasterConfigurationMigration, legacyRuntimeConfiguration } from '../src/lib/master-configuration-migration.mjs';

test('migration preserves effective settings across base, native overlay and environment', () => {
  const base = {projectName:'sonuvi', ports:{api:3101,ui:8101}, features:{podcasts:false,ratings:false}, mpd:{host:'127.0.0.1',port:6600}, paths:{musicLibraryRoot:'/empty'}, customIntegration:{value:42}};
  const overlay = {format:'sonuvi-server-configuration', version:1, settings:{features:{podcasts:true,ratings:true}, mpd:{host:'player.local'}, paths:{podcastRoot:'/music/Podcasts'}}};
  const plan = planMasterConfigurationMigration({base,overlay,environment:{MUSIC_LIBRARY_ROOT:'/music',MPD_HOST:'10.0.0.254'}});
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.document.plugins.library.musicLibraryRoot, '/music');
  assert.equal(plan.document.plugins.mpd.host, '10.0.0.254');
  assert.equal(plan.document.plugins.podcasts.enabled, true);
  assert.equal(plan.document.core.paths.musicLibraryRoot, undefined);
  const runtime = legacyRuntimeConfiguration(plan.document);
  assert.deepEqual(runtime.customIntegration, {value:42});
  assert.equal(runtime.paths.musicLibraryRoot, '/music');
  assert.equal(runtime.features.ratings, true);
  assert.equal(runtime.paths.podcastRoot, '/music/Podcasts');
  const again = planMasterConfigurationMigration({base:plan.document,overlay,environment:{MPD_HOST:'obsolete'}});
  assert.equal(again.changed, false);
  assert.deepEqual(again.document, plan.document);
  assert.equal(base.mpd.host, '127.0.0.1');
});

test('malformed overlay aborts migration without changing inputs', () => {
  const base = {features:{radio:true}};
  assert.throws(()=>planMasterConfigurationMigration({base,overlay:{settings:{}}}), /Invalid native/);
  assert.deepEqual(base,{features:{radio:true}});
});

test('legacy credentials are separated from the master migration document',()=>{
  const plan = planMasterConfigurationMigration({base:{lastfm:{apiKey:'fixture-key',username:'public-user'}}});
  assert.equal(plan.credentialTransfers[0].path,'lastfm.apiKey');
  assert.equal(JSON.stringify(plan.document).includes('fixture-key'),false);
  assert.equal(plan.document.plugins.lastfm.publicUsername,'public-user');
  plan.document.plugins.lastfm.apiSecret='fixture-secret';
  assert.ok(validateMasterConfiguration(plan.document).some(e=>e.path==='/plugins/lastfm/apiSecret'));
});

test('defaults initialize missing fields without replacing saved false, zero or custom properties', () => {
  const input = { plugins: { artwork: { enabled: false, artCacheLimit: 0, custom: 'preserve' } } };
  const result = initializeMasterConfiguration(input);
  assert.equal(result.plugins.artwork.enabled, false);
  assert.equal(result.plugins.artwork.artCacheLimit, 0);
  assert.equal(result.plugins.artwork.custom, 'preserve');
  assert.deepEqual(validateMasterConfiguration(result), []);
  assert.equal(input.plugins.lastfm, undefined);
  assert.deepEqual(initializeMasterConfiguration(result), result);
});

test('validation reports exact field errors and rejects dangerous properties', () => {
  const document = initializeMasterConfiguration();
  document.plugins.mpd.port = 70000;
  document.plugins.lastfm.scrobblingEnabled = 'true';
  document.plugins.radio.extra = JSON.parse('{"__proto__":{"polluted":true}}');
  const errors = validateMasterConfiguration(document);
  assert.ok(errors.some(e => e.path === '/plugins/mpd/port'));
  assert.ok(errors.some(e => e.path === '/plugins/lastfm/scrobblingEnabled'));
  assert.ok(errors.some(e => e.path.endsWith('/__proto__')));
  assert.equal({}.polluted, undefined);
});

test('revision is independent of object property order', () => {
  assert.equal(configurationRevision({a:1,b:2}), configurationRevision({b:2,a:1}));
});

test('independent stores reject concurrent/stale edits and preserve persisted state on invalid save', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-master-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const initial = initializeMasterConfiguration();
  await fs.writeFile(file, JSON.stringify(initial), {mode:0o640});
  await fs.chmod(file, 0o640);
  const a = createMasterConfigurationStore(file), b = createMasterConfigurationStore(file);
  const { revision } = await a.read();
  const first = structuredClone(initial), second = structuredClone(initial);
  first.plugins.display.idleBrandLine = 'First';
  second.plugins.display.idleBrandLine = 'Second';
  const results = await Promise.allSettled([a.save(first, revision), b.save(second, revision)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length, 1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status, 409);
  const saved = await createMasterConfigurationStore(file).read();
  assert.notEqual(saved.revision, revision);
  await assert.rejects(a.save(initial, revision), {code:'configuration_conflict'});
  const invalid = structuredClone(saved.document);
  invalid.plugins.mpd.port = 'invalid';
  await assert.rejects(a.save(invalid, saved.revision), {code:'configuration_invalid'});
  assert.deepEqual(await b.read(), saved);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  assert.equal((await a.save(saved.document, saved.revision)).changed, false);
});
