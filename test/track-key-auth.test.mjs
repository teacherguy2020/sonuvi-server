import assert from 'node:assert/strict';
import test from 'node:test';

import { hasConfiguredTrackKey, isAuthorizedTrackKey } from '../src/lib/track-key-auth.mjs';

test('operator Track Key authentication fails closed without a configured key', () => {
  assert.equal(hasConfiguredTrackKey(''), false);
  assert.equal(hasConfiguredTrackKey('   '), false);
  assert.equal(isAuthorizedTrackKey('', 'candidate'), false);
  assert.equal(isAuthorizedTrackKey('configured', ''), false);
});

test('operator Track Key authentication accepts only the exact configured key', () => {
  assert.equal(hasConfiguredTrackKey('configured-key'), true);
  assert.equal(isAuthorizedTrackKey('configured-key', 'configured-key'), true);
  assert.equal(isAuthorizedTrackKey('configured-key', 'wrong-key'), false);
  assert.equal(isAuthorizedTrackKey('configured-key', 'configured-key-extra'), false);
});
