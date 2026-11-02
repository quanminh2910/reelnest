import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const sources = await Promise.all(['../src/shared/download-limits.js', '../src/shared/profile-queue-config.js',
  '../src/content/profile-queue-panel.js'].map(name => readFile(new URL(name, import.meta.url), 'utf8')));
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function node(tag) {
  return { tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, listeners: {}, hidden: false,
    disabled: false, textContent: '', value: '', adoptedStyleSheets: [],
    setAttribute(key, value) {
      this.attributes[key] = value;
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
      if (key === 'hidden') this.hidden = true;
      if (key === 'disabled') this.disabled = true;
      if (key === 'value') this.value = value;
    },
    append(...values) { for (const value of values) { this.children.push(value); value.parent = this; } },
    prepend(...values) { this.children.unshift(...values); },
    replaceChildren(...values) { this.children = []; this.append(...values); },
    querySelectorAll(selector) {
      const tags = selector.split(',').map(value => value.trim().toUpperCase());
      const found = [];
      const walk = entry => { for (const child of entry.children) { if (tags.includes(child.tagName)) found.push(child); walk(child); } };
      walk(this); return found;
    },
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    async event(type, extra = {}) { for (const listener of this.listeners[type] || []) await listener({ isTrusted: true, target: this, ...extra }); },
    focus() {}, select() {}, click() { this.clicked = true; },
  };
}
function walk(entry, predicate) {
  if (predicate(entry)) return entry;
  for (const child of entry.children) { const result = walk(child, predicate); if (result) return result; }
  return null;
}
const item = (number, state = 'saved') => ({ mediaId: String(number), shortcode: `R${number}`, state, attempts: 1,
  filename: `creator_R${number}.mp4`, bytesWritten: 24 });

