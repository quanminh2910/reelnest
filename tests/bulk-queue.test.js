import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/bulk-queue.js', import.meta.url), 'utf8');
const profile = { id: '1234', username: 'example_creator' };
const item = value => ({ mediaId: String(value), shortcode: `R${value}`, username: profile.username });
const result = entry => ({ filename: `creator_${entry.shortcode}.mp4`, bytesWritten: 50 });
const options = overrides => ({ profile, batchSize: 35, mode: 'batches', ...overrides });
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function load(deps = {}) {
  const context = vm.createContext({ AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return { api: context.ReelSaverBulkQueue,
    queue: context.ReelSaverBulkQueue.create({ retryDelays: [],
      discoverPage: async () => ({ items: [], nextCursor: null, hasMore: false }),
      saveItem: async ({ item: entry }) => result(entry), ...deps }) };
}

function paginated(total, pageSize, events = []) {
  return async ({ cursor }) => {
    const start = Number(cursor || 0);
    events.push(`discover:${start}`);
    const end = Math.min(total, start + pageSize);
    return { items: Array.from({ length: end - start }, (_, index) => item(start + index + 1)),
      nextCursor: end < total ? String(end) : null, hasMore: end < total };
  };
}

test('validates identifiers, download mode, and bounded batch size before starting', () => {
  const { api, queue } = load();
  assert.deepEqual(plain(api.validateOptions({ profile })), options());
  for (const invalid of [
    options({ batchSize: 0 }), options({ batchSize: 501 }), options({ batchSize: 1.5 }),
    options({ batchSize: '35' }), options({ mode: 'parallel' }),
    options({ profile: { id: 'not-an-id', username: 'creator' } }),
    options({ profile: { id: '12', username: '../creator' } }),
  ]) assert.throws(() => queue.start(invalid), { code: 'INVALID_OPTIONS' });
  assert.equal(queue.snapshot().state, 'idle');
});

test('a stopped queue reconciles a physical save without scheduling another transfer', async () => {
  let transfers = 0;
  const { queue } = load({ discoverPage: paginated(2, 2), saveItem: async () => {
    transfers++;
    throw Object.assign(new Error('Video saved; cache update failed.'), { code: 'CACHE_WRITE_FAILED' });
  } });
  queue.start(options());
  await queue.waitForIdle();
  assert.equal(queue.snapshot().state, 'paused');
  assert.throws(() => queue.recordSaved('1', result(item(1))), { code: 'JOB_BUSY' });
  queue.stop();
  await queue.waitForIdle();
  assert.equal(queue.snapshot().counts.canceled, 2);
  queue.recordSaved('1', result(item(1)));
  const stopped = queue.snapshot();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.counts.saved, 1);
  assert.equal(stopped.counts.canceled, 1);
  assert.equal(stopped.items[0].state, 'saved');
  assert.equal(stopped.items[0].result.bytesWritten, 50);
  assert.equal(stopped.error, undefined);
  assert.equal(transfers, 1);
  assert.throws(() => queue.recordSaved('99', result(item(99))), { code: 'INVALID_RESULT' });
  assert.throws(() => queue.recordSaved('1', { ...result(item(1)), cacheHit: true }), { code: 'INVALID_RESULT' });
});

test('query diagnostics survive discovery failure without retrying a rejected query', async () => {
  let calls = 0;
  const diagnostic = { queryName: 'PolarisProfileReelsTabContentQuery_connection', adapterVersion: 'profile-relay-v2',
    httpStatus: 400, serverCode: 'GRAPHQL_VALIDATION_FAILED', variableNames: ['data', 'scale'],
    executionMethod: 'environment.execute', connectionPath: ['node', 'xdt_api__v1__clips__user__connection_v2'],
    unsetVariableNames: ['after'],
    selectionKinds: ['LinkedField', 'FragmentSpread'], fieldNames: ['node'],
    fragmentNames: ['ProfileReelsQuery'], connectionMatchCount: 0,
    serverMessage: 'Required scale missing; token=secretToken; https://cdninstagram.com/a.mp4?sig=secretSig',
    variables: { scale: 0, token: 'secretVariable' } };
  const { queue } = load({ retryDelays: [0, 0], discoverPage: async () => {
    calls++;
    throw Object.assign(new Error('Instagram rejected its profile query.'), { code: 'QUERY_FAILED', stage: 'discovery', diagnostic });
  } });
  queue.start(options());
  const state = await queue.waitForIdle();
  assert.equal(state.state, 'incomplete');
  assert.equal(state.sourceExhausted, false);
  assert.equal(calls, 1);
  assert.equal(state.error.diagnostic.httpStatus, 400);
  assert.deepEqual(plain(state.error.diagnostic.variableNames), ['data', 'scale']);
  assert.equal(state.error.diagnostic.executionMethod, 'environment.execute');
  assert.deepEqual(plain(state.error.diagnostic.connectionPath), ['node', 'xdt_api__v1__clips__user__connection_v2']);
  assert.deepEqual(plain(state.error.diagnostic.unsetVariableNames), ['after']);
  assert.deepEqual(plain(state.error.diagnostic.selectionKinds), ['LinkedField', 'FragmentSpread']);
  assert.deepEqual(plain(state.error.diagnostic.fieldNames), ['node']);
  assert.deepEqual(plain(state.error.diagnostic.fragmentNames), ['ProfileReelsQuery']);
  assert.equal(state.error.diagnostic.connectionMatchCount, 0);
  assert.match(state.error.diagnostic.serverMessage, /Required scale missing/);
  assert.equal(JSON.stringify(state).includes('secret'), false);
  diagnostic.variableNames.push('laterMutation');
  assert.equal(queue.snapshot().error.diagnostic.variableNames.length, 2);
  assert.ok(Object.isFrozen(state.error.diagnostic));
});

test('page sizes and batch sizes are independent, including a final partial batch', async t => {
  for (const total of [0, 1, 34, 35, 36, 70, 71, 82]) {
    for (const pageSize of [7, 12, 50]) {
      await t.test(`${total} Reels / page size ${pageSize}`, async () => {
        let queue;
        let concurrent = 0;
        const groups = new Map();
        const saves = [];
        ({ queue } = load({ discoverPage: paginated(total, pageSize),
          saveItem: async ({ item: entry }) => {
            concurrent++;
            assert.equal(concurrent, 1);
            const batch = queue.snapshot().batchNumber;
            groups.set(batch, (groups.get(batch) || 0) + 1);
            saves.push(entry.mediaId);
            await Promise.resolve();
            concurrent--;
            return result(entry);
          } }));
        queue.start(options());
        const state = await queue.waitForIdle();
        assert.equal(state.state, 'completed');
        assert.equal(state.counts.discovered, total);
        assert.equal(state.counts.saved, total);
        assert.equal(state.counts.queued, 0);
        assert.equal(new Set(saves).size, total);
        const expected = Array.from({ length: Math.ceil(total / 35) }, (_, index) => Math.min(35, total - index * 35));
        assert.deepEqual([...groups.values()], expected);
      });
    }
  }
});

test('downloads a filled batch before fetching the following batch', async () => {
  const events = [];
  const { queue } = load({ discoverPage: paginated(82, 12, events),
    saveItem: async ({ item: entry }) => { events.push(`save:${entry.mediaId}`); return result(entry); } });
  queue.start(options());
  await queue.waitForIdle();
  assert.ok(events.indexOf('save:1') < events.indexOf('discover:36'));
  assert.ok(events.indexOf('save:35') < events.indexOf('discover:36'));
  assert.ok(events.indexOf('save:70') < events.indexOf('discover:72'));
  assert.ok(events.indexOf('save:36') > events.indexOf('discover:60'));
});

test('job-wide deduplication retains overflow and ignores later pinned duplicates', async () => {
  const pages = [
    { items: [item(1), item(2), item(3), item(4)], nextCursor: 'a', hasMore: true },
    { items: [item(1), item(4), item(5), item(6)], nextCursor: 'b', hasMore: true },
    { items: [item(2), item(7)], nextCursor: null, hasMore: false },
  ];
  const saved = [];
  const { queue } = load({ discoverPage: async () => pages.shift(),
    saveItem: async ({ item: entry }) => { saved.push(entry.mediaId); return result(entry); } });
  queue.start(options({ batchSize: 3 }));
  const state = await queue.waitForIdle();
  assert.deepEqual(saved, ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(state.counts.discovered, 7);
  assert.equal(state.counts.saved, 7);
});

test('scan-all pauses at a ready boundary before any files start saving', async () => {
  const saved = [];
  const { queue } = load({ discoverPage: paginated(82, 12),
    saveItem: async ({ item: entry }) => { saved.push(entry.mediaId); return result(entry); } });
  queue.start(options({ mode: 'scan_all' }));
  const ready = await queue.waitForIdle();
  assert.equal(ready.state, 'paused');
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.sourceExhausted, true);
  assert.equal(ready.counts.discovered, 82);
  assert.equal(saved.length, 0);
  queue.resume();
  assert.equal((await queue.waitForIdle()).counts.saved, 82);
});

test('pause while discovering retains the finished page and resumes from its cursor', async () => {
  const response = deferred();
  const seen = [];
  const { queue } = load({ discoverPage: async ({ cursor }) => {
    seen.push(cursor);
    return cursor === null ? response.promise : { items: [item(4)], nextCursor: null, hasMore: false };
  } });
  queue.start(options({ batchSize: 3 }));
  await tick();
  queue.pause('Paused during discovery.');
  response.resolve({ items: [item(1), item(2), item(3)], nextCursor: 'next', hasMore: true });
  const paused = await queue.waitForIdle();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.counts.discovered, 3);
  assert.equal(paused.counts.saved, 0);
  assert.equal(paused.cursor, 'next');
  queue.resume();
  const complete = await queue.waitForIdle();
  assert.equal(complete.counts.saved, 4);
  assert.deepEqual(seen, [null, 'next']);
});

