import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryQueueBackend, setQueueStoreBackendForTests } from '../src/background/profile-queue-store.js';
import { recordReceipt } from '../src/background/browser-receipts.js';
import { getQueueRecovery, reconcileQueue } from '../src/background/profile-queue-recovery.js';

const profile = { id: '12345', username: 'creator' };
const item = { mediaId: '127', shortcode: 'B_' };
const extensionId = 'queue-recovery-fixture';
const download = (extra = {}) => ({ id: 7, byExtensionId: extensionId, filename: 'C:/Fixture Downloads/creator_B_.mp4',
  state: 'complete', exists: true, fileSize: 2048, mime: 'video/mp4', startTime: new Date(2000).toISOString(),
  url: 'https://scontent.cdninstagram.com/recovery.mp4?signature=fixture', ...extra });

async function fixture({ destination = 'downloads', intent = true, acceptedId = destination === 'downloads' } = {}) {
  const backend = createMemoryQueueBackend();
  const store = setQueueStoreBackendForTests(backend, { now: () => 1000, idFactory: () => 'recovery-run' });
  const state = { local: {}, downloads: [], searches: 0, downloadStarts: 0 };
  globalThis.chrome = { runtime: { id: extensionId }, storage: { local: {
    async get(key) { return key == null ? structuredClone(state.local) : { [key]: structuredClone(state.local[key]) }; },
    async set(values) { state.local = { ...state.local, ...structuredClone(values) }; },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state.local[key]; },
  } }, downloads: {
    async search({ id }) { state.searches++; return structuredClone(state.downloads.filter(value => value.id === id)); },
    async download() { state.downloadStarts++; throw new Error('Recovery must never start a download'); },
  } };
  let run = await store.create({ schemaVersion: 1, defaultLimit: 1, totalLimit: 1, batchSize: 35,
    entries: [{ id: 'entry', username: 'creator', limitMode: 'inherit', maxNewVideos: null }] }, { destination, skipExisting: true });
  await store.updateEntry(run.id, 'entry', { profile, state: 'running' });
  await store.discover(run.id, 'entry', [item]);
  await store.reserve(run.id, 'entry', item, 'attempt');
  if (intent) await store.settle(run.id, 'entry', item, 'attempt', { state: 'unknown', filename: 'creator_B_.mp4', ...(acceptedId ? { downloadId: 7 } : {}) });
  run = await store.updateRun(run.id, { state: 'interrupted', completionReason: 'host_lost' });
  return { backend, store, state, run };
}

test('interrupted browser completion records durable history and commits its old allowance once without downloading', async () => {
  const f = await fixture(); f.state.downloads = [download()];
  const recovery = await getQueueRecovery(f.run.id);
  assert.equal(recovery.entry.profile.id, profile.id);
  assert.equal(recovery.item.attemptId, 'attempt');
  const settled = await reconcileQueue(f.run.id);
  assert.equal(settled.state, 'interrupted');
  assert.equal(settled.committedNewSaves, 1);
  assert.equal(settled.reservation, null);
  assert.equal((await f.store.getProfileReport(f.run.id, 'entry')).items[0].filename, 'creator_B_.mp4');
  assert.deepEqual(await reconcileQueue(f.run.id), settled);
  assert.equal(await getQueueRecovery(f.run.id), null);
  assert.equal(f.state.downloadStarts, 0);
});

test('a failed result-archive write retains the Chrome proof and replays only metadata', async () => {
  const f = await fixture(); f.state.downloads = [download()];
  f.backend.state.failWrite = true;
  await assert.rejects(reconcileQueue(f.run.id), { code: 'CACHE_QUEUE_WRITE_FAILED' });
  assert.equal((await f.store.getLatest()).committedNewSaves, 0);
  assert.ok((await f.store.getLatest()).reservation);
  assert.ok(Object.keys(f.state.local).some(key => key.startsWith('reelnest:browser-receipt:v1:')));
  assert.equal((await reconcileQueue(f.run.id)).committedNewSaves, 1);
  assert.equal(f.state.downloadStarts, 0);
});

test('an accepted Chrome ID missing from history remains uncertain and cannot release its allowance', async () => {
  const f = await fixture();
  await assert.rejects(reconcileQueue(f.run.id), { code: 'RECONCILIATION_REQUIRED' });
  assert.ok((await f.store.getLatest()).reservation);
  assert.equal((await f.store.getLatest()).committedNewSaves, 0);
  f.state.downloads = [download({ byExtensionId: 'another-extension' })];
  await assert.rejects(reconcileQueue(f.run.id), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.state.downloadStarts, 0);
});

