import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const [limitsSource, queueSource, runnerSource] = await Promise.all([
  readFile(new URL('../src/shared/download-limits.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/content/bulk-queue.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/content/profile-job-runner.js', import.meta.url), 'utf8'),
]);
const profile = { id: '12345', username: 'creator' };
const item = id => ({ mediaId: String(id), shortcode: `R${id}`, username: profile.username });
const saved = entry => ({ filename: `creator_${entry.shortcode}.mp4`, bytesWritten: 2048 });
const named = (code, message = code) => Object.assign(new Error(message), { code });
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture({ destination = 'folder', items = [item(1)], ...extra } = {}) {
  const state = { requests: [], opens: 0, closes: 0, writes: 0, resolves: 0, begins: 0, commits: 0,
    abandons: 0, browserTransfers: 0, browserPolls: 0, cache: new Map(), acknowledgements: new Map(), changes: [], events: [], ...extra };
  const root = { name: 'Library root' };
  const child = { name: 'creator child' };
  const cache = {
    profile, folderName: profile.username, directoryHandle: child,
    async verifyItem(entry) { return state.cache.get(entry.mediaId) || null; },
    reservedNamesFor() { return new Set(); },
    async beginWrite() { state.begins++; state.events.push('cache_intent'); },
    async commitSaved(entry, result) {
      state.commits++;
      if (state.failCommit) { state.failCommit--; throw named('CACHE_WRITE_FAILED'); }
      state.cache.set(entry.mediaId, { cacheHit: true, ...result });
    },
    async abandonWrite() { state.abandons++; if (state.failAbandon) { state.failAbandon--; throw named('CACHE_WRITE_FAILED'); } },
    close() { state.closes++; },
  };
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout,
    ReelSaverProfileCache: { async openLibrary(handle, selected) {
      assert.equal(handle, root); assert.deepEqual(plain(selected), profile); state.opens++; return cache;
    } },
    ReelSaverFolderWriter: { async saveToFolder(options) {
      assert.equal(options.directoryHandle, child);
      const filename = state.chosenFilename || options.filename;
      await options.beforeCreate({ filename, expectedBytes: 2048 });
      state.writes++; state.events.push('file_create');
      if (state.writer) return state.writer(options);
      return { filename, bytesWritten: 2048 };
    } },
  });
  for (const source of [limitsSource, queueSource, runnerSource]) vm.runInContext(source, context);
  const job = { jobId: 'queue-child-1', profile,
    queue: { runId: 'run-1', entryId: 'entry-1' },
    options: { destination, mode: 'batches', batchSize: 35, maxNewVideos: null, skipExisting: true }, ...state.job };
  async function request(message) {
    state.requests.push(plain(message));
    const action = message.type.slice('REEL_SAVER_BULK_'.length);
    if (action === 'PAGE') return { ok: true, page: { items, nextCursor: null, hasMore: false } };
    if (action === 'RESOLVE') { state.resolves++; return { ok: true,
      media: { mediaId: message.item.mediaId, shortcode: message.item.shortcode,
        url: 'https://scontent.cdninstagram.com/private-fixture.mp4?signature=temporary' }, filename: saved(message.item).filename }; }
    if (action === 'NATIVE_INTENT') {
      state.events.push('worker_intent');
      if (state.failIntent) { state.failIntent--; throw named('CACHE_QUEUE_WRITE_FAILED'); }
      state.lastIntent = plain(message); return { ok: true };
    }
    if (action === 'ITEM_RESULT') {
      if (message.result.state === 'saved') state.acknowledgements.set(message.mediaId, plain(message.result));
      if (state.failAck) { state.failAck--; throw named('STORAGE_FAILED'); }
      return { ok: true };
    }
    if (action === 'CHECK_EXISTING') return { ok: true, result: state.cache.get(message.item.mediaId) || null };
    if (action === 'DOWNLOAD') {
      if (!state.accepted) { state.browserTransfers++; state.accepted = true; }
      if (state.download) return state.download(message);
      return { ok: true, download: { id: 7, state: state.browserPolls ? 'complete' : 'in_progress',
        filename: saved(message.item).filename, bytesWritten: 2048 } };
    }
    if (action === 'STATUS') {
      state.browserPolls++;
      if (state.failStatus) { state.failStatus--; throw named('CACHE_RECEIPT_WRITE_FAILED'); }
      return { ok: true, download: { id: 7, state: 'complete', filename: saved(item(1)).filename, bytesWritten: 2048 } };
    }
    if (action === 'CANCEL_ITEM') { state.cancelCalls = (state.cancelCalls || 0) + 1; return { ok: true }; }
    if (action === 'END') {
      if (state.failEnd) { state.failEnd--; throw named('STORAGE_FAILED'); }
      return { ok: true, savedResults: state.endReceipts || [] };
    }
    throw new Error(`Unexpected request ${message.type}`);
  }
  const runner = await context.ReelNestProfileJobRunner.create({ request, job,
    target: { kind: destination, ...(destination === 'folder' ? { handle: root, name: root.name } : {}) },
    pollIntervalMs: 0, onChange: value => state.changes.push(plain(value)),
    onLibraryDestination: value => { state.libraryDestination = value; },
  });
  return { state, runner, context, request, job, root };
}

