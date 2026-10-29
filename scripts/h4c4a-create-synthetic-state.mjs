#!/usr/bin/env node
import { createSyntheticRehearsalState } from './lib/h4c4a-rehearsal.mjs';

function value(name) {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

const result = await createSyntheticRehearsalState({
  stateRoot: required('--state-root'),
  apiPort: value('--api-port') || undefined,
  webPort: value('--web-port') || undefined,
  fixtureId: value('--fixture-id') || undefined,
});
process.stdout.write(`${JSON.stringify({
  stateRoot: result.stateRoot,
  fixtureId: result.fixtureId,
  ports: result.ports,
  files: result.files,
  synthetic: true,
}, null, 2)}\n`);
