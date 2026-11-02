import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryQueueBackend, createQueueStore } from '../src/background/profile-queue-store.js';

const code = input => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let value = BigInt(input), result = '';
  do { result = alphabet[Number(value % 64n)] + result; value /= 64n; } while (value);
  return result;
};
const item = number => ({ mediaId: String(number), shortcode: code(number) });
const first = item(1), second = item(2), third = item(3);
const draft = (extra = {}) => ({ schemaVersion: 1, batchSize: 35, defaultLimit: 2, totalLimit: null,
  entries: [{ id: 'entry-a', username: 'creator_a', limitMode: 'inherit', maxNewVideos: null }], ...extra });
const saved = (name = 'creator_B.mp4', extra = {}) => ({ state: 'saved', filename: name, bytesWritten: 2048, ...extra });

function fixture(options = {}) {
  const backend = createMemoryQueueBackend(); let timestamp = 1000, sequence = 0;
  const create = () => createQueueStore({ backend, now: () => ++timestamp, idFactory: () => `run-${++sequence}`, ...options });
  return { backend, store: create(), reopen: create };
}
async function begin(f, selected = draft()) {
  let run = await f.store.create(selected, { destination: 'downloads', skipExisting: true });
  run = await f.store.updateEntry(run.id, run.entries[0].id, { profile: { id: '12345', username: run.entries[0].username }, state: 'running' });
  return run;
}
async function commit(store, run, entryId, value, attemptId, name) {
  await store.reserve(run.id, entryId, value, attemptId);
  return store.settle(run.id, entryId, value, attemptId, saved(name));
}

test('queue results persist across store instances with versioned sparse media rows', async () => {
  const f = fixture(); let run = await begin(f);
  assert.equal(run.id, run.runId);
  assert.equal(run.options.destination, 'downloads');
  assert.equal(run.entries[0].effectiveLimit, 2);
  await f.store.discover(run.id, 'entry-a', [first, second, first]);
  run = await commit(f.store, run, 'entry-a', first, 'first-attempt', 'creator_B.mp4');
  const reopened = f.reopen();
  assert.deepEqual(await reopened.getLatest(), run);
  assert.equal(run.committedNewSaves, 1);
  assert.equal(run.entries[0].counts.discovered, 2);
  assert.equal(f.backend.state.items.size, 2);
  assert.equal(f.backend.state.latest.items, undefined, 'item lists are not embedded in the summary');
  assert.equal((await reopened.getItems(run.id, 'entry-a')).items[0].filename, 'creator_B.mp4');
});

test('profile and whole-queue caps count confirmed physical outputs once and preserve unfinished source facts', async () => {
  const f = fixture(); let run = await begin(f, draft({ totalLimit: 3, entries: [
    { id: 'entry-a', username: 'creator_a', limitMode: 'inherit', maxNewVideos: null },
    { id: 'entry-b', username: 'creator_b', limitMode: 'custom', maxNewVideos: 1 },
    { id: 'entry-c', username: 'creator_c', limitMode: 'unlimited', maxNewVideos: null },
  ] }));
  await f.store.discover(run.id, 'entry-a', [first, second, third]);
  await commit(f.store, run, 'entry-a', first, 'a-one', 'creator_B.mp4');
  await commit(f.store, run, 'entry-a', second, 'a-two', 'creator_C.mp4');
  await assert.rejects(f.store.reserve(run.id, 'entry-a', third, 'a-three'), { code: 'PROFILE_LIMIT_REACHED' });
  run = await f.store.finishEntry(run.id, 'entry-a', { state: 'completed', completionReason: 'profile_limit_reached', sourceExhausted: false });
  assert.equal(run.entries[0].counts.deferred, 1);
  assert.equal(run.entries[0].sourceExhausted, false);
  await f.store.updateRun(run.id, { currentIndex: 1 });
  await f.store.updateEntry(run.id, 'entry-b', { profile: { id: '23456', username: 'creator_b' }, state: 'running' });
  await f.store.discover(run.id, 'entry-b', [first]);
  run = await commit(f.store, run, 'entry-b', first, 'b-one', 'creator_b_B.mp4');
  assert.equal(run.committedNewSaves, 3);
  assert.deepEqual(run.entries.map(value => value.committedNewSaves), [2, 1, 0]);
  await f.store.finishEntry(run.id, 'entry-b', { completionReason: 'queue_limit_reached', sourceExhausted: false });
  await f.store.updateRun(run.id, { currentIndex: 2 });
  await f.store.updateEntry(run.id, 'entry-c', { profile: { id: '34567', username: 'creator_c' }, state: 'running' });
  await f.store.discover(run.id, 'entry-c', [first]);
  await assert.rejects(f.store.reserve(run.id, 'entry-c', first, 'c-one'), { code: 'QUEUE_LIMIT_REACHED' });
  assert.equal((await f.store.getLatest()).reservation, null);
});

