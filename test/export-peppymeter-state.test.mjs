import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Peppy export uses the shared cache root when immutable state is enabled', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sonuvi-peppy-export-'));
  const shared = path.join(temporary, 'shared');
  t.after(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
  await execFile(process.execPath, ['scripts/export-peppymeter-skins.mjs'], {
    cwd: repositoryRoot,
    env: { ...process.env, SONUVI_STATE_ROOT: shared },
  });
  const output = path.join(shared, 'cache', 'exports', 'peppymeter', '1280x400', 'meters.generated.txt');
  assert.equal(await fs.stat(output).then(() => true), true);
});