async function fixture(extra = {}) {
  const state = { draft: { schemaVersion: 1, batchSize: 35, defaultLimit: 2, totalLimit: null,
    entries: [{ id: 'a', username: 'creator_a', limitMode: 'inherit', maxNewVideos: null },
      { id: 'b', username: 'creator_b', limitMode: 'custom', maxNewVideos: 1 }] }, run: null,
    requests: [], calls: [], sourceWait: null, runners: [], sourceStarted: deferred(), writes: [], archives: [], ...extra };
  let clock = 100;
  const current = () => { if (state.run) state.run.updatedAt = ++clock; return plain(state.run); };
  async function request(message) {
    const action = message.type.replace('REEL_SAVER_QUEUE_', ''); state.requests.push(plain(message));
    const entry = state.run?.entries[state.run.currentIndex];
    if (action === 'DRAFT_GET') return { draft: plain(state.draft) };
    if (action === 'DRAFT_SET') { state.draft = plain(message.draft); return { draft: plain(state.draft) }; }
    if (action === 'LATEST') return { run: plain(state.run), owned: state.owned === true };
    if (action === 'LEASE_BEGIN') { state.recoveryLeased = true; return { leaseId: 'recovery-lease' }; }
    if (action === 'LEASE_END') { state.recoveryLeased = false; return {}; }
    if (action === 'RECOVERY_INFO') return { recovery: state.run.reservation ? { run: plain(state.run), entry: plain(state.run.entries[0]), item: plain(state.recoveryItem) } : null };
    if (action === 'RECONCILE') {
      assert.equal(state.recoveryLeased, true); state.recoveryProof = message.result === undefined ? null : plain(message.result);
      state.run.reservation = null;
      if (state.failRecoveryAck) { state.failRecoveryAck--; throw new Error('Recovery acknowledgement lost'); }
      return { run: current() };
    }
    if (action === 'START') {
      state.run = { id: 'run-one', state: 'running', currentIndex: 0, committedNewSaves: 0, draft: plain(message.draft), options: plain(message.options),
        entries: message.draft.entries.map(value => ({ ...plain(value), state: 'pending', effectiveLimit: value.limitMode === 'custom' ? value.maxNewVideos : value.limitMode === 'unlimited' ? null : message.draft.defaultLimit,
          committedNewSaves: 0, counts: { alreadyDownloaded: 0, failed: 0 } })) };
      state.owned = true;
      if (state.failStartAck) { state.failStartAck--; throw new Error('Start acknowledgement lost'); }
      return { run: current() };
    }
    if (action === 'ENTRY_START') {
      state.calls.push(`source:${message.entryId}`); state.sourceStarted.resolve();
      if (state.sourceWait && message.entryId === 'a') await state.sourceWait.promise;
      if (entry?.id !== state.run.entries[state.run.currentIndex]?.id || state.run.state !== 'running') throw Object.assign(new Error('Source navigation was canceled'), { code: 'STALE_QUEUE' });
      entry.state = 'running'; entry.profile = { id: entry.id === 'a' ? '123' : '456', username: entry.username };
      const remaining = state.run.draft.totalLimit == null ? Infinity : state.run.draft.totalLimit - state.run.committedNewSaves;
      return { run: current(), job: { jobId: `child-${entry.id}`, profile: entry.profile,
        options: { mode: 'batches', batchSize: state.run.draft.batchSize, maxNewVideos: Math.min(entry.effectiveLimit ?? Infinity, remaining) } } };
    }
    if (action === 'PROGRESS') {
      if (state.failProgress) { state.failProgress--; throw new Error('Archive unavailable'); }
      const row = state.run.entries.find(value => value.id === message.entryId);
      row.committedNewSaves = message.snapshot.counts.saved;
      row.counts = plain(message.snapshot.counts);
      state.run.committedNewSaves = state.run.entries.reduce((sum, value) => sum + value.committedNewSaves, 0);
      state.archives.push(plain(message.snapshot)); return { run: current() };
    }
    if (action === 'ENTRY_FINISH') {
      const finished = state.run.entries.find(row => row.id === message.entryId);
      if (finished && finished.state !== 'running') return { run: current() };
      assert.ok(state.calls.includes(`finalize:${message.entryId}`), 'handoff follows successful child release');
      state.calls.push(`finish:${message.entryId}`); entry.state = message.summary.state;
      state.run.currentIndex++;
      if (state.run.currentIndex >= state.run.entries.length || state.run.draft.totalLimit != null && state.run.committedNewSaves >= state.run.draft.totalLimit) state.run.state = 'completed';
      if (state.failFinishAck) { state.failFinishAck--; throw new Error('Finish acknowledgement lost'); }
      return { run: current() };
    }
    if (action === 'PAUSE') { state.run.state = 'paused'; return { run: current() }; }
    if (action === 'RESUME') { state.run.state = 'running'; return { run: current() }; }
    if (action === 'SKIP') { entry.state = 'skipped'; state.run.currentIndex++; state.run.state = state.run.currentIndex < state.run.entries.length ? 'running' : 'completed'; return { run: current() }; }
    if (action === 'STOP') { state.run.state = 'stopped'; return { run: current() }; }
    if (action === 'SHOW_SOURCE') return {};
    if (action === 'REPORT') return { report: message.entryId ? { version: 1, profile: { username: 'creator_a' }, jobId: 'child-a', items: [] } : { type: 'reelnest_queue', version: 1, profiles: [] } };
    throw new Error(`Unexpected message ${action}`);
  }
  const timers = (fn, delay) => setTimeout(fn, delay >= 10000 ? 1 : Math.min(delay, 20));
  const context = vm.createContext({ setTimeout: timers, clearTimeout, Blob, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    crypto: { randomUUID: () => `new-${++clock}` }, location: { href: 'https://www.instagram.com/control/reels/' },
    CSSStyleSheet: class { replaceSync() {} }, document: { createElement: node },
    ReelSaverProfileCache: { async openLibrary(target, profile, options) {
      state.recoveryCacheOpens = (state.recoveryCacheOpens || 0) + 1;
      assert.equal(options?.existingOnly, true);
      if (state.wrongRecoveryRoot) throw Object.assign(new Error('Choose the original library'), { code: 'CACHE_RECONCILIATION_REQUIRED' });
      return { async verifyItem() { return state.recoverySaved || null; },
        directoryHandle: { async getFileHandle() { if (!state.recoveryFilePresent) throw Object.assign(new Error('Not found'), { name: 'NotFoundError' }); return {}; } },
        close() { state.recoveryCacheClosed = (state.recoveryCacheClosed || 0) + 1; } };
    } },
    ReelNestProfileJobRunner: { async create({ job, onChange }) {
      const number = job.profile.id === '123' ? 1 : 10;
      let value = { jobId: job.jobId, profile: job.profile, state: 'idle', phase: 'downloading', sourceExhausted: false,
        counts: { saved: 0, alreadyDownloaded: 0, failed: 0 }, items: [] };
      let task = null, paused = false, stopped = false, nextItem = 0;
      const count = Number.isFinite(job.options.maxNewVideos) ? Math.min(3, job.options.maxNewVideos) : 3;
      const emit = () => onChange(plain(value));
      const launch = () => {
        task = (async () => {
          while (nextItem < count) {
            if (state.transferWait) await state.transferWait.promise;
            if (stopped) { value.state = 'stopped'; emit(); return; }
            if (paused) { value.state = 'paused'; emit(); return; }
            state.writes.push(`${job.profile.username}:${nextItem}`);
            value.items.push(item(number + nextItem)); nextItem++; value.counts.saved++; emit();
            await new Promise(resolve => setTimeout(resolve, state.itemDelay || 4));
          }
          value.state = stopped ? 'stopped' : 'completed'; value.completionReason = 'profile_limit_reached'; emit();
        })();
      };
      const runner = {
        start() { state.calls.push(`start:${job.profile.username}`); value.state = 'running'; emit(); launch(); return plain(value); },
        pause() { if (['completed', 'stopped'].includes(value.state)) throw new Error('Cannot pause finalized runner'); paused = true; value.state = 'pausing'; emit(); },
        resume() { paused = false; value.state = 'running'; emit(); launch(); },
        stop() { stopped = true; if (value.state === 'idle') value.state = 'stopped'; else value.state = 'stopping'; emit(); },
        async waitForIdle() { await task; return plain(value); }, snapshot: () => plain(value),
        async finalize() {
          await task;
          if (state.failFinalize) { state.failFinalize--; throw new Error('History acknowledgement unavailable'); }
          if (value.state === 'idle') value.state = 'stopped';
          state.calls.push(`finalize:${job.profile.id === '123' ? 'a' : 'b'}`); return plain(value);
        },
      };
      state.runners.push(runner); return runner;
    } },
  });
  for (const source of sources) vm.runInContext(source, context);
  const root = node('root');
  const panel = context.ReelNestProfileQueuePanel.create({ root, request, readRoute: () => ({ type: 'profile', username: 'control' }),
    getDestination: () => state.destination || ({ kind: 'downloads' }), onBusyChange() {} });
  const role = value => walk(panel.element, entry => entry.dataset.role === value);
  await panel.load();
  return { context, state, panel, role };
}
async function until(check, title) {
  for (let attempt = 0; attempt < 250; attempt++) { if (check()) return; await tick(); }
  throw new Error(`Timed out: ${title}`);
}