test('pause finishes the active save and resumes without repeating it', async () => {
  const active = deferred();
  const saved = [];
  const { queue } = load({ discoverPage: paginated(4, 4),
    saveItem: async ({ item: entry }) => {
      saved.push(entry.mediaId);
      if (entry.mediaId === '1') await active.promise;
      return result(entry);
    } });
  queue.start(options({ batchSize: 3 }));
  await tick();
  const pausing = queue.pause();
  assert.equal(pausing.state, 'pausing');
  assert.deepEqual(saved, ['1']);
  active.resolve();
  const paused = await queue.waitForIdle();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.counts.saved, 1);
  queue.resume();
  const finished = await queue.waitForIdle();
  assert.equal(finished.state, 'completed');
  assert.deepEqual(saved, ['1', '2', '3', '4']);
});

test('Stop aborts an active save and starts no later item', async () => {
  const saved = [];
  let signal;
  const { queue } = load({ discoverPage: paginated(4, 4),
    saveItem: async ({ item: entry, signal: current }) => {
      signal = current;
      saved.push(entry.mediaId);
      return new Promise((resolve, reject) => current.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { code: 'SAVE_CANCELLED' })), { once: true }));
    } });
  queue.start(options());
  await tick();
  queue.stop();
  const stopped = await queue.waitForIdle();
  assert.equal(signal.aborted, true);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.counts.canceled, 4);
  assert.deepEqual(saved, ['1']);
});

