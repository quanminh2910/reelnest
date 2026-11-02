import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { handleProfileQueueMessage, cleanupProfileQueueTab } from '../src/background/profile-queue-background.js';
import { handleBulkMessage } from '../src/background/bulk-background.js';
import { createMemoryQueueBackend, setQueueStoreBackendForTests } from '../src/background/profile-queue-store.js';
import { QUEUE_OWNER, BULK_ACTIVE } from '../src/background/profile-queue-owner.js';

const extensionId = 'profile-queue-integration';
const hostId = 7;
const hostUrl = 'https://www.instagram.com/host_creator/reels/';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const code = input => { let value = BigInt(input), result = ''; do { result = alphabet[Number(value % 64n)] + result; value /= 64n; } while (value); return result; };
const media = input => ({ mediaId: String(input), shortcode: code(input) });
const sources = await Promise.all(['../src/shared/download-limits.js', '../src/content/bulk-queue.js', '../src/content/profile-job-runner.js'].map(name => readFile(new URL(name, import.meta.url), 'utf8')));
const plain = value => structuredClone(value);
const sender = (tabId = hostId, documentId = 'host-document', url = hostUrl) => ({ id: extensionId, frameId: 0,
  tab: { id: tabId, url }, url, documentId });
const q = (action, values = {}) => ({ type: `REEL_SAVER_QUEUE_${action}`, ...values });
const b = (action, job, values = {}) => ({ type: `REEL_SAVER_BULK_${action}`, jobId: job.jobId, ...values });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function fixture(options = {}) {
  const backend = createMemoryQueueBackend();
  const store = setQueueStoreBackendForTests(backend);
  const state = { backend, local: {}, session: {}, tabs: new Map([[hostId, { id: hostId, url: hostUrl, status: 'complete', autoDiscardable: true, documentId: 'host-document' }]]),
    downloads: [], sourceCalls: [], tabChanges: [], createdTabs: [], removedTabs: [], profiles: new Map(), nextTab: 99,
    folderSelections: [], folders: new Map(), folderLease: false, nativeWrites: 0, cacheCloses: 0, ...options };
  for (const [index, username] of ['alpha', 'beta', 'gamma', 'delta'].entries()) {
    state.profiles.set(username, { profile: { id: String(900 + index), username }, ids: Array.from({ length: 80 }, (_, position) => String(100000 * (index + 1) + position + 1)) });
  }
  const storage = name => ({
    async get(key) {
      if (key == null) return plain(state[name]);
      if (Array.isArray(key)) return Object.fromEntries(key.map(value => [value, plain(state[name][value])]));
      return { [key]: plain(state[name][key]) };
    },
    async set(values) {
      if (name === 'session' && state.ownerWriteGate && values[QUEUE_OWNER]?.navigating === true && !state.ownerWriteGated) {
        state.ownerWriteGated = true; state.ownerWriting.resolve(); await state.ownerWriteGate.promise;
      }
      if (state.failSessionWrite && name === 'session') { state.failSessionWrite = false; throw new Error('Session unavailable'); }
      Object.assign(state[name], plain(values));
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[name][key]; },
  });
  const chrome = {
    runtime: { id: extensionId }, storage: { local: storage('local'), session: storage('session') },
    tabs: {
      async get(tabId) { const tab = state.tabs.get(tabId); if (!tab) throw new Error('Tab closed'); return plain(tab); },
      async create(value) {
        const id = ++state.nextTab;
        const tab = { id, ...value, status: 'complete', autoDiscardable: true, documentId: `source-${id}-1`, navigation: 1 };
        state.tabs.set(id, tab); state.createdTabs.push(plain(tab)); return plain(tab);
      },
      async update(tabId, patch) {
        const tab = state.tabs.get(tabId); if (!tab) throw new Error('Tab closed');
        state.tabChanges.push({ tabId, patch: plain(patch) });
        Object.assign(tab, patch);
        if (patch.url) { tab.navigation++; tab.documentId = `source-${tabId}-${tab.navigation}`; }
        return plain(tab);
      },
      async remove(tabId) { state.tabs.delete(tabId); state.removedTabs.push(tabId); },
    },
    scripting: { async executeScript(value) {
      const tab = state.tabs.get(value.target.tabId); if (!tab) throw new Error('Tab closed');
      if (value.target.documentIds && !value.target.documentIds.includes(tab.documentId)) throw new Error('Document replaced');
      const username = new URL(tab.url).pathname.split('/')[1];
      const fixtureProfile = state.profiles.get(username);
      const action = value.args?.[0]?.action || 'probe';
      state.sourceCalls.push({ action, tabId: tab.id, documentId: tab.documentId, target: plain(value.target), username });
      if (action === 'probe' && state.probeGate) { state.probing.resolve(); await state.probeGate.promise; }
      if (action === 'identify' && state.identifyGate) { state.identifying.resolve(); await state.identifyGate.promise; }
      if (action === 'page' && state.pageGate) { state.paging.resolve(); await state.pageGate.promise; }
      if (action === 'resolve' && state.resolveGate) { state.resolving.resolve(); await state.resolveGate.promise; }
      let result;
      if (action === 'probe') result = { ready: true, username };
      else if (!fixtureProfile) result = { ok: false, error: { code: 'PROFILE_UNAVAILABLE', message: 'Profile unavailable' } };
      else if (action === 'identify') result = { ok: true, profile: fixtureProfile.profile };
      else if (action === 'page') {
        const offset = Number(value.args[0].cursor || 0), entries = fixtureProfile.ids.slice(offset, offset + 12).map(media), next = offset + entries.length;
        result = { ok: true, profile: fixtureProfile.profile, page: { items: entries, nextCursor: next < fixtureProfile.ids.length ? String(next) : null, hasMore: next < fixtureProfile.ids.length } };
      } else {
        const item = value.args[0].item;
        result = { ok: true, profile: fixtureProfile.profile, media: { ...item, username,
          pageUrl: `https://www.instagram.com/reel/${item.shortcode}/`,
          url: `https://scontent.cdninstagram.com/${item.mediaId}.mp4?signature=temporary`, width: 720, height: 1280 } };
      }
      return [{ frameId: 0, documentId: tab.documentId, result }];
    } },
    downloads: {
      async download(value) {
        const id = state.downloads.length + 1;
        state.downloads.push({ id, filename: value.filename, byExtensionId: extensionId, url: value.url, finalUrl: value.url,
          state: state.downloadInProgress ? 'in_progress' : 'complete', fileSize: 2048, exists: true, mime: 'video/mp4', startTime: new Date().toISOString() });
        if (state.failLedgerAfterAcceptance) { state.failLedgerAfterAcceptance = false; backend.state.failWrite = true; }
        return id;
      },
      async search(query) {
        const records = state.downloads.filter(value => (query.id == null || value.id === query.id) &&
          (!query.state || value.state === query.state) && (query.exists === undefined || value.exists === query.exists) &&
          (!query.filenameRegex || new RegExp(query.filenameRegex).test(value.filename)));
        return plain(records.slice(0, query.limit || records.length));
      },
      async cancel(id) { const value = state.downloads.find(record => record.id === id); if (value?.state === 'in_progress') { value.state = 'interrupted'; value.error = 'USER_CANCELED'; } },
    },
  };
  globalThis.chrome = chrome;
  return { state, chrome, store,
    queue: (action, values, source = sender()) => handleProfileQueueMessage(q(action, values), source),
    bulk: (action, job, values, source = sender()) => handleBulkMessage(b(action, job, values), source),
  };
}