test('queue draft validates input, preserves valid lines, deduplicates and ignores synthetic edits', async () => {
  const f = await fixture();
  f.role('queue-input').value = '@New_Creator\nhttps://example.com/foreign\n@CREATOR_A';
  await f.role('queue-add').event('click', { isTrusted: false });
  assert.equal(f.state.requests.filter(value => value.type.endsWith('DRAFT_SET')).length, 0);
  await f.role('queue-add').event('click'); await tick();
  assert.equal(f.state.draft.entries.length, 3);
  assert.equal(f.state.draft.entries[2].username, 'new_creator');
  assert.match(f.role('queue-input-errors').textContent, /Line 2/);
  assert.match(f.role('queue-status').textContent, /1 already in the queue/);
});

test('queue serially finalizes each profile before opening the next and retains configured caps', async () => {
  const f = await fixture();
  await f.role('queue-start').event('click');
  await until(() => !f.panel.isBusy(), 'queue completion');
  assert.deepEqual(f.state.writes, ['creator_a:0', 'creator_a:1', 'creator_b:0']);
  assert.ok(f.state.calls.indexOf('finalize:a') < f.state.calls.indexOf('source:b'));
  assert.ok(f.state.calls.indexOf('finish:a') < f.state.calls.indexOf('source:b'));
  assert.equal(f.state.run.committedNewSaves, 3);
  assert.match(f.role('queue-status').textContent, /3 new videos saved/);
  assert.equal(f.role('queue-report').hidden, false);
});

test('pause waits at the profile boundary and Resume continues without resetting saved counts', async () => {
  const f = await fixture({ transferWait: deferred() });
  await f.role('queue-start').event('click');
  await until(() => f.state.runners.length === 1, 'first child');
  await f.role('queue-pause').event('click');
  f.state.transferWait.resolve();
  await until(() => f.state.runners[0].snapshot().state === 'paused', 'child pause');
  assert.equal(f.state.calls.includes('source:b'), false);
  assert.equal(f.panel.isBusy(), true);
  await f.role('queue-resume').event('click');
  await until(() => !f.panel.isBusy(), 'resumed completion');
  assert.equal(f.state.run.committedNewSaves, 3);
  assert.equal(f.state.writes.length, 3);
});