test('only an owned interrupted Chrome transfer with no remaining file can release as canceled', async () => {
  const f = await fixture();
  for (const value of [download({ state: 'in_progress', exists: false }), download({ state: 'interrupted', exists: true }),
    download({ state: 'complete', exists: false }), download({ fileSize: -1 })]) {
    f.state.downloads = [value];
    await assert.rejects(reconcileQueue(f.run.id), { code: 'RECONCILIATION_REQUIRED' });
  }
  f.state.downloads = [download({ state: 'interrupted', exists: false })];
  const settled = await reconcileQueue(f.run.id);
  assert.equal(settled.committedNewSaves, 0);
  assert.equal(settled.reservation, null);
  assert.equal((await f.store.getItems(f.run.id, 'entry')).items[0].state, 'canceled');
});

test('untrusted media source, invalid MIME and wrong filename cannot seed recovery receipts', async () => {
  for (const changes of [{ url: 'https://attacker.example/recovery.mp4' }, { mime: 'text/html' }, { filename: 'C:/Fixture Downloads/other.mp4' }]) {
    const f = await fixture(); f.state.downloads = [download(changes)];
    await assert.rejects(reconcileQueue(f.run.id));
    assert.equal((await f.store.getLatest()).committedNewSaves, 0);
    assert.ok((await f.store.getLatest()).reservation);
    assert.equal(Object.keys(f.state.local).filter(key => key.startsWith('reelnest:browser-receipt:v1:')).length, 0);
  }
});

test('a missing accepted ID can recover through a verified durable receipt from the same queue run', async () => {
  const f = await fixture({ acceptedId: false }); f.state.downloads = [download()];
  await recordReceipt(profile.id, item, f.state.downloads[0]);
  const settled = await reconcileQueue(f.run.id);
  assert.equal(settled.committedNewSaves, 1);
  assert.equal(settled.reservation, null);
  assert.equal(f.state.downloadStarts, 0);
});

test('an older deliberate browser copy cannot satisfy this queue run’s missing accepted-ID proof', async () => {
  const f = await fixture({ acceptedId: false }); f.state.downloads = [download({ startTime: new Date(500).toISOString() })];
  await recordReceipt(profile.id, item, f.state.downloads[0]);
  await assert.rejects(reconcileQueue(f.run.id), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal((await f.store.getLatest()).committedNewSaves, 0);
  assert.ok((await f.store.getLatest()).reservation);
});

test('a lookup-only reservation without any external intent safely cancels without querying browser history', async () => {
  for (const destination of ['downloads', 'folder']) {
    const f = await fixture({ destination, intent: false });
    const settled = await reconcileQueue(f.run.id);
    assert.equal(settled.reservation, null);
    assert.equal(settled.committedNewSaves, 0);
    assert.equal(f.state.searches, 0);
    assert.equal(f.state.downloadStarts, 0);
  }
});

test('native recovery accepts only matching complete file proof and keeps the old run interrupted', async () => {
  const f = await fixture({ destination: 'folder' });
  const result = { state: 'saved', filename: 'creator_B_.mp4', bytesWritten: 2048, profileId: profile.id, ...item };
  for (const changes of [{ filename: 'another.mp4' }, { filename: '../creator_B_.mp4' }, { bytesWritten: 0 },
    { profileId: '99999' }, { mediaId: '128' }, { shortcode: 'CA' }]) {
    await assert.rejects(reconcileQueue(f.run.id, { result: { ...result, ...changes } }), { code: 'RECONCILIATION_REQUIRED' });
  }
  const settled = await reconcileQueue(f.run.id, { destination: 'folder', result });
  assert.equal(settled.state, 'interrupted');
  assert.equal(settled.reservation, null);
  assert.equal(settled.committedNewSaves, 1);
  assert.equal(f.state.downloadStarts, 0);
});

test('native cancellation requires the expected absent filename and refuses partial cleanup uncertainty', async () => {
  const f = await fixture({ destination: 'folder' });
  await assert.rejects(reconcileQueue(f.run.id), { code: 'RECONCILIATION_REQUIRED' });
  for (const result of [{ state: 'canceled' }, { state: 'canceled', filename: 'other.mp4' },
    { state: 'canceled', filename: 'creator_B_.mp4', bytesWritten: 12 },
    { state: 'canceled', filename: 'creator_B_.mp4', error: { cleanupFailed: true } }]) {
    await assert.rejects(reconcileQueue(f.run.id, { result }), { code: 'RECONCILIATION_REQUIRED' });
  }
  const settled = await reconcileQueue(f.run.id, { result: { state: 'canceled', filename: 'creator_B_.mp4' } });
  assert.equal(settled.committedNewSaves, 0);
  assert.equal(settled.reservation, null);
});

test('active queues, stale run IDs, and destination changes cannot use interrupted-save recovery', async () => {
  const f = await fixture({ destination: 'folder' });
  await assert.rejects(reconcileQueue(f.run.id, { destination: 'downloads', result: { state: 'canceled', filename: 'creator_B_.mp4' } }), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(getQueueRecovery('another-run'), { code: 'STALE_QUEUE' });
  await f.store.updateRun(f.run.id, { state: 'running' });
  await assert.rejects(getQueueRecovery(f.run.id), { code: 'RECONCILIATION_REQUIRED' });
  assert.ok((await f.store.getLatest()).reservation);
});