test('one child reuses its profile cache, saves sequentially, and releases only after END', async () => {
  const f = await fixture({ items: [item(1), item(2)] });
  f.runner.start(); const completed = await f.runner.waitForIdle();
  assert.equal(completed.state, 'completed');
  assert.equal(completed.counts.saved, 2);
  assert.equal(f.state.opens, 1); assert.equal(f.state.writes, 2);
  assert.equal(f.state.acknowledgements.size, 2);
  assert.equal(f.state.closes, 0);
  assert.equal(f.state.libraryDestination.rootHandle, f.root);
  await f.runner.finalize();
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.requests.at(-1).type, 'REEL_SAVER_BULK_END');
  assert.equal(f.state.requests.some(message => message.type.startsWith('REEL_SAVER_QUEUE_')), false,
    'the queue panel owns progress persistence');
  assert.equal(JSON.stringify(f.runner.snapshot()).includes('signature='), false);
});

test('verified library history skips physical lookup and writing without using the allowance', async () => {
  const f = await fixture({ items: [item(1), item(2)], job: { options: { destination: 'folder', mode: 'batches', batchSize: 35, maxNewVideos: 1, skipExisting: true } } });
  f.state.cache.set('1', { cacheHit: true, ...saved(item(1)) });
  f.runner.start(); const result = await f.runner.waitForIdle();
  assert.equal(result.counts.alreadyDownloaded, 1); assert.equal(result.counts.saved, 1);
  assert.equal(f.state.resolves, 1); assert.equal(f.state.writes, 1);
  await f.runner.finalize();
});

test('the actual unique native filename is recorded after the cache intent and before creating a file', async () => {
  const f = await fixture({ chosenFilename: 'creator_R1 (1).mp4' });
  f.runner.start(); const result = await f.runner.waitForIdle();
  assert.equal(result.counts.saved, 1); assert.equal(result.items[0].filename, 'creator_R1 (1).mp4');
  assert.equal(f.state.lastIntent.filename, 'creator_R1 (1).mp4');
  assert.equal(f.state.lastIntent.mediaId, '1');
  assert.deepEqual(f.state.events.slice(0, 3), ['cache_intent', 'worker_intent', 'file_create']);
  await f.runner.finalize();
});

test('a failed native intent acknowledgement abandons the cache intent before creating any MP4', async () => {
  const f = await fixture({ failIntent: 1 }); f.runner.start();
  const paused = await f.runner.waitForIdle();
  assert.equal(paused.state, 'paused'); assert.equal(paused.counts.saved, 0);
  assert.equal(f.state.writes, 0); assert.equal(f.state.begins, 1); assert.equal(f.state.abandons, 1);
  assert.equal(f.state.requests.find(message => message.type === 'REEL_SAVER_BULK_ITEM_RESULT').result.state, 'failed');
  f.runner.resume(); const result = await f.runner.waitForIdle();
  assert.equal(result.counts.saved, 1); assert.equal(f.state.writes, 1); assert.equal(f.state.begins, 2);
  await f.runner.finalize();
});

test('a history write failure retries metadata before another physical save', async () => {
  const f = await fixture({ failCommit: 1 });
  f.runner.start();
  assert.equal((await f.runner.waitForIdle()).state, 'paused');
  assert.equal(f.state.writes, 1); assert.equal(f.state.acknowledgements.size, 0);
  f.runner.resume(); const result = await f.runner.waitForIdle();
  assert.equal(result.counts.saved, 1); assert.equal(result.counts.alreadyDownloaded, 0);
  assert.equal(f.state.commits, 2); assert.equal(f.state.resolves, 1); assert.equal(f.state.writes, 1);
  await f.runner.finalize(); assert.equal(f.state.closes, 1);
});

test('a lost native acknowledgement replays the original receipt rather than resolving or writing again', async () => {
  const f = await fixture({ failAck: 1 });
  f.runner.start(); const paused = await f.runner.waitForIdle();
  assert.equal(paused.state, 'paused'); assert.equal(paused.counts.saved, 0);
  const original = f.state.requests.find(message => message.type === 'REEL_SAVER_BULK_ITEM_RESULT');
  f.runner.resume(); const result = await f.runner.waitForIdle();
  const receipts = f.state.requests.filter(message => message.type === 'REEL_SAVER_BULK_ITEM_RESULT');
  assert.equal(receipts.length, 2); assert.equal(receipts[1].attemptId, original.attemptId);
  assert.equal(result.counts.saved, 1); assert.equal(result.counts.alreadyDownloaded, 0);
  assert.equal(f.state.writes, 1); assert.equal(f.state.resolves, 1); assert.equal(f.state.commits, 1);
  await f.runner.finalize();
});

