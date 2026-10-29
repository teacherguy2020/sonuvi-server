import assert from 'node:assert/strict';
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
