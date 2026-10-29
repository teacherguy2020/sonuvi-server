#!/usr/bin/env node
import { removeSyntheticRehearsalState } from './lib/h4c4a-rehearsal.mjs';

function value(name) {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

const result = await removeSyntheticRehearsalState({
  stateRoot: required('--state-root'),
  fixtureId: required('--fixture-id'),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
