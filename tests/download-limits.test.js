import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/shared/download-limits.js', import.meta.url), 'utf8');

function load() {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.ReelSaverDownloadLimits;
}

test('download limits default legacy options to unlimited and validate numeric boundaries strictly', () => {
  const limits = load();
  assert.equal(limits.normalize(undefined), null);
  assert.equal(limits.normalize(null), null);
  for (const value of [1, 35, 50_000]) assert.equal(limits.normalize(value), value);
  for (const value of [0, -1, 1.1, 50_001, NaN, Infinity, '', '35', 'Unlimited', true, [], {}, 2 ** 54]) {
    assert.throws(() => limits.normalize(value), { code: 'INVALID_LIMIT' });
  }
});

test('remaining allowance subtracts reserved slots without changing committed-save accounting', () => {
  const limits = load();
  assert.equal(limits.remaining(null, 99, 1), Infinity);
  assert.equal(limits.remaining(50, 35), 15);
  assert.equal(limits.remaining(50, 49, 1), 0);
  assert.equal(limits.reached(50, 49), false);
  assert.equal(limits.reached(50, 50), true);
  assert.equal(limits.remaining(50, 51), 0);
  assert.equal(limits.reached(null, 50_000), false);
  assert.throws(() => limits.remaining(50, undefined), { code: 'INVALID_ACCOUNTING' });
  for (const value of [-1, 0.1, '1', Infinity, NaN]) {
    assert.throws(() => limits.remaining(50, value), { code: 'INVALID_ACCOUNTING' });
    assert.throws(() => limits.remaining(50, 0, value), { code: 'INVALID_ACCOUNTING' });
  }
});