test('a save that actually completes during Stop remains saved', async () => {
  const active = deferred();
  const { queue } = load({ discoverPage: paginated(2, 2),
    saveItem: async ({ item: entry }) => { await active.promise; return result(entry); } });
  queue.start(options());
  await tick();
  queue.stop();
  active.resolve();
  const stopped = await queue.waitForIdle();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.counts.saved, 1);
  assert.equal(stopped.counts.canceled, 1);
});

test('bounded transient retries settle a failed item and allow later batches to continue', async () => {
  const attempts = [];
  const waits = [];
  const { queue } = load({ discoverPage: paginated(4, 2), retryDelays: [1, 2],
    sleep: async milliseconds => waits.push(milliseconds),
    saveItem: async ({ item: entry, attemptId }) => {
      attempts.push([entry.mediaId, attemptId]);
      if (entry.mediaId === '1') throw Object.assign(new Error('Disconnected'), { code: 'NETWORK_FAILED' });
      return result(entry);
    } });
  queue.start(options({ batchSize: 2 }));
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed_with_errors');
  assert.equal(complete.counts.failed, 1);
  assert.equal(complete.counts.saved, 3);
  assert.equal(attempts.filter(([id]) => id === '1').length, 3);
  assert.equal(new Set(attempts.map(([, id]) => id)).size, attempts.length);
  assert.deepEqual(waits, [1, 2]);
});