test('Skip while the helper is loading fences the old response and starts only the next profile', async () => {
  const sourceWait = deferred(); const f = await fixture({ sourceWait });
  await f.role('queue-start').event('click'); await f.state.sourceStarted.promise;
  await f.role('queue-skip').event('click'); sourceWait.resolve();
  await until(() => !f.panel.isBusy(), 'skip and completion');
  assert.equal(f.state.calls.includes('start:creator_a'), false);
  assert.deepEqual(f.state.writes, ['creator_b:0']);
  assert.equal(f.state.run.entries[0].state, 'skipped');
});

test('a failed child release pauses handoff and retries metadata before another profile starts', async () => {
  const f = await fixture({ failFinalize: 1 });
  await f.role('queue-start').event('click');
  await until(() => /Retry release/.test(f.role('queue-resume').textContent), 'release failure');
  assert.equal(f.state.calls.includes('source:b'), false);
  const physicalBefore = f.state.writes.length;
  await f.role('queue-resume').event('click');
  await until(() => !f.panel.isBusy(), 'release retry and completion');
  assert.equal(physicalBefore, 2);
  assert.equal(f.state.writes.length, 3, 'the first child is not downloaded again');
});

test('Stop settles an active child and leaves later profiles unrun', async () => {
  const f = await fixture({ transferWait: deferred() });
  await f.role('queue-start').event('click');
  await until(() => f.state.runners.length === 1, 'child start');
  const stopping = f.role('queue-stop').event('click'); f.state.transferWait.resolve(); await stopping;
  await until(() => !f.panel.isBusy(), 'stop settled');
  assert.equal(f.state.run.state, 'stopped');
  assert.equal(f.state.calls.includes('source:b'), false);
  assert.equal(f.state.run.entries[1].state, 'pending');
  assert.equal(f.state.writes.length, 0);
});

test('loading saved results never starts a previous queue automatically', async () => {
  const f = await fixture({ run: { id: 'previous', state: 'interrupted', currentIndex: 0, committedNewSaves: 5,
    entries: [{ id: 'a', username: 'creator_a', profile: { id: '123', username: 'creator_a' }, state: 'stopped', committedNewSaves: 5, counts: { failed: 0 } }] } });
  assert.equal(f.panel.isBusy(), false);
  assert.equal(f.role('queue-report').hidden, false);
  assert.equal(f.state.requests.some(value => value.type.endsWith('_START')), false);
  assert.match(f.role('queue-status').textContent, /Interrupted/);
});

test('a lost Start acknowledgement recovers only the newly owned run without starting another queue', async () => {
  const f = await fixture({ failStartAck: 1 });
  await f.role('queue-start').event('click');
  await until(() => !f.panel.isBusy(), 'recovered Start completes');
  assert.equal(f.state.requests.filter(message => message.type.endsWith('_START')).length, 3, 'one queue start plus two child starts');
  assert.equal(f.state.run.committedNewSaves, 3);
  assert.equal(f.state.writes.length, 3);
});

test('a lost entry-finish response retries that handoff before resuming without duplicate files', async () => {
  const f = await fixture({ failFinishAck: 1 });
  await f.role('queue-start').event('click');
  await until(() => /Retry release/.test(f.role('queue-resume').textContent), 'lost finish response');
  assert.equal(f.state.calls.includes('source:b'), false);
  assert.equal(f.state.writes.length, 2);
  await f.role('queue-resume').event('click');
  await until(() => !f.panel.isBusy(), 'handoff retry completes');
  assert.equal(f.state.calls.filter(value => value === 'finish:a').length, 1);
  assert.equal(f.state.writes.length, 3);
});

test('source lifecycle events pause only the currently owned queue', async () => {
  const f = await fixture({ transferWait: deferred() });
  await f.role('queue-start').event('click');
  await until(() => f.state.runners.length === 1, 'active child');
  f.panel.handleEvent({ ...plain(f.state.run), id: 'other-run', state: 'paused', error: { message: 'Wrong queue' } });
  assert.equal(f.state.runners[0].snapshot().state, 'running');
  f.state.run.revision = 10;
  f.panel.handleEvent(plain(f.state.run));
  f.panel.handleEvent({ ...plain(f.state.run), revision: 9, state: 'paused', error: { message: 'Stale event' } });
  assert.equal(f.state.runners[0].snapshot().state, 'running', 'an older lifecycle revision cannot pause a resumed run');
  f.state.run.state = 'paused';
  f.panel.handleEvent({ ...plain(f.state.run), state: 'paused', error: { message: 'Source tab closed' } });
  f.state.transferWait.resolve();
  await until(() => f.state.runners[0].snapshot().state === 'paused', 'source event honored');
  assert.equal(f.state.calls.includes('source:b'), false);
  await f.role('queue-stop').event('click');
  await until(() => !f.panel.isBusy(), 'cleanup');
});

