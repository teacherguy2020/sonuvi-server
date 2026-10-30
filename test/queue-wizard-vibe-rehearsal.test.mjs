import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { registerConfigQueueWizardVibeRoutes } from '../src/routes/config.queue-wizard-vibe.routes.mjs';

function appFixture() {
  return {
    get() {},
    post() {},
  };
}

test('rehearsal registration does not start the endless-vibe background worker', (t) => {
  const previousMode = process.env.SONUVI_EXECUTION_MODE;
  const previousRoot = process.env.SONUVI_REHEARSAL_STATE_ROOT;
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  let timers = 0;
  process.env.SONUVI_EXECUTION_MODE = 'rehearsal';
  process.env.SONUVI_REHEARSAL_STATE_ROOT = '/synthetic/rehearsal-state';
  const timerHandle = { unref() {} };
  globalThis.setTimeout = () => {
    timers += 1;
    return timerHandle;
  };
  globalThis.setInterval = () => {
    timers += 1;
    return timerHandle;
  };
  t.after(() => {
    if (previousMode === undefined) delete process.env.SONUVI_EXECUTION_MODE;
    else process.env.SONUVI_EXECUTION_MODE = previousMode;
    if (previousRoot === undefined) delete process.env.SONUVI_REHEARSAL_STATE_ROOT;
    else process.env.SONUVI_REHEARSAL_STATE_ROOT = previousRoot;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
  });

  registerConfigQueueWizardVibeRoutes(appFixture(), {
    requireTrackKey: () => true,
    getRatingForFile: async () => null,
    mpdQueryRaw: async () => '',
    mpdHasACK: () => false,
    parseMpdKeyVals: () => ({}),
    parseMpdFirstBlock: () => ({}),
    log: {},
  });
  assert.equal(timers, 0);
});

test('Endless Vibe uses the V2 plan-before-MPD-mutation path', async () => {
  const source = await readFile(
    new URL('../src/routes/config.queue-wizard-vibe.routes.mjs', import.meta.url),
    'utf8',
  );

  assert.match(source, /const usePlannerV2 = endless === true/);
  assert.match(source, /'--planner-v2'/);
  assert.match(source, /'--dry-run'/);
  assert.match(source, /await applyVibePlanToMpd\(job, \{/);
  assert.match(source, /resumePlayback: endless/);
  assert.match(source, /targetQueue: 12/);
});