test('Retry failed processes only failed IDs and preserves previous successful results', async () => {
  let fail = true;
  const saved = [];
  const { queue } = load({ discoverPage: paginated(3, 3),
    saveItem: async ({ item: entry }) => {
      saved.push(entry.mediaId);
      if (entry.mediaId === '2' && fail) throw new Error('Temporary failure');
      return result(entry);
    } });
  queue.start(options());
  assert.equal((await queue.waitForIdle()).state, 'completed_with_errors');
  fail = false;
  queue.retryFailed();
  const finished = await queue.waitForIdle();
  assert.equal(finished.state, 'completed');
  assert.equal(finished.counts.saved, 3);
  assert.deepEqual(saved, ['1', '2', '3', '2']);
});

test('deleted/unavailable videos are skipped while authentication and permission errors pause', async () => {
  for (const code of ['LOGIN_REQUIRED', 'CHECKPOINT_REQUIRED', 'FOLDER_PERMISSION', 'FOLDER_FULL', 'RECONCILIATION_REQUIRED']) {
    const { queue } = load({ discoverPage: paginated(2, 2),
      saveItem: async () => { throw Object.assign(new Error(code), { code }); } });
    queue.start(options());
    const paused = await queue.waitForIdle();
    assert.equal(paused.state, 'paused', code);
    assert.equal(paused.counts.queued, 2, code);
    assert.equal(paused.counts.saved, 0);
  }
  const { queue } = load({ discoverPage: paginated(2, 2), saveItem: async ({ item: entry }) => {
    if (entry.mediaId === '1') throw Object.assign(new Error('Unavailable'), { code: 'MEDIA_UNAVAILABLE' });
    return result(entry);
  } });
  queue.start(options());
  const complete = await queue.waitForIdle();
  assert.equal(complete.counts.skipped, 1);
  assert.equal(complete.counts.saved, 1);
});

test('rate-limit pause honors an explicit retry deadline before resuming', async () => {
  let time = 100;
  let requests = 0;
  const { queue } = load({ now: () => time, discoverPage: paginated(1, 1),
    saveItem: async ({ item: entry }) => {
      if (!requests++) throw Object.assign(new Error('Wait'), { code: 'RATE_LIMITED', retryAfterMs: 5000 });
      return result(entry);
    } });
  queue.start(options());
  const limited = await queue.waitForIdle();
  assert.equal(limited.retryAt, 5100);
  queue.resume();
  assert.equal(queue.snapshot().state, 'paused');
  assert.equal(requests, 1);
  time = 5100;
  queue.resume();
  assert.equal((await queue.waitForIdle()).state, 'completed');
  assert.equal(requests, 2);
});

test('discovery errors are incomplete and Resume retries the same cursor without losing overflow', async () => {
  let broken = true;
  const cursors = [];
  const { queue } = load({ discoverPage: async ({ cursor }) => {
    cursors.push(cursor);
    if (cursor === null) return { items: [item(1), item(2), item(3)], nextCursor: 'next', hasMore: true };
    if (broken) throw Object.assign(new Error('Source changed'), { code: 'SCHEMA_CHANGED' });
    return { items: [item(4)], nextCursor: null, hasMore: false };
  } });
  queue.start(options({ batchSize: 2 }));
  const incomplete = await queue.waitForIdle();
  assert.equal(incomplete.state, 'incomplete');
  assert.equal(incomplete.counts.saved, 2);
  assert.equal(incomplete.counts.queued, 1);
  assert.equal(incomplete.sourceExhausted, false);
  broken = false;
  queue.resume();
  const complete = await queue.waitForIdle();
  assert.equal(complete.counts.saved, 4);
  assert.deepEqual(cursors, [null, 'next', 'next']);
});

test('a repeated cursor or malformed end condition never appears as complete discovery', async () => {
  const pages = [
    { items: [item(1)], nextCursor: 'same', hasMore: true },
    { items: [item(2)], nextCursor: 'same', hasMore: true },
  ];
  const { queue } = load({ discoverPage: async () => pages.shift() });
  queue.start(options());
  const incomplete = await queue.waitForIdle();
  assert.equal(incomplete.state, 'incomplete');
  assert.equal(incomplete.error.code, 'CURSOR_REPEATED');
  assert.equal(incomplete.counts.discovered, 1);
  for (const page of [
    { items: [item(1)], nextCursor: null, hasMore: true },
    { items: [item(1)], nextCursor: null },
    { items: [item(1), { mediaId: '2', shortcode: '<script>' }], nextCursor: null, hasMore: false },
  ]) {
    const current = load({ discoverPage: async () => page }).queue;
    current.start(options());
    assert.equal((await current.waitForIdle()).state, 'incomplete');
    assert.equal(current.snapshot().counts.discovered, 0, 'malformed pages do not partially commit');
  }
});