const draft = (names = ['alpha', 'beta'], overrides = {}) => ({ schemaVersion: 1, batchSize: 35, defaultLimit: 1, totalLimit: null,
  entries: names.map((username, index) => ({ id: `entry-${index + 1}`, username, limitMode: 'inherit', maxNewVideos: null })), ...overrides });
async function start(f, selected = draft(), destination = 'folder') {
  const result = await f.queue('START', { draft: selected, options: { destination, skipExisting: true } });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.run;
}
async function startEntry(f, run) {
  const entry = run.entries[run.currentIndex];
  const result = await f.queue('ENTRY_START', { runId: run.id, entryId: entry.id });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
async function childPage(f, job, cursor = null) {
  const result = await f.bulk('PAGE', job, { cursor }); assert.equal(result.ok, true, JSON.stringify(result)); return result.page;
}
async function directNativeSave(f, job, entry, attemptId = 'save-one') {
  const resolved = await f.bulk('RESOLVE', job, { item: entry, attemptId });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const result = { state: 'saved', filename: resolved.filename, bytesWritten: 2048 };
  const saved = await f.bulk('ITEM_RESULT', job, { item: entry, attemptId, result });
  assert.equal(saved.ok, true, JSON.stringify(saved)); return result;
}
async function finish(f, run, job, summary = {}) {
  const released = await f.bulk('END', job, { state: summary.state || 'completed' }); assert.equal(released.ok, true, JSON.stringify(released));
  const result = await f.queue('ENTRY_FINISH', { runId: run.id, entryId: run.entries[run.currentIndex].id, jobId: job.jobId,
    summary: { state: 'completed', completionReason: 'profile_limit_reached', sourceExhausted: false, ...summary } });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.run;
}

async function runnerFor(f, run, job, root) {
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
    ReelSaverProfileCache: { async openLibrary(handle, profile) {
      assert.equal(handle, root); assert.equal(f.state.folderLease, false, 'a previous profile cache still owns the writer');
      f.state.folderLease = true; f.state.folderSelections.push(profile.id);
      if (!f.state.folders.has(profile.id)) f.state.folders.set(profile.id, { files: new Map(), profile: plain(profile) });
      const directory = f.state.folders.get(profile.id);
      return { profile, folderName: profile.username, directoryHandle: directory,
        verifyItem: async entry => directory.files.get(entry.mediaId) ? { cacheHit: true, ...directory.files.get(entry.mediaId) } : null,
        reservedNamesFor: () => new Set(), beginWrite: async () => {}, abandonWrite: async () => {},
        async commitSaved(entry, result) { directory.files.set(entry.mediaId, plain(result)); },
        close() { f.state.folderLease = false; f.state.cacheCloses++; },
      };
    } },
    ReelSaverFolderWriter: { async saveToFolder(value) {
      await value.beforeCreate({ filename: value.filename, bytesWritten: 2048 });
      f.state.nativeWrites++; return { filename: value.filename, bytesWritten: 2048 };
    } },
  });
  for (const source of sources) vm.runInContext(source, context);
  return context.ReelNestProfileJobRunner.create({ job, target: { kind: run.options.destination,
    ...(run.options.destination === 'folder' ? { handle: root } : {}) }, pollIntervalMs: 0,
    request: async message => {
      const result = await handleBulkMessage(message, sender());
      if (!result?.ok) throw Object.assign(new Error(result?.error?.message || 'Request failed'), result?.error);
      return result;
    },
  });
}