test('failed END retains the cache lease and can be retried idempotently', async () => {
  const f = await fixture({ failEnd: 1 });
  f.runner.start(); await f.runner.waitForIdle();
  await assert.rejects(f.runner.finalize(), { code: 'STORAGE_FAILED' });
  assert.equal(f.state.closes, 0);
  await Promise.all([f.runner.finalize(), f.runner.finalize()]);
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.requests.filter(message => message.type === 'REEL_SAVER_BULK_END').length, 2);
  await f.runner.finalize(); assert.equal(f.state.closes, 1);
});

test('Stop keeps a file completed during cancellation and retries its lost acknowledgement before release', async () => {
  const writing = deferred(), finish = deferred();
  const f = await fixture({ failAck: 1, writer: async options => {
    writing.resolve(); await finish.promise; return { filename: options.filename, bytesWritten: 2048 };
  } });
  f.runner.start(); await writing.promise;
  f.runner.stop(); finish.resolve();
  assert.equal((await f.runner.waitForIdle()).counts.saved, 0);
  const released = await f.runner.finalize();
  assert.equal(released.state, 'stopped'); assert.equal(released.counts.saved, 1);
  assert.equal(f.state.writes, 1); assert.equal(f.state.commits, 1); assert.equal(f.state.acknowledgements.size, 1);
  assert.equal(f.state.closes, 1);
});

test('failed partial-file history must settle before a stopped profile can close its lease', async () => {
  const f = await fixture({ failAbandon: 2, writer: async () => { throw named('FOLDER_SAVE_FAILED'); } });
  f.runner.start(); assert.equal((await f.runner.waitForIdle()).state, 'paused');
  f.runner.stop(); await f.runner.waitForIdle();
  await assert.rejects(f.runner.finalize(), { code: 'CACHE_WRITE_FAILED' });
  assert.equal(f.state.closes, 0);
  await f.runner.finalize();
  assert.equal(f.state.abandons, 3); assert.equal(f.state.writes, 1); assert.equal(f.state.closes, 1);
});

test('a completed browser copy with a lost receipt is reconciled as new on Resume', async () => {
  const f = await fixture({ destination: 'downloads', failStatus: 1 });
  f.runner.start(); assert.equal((await f.runner.waitForIdle()).state, 'paused');
  assert.equal(f.state.browserTransfers, 1);
  f.runner.resume(); const result = await f.runner.waitForIdle();
  assert.equal(result.counts.saved, 1); assert.equal(result.counts.alreadyDownloaded, 0);
  assert.equal(result.items[0].downloadId, 7); assert.equal(result.items[0].bytesWritten, 2048);
  assert.equal(f.state.browserTransfers, 1);
  await f.runner.finalize();
});

test('Stop folds a browser completion returned by END without starting another transfer', async () => {
  const accepted = deferred(), finish = deferred();
  const f = await fixture({ destination: 'downloads', endReceipts: [{ mediaId: '1', ...saved(item(1)), downloadId: 7 }],
    download: async () => { accepted.resolve(); await finish.promise; return { ok: true, download: { id: 7, state: 'in_progress' } }; } });
  f.runner.start(); await accepted.promise;
  f.runner.stop(); finish.resolve(); await f.runner.waitForIdle();
  const stopped = await f.runner.finalize();
  assert.equal(stopped.counts.saved, 1); assert.equal(stopped.state, 'stopped');
  assert.equal(f.state.browserTransfers, 1);
  assert.ok(f.state.cancelCalls >= 1);
});

test('an archived retry list does not discover the source feed and respects page-size boundaries', async () => {
  const entries = Array.from({ length: 1001 }, (_, index) => item(index + 1));
  const f = await fixture({ job: { retryItems: entries, options: { destination: 'folder', mode: 'batches', batchSize: 35, maxNewVideos: null, skipExisting: true } } });
  for (const entry of entries) f.state.cache.set(entry.mediaId, { cacheHit: true, ...saved(entry) });
  f.runner.start(); const result = await f.runner.waitForIdle();
  assert.equal(result.counts.alreadyDownloaded, 1001); assert.equal(result.counts.saved, 0);
  assert.equal(f.state.requests.some(message => message.type === 'REEL_SAVER_BULK_PAGE'), false);
  assert.equal(f.state.writes, 0);
  await f.runner.finalize();
});

test('a registered job can safely release before starting its controller', async () => {
  const f = await fixture(); await f.runner.finalize();
  assert.equal(f.state.writes, 0); assert.equal(f.state.closes, 1);
  assert.equal(f.state.requests.length, 1); assert.equal(f.state.requests[0].state, 'stopped');
});

test('invalid registered options fail before opening a folder capability', async () => {
  await assert.rejects(fixture({ job: { options: { destination: 'folder', mode: 'parallel', batchSize: 35 } } }), { code: 'INVALID_OPTIONS' });
});

test('finalize refuses a paused child until it is explicitly stopped', async () => {
  const f = await fixture({ failCommit: 1 }); f.runner.start(); await f.runner.waitForIdle();
  await assert.rejects(f.runner.finalize(), { code: 'JOB_BUSY' });
  assert.equal(f.state.closes, 0);
  const stopped = await f.runner.finalize('stopped');
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.counts.saved, 1); assert.equal(f.state.closes, 1);
});