test('empty or duplicate-only intermediate pages are not treated as end-of-profile', async () => {
  const pages = [
    { items: [item(1)], nextCursor: 'one', hasMore: true },
    { items: [], nextCursor: 'two', hasMore: true },
    { items: [item(1)], nextCursor: 'three', hasMore: true },
    { items: [item(2)], nextCursor: null, hasMore: false },
  ];
  const { queue } = load({ discoverPage: async () => pages.shift() });
  queue.start(options());
  assert.equal((await queue.waitForIdle()).counts.saved, 2);
});

test('prolonged nonprogressing pagination stops as incomplete rather than looping forever', async () => {
  let requests = 0;
  const { queue } = load({ discoverPage: async () => ({ items: [], nextCursor: String(++requests), hasMore: true }) });
  queue.start(options());
  const incomplete = await queue.waitForIdle();
  assert.equal(incomplete.state, 'incomplete');
  assert.equal(requests, 5);
  assert.equal(incomplete.sourceExhausted, false);
});

test('stale progress callbacks cannot modify a stopped or newer job', async () => {
  const callbacks = [];
  const { queue } = load({ discoverPage: paginated(1, 1),
    saveItem: async ({ item: entry, onProgress }) => { callbacks.push(onProgress); return result(entry); } });
  queue.start(options({ jobId: 'first' }));
  await queue.waitForIdle();
  queue.start(options({ jobId: 'second' }));
  await queue.waitForIdle();
  callbacks[0]({ bytesWritten: 999999, filename: 'wrong.mp4' });
  const second = queue.snapshot();
  assert.equal(second.jobId, 'second');
  assert.equal(second.items[0].filename, 'creator_R1.mp4');
  assert.equal(second.active, null);
});

test('snapshots and operation payloads contain stable metadata instead of signed URLs', async () => {
  const { queue } = load({ discoverPage: async () => ({
    items: [{ ...item(1), url: 'https://signed.example/video.mp4?secret=one', thumbnailUrl: 'https://signed.example/image' }],
    nextCursor: null, hasMore: false,
  }), saveItem: async ({ item: entry }) => {
    assert.equal(entry.url, undefined);
    assert.equal(entry.thumbnailUrl, undefined);
    throw new Error('Failed https://signed.example/video.mp4?secret=one');
  } });
  queue.start(options());
  const completed = await queue.waitForIdle();
  assert.ok(!JSON.stringify(completed).includes('secret=one'));
  assert.match(completed.items[0].error.message, /\[link\]/);
});

test('duplicate Start cannot replace an active or paused job', async () => {
  const response = deferred();
  const { queue } = load({ discoverPage: async () => response.promise });
  queue.start(options({ jobId: 'active' }));
  assert.throws(() => queue.start(options({ jobId: 'other' })), { code: 'JOB_BUSY' });
  queue.pause();
  response.resolve({ items: [item(1)], nextCursor: null, hasMore: false });
  await queue.waitForIdle();
  assert.throws(() => queue.start(options({ jobId: 'other' })), { code: 'JOB_BUSY' });
  queue.stop();
  await queue.waitForIdle();
  assert.equal(queue.snapshot().state, 'stopped');
});

test('temporary discovery failures retry the same page with a bounded wait policy', async () => {
  let requests = 0;
  const waits = [];
  const { queue } = load({ retryDelays: [1, 2], sleep: async delay => waits.push(delay),
    discoverPage: async ({ cursor }) => {
      assert.equal(cursor, null);
      if (++requests < 3) throw Object.assign(new Error('Connection lost'), { code: 'NETWORK_FAILED' });
      return { items: [item(1)], nextCursor: null, hasMore: false };
    } });
  queue.start(options());
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed');
  assert.equal(complete.counts.saved, 1);
  assert.equal(requests, 3);
  assert.deepEqual(waits, [1, 2]);
});

test('systematic native folder failures pause before trying every profile item', async () => {
  let saves = 0;
  const { queue } = load({ discoverPage: paginated(82, 12), saveItem: async () => {
    saves++;
    throw Object.assign(new Error('Use Browser Save As'), { code: 'FOLDER_SAVE_FAILED' });
  } });
  queue.start(options());
  const paused = await queue.waitForIdle();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.error.code, 'FOLDER_SAVE_FAILED');
  assert.equal(saves, 1);
  assert.equal(paused.counts.failed, 0);
});

