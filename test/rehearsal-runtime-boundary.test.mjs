import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const execFileP = promisify(execFile);

async function runImmutableBoundary(t, body, extraEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-process-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const boundaryUrl = pathToFileURL(path.resolve('src/lib/rehearsal-runtime-boundary.mjs')).href;
  const program = [
    `import ${JSON.stringify(boundaryUrl)};`,
    "import assert from 'node:assert/strict';",
    "import cp from 'node:child_process';",
    "import { promisify } from 'node:util';",
    body,
  ].join('\n');
  return execFileP(process.execPath, ['--input-type=module', '--eval', program], {
    env: { ...process.env, SONUVI_STATE_ROOT: root, ...extraEnv },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}

test('immutable execFile promise retains stdout, stderr and child process', async (t) => {
  await runImmutableBoundary(t, `
    const result = promisify(cp.execFile)(process.execPath, ['-e',
      'process.stdout.write("albums\\\\nplaylists"); process.stderr.write("diagnostic")']);
    assert(result.child && Number.isInteger(result.child.pid));
    assert.deepEqual(await result, { stdout: 'albums\\nplaylists', stderr: 'diagnostic' });
  `);
});

test('immutable exec promise retains native result shape', async (t) => {
  await runImmutableBoundary(t, `
    const result = promisify(cp.exec)('printf albums; printf diagnostic >&2');
    assert(result.child && Number.isInteger(result.child.pid));
    assert.deepEqual(await result, { stdout: 'albums', stderr: 'diagnostic' });
  `);
});

test('immutable callback execFile retains callback stdout and stderr', async (t) => {
  await runImmutableBoundary(t, `
    await new Promise((resolve, reject) => cp.execFile(process.execPath, ['-e',
      'process.stdout.write("albums"); process.stderr.write("diagnostic")'],
      (error, stdout, stderr) => {
        if (error) return reject(error);
        try {
          assert.equal(stdout, 'albums');
          assert.equal(stderr, 'diagnostic');
          resolve();
        } catch (failure) { reject(failure); }
      }));
  `);
});

test('immutable promises retain native exit code and rejection output', async (t) => {
  await runImmutableBoundary(t, `
    await assert.rejects(promisify(cp.execFile)(process.execPath, ['-e',
      'process.stdout.write("partial"); process.stderr.write("failed"); process.exit(7)']),
      error => error.code === 7 && error.stdout === 'partial' && error.stderr === 'failed');
  `);
});

test('immutable promises retain timeout handling', async (t) => {
  await runImmutableBoundary(t, `
    const result = promisify(cp.execFile)(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { timeout: 50 });
    assert(result.child);
    await assert.rejects(result, error => error.killed === true && error.signal === 'SIGTERM');
  `);
});

test('immutable promises retain Buffer stdout and stderr', async (t) => {
  await runImmutableBoundary(t, `
    const { stdout, stderr } = await promisify(cp.execFile)(process.execPath,
      ['-e', 'process.stdout.write("albums"); process.stderr.write("diagnostic")'], { encoding: 'buffer' });
    assert(Buffer.isBuffer(stdout) && Buffer.isBuffer(stderr));
    assert.equal(stdout.toString(), 'albums');
    assert.equal(stderr.toString(), 'diagnostic');
  `);
});

test('custom promises cannot bypass immutable raw SSH transport guard', async (t) => {
  await runImmutableBoundary(t, `
    for (const command of ['ssh', '/usr/bin/ssh', 'scp', 'sftp']) {
      for (const invoke of [
        () => cp.execFile(command, [], () => {}),
        () => promisify(cp.execFile)(command, []),
        () => cp.execFile[promisify.custom](command, []),
        () => promisify(cp.exec)(command),
      ]) {
        await assert.rejects(async () => invoke(), /Raw SSH\\/SCP transport is disabled/);
      }
    }
  `);
});

test('custom promises cannot bypass rehearsal process denial', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-promisify-rehearsal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runImmutableBoundary(t, `
    for (const invoke of [
      () => promisify(cp.execFile)(process.execPath, ['--version']),
      () => cp.execFile[promisify.custom](process.execPath, ['--version']),
      () => promisify(cp.exec)('printf forbidden'),
    ]) {
      await assert.rejects(async () => invoke(), error => error.code === 'SONUVI_REHEARSAL_DENIED');
    }
  `, { SONUVI_EXECUTION_MODE: 'rehearsal', SONUVI_REHEARSAL_STATE_ROOT: root });
});

test('rehearsal bootstrap blocks legacy built-ins before they leave the disposable state root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-rehearsal-boundary-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-rehearsal-boundary-outside-'));
  const escaped = path.join(outside, 'escaped.txt');
  const outsideWrite = path.join(outside, 'outside.txt');
  await fs.symlink(outside, path.join(root, 'escape'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  const boundaryUrl = pathToFileURL(path.resolve('src/lib/rehearsal-runtime-boundary.mjs')).href;
  const program = [
    `import ${JSON.stringify(boundaryUrl)};`,
    "import { execFile } from 'node:child_process';",
    "import { writeFile } from 'node:fs/promises';",
    'const result = {};',
    `try { execFile(process.execPath, ['--version'], () => {}); } catch (error) { result.process = error?.code; }`,
    `try { await fetch('http://127.0.0.1:9'); } catch (error) { result.fetch = error?.code; }`,
    `try { await writeFile(${JSON.stringify(outsideWrite)}, 'outside'); } catch (error) { result.outside = error?.code; }`,
    `try { await writeFile(${JSON.stringify(path.join(root, 'escape', 'escaped.txt'))}, 'escaped'); } catch (error) { result.symlink = error?.code; }`,
    `await writeFile(${JSON.stringify(path.join(root, 'inside.txt'))}, 'inside');`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  const { stdout } = await execFileP(process.execPath, ['--input-type=module', '--eval', program], {
    env: {
      ...process.env,
      SONUVI_EXECUTION_MODE: 'rehearsal',
      SONUVI_REHEARSAL_STATE_ROOT: root,
    },
    maxBuffer: 1024 * 1024,
  });
  assert.deepEqual(JSON.parse(stdout), {
    process: 'SONUVI_REHEARSAL_DENIED',
    fetch: 'SONUVI_REHEARSAL_DENIED',
    outside: 'SONUVI_REHEARSAL_DENIED',
    symlink: 'SONUVI_REHEARSAL_DENIED',
  });
  assert.equal(await fs.readFile(path.join(root, 'inside.txt'), 'utf8'), 'inside');
  await assert.rejects(fs.access(outsideWrite));
  await assert.rejects(fs.access(escaped));
});