test('a full two-profile handoff reuses one background source and one library root in both destinations', async t => {
  for (const destination of ['folder', 'downloads']) await t.test(destination, async () => {
    const f = fixture(), root = { name: 'Selected library root' }; let run = await start(f, draft(), destination);
    const sourceIds = [];
    for (let index = 0; index < 2; index++) {
      const started = await startEntry(f, run); const job = started.job;
      sourceIds.push(job.queue.sourceTabId);
      const runner = await runnerFor(f, run, job, root); runner.start();
      const ended = await runner.waitForIdle();
      assert.equal(ended.counts.saved, 1); assert.equal(ended.completionReason, 'profile_limit_reached');
      assert.equal((await f.queue('PROGRESS', { runId: run.id, entryId: run.entries[run.currentIndex].id, jobId: job.jobId, snapshot: plain(ended) })).ok, true);
      const final = await runner.finalize();
      const next = await f.queue('ENTRY_FINISH', { runId: run.id, entryId: run.entries[run.currentIndex].id, jobId: job.jobId, summary: plain(final) });
      assert.equal(next.ok, true, JSON.stringify(next)); run = next.run;
    }
    assert.equal(run.state, 'completed'); assert.equal(run.committedNewSaves, 2);
    assert.equal(new Set(sourceIds).size, 1); assert.equal(f.state.createdTabs.length, 1);
    assert.equal(f.state.createdTabs[0].active, false);
    assert.equal(f.state.tabs.get(hostId).url, hostUrl); assert.equal(f.state.tabs.get(hostId).autoDiscardable, true);
    assert.equal(f.state.session[QUEUE_OWNER].active, false);
    assert.deepEqual(f.state.removedTabs, [sourceIds[0]]);
    assert.ok(f.state.sourceCalls.every(call => call.tabId !== hostId));
    assert.ok(f.state.sourceCalls.filter(call => call.action !== 'probe').every(call => call.target.documentIds?.length === 1));
    if (destination === 'folder') {
      assert.deepEqual(f.state.folderSelections, ['900', '901']); assert.equal(f.state.cacheCloses, 2); assert.equal(f.state.folders.size, 2);
      assert.equal(f.state.nativeWrites, 2); assert.equal(f.state.downloads.length, 0);
    } else { assert.equal(f.state.downloads.length, 2); assert.equal(f.state.nativeWrites, 0); }
  });
});