test('consecutive unrecognized save failures trip a job-wide pause budget', async () => {
  let fail = true;
  const { queue } = load({ discoverPage: paginated(10, 10), saveItem: async ({ item: entry }) => {
    if (fail) throw new Error('Unrecognized failure');
    return result(entry);
  } });
  queue.start(options());
  const paused = await queue.waitForIdle();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.error.code, 'REPEATED_FAILURES');
  assert.equal(paused.counts.failed, 3);
  assert.equal(paused.counts.queued, 7);
  fail = false;
  queue.resume();
  const finished = await queue.waitForIdle();
  assert.equal(finished.state, 'completed_with_errors');
  assert.equal(finished.counts.saved, 7);
});

test('cleanup uncertainty pauses and retains only a relative leftover filename in results', async () => {
  const { queue } = load({ discoverPage: paginated(2, 2), saveItem: async () => {
    throw Object.assign(new Error('Cleanup failed'), { code: 'NETWORK_FAILED', cleanupFailed: true,
      leftoverFilename: 'C:\\private\\folder\\partial.mp4' });
  } });
  queue.start(options());
  const paused = await queue.waitForIdle();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.error.cleanupFailed, true);
  assert.equal(paused.error.leftoverFilename, 'partial.mp4');
});

test('worker journal, stale operation, and identity failures pause the current item', async () => {
  for (const code of ['RECONCILE_REQUIRED', 'STORAGE_FAILED', 'STALE_JOB', 'STALE_OPERATION', 'ADAPTER_ERROR', 'PROFILE_UNAVAILABLE', 'MEDIA_MISMATCH', 'INVALID_ITEM', 'FILE_FAILED']) {
    const { queue } = load({ discoverPage: paginated(2, 2), saveItem: async () => {
      throw Object.assign(new Error(code), { code });
    } });
    queue.start(options());
    const paused = await queue.waitForIdle();
    assert.equal(paused.state, 'paused', code);
    assert.equal(paused.counts.failed, 0, code);
    assert.equal(paused.error.code, code);
  }
});

test('refused signed URLs are refreshed within the retry budget and then pause', async () => {
  for (const code of ['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED']) {
    let attempts = 0;
    const { queue } = load({ discoverPage: paginated(82, 12), retryDelays: [0, 0],
      saveItem: async () => { attempts++; throw Object.assign(new Error('Refused'), { code }); } });
    queue.start(options());
    const paused = await queue.waitForIdle();
    assert.equal(paused.state, 'paused', code);
    assert.equal(attempts, 3, code);
    assert.equal(paused.counts.failed, 0, code);
  }
});

test('a Pause during the final file reports completion when no work remains', async () => {
  const active = deferred();
  const { queue } = load({ discoverPage: paginated(1, 1), saveItem: async ({ item: entry }) => {
    await active.promise;
    return result(entry);
  } });
  queue.start(options());
  await tick();
  queue.pause();
  active.resolve();
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed');
  assert.equal(complete.counts.saved, 1);
});

test('the final consecutive failure reports finished-with-errors instead of requiring an empty resume', async () => {
  const { queue } = load({ discoverPage: paginated(3, 3), saveItem: async () => { throw new Error('Invalid video'); } });
  queue.start(options());
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed_with_errors');
  assert.equal(complete.counts.failed, 3);
});

test('explicit Resume refreshes the no-progress budget and can advance a cached empty page', async () => {
  const cursors = [];
  const { queue } = load({ discoverPage: async ({ cursor }) => {
    cursors.push(cursor);
    const index = Number(cursor || 0);
    if (index < 5) return { items: [], nextCursor: String(index + 1), hasMore: true };
    return { items: [item(1)], nextCursor: null, hasMore: false };
  } });
  queue.start(options());
  const incomplete = await queue.waitForIdle();
  assert.equal(incomplete.state, 'incomplete');
  assert.equal(incomplete.error.code, 'NO_DISCOVERY_PROGRESS');
  assert.equal(incomplete.cursor, '4', 'the rejected page did not advance the local cursor');
  queue.resume();
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed');
  assert.equal(complete.counts.saved, 1);
  assert.deepEqual(cursors, [null, '1', '2', '3', '4', '4', '5']);
});

