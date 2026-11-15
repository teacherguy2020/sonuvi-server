// Opt-in disposable-fixture diagnostic only. Programmatic inspector/CDP is
// required to capture caught exceptions in short-lived fixed helper children.
// No listener/port is opened and no historical signed file is modified.
const inspector = require('node:inspector');
const session = new inspector.Session();
session.connect();
let remaining = 40;
const expressions = new Map();
session.on('Debugger.scriptParsed', ({ params }) => {
  if (!/\/(sonuvi-linux-systemd-upgrade|sonuvi-gate-c-existing-install-upgrade)\.mjs$/.test(params.url)) return;
  session.post('Debugger.getScriptSource', { scriptId: params.scriptId }, (error, result) => {
    if (error) return;
    const lines = result.scriptSource.split('\n');
    const adapter = params.url.endsWith('/sonuvi-linux-systemd-upgrade.mjs');
    const index = adapter ? lines.findIndex(line => line.startsWith('function fail(code,')) + 1
      : lines.findIndex(line => line.includes('const code = GATE_C_UPGRADE_FAILURE_CODES.includes(error?.upgradeCode)'));
    if (index < 1) return;
    const expression = adapter
      ? 'JSON.stringify({code, cause: cause?.message, stack: new Error().stack})'
      : 'JSON.stringify({message: error?.message, code: error?.upgradeCode, stack: error?.stack})';
    session.post('Debugger.setBreakpoint', { location: { scriptId: params.scriptId, lineNumber: index } }, (failure, breakpoint) => {
      if (!failure) expressions.set(breakpoint.breakpointId, expression);
    });
  });
});
session.on('Debugger.paused', ({ params }) => {
  const expression = (params.hitBreakpoints || []).map(id => expressions.get(id)).find(Boolean);
  if (!expression || remaining <= 0) { session.post('Debugger.resume'); return; }
  remaining -= 1;
  session.post('Debugger.evaluateOnCallFrame', {
    callFrameId: params.callFrames[0].callFrameId, expression, returnByValue: true, silent: true,
  }, (error, result) => {
    process.stderr.write(`fixture-caught-upgrade-error:${JSON.stringify({ pid: process.pid,
      error: error?.message, details: String(result?.result?.value || result?.exceptionDetails?.text || '').slice(0, 6000) })}\n`);
    session.post('Debugger.resume');
  });
});
session.post('Debugger.enable');
// Healthy code runs without exception pauses: capture only at the adapter's
// typed error constructor and the fixed wrapper's error-mapping boundary.
process.once('exit', () => session.disconnect());
