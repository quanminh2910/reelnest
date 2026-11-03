import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/bulk-panel.js', import.meta.url), 'utf8');
const limits = await readFile(new URL('../src/shared/download-limits.js', import.meta.url), 'utf8');

function fixture({ production = true } = {}) {
  const roles = new Map(), events = [];
  class Node {
    constructor(tag) { this.tagName = tag; this.hidden = false; this.disabled = false; this.dataset = {}; this.children = []; this.listeners = new Map(); this.textContent = ''; this.value = ''; }
    setAttribute(name, value) {
      if (name === 'data-role') { this.dataset.role = value; roles.set(value, this); }
      else if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
      else if (name === 'hidden') this.hidden = true;
      else this[name] = value;
    }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    focus() {}
  }
  const state = { route: { type: 'profile', username: 'creator' }, lease: false, closeCount: 0, cleared: 0,
    failEnd: 0, failBeginAck: false, cacheOpened: false, cacheClosed: false, permission: 'granted' };
  const profile = { id: '12345', username: 'creator' };
  const cache = { profile, folderName: 'creator', recordedCount: 3,
    close() { events.push('cache:close'); state.closeCount++; state.cacheClosed = true; },
    async clearHistory() { events.push('cache:clear'); state.cleared++; return { cleared: 3 }; },
  };
  const target = { kind: 'folder', name: 'Library', handle: { async requestPermission() { events.push('permission'); return state.permission; } } };
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, setTimeout, clearTimeout,
    CSSStyleSheet: class { replaceSync() {} },
    ...(production ? { ReelNestProfileQueueConfig: {} } : {}),
    ReelSaverProfileCache: { async openLibrary() { events.push('cache:open'); state.cacheOpened = true; state.cacheClosed = false; return cache; } },
  });
  vm.runInContext(limits, context); vm.runInContext(source, context);
  const panel = context.ReelSaverBulkPanel.create({ root: { adoptedStyleSheets: [], append() {} },
    readRoute: () => state.route, getDestination: () => target, isSingleBusy: () => false,
    onBusyChange() {}, request: async request => {
      events.push(request.type);
      if (request.type === 'REEL_SAVER_QUEUE_LEASE_BEGIN') {
        state.lease = true;
        if (state.failBeginAck) { state.failBeginAck = false; throw new Error('Lease acknowledgement lost'); }
        return { leaseId: 'clear-lease' };
      }
      if (request.type === 'REEL_SAVER_QUEUE_LEASE_END') {
        if (state.cacheOpened) assert.equal(state.cacheClosed, true, 'cache must close before the operation lease releases');
        if (state.failEnd > 0) { state.failEnd--; throw new Error('Release unavailable'); }
        state.lease = false;
        return { ok: true };
      }
      if (request.type === 'REEL_SAVER_BULK_IDENTIFY') return { profile };
      throw new Error(`Unexpected request ${request.type}`);
    } });
  panel.loadSettings({ mode: 'batches', batchSize: 35, maxNewVideos: null });
  const click = (role, trusted = true) => roles.get(role).listeners.get('click')({ isTrusted: trusted });
  return { state, events, panel, roles, click };
}
async function settled(predicate) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('The history operation did not settle');
}

test('history clear holds a global operation lease before opening its cache and releases it after Cancel closes the cache', async () => {
  const f = fixture();
  await f.click('cache-clear', false);
  assert.deepEqual(f.events, []);
  await f.click('cache-clear');
  assert.deepEqual(f.events.slice(0, 3), ['REEL_SAVER_QUEUE_LEASE_BEGIN', 'REEL_SAVER_BULK_IDENTIFY', 'cache:open']);
  assert.equal(f.state.lease, true);
  assert.equal(f.panel.isBusy(), true);
  assert.equal(f.roles.get('cache-clear-confirm').disabled, false);
  await f.click('cache-clear-cancel');
  assert.deepEqual(f.events.slice(-2), ['cache:close', 'REEL_SAVER_QUEUE_LEASE_END']);
  assert.equal(f.state.lease, false);
  assert.equal(f.state.cleared, 0);
  assert.equal(f.panel.isBusy(), false);
});

test('successful clear keeps the lease through identity recheck and metadata commit', async () => {
  const f = fixture(); await f.click('cache-clear');
  await f.click('cache-clear-confirm');
  assert.equal(f.state.cleared, 1);
  assert.deepEqual(f.events.slice(-5), ['permission', 'REEL_SAVER_BULK_IDENTIFY', 'cache:clear', 'cache:close', 'REEL_SAVER_QUEUE_LEASE_END']);
  assert.equal(f.state.lease, false);
  assert.equal(f.panel.isBusy(), false);
});

test('lost lease release keeps a retryable UI context and never repeats the history reset', async () => {
  const f = fixture(); await f.click('cache-clear');
  f.state.failEnd = 1;
  await f.click('cache-clear-confirm');
  assert.equal(f.state.cleared, 1);
  assert.equal(f.state.lease, true);
  assert.equal(f.panel.isBusy(), true);
  assert.equal(f.roles.get('cache-clear-confirm').disabled, true);
  assert.equal(f.roles.get('cache-clear-cancel').textContent, 'Release history operation');
  assert.equal(f.roles.get('cache-clear-cancel').disabled, false);
  await f.click('cache-clear-confirm');
  assert.equal(f.state.cleared, 1);
  await f.click('cache-clear-cancel');
  assert.equal(f.state.closeCount, 1);
  assert.equal(f.state.lease, false);
  assert.equal(f.panel.isBusy(), false);
});

test('lost BEGIN acknowledgement can release its sender-owned lease without opening history', async () => {
  const f = fixture(); f.state.failBeginAck = true; f.state.failEnd = 1;
  await f.click('cache-clear');
  assert.equal(f.state.cacheOpened, false);
  assert.equal(f.state.lease, true);
  assert.equal(f.panel.isBusy(), true);
  assert.equal(f.roles.get('cache-clear-cancel').textContent, 'Release history operation');
  await f.click('cache-clear-cancel');
  assert.equal(f.state.lease, false);
  assert.equal(f.panel.isBusy(), false);
  assert.equal(f.state.cleared, 0);
});

test('profile navigation closes an unconfirmed history cache and its lease without resetting videos', async () => {
  const f = fixture(); await f.click('cache-clear');
  f.state.route = { type: 'profile', username: 'another_creator' };
  f.panel.contextChanged();
  await settled(() => !f.panel.isBusy());
  assert.equal(f.state.lease, false);
  assert.equal(f.state.cleared, 0);
  assert.equal(f.state.closeCount, 1);
});

test('legacy browser fixtures can exercise history clearing without queue message support', async () => {
  const f = fixture({ production: false });
  await f.click('cache-clear'); await f.click('cache-clear-cancel');
  assert.equal(f.events.some(value => value.startsWith('REEL_SAVER_QUEUE_')), false);
  assert.equal(f.state.closeCount, 1);
  assert.equal(f.panel.isBusy(), false);
});