test('mixed profile limits enforce the shared cap as 25, 10, 25 with remaining entries not run', async () => {
  const f = fixture(); const selected = draft(['alpha', 'beta', 'gamma', 'delta'], { defaultLimit: 25, totalLimit: 60 });
  selected.entries[1] = { ...selected.entries[1], limitMode: 'custom', maxNewVideos: 10 };
  selected.entries[2] = { ...selected.entries[2], limitMode: 'unlimited' };
  let run = await start(f, selected, 'downloads');
  for (const amount of [25, 10, 25]) {
    const started = await startEntry(f, run); assert.equal(started.job.options.maxNewVideos, amount);
    const runner = await runnerFor(f, run, started.job); runner.start();
    const result = await runner.waitForIdle(); assert.equal(result.counts.saved, amount);
    const final = await runner.finalize();
    run = (await f.queue('ENTRY_FINISH', { runId: run.id, entryId: run.entries[run.currentIndex].id, jobId: started.job.jobId, summary: plain(final) })).run;
  }
  assert.equal(run.state, 'completed'); assert.equal(run.completionReason, 'queue_limit_reached');
  assert.equal(run.committedNewSaves, 60); assert.deepEqual(run.entries.map(entry => entry.committedNewSaves), [25, 10, 25, 0]);
  assert.equal(run.entries[3].state, 'not_run'); assert.equal(f.state.downloads.length, 60);
  assert.equal(f.state.sourceCalls.some(call => call.username === 'delta'), false);
  const report = await f.queue('REPORT', { runId: run.id }); assert.equal(report.ok, true);
  assert.equal(report.report.profiles[2].report.maxNewVideos, null); assert.equal(report.report.profiles[2].report.sourceExhausted, false);
  const serialized = JSON.stringify(report.report);
  assert.equal(serialized.includes('signature='), false); assert.equal(serialized.includes('https:'), false);
});

test('a native save awaiting acknowledgement prevents release and profile advancement', async () => {
  const f = fixture(); let run = await start(f); const first = await startEntry(f, run), page = await childPage(f, first.job);
  const item = page.items[0], attemptId = 'pending-native';
  assert.equal((await f.bulk('RESOLVE', first.job, { item, attemptId })).ok, true);
  assert.equal((await f.bulk('END', first.job, { state: 'stopped' })).error.code, 'RECONCILIATION_REQUIRED');
  const premature = await f.queue('ENTRY_FINISH', { runId: run.id, entryId: run.entries[0].id, jobId: first.job.jobId });
  assert.equal(premature.error.code, 'RECONCILIATION_REQUIRED');
  assert.equal(f.state.sourceCalls.some(call => call.username === 'beta'), false);
  assert.equal((await f.bulk('ITEM_RESULT', first.job, { item, attemptId, result: { state: 'saved', filename: `alpha_${item.shortcode}.mp4`, bytesWritten: 2048 } })).ok, true);
  run = await finish(f, run, first.job);
  assert.equal(run.committedNewSaves, 1); assert.equal((await startEntry(f, run)).job.profile.username, 'beta');
});

test('native durable-result failure keeps its allowance and replays a single physical receipt', async () => {
  const f = fixture(); const run = await start(f); const { job } = await startEntry(f, run), page = await childPage(f, job);
  const item = page.items[0], attemptId = 'durable-replay';
  const response = await f.bulk('RESOLVE', job, { item, attemptId }); assert.equal(response.ok, true);
  const result = { state: 'saved', filename: response.filename, bytesWritten: 2048 };
  f.state.backend.state.failWrite = true;
  assert.equal((await f.bulk('ITEM_RESULT', job, { item, attemptId, result })).error.code, 'CACHE_QUEUE_WRITE_FAILED');
  assert.equal((await f.store.getRun(run.id)).committedNewSaves, 0);
  assert.equal((await f.store.getRun(run.id)).reservation.mediaId, item.mediaId);
  assert.equal((await f.bulk('ITEM_RESULT', job, { item, attemptId, result })).ok, true);
  assert.equal((await f.bulk('ITEM_RESULT', job, { item, attemptId, result })).ok, true);
  assert.equal((await f.store.getRun(run.id)).committedNewSaves, 1);
  assert.equal(f.state.sourceCalls.filter(call => call.action === 'resolve').length, 1);
});