test('verified history hits do not use the batch quota or count as saved or unavailable', async () => {
  let queue;
  const groups = new Map();
  const checked = [];
  let firstSaveDiscovered;
  ({ queue } = load({ discoverPage: paginated(70, 12),
    checkExisting: async ({ item: entry, signal }) => {
      assert.equal(signal.aborted, false);
      checked.push(entry.mediaId);
      return Number(entry.mediaId) <= 20 ? { ...result(entry), cacheHit: true,
        url: 'https://cdninstagram.com/hidden.mp4?token=secret' } : null;
    },
    saveItem: async ({ item: entry }) => {
      const state = queue.snapshot();
      firstSaveDiscovered ??= state.counts.discovered;
      groups.set(state.batchNumber, (groups.get(state.batchNumber) || 0) + 1);
      return result(entry);
    } }));
  queue.start(options());
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed');
  assert.equal(firstSaveDiscovered, 60);
  assert.deepEqual([...groups.values()], [35, 15]);
  assert.equal(new Set(checked).size, 70);
  assert.equal(complete.counts.discovered, 70);
  assert.equal(complete.counts.saved, 50);
  assert.equal(complete.counts.alreadyDownloaded, 20);
  assert.equal(complete.counts.skipped, 0);
  assert.equal(complete.counts.queued, 0);
  assert.equal(complete.items[0].state, 'already_downloaded');
  assert.equal(complete.items[0].reason, 'already_downloaded');
  assert.equal(complete.items[0].attempts, 0);
  assert.equal(JSON.stringify(complete).includes('secret'), false);
});

test('a long all-cached profile scans to explicit exhaustion without resolving or saving media', async () => {
  for (const mode of ['batches', 'scan_all']) {
    let saves = 0;
    const events = [];
    const { queue } = load({ discoverPage: paginated(170, 12, events),
      checkExisting: async ({ item: entry }) => ({ ...result(entry), cacheHit: true }),
      saveItem: async () => { saves++; throw new Error('Cached items must not reach saving.'); } });
    queue.start(options({ mode }));
    const complete = await queue.waitForIdle();
    assert.equal(complete.state, 'completed', mode);
    assert.equal(complete.sourceExhausted, true);
    assert.equal(events.length, 15);
    assert.equal(saves, 0);
    assert.equal(complete.counts.alreadyDownloaded, 170);
    assert.equal(complete.counts.saved, 0);
    assert.equal(complete.batchNumber, 0);
  }
});

test('cached-only duplicate pages still trigger discovery no-progress protection', async () => {
  let checks = 0;
  const { queue } = load({
    discoverPage: async ({ cursor }) => ({ items: [item(1)], nextCursor: String(Number(cursor || 0) + 1), hasMore: true }),
    checkExisting: async ({ item: entry }) => { checks++; return { ...result(entry), cacheHit: true }; },
  });
  queue.start(options());
  const incomplete = await queue.waitForIdle();
  assert.equal(incomplete.state, 'incomplete');
  assert.equal(incomplete.error.code, 'NO_DISCOVERY_PROGRESS');
  assert.equal(incomplete.sourceExhausted, false);
  assert.equal(incomplete.counts.alreadyDownloaded, 1);
  assert.equal(checks, 1);
});

test('a history read failure keeps the entire new page uncommitted and retains previous overflow', async () => {
  const cursors = [];
  const saves = [];
  let fail = true;
  const { queue } = load({ retryDelays: [0, 0],
    discoverPage: async ({ cursor }) => {
      cursors.push(cursor);
      return cursor === null
        ? { items: [1, 2, 3, 4, 5].map(item), nextCursor: 'next', hasMore: true }
        : { items: [item(6), item(7)], nextCursor: null, hasMore: false };
    },
    checkExisting: async ({ item: entry }) => {
      if (entry.mediaId === '6') return { ...result(entry), cacheHit: true };
      if (entry.mediaId === '7' && fail) throw Object.assign(new Error('History is unreadable'), {
        code: 'CACHE_READ_FAILED', stage: 'cache', retryable: true,
      });
      return null;
    },
    saveItem: async ({ item: entry }) => { saves.push(entry.mediaId); return result(entry); },
  });
  queue.start(options({ batchSize: 3 }));
  const paused = await queue.waitForIdle();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.error.code, 'CACHE_READ_FAILED');
  assert.equal(paused.error.stage, 'cache');
  assert.equal(paused.cursor, 'next');
  assert.equal(paused.counts.discovered, 5);
  assert.equal(paused.counts.saved, 3);
  assert.equal(paused.counts.queued, 2);
  assert.equal(paused.counts.alreadyDownloaded, 0);
  assert.deepEqual(cursors, [null, 'next'], 'history errors cannot automatically retry discovery');
  fail = false;
  queue.resume();
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed');
  assert.equal(complete.counts.saved, 6);
  assert.equal(complete.counts.alreadyDownloaded, 1);
  assert.deepEqual(saves, ['1', '2', '3', '4', '5', '7']);
  assert.deepEqual(cursors, [null, 'next', 'next']);
});