function interruptedFolder(extra = {}) {
  return { run: { id: 'interrupted-run', state: 'interrupted', revision: 1, currentIndex: 0, committedNewSaves: 0,
    options: { destination: 'folder', skipExisting: true }, reservation: { entryId: 'a', mediaId: '1', attemptId: 'old-attempt' },
    entries: [{ id: 'a', username: 'creator_a', profile: { id: '123', username: 'creator_a' }, state: 'running', committedNewSaves: 0, counts: {} }] },
    recoveryItem: { mediaId: '1', shortcode: 'B', state: 'unknown', filename: 'creator_B (1).mp4' },
    destination: { kind: 'folder', handle: { name: 'Original library' } }, ...extra };
}

test('a new queue reconciles an interrupted folder save from its exact verified cache result before Start', async () => {
  const f = await fixture(interruptedFolder({ recoverySaved: { filename: 'creator_B (1).mp4', bytesWritten: 2048 } }));
  await f.role('queue-start').event('click');
  await until(() => !f.panel.isBusy(), 'recovered queue completes');
  assert.deepEqual(f.state.recoveryProof, { state: 'saved', filename: 'creator_B (1).mp4', bytesWritten: 2048 });
  assert.equal(f.state.recoveryCacheClosed, 1);
  const actions = f.state.requests.map(message => message.type);
  assert.ok(actions.indexOf('REEL_SAVER_QUEUE_RECONCILE') < actions.indexOf('REEL_SAVER_QUEUE_START'));
  assert.equal(f.state.recoveryLeased, false);
});

test('an older cached copy cannot prove the new interrupted copy; exact absent output is canceled', async () => {
  const f = await fixture(interruptedFolder({ recoverySaved: { filename: 'creator_B.mp4', bytesWritten: 2048 } }));
  await f.role('queue-start').event('click');
  await until(() => !f.panel.isBusy(), 'queue after absent output');
  assert.deepEqual(f.state.recoveryProof, { state: 'canceled', filename: 'creator_B (1).mp4' });
});

test('wrong library or an unverified present output leaves recovery pending without starting a queue', async () => {
  for (const extra of [{ wrongRecoveryRoot: true }, { recoveryFilePresent: true }]) {
    const f = await fixture(interruptedFolder(extra));
    await f.role('queue-start').event('click');
    assert.equal(f.state.requests.some(message => message.type === 'REEL_SAVER_QUEUE_START'), false);
    assert.equal(f.state.recoveryProof, undefined);
    assert.ok(f.state.run.reservation);
    assert.equal(f.state.recoveryLeased, false);
  }
});

test('a lost recovery acknowledgement refreshes authoritative history before the next Start attempt', async () => {
  const f = await fixture(interruptedFolder({ recoverySaved: { filename: 'creator_B (1).mp4', bytesWritten: 2048 }, failRecoveryAck: 1 }));
  await f.role('queue-start').event('click');
  assert.equal(f.state.requests.some(message => message.type === 'REEL_SAVER_QUEUE_START'), false);
  assert.equal(f.state.run.reservation, null);
  await f.role('queue-start').event('click');
  await until(() => !f.panel.isBusy(), 'new run after lost recovery acknowledgement');
  assert.equal(f.state.requests.filter(message => message.type === 'REEL_SAVER_QUEUE_RECONCILE').length, 1);
});

test('Chrome recovery and a lookup-only interruption do not open or initialize a library', async () => {
  for (const destination of ['downloads', 'folder']) {
    const extra = interruptedFolder({ destination: { kind: 'downloads' } });
    extra.run.options.destination = destination;
    if (destination === 'folder') extra.recoveryItem = { mediaId: '1', shortcode: 'B', state: 'resolving' };
    else extra.recoveryItem.downloadId = 42;
    const f = await fixture(extra);
    await f.role('queue-start').event('click');
    await until(() => !f.panel.isBusy(), 'automatic interrupted-operation check');
    assert.equal(f.state.recoveryProof, null, 'the worker performs the browser/no-intent proof');
    assert.equal(f.state.recoveryCacheOpens, undefined);
    assert.equal(f.state.recoveryLeased, false);
  }
});