test('a failed session reservation releases its durable slot before any source resolution or physical save', async () => {
  const f = fixture(); const run = await start(f), { job } = await startEntry(f, run), page = await childPage(f, job);
  const item = page.items[0]; f.state.failSessionWrite = true;
  const failed = await f.bulk('RESOLVE', job, { item, attemptId: 'unrecorded-reservation' });
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'STORAGE_FAILED');
  assert.equal((await f.store.getRun(run.id)).reservation, null);
  assert.equal((await f.store.getRun(run.id)).committedNewSaves, 0);
  assert.equal(f.state.sourceCalls.some(call => call.action === 'resolve'), false);
  assert.equal(f.state.session[`reel-saver:bulk:${job.jobId}:operation:${item.mediaId}`], undefined);
  await directNativeSave(f, job, item, 'retry-reservation');
  assert.equal((await f.store.getRun(run.id)).committedNewSaves, 1);
  assert.equal(f.state.sourceCalls.filter(call => call.action === 'resolve').length, 1);
});

test('old host documents, source-tab senders and arbitrary target-tab requests cannot control the queue', async () => {
  const f = fixture(); const run = await start(f); const { job } = await startEntry(f, run);
  assert.equal((await f.queue('PAUSE', { runId: run.id }, sender(hostId, 'old-document'))).error.code, 'STALE_JOB');
  const source = f.state.tabs.get(job.queue.sourceTabId);
  assert.equal((await f.queue('STOP', { runId: run.id }, sender(source.id, source.documentId, source.url))).error.code, 'STALE_JOB');
  assert.equal((await f.queue('STOP', { runId: run.id, tabId: source.id })).error.code, 'INVALID_SENDER');
  assert.equal((await f.bulk('PAGE', job, { cursor: null }, sender(source.id, source.documentId, source.url))).error.code, 'STALE_JOB');
  assert.equal((await handleBulkMessage({ type: 'REEL_SAVER_BULK_START', options: { mode: 'batches', batchSize: 35, destination: 'downloads' } }, sender())).error.code, 'QUEUE_BUSY');
  assert.equal((await f.queue('LEASE_BEGIN', { kind: 'clear' })).error.code, 'QUEUE_BUSY');
});

test('source document replacement rejects the old bound query before any physical output', async () => {
  const f = fixture(); const run = await start(f); const { job } = await startEntry(f, run);
  f.state.tabs.get(job.queue.sourceTabId).documentId = 'unexpected-new-source-document';
  const result = await f.bulk('PAGE', job, { cursor: null });
  assert.equal(result.ok, false); assert.equal(f.state.downloads.length, 0); assert.equal(f.state.nativeWrites, 0);
  assert.equal((await f.store.getRun(run.id)).committedNewSaves, 0);
});

test('Pause, Skip and Stop invalidate an ENTRY_START already waiting for background readiness', async t => {
  for (const action of ['PAUSE', 'SKIP', 'STOP']) await t.test(action, async () => {
    const probing = deferred(), gate = deferred(); const f = fixture({ probing, probeGate: gate }); const run = await start(f);
    const preparing = f.queue('ENTRY_START', { runId: run.id, entryId: run.entries[0].id }); await probing.promise;
    const control = await f.queue(action, { runId: run.id, entryId: run.entries[0].id }); assert.equal(control.ok, true, JSON.stringify(control));
    gate.resolve(); const result = await preparing; assert.equal(result.ok, false);
    assert.equal(f.state.session[QUEUE_OWNER].childJobId, null);
    assert.equal(f.state.sourceCalls.some(call => call.action === 'resolve'), false);
    const latest = await f.store.getRun(run.id);
    if (action === 'PAUSE') assert.equal(latest.state, 'paused');
    if (action === 'SKIP') { assert.equal(latest.entries[0].state, 'skipped'); assert.equal(latest.currentIndex, 1); }
    if (action === 'STOP') { assert.equal(latest.state, 'stopped'); assert.equal(latest.entries[1].state, 'not_run'); }
  });
});