test('failures, cache hits and retries do not consume allowance, and duplicate acknowledgements cannot double-count', async () => {
  const f = fixture(); let run = await begin(f);
  await f.store.discover(run.id, 'entry-a', [first, second, third]);
  await f.store.recordItems(run.id, 'entry-a', [{ ...third, state: 'already_downloaded', filename: 'creator_D.mp4', bytesWritten: 2048 }]);
  await f.store.reserve(run.id, 'entry-a', first, 'first-attempt');
  run = await f.store.settle(run.id, 'entry-a', first, 'first-attempt', { state: 'failed', error: { code: 'NETWORK_FAILED', message: 'Offline' } });
  assert.equal(run.committedNewSaves, 0);
  assert.equal(run.reservation, null);
  assert.equal(run.entries[0].counts.alreadyDownloaded, 1);
  await f.store.reserve(run.id, 'entry-a', first, 'retry-attempt');
  const value = saved('creator_B.mp4', { downloadId: 7 });
  const once = await f.store.settle(run.id, 'entry-a', first, 'retry-attempt', value);
  const repeated = await f.store.settle(run.id, 'entry-a', first, 'retry-attempt', value);
  assert.deepEqual(repeated, once);
  assert.equal(repeated.committedNewSaves, 1);
  assert.deepEqual(await f.store.settle(run.id, 'entry-a', first, 'retry-attempt', { state: 'failed' }), once, 'late failures cannot undo completion');
  await assert.rejects(f.store.settle(run.id, 'entry-a', first, 'retry-attempt', saved('different.mp4', { downloadId: 8 })), { code: 'RECONCILIATION_REQUIRED' });
});