test('invalid history results pause before any new page item or cursor is committed', async () => {
  for (const cached of [false, { cacheHit: true, filename: 'reel.mp4', bytesWritten: 0 },
    { cacheHit: true, filename: 'reel.html', bytesWritten: 50 }]) {
    const { queue } = load({ discoverPage: paginated(2, 1), checkExisting: async () => cached });
    queue.start(options());
    const paused = await queue.waitForIdle();
    assert.equal(paused.state, 'paused');
    assert.equal(paused.error.code, 'CACHE_ENTRY_INVALID');
    assert.equal(paused.cursor, null);
    assert.equal(paused.counts.discovered, 0);
    assert.equal(paused.sourceExhausted, false);
  }
});

test('unrecognized or transport-like history errors pause without retrying the page', async () => {
  for (const failure of [new Error('Read failed'), Object.assign(new Error('Read failed'), { code: 'NETWORK_FAILED', retryable: true })]) {
    let discoveries = 0;
    const { queue } = load({ retryDelays: [0, 0],
      discoverPage: async () => { discoveries++; return { items: [item(1)], nextCursor: null, hasMore: false }; },
      checkExisting: async () => { throw failure; },
    });
    queue.start(options());
    const paused = await queue.waitForIdle();
    assert.equal(paused.state, 'paused');
    assert.equal(paused.error.code, 'CACHE_CHECK_FAILED');
    assert.equal(paused.error.stage, 'cache');
    assert.equal(discoveries, 1);
    assert.equal(paused.counts.discovered, 0);
  }
});

test('stopping while history verification is pending fences all results from that page', async () => {
  const checking = deferred();
  let signal;
  const { queue } = load({ discoverPage: paginated(2, 2),
    checkExisting: async request => { signal = request.signal; await checking.promise; return { ...result(request.item), cacheHit: true }; },
  });
  queue.start(options());
  await tick();
  queue.stop();
  assert.equal(signal.aborted, true);
  checking.resolve();
  const stopped = await queue.waitForIdle();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.counts.discovered, 0);
  assert.equal(stopped.counts.alreadyDownloaded, 0);
  assert.equal(stopped.cursor, null);
});

test('a save-time cache recheck has the same separate already-downloaded outcome', async () => {
  const { queue } = load({ discoverPage: paginated(2, 2),
    saveItem: async ({ item: entry }) => ({ ...result(entry), cacheHit: true }),
  });
  queue.start(options());
  const complete = await queue.waitForIdle();
  assert.equal(complete.state, 'completed');
  assert.equal(complete.counts.alreadyDownloaded, 2);
  assert.equal(complete.counts.saved, 0);
  assert.equal(complete.counts.skipped, 0);
  assert.equal(complete.counts.queued, 0);
  assert.ok(complete.items.every(entry => entry.state === 'already_downloaded' && entry.reason === 'already_downloaded'));
});

test('history save failures pause without retrying a potentially completed physical save', async () => {
  for (const code of ['CACHE_WRITE_FAILED', 'CACHE_PERMISSION', 'CACHE_RECONCILIATION_REQUIRED',
    'CACHE_UNSUPPORTED_VERSION', 'CACHE_SCHEMA_INVALID', 'CACHE_IDENTITY_CONFLICT']) {
    let saves = 0;
    const { queue } = load({ retryDelays: [0, 0], discoverPage: paginated(2, 2),
      saveItem: async () => { saves++; throw Object.assign(new Error('History requires attention'), { code, stage: 'cache', retryable: true }); },
    });
    queue.start(options());
    const paused = await queue.waitForIdle();
    assert.equal(paused.state, 'paused', code);
    assert.equal(paused.error.code, code);
    assert.equal(paused.error.stage, 'cache');
    assert.equal(saves, 1);
    assert.equal(paused.counts.failed, 0);
    assert.equal(paused.counts.queued, 2);
  }
});