test('a late discovery result cannot register the old profile after handoff to the next source document', async () => {
  const f = fixture(); let run = await start(f); const { job } = await startEntry(f, run);
  const paging = deferred(), gate = deferred(); f.state.paging = paging; f.state.pageGate = gate;
  const pendingPage = f.bulk('PAGE', job, { cursor: null }); await paging.promise;
  run = await finish(f, run, job, { state: 'completed', completionReason: 'feed_exhausted' });
  delete f.state.pageGate; const next = await startEntry(f, run);
  gate.resolve(); const stale = await pendingPage; assert.equal(stale.ok, false);
  assert.equal((await f.queue('PROGRESS', { runId: run.id, entryId: run.entries[0].id, jobId: job.jobId, snapshot: { jobId: job.jobId, items: [] } })).error.code, 'STALE_JOB');
  assert.equal(f.state.session[BULK_ACTIVE].jobId, next.job.jobId);
  assert.equal(Object.keys(f.state.session).some(key => key.startsWith(`reel-saver:bulk:${job.jobId}:member:`)), false);
});

test('a delayed source-owner write cannot overwrite a newer Pause command', async () => {
  const writing = deferred(), gate = deferred(); const f = fixture({ ownerWriting: writing, ownerWriteGate: gate });
  const run = await start(f);
  const pending = f.queue('ENTRY_START', { runId: run.id, entryId: run.entries[0].id });
  await writing.promise;
  const pausing = f.queue('PAUSE', { runId: run.id });
  gate.resolve(); const paused = await pausing; assert.equal(paused.ok, true);
  const result = await pending;
  assert.equal(result.ok, false, 'an older source-navigation write must not restart the queue');
  assert.equal(f.state.session[QUEUE_OWNER].control, 'paused');
  assert.equal(f.state.session[QUEUE_OWNER].childJobId, null);
  assert.equal((await f.store.getRun(run.id)).state, 'paused');
});

test('a missing source tab pauses the queue and Resume reopens/rebinds its child without losing allowance', async () => {
  const f = fixture(); const run = await start(f); const { job } = await startEntry(f, run);
  await f.chrome.tabs.remove(job.queue.sourceTabId); await cleanupProfileQueueTab(job.queue.sourceTabId, { closed: true });
  assert.equal((await f.store.getRun(run.id)).state, 'paused');
  const resumed = await f.queue('RESUME', { runId: run.id }); assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const owner = f.state.session[QUEUE_OWNER]; assert.notEqual(owner.sourceTabId, job.queue.sourceTabId);
  assert.equal((await f.bulk('PAGE', job, { cursor: null })).ok, true);
  assert.equal((await f.store.getRun(run.id)).committedNewSaves, 0);
});

test('latest reports survive host loss while the run is interrupted and never autoplays', async () => {
  const f = fixture(); const run = await start(f); const { job } = await startEntry(f, run), page = await childPage(f, job);
  await directNativeSave(f, job, page.items[0]);
  await cleanupProfileQueueTab(hostId, { closed: true });
  const latest = await f.queue('LATEST'); assert.equal(latest.ok, true); assert.equal(latest.run.state, 'interrupted'); assert.equal(latest.run.committedNewSaves, 1);
  const count = f.state.sourceCalls.length;
  const report = await f.queue('REPORT', { runId: run.id, entryId: run.entries[0].id });
  assert.equal(report.ok, true); assert.equal(report.report.items.filter(item => item.state === 'saved').length, 1);
  assert.equal(f.state.sourceCalls.length, count); assert.equal(f.state.session[QUEUE_OWNER].active, false);
});