test('an unknown output holds both caps and blocks handoff, Stop, or replacement until reconciled', async () => {
  const f = fixture(); const run = await begin(f, draft({ totalLimit: 1 }));
  await f.store.discover(run.id, 'entry-a', [first, second]);
  await f.store.reserve(run.id, 'entry-a', first, 'first-attempt');
  await f.store.settle(run.id, 'entry-a', first, 'first-attempt', { state: 'unknown', filename: 'creator_B.mp4' });
  await assert.rejects(f.store.reserve(run.id, 'entry-a', second, 'second-attempt'), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(f.store.reserve(run.id, 'entry-a', first, 'different-attempt'), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(f.store.finishEntry(run.id, 'entry-a'), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(f.store.updateRun(run.id, { currentIndex: 1 }), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(f.store.updateRun(run.id, { state: 'stopped' }), { code: 'RECONCILIATION_REQUIRED' });
  await f.store.updateRun(run.id, { state: 'interrupted' });
  await assert.rejects(f.store.create(draft(), { destination: 'downloads' }), { code: 'QUEUE_BUSY' });
  const settled = await f.store.settle(run.id, 'entry-a', first, 'first-attempt', saved());
  assert.equal(settled.committedNewSaves, 1);
  assert.equal(settled.reservation, null);
  const replacement = await f.store.create(draft(), { destination: 'folder' });
  assert.notEqual(replacement.id, run.id);
  assert.equal(replacement.committedNewSaves, 0);
  assert.equal(f.backend.state.items.size, 0);
});

test('a failed durable write commits neither receipt nor counters and retry is metadata-only', async () => {
  const f = fixture(); const run = await begin(f);
  await f.store.discover(run.id, 'entry-a', [first]);
  await f.store.reserve(run.id, 'entry-a', first, 'first-attempt');
  const before = structuredClone(f.backend.state.latest);
  f.backend.state.failWrite = true;
  await assert.rejects(f.store.settle(run.id, 'entry-a', first, 'first-attempt', saved()), { code: 'CACHE_QUEUE_WRITE_FAILED' });
  assert.deepEqual(f.backend.state.latest, before);
  assert.equal((await f.store.getItems(run.id, 'entry-a')).items[0].state, 'resolving');
  const completed = await f.reopen().settle(run.id, 'entry-a', first, 'first-attempt', saved());
  assert.equal(completed.committedNewSaves, 1);
  assert.equal(completed.reservation, null);
});

test('concurrent reservations cannot spend the same last queue allowance twice', async () => {
  const f = fixture(); const run = await begin(f, draft({ totalLimit: 1 }));
  await f.store.discover(run.id, 'entry-a', [first, second]);
  const attempts = await Promise.allSettled([first, second].map((value, index) => f.store.reserve(run.id, 'entry-a', value, `attempt-${index}`)));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(value => value.status === 'rejected' && value.reason.code === 'RECONCILIATION_REQUIRED').length, 1);
});

test('untrusted snapshots cannot fabricate physical saves, replace a reservation, or patch quota counters', async () => {
  const f = fixture(); const run = await begin(f);
  await f.store.discover(run.id, 'entry-a', [first, second]);
  await f.store.recordItems(run.id, 'entry-a', [{ ...first, state: 'saved', filename: 'forged.mp4', bytesWritten: 2048 }]);
  assert.equal((await f.store.getLatest()).committedNewSaves, 0);
  await f.store.reserve(run.id, 'entry-a', first, 'first-attempt');
  await f.store.recordItems(run.id, 'entry-a', [{ ...first, state: 'canceled' }]);
  assert.equal((await f.store.getLatest()).reservation.mediaId, '1');
  await assert.rejects(f.store.recordItems(run.id, 'entry-a', [{ ...third, state: 'failed' }]), { code: 'INVALID_ITEM' });
  assert.throws(() => f.store.updateRun(run.id, { committedNewSaves: 100 }), { code: 'INVALID_QUEUE' });
  assert.throws(() => f.store.updateEntry(run.id, 'entry-a', { effectiveLimit: null }), { code: 'INVALID_QUEUE' });
  await assert.rejects(f.store.settle(run.id, 'entry-a', first, 'stale-attempt', saved()), { code: 'STALE_OPERATION' });
  assert.throws(() => f.store.settle(run.id, 'entry-a', first, 'first-attempt', saved('creator_B.mp4', { bytesWritten: 0 })), { code: 'INVALID_RESULT' });
});

test('numeric profile identity survives renames but refuses account replacement', async () => {
  const f = fixture(); const run = await begin(f);
  const renamed = await f.store.updateEntry(run.id, 'entry-a', { profile: { id: '12345', username: 'renamed_creator' } });
  assert.equal(renamed.entries[0].username, 'renamed_creator');
  await assert.rejects(f.store.updateEntry(run.id, 'entry-a', { profile: { id: '99999', username: 'creator_a' } }), { code: 'PROFILE_CHANGED' });
  assert.equal((await f.reopen().getLatest()).entries[0].profile.id, '12345');
});

test('reports preserve full shortcode identity, basename proof and compatible saved fields while omitting sensitive metadata', async () => {
  const f = fixture(); const run = await begin(f);
  const special = item(4033);
  assert.equal(special.shortcode, '_B');
  await f.store.discover(run.id, 'entry-a', [special, second]);
  await f.store.reserve(run.id, 'entry-a', special, 'special-attempt');
  await f.store.settle(run.id, 'entry-a', special, 'special-attempt', saved('C:/Private Folder/coauthor__B.mp4', { url: 'https://private.example/token', cookie: 'secret-cookie' }));
  await f.store.recordItems(run.id, 'entry-a', [{ ...second, state: 'failed', attempts: 2,
    error: { code: 'NETWORK_FAILED', message: 'cookie: session=private; other=hidden\nC:/Private Folder/file.mp4 https://private.example/token', url: 'https://private.example/' } }]);
  await f.store.finishEntry(run.id, 'entry-a', { state: 'completed_with_errors', completionReason: 'feed_exhausted', sourceExhausted: true });
  const profile = await f.store.getProfileReport(run.id, 'entry-a');
  assert.equal(profile.version, 1);
  assert.equal(profile.profile.id, '12345');
  assert.equal(profile.items[0].state, 'saved');
  assert.equal(profile.items[0].shortcode, '_B');
  assert.equal(profile.items[0].filename, 'coauthor__B.mp4');
  assert.equal(profile.items[0].bytesWritten, 2048);
  assert.equal(profile.sourceExhausted, true);
  const queue = await f.store.getQueueReport(run.id);
  assert.equal(queue.type, 'reelnest-profile-queue');
  assert.equal(queue.profiles[0].report.items[0].filename, 'coauthor__B.mp4');
  const serialized = JSON.stringify(queue);
  for (const unsafe of ['https:', 'C:', 'Private Folder', 'secret-cookie', 'session=private', 'other=hidden']) assert.equal(serialized.includes(unsafe), false, unsafe);
});

test('report pagination retains discovery order and filters failed rows for later retries', async () => {
  const f = fixture(); const run = await begin(f);
  await f.store.discover(run.id, 'entry-a', [third, first, second]);
  await f.store.recordItems(run.id, 'entry-a', [{ ...third, state: 'failed' }, { ...second, state: 'failed' }]);
  const page = await f.store.getItems(run.id, 'entry-a', { limit: 2 });
  assert.deepEqual(page.items.map(value => value.mediaId), ['3', '1']);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual((await f.store.getItems(run.id, 'entry-a', { offset: 2, limit: 2 })).items.map(value => value.mediaId), ['2']);
  assert.deepEqual((await f.store.getItems(run.id, 'entry-a', { states: ['failed'] })).items.map(value => value.mediaId), ['3', '2']);
});

test('archive bounds reject another discovery page atomically and reserve room to settle the active receipt', async () => {
  const f = fixture({ maxBytes: 16_000, maxProfileBytes: 10_000 }); const run = await begin(f);
  let number = 1;
  for (; number < 1000; number++) {
    try { await f.store.discover(run.id, 'entry-a', [item(number)]); }
    catch (error) { assert.equal(error.code, 'CACHE_QUEUE_LIMIT'); break; }
  }
  assert.ok(number > 1 && number < 1000);
  const before = await f.store.getLatest();
  assert.equal(before.entries[0].counts.discovered, number - 1);
  await assert.rejects(f.store.discover(run.id, 'entry-a', [item(number), item(number + 1)]), { code: 'CACHE_QUEUE_LIMIT' });
  assert.deepEqual(await f.store.getLatest(), before);
  await f.store.reserve(run.id, 'entry-a', first, 'last-receipt');
  const completed = await f.store.settle(run.id, 'entry-a', first, 'last-receipt', saved());
  assert.equal(completed.committedNewSaves, 1);
  assert.equal(completed.reservation, null);
});

test('corrupt/newer result schemas and storage errors fail closed without replacing the archive', async () => {
  const f = fixture(); const run = await begin(f);
  f.backend.state.latest.schemaVersion = 2;
  const before = structuredClone(f.backend.state.latest);
  await assert.rejects(f.store.getLatest(), { code: 'CACHE_QUEUE_UNSUPPORTED' });
  await assert.rejects(f.store.create(draft(), { destination: 'downloads' }), { code: 'CACHE_QUEUE_UNSUPPORTED' });
  assert.deepEqual(f.backend.state.latest, before);
  f.backend.state.latest.schemaVersion = 1;
  f.backend.state.latest.entries[0].committedNewSaves = 1;
  await assert.rejects(f.store.getLatest(), { code: 'CACHE_QUEUE_CORRUPT' });
  f.backend.state.latest.entries[0].committedNewSaves = 0;
  f.backend.state.failRead = true;
  await assert.rejects(f.store.getRun(run.id), { code: 'CACHE_QUEUE_READ_FAILED' });
  const quotaStore = createQueueStore({ backend: { transaction: async () => { throw new DOMException('Full', 'QuotaExceededError'); } } });
  await assert.rejects(quotaStore.getLatest(), { code: 'CACHE_QUEUE_LIMIT' });
});
