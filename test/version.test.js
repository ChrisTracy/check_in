import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVersion } from '../scripts/next-version.mjs';

test('release version: a version you set by hand is released as it is', () => {
  assert.deepEqual(nextVersion('1.0.27', []), { version: '1.0.27', mode: 'asis' });
  assert.deepEqual(nextVersion('1.1.0', ['v1.0.27', 'v1.0.28']), { version: '1.1.0', mode: 'asis' });
  assert.deepEqual(nextVersion('2.0.0', ['v1.9.9']), { version: '2.0.0', mode: 'asis' });
});

test('release version: otherwise the patch goes up from the highest tag on that major.minor', () => {
  assert.deepEqual(nextVersion('1.0.27', ['v1.0.27']), { version: '1.0.28', mode: 'bump' });
  // package.json is behind because an earlier run's bump commit was not in this checkout
  assert.deepEqual(nextVersion('1.0.27', ['v1.0.27', 'v1.0.28', 'v1.0.29']), { version: '1.0.30', mode: 'bump' });
  // other lines do not count
  assert.deepEqual(nextVersion('1.1.0', ['v1.1.0', 'v1.0.99']), { version: '1.1.1', mode: 'bump' });
  assert.deepEqual(nextVersion('1.0.9', ['v1.0.9', 'v1.0.10']), { version: '1.0.11', mode: 'bump' });
});

test('release version: refuses a version that is not major.minor.patch', () => {
  assert.throws(() => nextVersion('1.0', []));
  assert.throws(() => nextVersion('1.0.0-beta', []));
});