test('retry visits only failed IDs and preserves the original profile allowance and earlier saves', async () => {
  const f = fixture(); let run = await start(f, draft(['alpha'], { defaultLimit: 2 }));
  const first = await startEntry(f, run), page = await childPage(f, first.job);
  await directNativeSave(f, first.job, page.items[0], 'first-success');
  const failedItem = page.items[1], failedAttempt = 'first-failure';
  assert.equal((await f.bulk('RESOLVE', first.job, { item: failedItem, attemptId: failedAttempt })).ok, true);
  assert.equal((await f.bulk('ITEM_RESULT', first.job, { item: failedItem, attemptId: failedAttempt,
    result: { state: 'failed', error: { code: 'FILE_FAILED', message: 'Fixture write failed' } } })).ok, true);
  run = await finish(f, run, first.job, { state: 'completed_with_errors', completionReason: 'feed_exhausted', sourceExhausted: true });
  assert.equal(run.committedNewSaves, 1); assert.equal(run.entries[0].counts.failed, 1);
  const retry = await f.queue('RETRY', { runId: run.id }); assert.equal(retry.ok, true, JSON.stringify(retry)); run = retry.run;
  const next = await startEntry(f, run); assert.equal(next.job.options.maxNewVideos, 1);
  assert.deepEqual(next.job.retryItems.map(item => item.mediaId), [failedItem.mediaId]);
  const sourcePages = f.state.sourceCalls.filter(call => call.action === 'page').length;
  const runner = await runnerFor(f, run, next.job, { name: 'Selected library root' }); runner.start();
  const completed = await runner.waitForIdle(); assert.equal(completed.counts.saved, 1);
  assert.equal(f.state.sourceCalls.filter(call => call.action === 'page').length, sourcePages);
  await runner.finalize();
  run = (await f.queue('ENTRY_FINISH', { runId: run.id, entryId: run.entries[0].id, jobId: next.job.jobId, summary: plain(completed) })).run;
  assert.equal(run.committedNewSaves, 2); assert.equal(run.entries[0].counts.saved, 2); assert.equal(run.entries[0].counts.failed, 0);
});

test('retry cannot acquire queue ownership while an ordinary bulk job owns the worker', async () => {
  const f = fixture(); let run = await start(f, draft(['alpha']));
  const first = await startEntry(f, run), page = await childPage(f, first.job), failedItem = page.items[0];
  assert.equal((await f.bulk('RESOLVE', first.job, { item: failedItem, attemptId: 'failed-for-retry' })).ok, true);
  assert.equal((await f.bulk('ITEM_RESULT', first.job, { item: failedItem, attemptId: 'failed-for-retry',
    result: { state: 'failed', error: { code: 'FILE_FAILED', message: 'Fixture write failed' } } })).ok, true);
  run = await finish(f, run, first.job, { state: 'completed_with_errors', completionReason: 'feed_exhausted' });
  f.state.profiles.set('host_creator', { profile: { id: '990', username: 'host_creator' }, ids: ['42'] });
  const ordinary = await handleBulkMessage({ type: 'REEL_SAVER_BULK_START', options: { destination: 'downloads', mode: 'batches', batchSize: 35 } }, sender());
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
  const retry = await f.queue('RETRY', { runId: run.id });
  assert.equal(retry.ok, false);
  assert.equal(f.state.session[QUEUE_OWNER].active, false);
  assert.equal(f.state.session[BULK_ACTIVE].jobId, ordinary.job.jobId);
});

test('an accepted browser ID survives queue-ledger failure even with another rapid older copy', async () => {
  const f = fixture(); const run = await start(f, draft(['alpha']), 'downloads'); const { job } = await startEntry(f, run), page = await childPage(f, job);
  const item = page.items[0], attemptId = 'accepted-ledger-fault';
  f.state.downloads.push({ id: 1, byExtensionId: extensionId, filename: `Reel Saver/alpha_${item.shortcode}.mp4`,
    url: `https://scontent.cdninstagram.com/old.mp4`, state: 'complete', mime: 'video/mp4', exists: true, fileSize: 2048, startTime: new Date().toISOString() });
  // Deliberate-copy mode makes the accepted ID, not filename proximity, the proof.
  f.state.session[BULK_ACTIVE].options.skipExisting = false;
  f.state.failLedgerAfterAcceptance = true;
  const result = await f.bulk('DOWNLOAD', job, { item, attemptId });
  assert.equal(result.ok, false);
  const operation = f.state.session[`reel-saver:bulk:${job.jobId}:operation:${item.mediaId}`];
  assert.equal(operation.downloadId, 2);
  const retried = await f.bulk('DOWNLOAD', job, { item, attemptId: 'retry-accepted' });
  assert.equal(retried.ok, true, JSON.stringify(retried)); assert.equal(retried.download.id, 2);
  assert.equal(f.state.downloads.length, 2); assert.equal((await f.store.getRun(run.id)).committedNewSaves, 1);
});
