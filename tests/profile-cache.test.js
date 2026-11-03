import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { memoryDirectory, mp4Bytes, namedError } from './fixtures/file-system.mjs';

const source = await readFile(new URL('../src/content/profile-cache.js', import.meta.url), 'utf8');
const CACHE = '.reel-saver-cache.json';
const BACKUP = '.reel-saver-cache.backup.json';
const INDEX = '.reel-saver-library.json';
const profile = { id: '1234567890', username: 'example.creator' };
const item = { mediaId: '3', shortcode: 'D' };
const second = { mediaId: '1', shortcode: 'B' };
const bytes = mp4Bytes();
const plain = value => JSON.parse(JSON.stringify(value));

function environment(options = {}) {
  const context = vm.createContext({ Blob, Uint8Array, navigator: options.navigator || {} });
  vm.runInContext(source, context);
  return context.ReelSaverProfileCache;
}
function manifest({ owner = profile, saved = {}, pending = {}, revision = 0, schemaVersion = 1 } = {}) {
  return { schemaVersion, profile: owner, revision, updatedAt: '2026-11-01T00:00:00.000Z', saved, pending };
}
function savedEntry(filename = 'video.mp4', size = bytes.byteLength, shortcode = item.shortcode) {
  return { shortcode, relativePath: filename, bytesWritten: size, recordedAt: '2026-11-01T00:00:00.000Z', origin: 'download' };
}
function pendingEntry(filename = 'video.mp4', size = bytes.byteLength) {
  return { shortcode: item.shortcode, relativePath: filename, expectedBytes: size, recordedAt: '2026-11-01T00:00:00.000Z', origin: 'download' };
}
function report(rows = [{ ...item, state: 'saved', filename: 'video.mp4', bytesWritten: bytes.byteLength }], owner = profile) {
  return { version: 1, profile: owner, items: rows };
}
async function record(session, reel = item, filename = 'video.mp4') {
  await session.beginWrite(reel, { filename, expectedBytes: bytes.byteLength });
  session.directoryHandle.putFile(filename, bytes);
  await session.commitSaved(reel, { filename, bytesWritten: bytes.byteLength });
}

test('recovery-only library access requires an existing verified child and never initializes a wrong root', async () => {
  const cache = environment();
  const wrongRoot = memoryDirectory();
  await assert.rejects(cache.openLibrary(wrongRoot, profile, { existingOnly: true }), { code: 'CACHE_RECONCILIATION_REQUIRED' });
  assert.deepEqual(wrongRoot.names, []);
  const original = memoryDirectory();
  const session = await cache.openLibrary(original, profile);
  await record(session);
  session.close();
  const recovered = await cache.openLibrary(original, { ...profile, username: 'renamed.creator' }, { existingOnly: true });
  assert.equal(recovered.folderName, profile.username);
  assert.equal((await recovered.verifyItem(item)).filename, 'video.mp4');
  recovered.close();
});

test('clearing profile history preserves videos, other profiles and library mappings', async () => {
  const root = memoryDirectory();
  const cache = environment();
  const other = await cache.openLibrary(root, { id: '2', username: 'other.creator' });
  await record(other);
  const otherHistory = await other.directoryHandle.json(CACHE);
  other.close();
  const session = await cache.openLibrary(root, profile);
  await record(session);
  await record(session, second, 'second.mp4');
  const before = await session.directoryHandle.json(CACHE);
  const index = await root.json(INDEX);
  const preview = await session.previewReport(report());
  assert.deepEqual(plain(await session.clearHistory()), { cleared: 2 });
  assert.equal(session.recordedCount, 0);
  assert.equal(await session.verifyItem(item), null);
  assert.deepEqual(plain(session.reservedNamesFor(item)), []);
  const cleared = await session.directoryHandle.json(CACHE);
  assert.equal(cleared.revision, before.revision + 1);
  assert.deepEqual(cleared.profile, profile);
  assert.deepEqual(cleared.saved, {});
  assert.deepEqual(cleared.pending, {});
  assert.deepEqual(await session.directoryHandle.json(BACKUP), cleared);
  assert.deepEqual(await root.json(INDEX), index);
  assert.deepEqual(await root.lookup('other.creator').json(CACHE), otherHistory);
  assert.deepEqual(session.directoryHandle.videoNames.sort(), ['second.mp4', 'video.mp4']);
  assert.deepEqual(await session.directoryHandle.bytes('video.mp4'), bytes);
  assert.deepEqual(await session.directoryHandle.bytes('second.mp4'), bytes);
  assert.deepEqual(await root.lookup('other.creator').bytes('video.mp4'), bytes);
  await assert.rejects(session.importReport(preview), { code: 'CACHE_INVALID_REPORT' });
  const child = session.directoryHandle;
  session.close();
  // Automatic recovery must restore the cleared backup, never the old saves.
  child.putFile(CACHE, '{');
  const reopened = await cache.openLibrary(root, profile);
  assert.equal(reopened.recordedCount, 0);
  assert.equal(await reopened.verifyItem(item), null);
  assert.deepEqual(reopened.directoryHandle.videoNames.sort(), ['second.mp4', 'video.mp4']);
  reopened.close();
});

test('clearing empty history also neutralizes a backup that still has old saves', async () => {
  const root = memoryDirectory();
  const child = root.putDirectory(profile.username);
  child.putFile('video.mp4', bytes);
  child.putJson(CACHE, manifest({ revision: 8 }));
  child.putJson(BACKUP, manifest({ revision: 7, saved: { [item.mediaId]: savedEntry() } }));
  const session = await environment().openLibrary(root, profile);
  assert.deepEqual(plain(await session.clearHistory()), { cleared: 0 });
  assert.equal((await child.json(CACHE)).revision, 9);
  assert.deepEqual(await child.json(BACKUP), await child.json(CACHE));
  assert.deepEqual(child.videoNames, ['video.mp4']);
  session.close();
});

test('clearing history can retry either failed metadata write without touching video files', async () => {
  for (const filename of [BACKUP, CACHE]) {
    const root = memoryDirectory();
    const session = await environment().openLibrary(root, profile);
    await record(session);
    const before = await session.directoryHandle.json(CACHE);
    root.state.hook = event => {
      if (event.operation === 'close' && event.path.endsWith(`/${filename}`)) throw namedError('QuotaExceededError');
    };
    await assert.rejects(session.clearHistory(), { code: 'CACHE_WRITE_FAILED' });
    assert.deepEqual(await session.directoryHandle.json(CACHE), before);
    assert.equal(session.recordedCount, 1);
    await assert.rejects(session.verifyItem(item), { code: 'CACHE_RESET_INCOMPLETE' });
    root.state.hook = undefined;
    assert.deepEqual(plain(await session.clearHistory()), { cleared: 1 });
    assert.equal(session.recordedCount, 0);
    assert.deepEqual(await session.directoryHandle.json(BACKUP), await session.directoryHandle.json(CACHE));
    assert.deepEqual(await session.directoryHandle.bytes('video.mp4'), bytes);
    session.close();
  }
});

test('clearing accepts an exact primary reset after its close committed then reported failure', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await record(session);
  let injected = false;
  root.state.hook = event => {
    if (!injected && event.operation === 'committed' && event.path.endsWith(`/${CACHE}`)) {
      injected = true;
      throw namedError('InvalidStateError');
    }
  };
  assert.deepEqual(plain(await session.clearHistory()), { cleared: 1 });
  assert.equal(injected, true);
  assert.equal(session.recordedCount, 0);
  assert.deepEqual(await session.directoryHandle.json(BACKUP), await session.directoryHandle.json(CACHE));
  session.close();
});

test('an uncertain reset read retains its exact receipt for a same-session retry', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await record(session);
  const before = await session.directoryHandle.json(CACHE);
  let committed = false;
  root.state.hook = event => {
    if (event.operation === 'committed' && event.path.endsWith(`/${CACHE}`)) {
      committed = true;
      throw namedError('InvalidStateError');
    }
    if (committed && event.operation === 'read' && event.path.endsWith(`/${CACHE}`)) throw namedError('NotAllowedError');
  };
  await assert.rejects(session.clearHistory(), { code: 'CACHE_WRITE_FAILED' });
  root.state.hook = undefined;
  assert.deepEqual(plain(await session.clearHistory()), { cleared: 1 });
  assert.equal((await session.directoryHandle.json(CACHE)).revision, before.revision + 1);
  assert.equal(session.recordedCount, 0);
  assert.deepEqual(await session.directoryHandle.bytes('video.mp4'), bytes);
  session.close();
});

test('clearing refuses unresolved pending writes and revision conflicts without metadata changes', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await session.beginWrite(item, { filename: 'video.mp4', expectedBytes: null });
  session.directoryHandle.putFile('video.mp4', bytes);
  const before = await session.directoryHandle.json(CACHE);
  const backup = await session.directoryHandle.json(BACKUP);
  await assert.rejects(session.clearHistory(), { code: 'CACHE_RECONCILIATION_REQUIRED' });
  assert.deepEqual(await session.directoryHandle.json(CACHE), before);
  assert.deepEqual(await session.directoryHandle.json(BACKUP), backup);
  await session.commitSaved(item, { filename: 'video.mp4', bytesWritten: bytes.byteLength });
  const external = await session.directoryHandle.json(CACHE);
  external.revision++;
  session.directoryHandle.putJson(CACHE, external);
  const externalBackup = await session.directoryHandle.json(BACKUP);
  await assert.rejects(session.clearHistory(), { code: 'CACHE_CONCURRENT_CHANGE' });
  assert.deepEqual(await session.directoryHandle.json(CACHE), external);
  assert.deepEqual(await session.directoryHandle.json(BACKUP), externalBackup);
  assert.deepEqual(await session.directoryHandle.bytes('video.mp4'), bytes);
  session.close();
});

test('clearing cannot race an active import and invalidates an in-flight preview', async () => {
  const root = memoryDirectory();
  root.putFile('video.mp4', bytes);
  const session = await environment().openLibrary(root, profile);
  const preview = await session.previewReport(report());
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  root.state.hook = async event => {
    if (event.operation === 'read' && event.path === `${root.name}/video.mp4`) { entered(); await held; }
  };
  const importing = session.importReport(preview);
  await started;
  await assert.rejects(session.clearHistory(), { code: 'CACHE_BUSY' });
  release();
  await importing;
  root.state.hook = undefined;
  await session.clearHistory();
  let previewEntered;
  let releasePreview;
  const previewStarted = new Promise(resolve => { previewEntered = resolve; });
  const previewHeld = new Promise(resolve => { releasePreview = resolve; });
  root.state.hook = async event => {
    if (event.operation === 'read' && event.path.endsWith('/video.mp4')) { previewEntered(); await previewHeld; }
  };
  const preparing = session.previewReport(report());
  const rejected = assert.rejects(preparing, { code: 'CACHE_INVALID_REPORT' });
  await previewStarted;
  await session.clearHistory();
  releasePreview();
  await rejected;
  root.state.hook = undefined;
  assert.equal(session.recordedCount, 0);
  session.close();
});

test('creates one profile child, keeps metadata there, and preserves root mappings', async () => {
  const root = memoryDirectory();
  const cache = environment();
  const one = await cache.openLibrary(root, profile);
  assert.equal(one.folderName, profile.username);
  assert.equal(one.directoryHandle, root.lookup(profile.username));
  assert.deepEqual(root.names.sort(), [INDEX, profile.username].sort());
  await record(one);
  assert.equal(one.recordedCount, 1);
  assert.deepEqual(plain(await one.verifyItem(item)), { filename: 'video.mp4', bytesWritten: bytes.byteLength, cacheHit: true });
  one.close();
  one.close();
  const two = await cache.openLibrary(root, { id: '2', username: 'other.creator' });
  two.close();
  const index = await root.json(INDEX);
  assert.equal(index.profiles[profile.id].folderName, profile.username);
  assert.equal(index.profiles['2'].folderName, 'other.creator');
  assert.equal(root.videoNames.length, 0);
});

test('reopens durable saves and lazily refuses missing, truncated and non-MP4 files', async () => {
  const root = memoryDirectory();
  let session = await environment().openLibrary(root, profile);
  await record(session);
  const directory = session.directoryHandle;
  session.close();
  root.state.calls.length = 0;
  session = await environment().openLibrary(root, profile);
  assert.equal(session.recordedCount, 1);
  assert.equal(root.state.calls.some(call => call.operation === 'read' && call.path.endsWith('/video.mp4')), false);
  assert.equal((await session.verifyItem(item)).cacheHit, true);
  directory.putFile('video.mp4', bytes.subarray(0, 12));
  assert.equal(await session.verifyItem(item), null);
  directory.putFile('video.mp4', new Uint8Array(bytes.byteLength));
  assert.equal(await session.verifyItem(item), null);
  await directory.removeEntry('video.mp4');
  assert.equal(await session.verifyItem(item), null);
  session.close();
});

test('reuses numeric identity after username changes and manual folder moves', async () => {
  const root = memoryDirectory();
  const cache = environment();
  let session = await cache.openLibrary(root, profile);
  await record(session);
  session.close();
  root.renameEntry(profile.username, 'Archived collection');
  session = await cache.openLibrary(root, { ...profile, username: 'new.username' });
  assert.equal(session.folderName, 'Archived collection');
  assert.equal(session.recordedCount, 1);
  assert.equal((await session.directoryHandle.json(CACHE)).profile.username, 'new.username');
  assert.equal((await root.json(INDEX)).profiles[profile.id].folderName, 'Archived collection');
  session.close();
});

test('rebuilds a corrupt/missing index from authoritative child caches', async () => {
  const root = memoryDirectory();
  const child = root.putDirectory('moved.collection');
  child.putJson(CACHE, manifest());
  root.putFile(INDEX, '{');
  const session = await environment().openLibrary(root, profile);
  assert.equal(session.folderName, 'moved.collection');
  assert.equal((await root.json(INDEX)).profiles[profile.id].folderName, 'moved.collection');
  session.close();
  root.putFile(INDEX, 'null');
  const again = await environment().openLibrary(root, profile);
  assert.equal(again.directoryHandle, child);
  again.close();
});

test('does not mix username reuse, unidentified folders, reserved names or case collisions', async () => {
  const root = memoryDirectory();
  const existing = root.putDirectory(profile.username.toUpperCase());
  existing.putFile('keep.mp4', bytes);
  const cache = environment();
  let session = await cache.openLibrary(root, profile);
  assert.equal(session.folderName, `${profile.username}__${profile.id}`);
  assert.deepEqual(existing.names, ['keep.mp4']);
  session.close();
  session = await cache.openLibrary(root, { id: '3', username: profile.username });
  assert.equal(session.folderName, `${profile.username}__3`);
  session.close();
  session = await cache.openLibrary(root, { id: '4', username: 'CON' });
  assert.equal(session.folderName, 'profile_CON');
  session.close();
});

test('initializes an empty existing folder and rejects choosing a profile child as root', async () => {
  const root = memoryDirectory();
  const child = root.putDirectory(profile.username);
  const cache = environment();
  const session = await cache.openLibrary(root, profile);
  assert.equal(session.directoryHandle, child);
  session.close();
  await assert.rejects(cache.openLibrary(child, profile), { code: 'CACHE_NOT_LIBRARY', stage: 'cache' });
  assert.equal(child.names.some(name => name === profile.username), false);
});

test('refuses duplicate profile claims and mismatched indexed ownership without modifying either', async () => {
  const root = memoryDirectory();
  root.putDirectory('one').putJson(CACHE, manifest());
  root.putDirectory('two').putJson(CACHE, manifest());
  await assert.rejects(environment().openLibrary(root, profile), { code: 'CACHE_FOLDER_CONFLICT' });
  const other = memoryDirectory();
  other.putDirectory(profile.username).putJson(CACHE, manifest({ owner: { id: '9', username: 'someone.else' } }));
  other.putJson(INDEX, { schemaVersion: 1, revision: 1, profiles: { [profile.id]: { folderName: profile.username, username: profile.username } } });
  await assert.rejects(environment().openLibrary(other, profile), { code: 'CACHE_PROFILE_MISMATCH' });
  assert.equal(other.names.length, 2);
});

test('refuses corrupt/newer intended cache instead of bypassing it with a duplicate folder', async () => {
  for (const data of ['{', 'null', 'false', JSON.stringify(manifest({ schemaVersion: 2 }))]) {
    const root = memoryDirectory();
    const child = root.putDirectory(profile.username);
    child.putFile(CACHE, data);
    await assert.rejects(environment().openLibrary(root, profile), error => ['CACHE_CORRUPT', 'CACHE_UNSUPPORTED'].includes(error.code));
    assert.deepEqual(root.names, [profile.username]);
    assert.equal(await (await child.getFileHandle(CACHE)).getFile().then(file => file.text()), data);
  }
});

test('restores a validated backup and never overwrites a newer primary schema', async () => {
  const root = memoryDirectory();
  const child = root.putDirectory(profile.username);
  const good = manifest({ saved: { [item.mediaId]: savedEntry() }, revision: 5 });
  child.putFile(CACHE, '{broken');
  child.putJson(BACKUP, good);
  child.putFile('video.mp4', bytes);
  const cache = environment();
  const session = await cache.openLibrary(root, profile);
  assert.equal(session.recovered, true);
  assert.equal((await session.verifyItem(item)).cacheHit, true);
  assert.equal((await child.json(CACHE)).revision, 5);
  session.close();
  child.putJson(CACHE, manifest({ schemaVersion: 2 }));
  await assert.rejects(cache.openLibrary(root, profile), { code: 'CACHE_UNSUPPORTED' });
  assert.equal((await child.json(CACHE)).schemaVersion, 2);
});

test('backup contains the last validated primary, not an in-memory mutation', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await session.beginWrite(item, { filename: 'video.mp4', expectedBytes: bytes.byteLength });
  const child = session.directoryHandle;
  assert.deepEqual((await child.json(BACKUP)).pending, {});
  child.putFile('video.mp4', bytes);
  await session.commitSaved(item, { filename: 'video.mp4', bytesWritten: bytes.byteLength });
  assert.ok((await child.json(BACKUP)).pending[item.mediaId]);
  assert.deepEqual((await child.json(BACKUP)).saved, {});
  assert.ok((await child.json(CACHE)).saved[item.mediaId]);
  session.close();
});

test('pending intent exists before video creation and reconciles completed or missing files on reopen', async () => {
  const root = memoryDirectory();
  const cache = environment();
  let session = await cache.openLibrary(root, profile);
  await session.beginWrite(item, { filename: 'video.mp4', expectedBytes: bytes.byteLength });
  assert.equal(session.directoryHandle.lookup('video.mp4'), undefined);
  assert.ok((await session.directoryHandle.json(CACHE)).pending[item.mediaId]);
  session.directoryHandle.putFile('video.mp4', bytes);
  session.close();
  session = await cache.openLibrary(root, profile);
  assert.equal((await session.verifyItem(item)).cacheHit, true);
  await session.beginWrite(second, { filename: 'missing.mp4', expectedBytes: bytes.byteLength });
  session.close();
  session = await cache.openLibrary(root, profile);
  assert.deepEqual((await session.directoryHandle.json(CACHE)).pending, {});
  assert.equal(session.recordedCount, 1);
  session.close();
});

test('unknown-size and partial pending files pause reconciliation without redownloading', async () => {
  for (const [expectedBytes, content] of [[null, bytes], [bytes.byteLength, bytes.subarray(0, 12)]]) {
    const root = memoryDirectory();
    const cache = environment();
    const session = await cache.openLibrary(root, profile);
    await session.beginWrite(item, { filename: 'video.mp4', expectedBytes });
    const child = session.directoryHandle;
    child.putFile('video.mp4', content);
    session.close();
    await assert.rejects(cache.openLibrary(root, profile), { code: 'CACHE_RECONCILIATION_REQUIRED', pause: true });
    assert.ok((await child.json(CACHE)).pending[item.mediaId]);
    assert.deepEqual((await child.json(CACHE)).saved, {});
    assert.deepEqual(child.videoNames, ['video.mp4']);
  }
});

test('abandon clears only a confirmed absent output and does not discard uncertain files', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await session.beginWrite(item, { filename: 'video.mp4', expectedBytes: bytes.byteLength });
  session.directoryHandle.putFile('video.mp4', bytes);
  await assert.rejects(session.abandonWrite(item), { code: 'CACHE_RECONCILIATION_REQUIRED' });
  await session.directoryHandle.removeEntry('video.mp4');
  await session.abandonWrite(item);
  assert.deepEqual((await session.directoryHandle.json(CACHE)).pending, {});
  session.close();
});

test('a history commit failure retains physical completion and retries metadata only', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await session.beginWrite(item, { filename: 'video.mp4', expectedBytes: bytes.byteLength });
  session.directoryHandle.putFile('video.mp4', bytes);
  let fail = true;
  root.state.hook = event => { if (fail && event.operation === 'close' && event.path.endsWith(`/${CACHE}`)) throw namedError('QuotaExceededError'); };
  await assert.rejects(session.commitSaved(item, { filename: 'video.mp4', bytesWritten: bytes.byteLength }), { code: 'CACHE_WRITE_FAILED' });
  assert.equal(session.recordedCount, 0);
  assert.deepEqual(session.directoryHandle.videoNames, ['video.mp4']);
  fail = false;
  await session.commitSaved(item, { filename: 'video.mp4', bytesWritten: bytes.byteLength });
  assert.equal(session.recordedCount, 1);
  assert.deepEqual(session.directoryHandle.videoNames, ['video.mp4']);
  session.close();
});

test('reopens and accepts an exact committed revision after an uncertain close outcome', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await session.beginWrite(item, { filename: 'video.mp4', expectedBytes: bytes.byteLength });
  session.directoryHandle.putFile('video.mp4', bytes);
  root.state.hook = event => { if (event.operation === 'committed' && event.path.endsWith(`/${CACHE}`)) throw namedError('UnknownError'); };
  await session.commitSaved(item, { filename: 'video.mp4', bytesWritten: bytes.byteLength });
  assert.equal(session.recordedCount, 1);
  session.close();
});

test('detects an externally changed revision instead of replacing it with stale state', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  session.directoryHandle.putJson(CACHE, manifest({ revision: 9, saved: { [second.mediaId]: savedEntry('external.mp4', bytes.byteLength, second.shortcode) } }));
  await assert.rejects(session.beginWrite(item, { filename: 'video.mp4', expectedBytes: bytes.byteLength }), { code: 'CACHE_CONCURRENT_CHANGE' });
  assert.ok((await session.directoryHandle.json(CACHE)).saved[second.mediaId]);
  session.close();
});

test('bounds history input and rejects duplicate JSON keys, unsafe paths and forged media IDs', async () => {
  const invalid = [
    JSON.stringify(manifest({ saved: { [item.mediaId]: savedEntry('../video.mp4') } })),
    JSON.stringify(manifest({ saved: { '2': savedEntry() } })),
    JSON.stringify(manifest({ saved: { [item.mediaId]: savedEntry(), [second.mediaId]: savedEntry('VIDEO.mp4', bytes.byteLength, second.shortcode) } })),
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"__proto__":{"polluted":true}}',
  ];
  for (const text of invalid) {
    const root = memoryDirectory();
    root.putDirectory(profile.username).putFile(CACHE, text);
    await assert.rejects(environment().openLibrary(root, profile), error => error.code?.startsWith('CACHE_'));
  }
  const root = memoryDirectory();
  root.putDirectory(profile.username).putFile(CACHE, ' '.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(environment().openLibrary(root, profile), { code: 'CACHE_LIMIT' });
  assert.equal({}.polluted, undefined);
});

test('library use leases reject competing sessions, then release idempotently on close', async () => {
  const root = memoryDirectory();
  const cache = environment();
  const session = await cache.openLibrary(root, profile);
  await assert.rejects(cache.openLibrary(root, profile), { code: 'CACHE_BUSY' });
  session.close();
  session.close();
  await assert.rejects(session.verifyItem(item), { code: 'CACHE_CLOSED' });
  const next = await cache.openLibrary(root, profile);
  next.close();
});

test('navigator Web Locks hold the use lease across independent contexts and release failed opens', async () => {
  const held = new Set();
  const locks = { async request(name, options, callback) {
    if (options.ifAvailable && held.has(name)) return callback(null);
    assert.equal(held.has(name), false);
    held.add(name);
    try { return await callback({ name }); }
    finally { held.delete(name); }
  } };
  const root = memoryDirectory();
  const first = environment({ navigator: { locks } });
  const secondCache = environment({ navigator: { locks } });
  const session = await first.openLibrary(root, profile);
  await assert.rejects(secondCache.openLibrary(root, profile), { code: 'CACHE_BUSY' });
  session.close();
  await new Promise(setImmediate);
  const next = await secondCache.openLibrary(root, profile);
  next.close();
  await new Promise(setImmediate);
  root.state.permission = 'denied';
  await assert.rejects(first.openLibrary(root, profile), { code: 'CACHE_PERMISSION' });
  await new Promise(setImmediate);
  assert.equal(held.size, 0);
});

test('report preview verifies exact filenames, ignores canceled items and performs no copy', async () => {
  const root = memoryDirectory();
  root.putFile('video (2).mp4', bytes);
  const session = await environment().openLibrary(root, profile);
  const preview = await session.previewReport(report([
    { ...item, state: 'saved', filename: 'video (2).mp4', bytesWritten: bytes.byteLength },
    { ...second, state: 'canceled', filename: '../unsafe.mp4' },
  ]));
  assert.deepEqual(plain(preview.summary), { saved: 1, ready: 1, alreadyRecorded: 0, missing: 0, conflicts: 0, copies: 1, adopted: 0 });
  assert.deepEqual(session.directoryHandle.videoNames, []);
  assert.deepEqual(root.videoNames, ['video (2).mp4']);
  const result = await session.importReport(preview);
  assert.equal(result.imported, 1);
  assert.equal(result.copied, 1);
  assert.deepEqual(session.directoryHandle.videoNames, ['video (2).mp4']);
  assert.deepEqual(root.videoNames, ['video (2).mp4']);
  assert.equal((await session.directoryHandle.json(CACHE)).saved[item.mediaId].origin, 'report-import');
  assert.equal((await session.importReport(preview)).alreadyRecorded, 1);
  assert.deepEqual(session.directoryHandle.videoNames, ['video (2).mp4']);
  session.close();
});

test('adopts existing child files first and distinguishes missing files from conflicts', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  session.directoryHandle.putFile('video.mp4', bytes);
  root.putFile('video.mp4', new Uint8Array(bytes.byteLength));
  session.directoryHandle.putFile('bad.mp4', new Uint8Array(bytes.byteLength));
  const preview = await session.previewReport(report([
    { ...item, state: 'saved', filename: 'video.mp4', bytesWritten: bytes.byteLength },
    { ...second, state: 'saved', filename: 'missing.mp4', bytesWritten: bytes.byteLength },
    { mediaId: '2', shortcode: 'C', state: 'saved', filename: 'bad.mp4', bytesWritten: bytes.byteLength },
  ]));
  assert.equal(preview.summary.adopted, 1);
  assert.equal(preview.summary.copies, 0);
  assert.equal(preview.summary.missing, 1);
  assert.equal(preview.summary.conflicts, 1);
  const result = await session.importReport(preview);
  assert.equal(result.imported, 1);
  assert.equal(result.copied, 0);
  assert.deepEqual(session.directoryHandle.videoNames.sort(), ['bad.mp4', 'video.mp4']);
  session.close();
});

test('report copy reserves a unique filename and persists intent before file creation', async () => {
  const root = memoryDirectory();
  root.putFile('video.mp4', bytes);
  const session = await environment().openLibrary(root, profile);
  session.directoryHandle.putFile('video.mp4', 'keep this file');
  let intentBeforeCreate = false;
  root.state.hook = async event => {
    if (event.operation === 'file-created' && event.path.endsWith('/video (1).mp4')) {
      const cache = await session.directoryHandle.json(CACHE);
      intentBeforeCreate = cache.pending[item.mediaId]?.relativePath === 'video (1).mp4';
    }
  };
  const preview = await session.previewReport(report());
  await session.importReport(preview);
  assert.equal(intentBeforeCreate, true);
  assert.equal((await session.verifyItem(item)).filename, 'video (1).mp4');
  assert.deepEqual(session.directoryHandle.videoNames.sort(), ['video (1).mp4', 'video.mp4']);
  assert.equal(await (await session.directoryHandle.getFileHandle('video.mp4')).getFile().then(file => file.text()), 'keep this file');
  session.close();
});

test('portable import names preserve case variants and paths claimed by missing videos', async () => {
  const root = memoryDirectory('Reel Saver', { caseInsensitive: false });
  root.putFile('video.mp4', bytes);
  const session = await environment().openLibrary(root, profile);
  await record(session, second, 'Video.mp4');
  const preview = await session.previewReport(report());
  assert.equal(preview.summary.copies, 1);
  assert.equal((await session.importReport(preview)).imported, 1);
  assert.equal((await session.verifyItem(item)).filename, 'video (1).mp4');
  assert.deepEqual(session.directoryHandle.videoNames.sort(), ['Video.mp4', 'video (1).mp4']);
  assert.equal((await session.verifyItem(second)).filename, 'Video.mp4');
  await session.directoryHandle.removeEntry('Video.mp4');
  const third = { mediaId: '2', shortcode: 'C' };
  const next = await session.previewReport(report([{ ...third, state: 'saved', filename: 'video.mp4', bytesWritten: bytes.byteLength }]));
  assert.equal((await session.importReport(next)).imported, 1);
  assert.equal((await session.verifyItem(third)).filename, 'video (2).mp4');
  assert.deepEqual(root.videoNames, ['video.mp4']);
  session.close();
});

test('report adoption never attributes another Reel\'s child file to a new ID', async () => {
  const root = memoryDirectory('Reel Saver', { caseInsensitive: false });
  const session = await environment().openLibrary(root, profile);
  await record(session, second, 'video.mp4');
  const preview = await session.previewReport(report());
  assert.equal(preview.summary.ready, 0);
  assert.equal(preview.summary.conflicts, 1);
  assert.equal((await session.importReport(preview)).imported, 0);
  assert.equal(await session.verifyItem(item), null);
  assert.equal((await session.verifyItem(second)).filename, 'video.mp4');
  session.close();
});

test('reserved names expose immutable other-Reel claims without reserving a deleted same-ID path', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  await record(session);
  await session.directoryHandle.removeEntry('video.mp4');
  const reserved = session.reservedNamesFor(second);
  assert.deepEqual(plain(reserved), ['video.mp4']);
  assert.ok(Object.isFrozen(reserved));
  assert.deepEqual(plain(session.reservedNamesFor(item)), []);
  assert.throws(() => session.reservedNamesFor({ ...second, mediaId: '2' }), { code: 'CACHE_INVALID_ITEM' });
  session.close();
  assert.throws(() => session.reservedNamesFor(second), { code: 'CACHE_CLOSED' });
});

test('report copy metadata failure retries recording without creating a second copy', async () => {
  const root = memoryDirectory();
  root.putFile('video.mp4', bytes);
  const session = await environment().openLibrary(root, profile);
  const preview = await session.previewReport(report());
  let physical = false;
  let fail = true;
  root.state.hook = event => {
    if (event.operation === 'committed' && event.path.endsWith('/video.mp4')) physical = true;
    if (physical && fail && event.operation === 'close' && event.path.endsWith(`/${CACHE}`)) throw namedError('QuotaExceededError');
  };
  await assert.rejects(session.importReport(preview), { code: 'CACHE_WRITE_FAILED' });
  assert.deepEqual(session.directoryHandle.videoNames, ['video.mp4']);
  await assert.rejects(session.clearHistory(), { code: 'CACHE_BUSY' });
  fail = false;
  const result = await session.importReport(preview);
  assert.equal(result.imported, 1);
  assert.equal(result.copied, 1);
  assert.deepEqual(session.directoryHandle.videoNames, ['video.mp4']);
  assert.equal(session.recordedCount, 1);
  session.close();
});

test('canceling a report copy removes its own partial file and clears confirmed absent intent', async () => {
  const root = memoryDirectory();
  root.putFile('video.mp4', bytes);
  const session = await environment().openLibrary(root, profile);
  const preview = await session.previewReport(report());
  const controller = new AbortController();
  root.state.hook = event => { if (event.operation === 'write' && event.path.endsWith('/video.mp4')) controller.abort(); };
  await assert.rejects(session.importReport(preview, { signal: controller.signal }), { code: 'CACHE_IMPORT_CANCELLED' });
  assert.deepEqual(session.directoryHandle.videoNames, []);
  assert.deepEqual((await session.directoryHandle.json(CACHE)).pending, {});
  assert.deepEqual(root.videoNames, ['video.mp4']);
  session.close();
});

test('rejects forged, conflicting and unsafe report data and previews from another session', async () => {
  const root = memoryDirectory();
  const session = await environment().openLibrary(root, profile);
  for (const data of [
    report(undefined, { id: '9', username: 'wrong.owner' }),
    report([{ ...item, state: 'saved', filename: '../video.mp4', bytesWritten: bytes.byteLength }]),
    report([{ ...item, mediaId: '2', state: 'saved', filename: 'video.mp4', bytesWritten: bytes.byteLength }]),
    report([{ ...item, state: 'saved', filename: 'video.mp4', bytesWritten: bytes.byteLength }, { ...item, state: 'saved', filename: 'other.mp4', bytesWritten: bytes.byteLength }]),
    report([{ ...item, state: 'saved', filename: 'video.mp4', bytesWritten: bytes.byteLength }, { ...second, state: 'saved', filename: 'VIDEO.mp4', bytesWritten: bytes.byteLength }]),
  ]) await assert.rejects(session.previewReport(data), error => error.code?.startsWith('CACHE_'));
  await assert.rejects(session.previewReport(report(Array(50001).fill({ state: 'canceled' }))), { code: 'CACHE_LIMIT' });
  await assert.rejects(session.importReport({ summary: { ready: 1 } }), { code: 'CACHE_INVALID_REPORT' });
  session.close();
});

test('failed partial-copy cleanup keeps the pending intent and blocks duplicate import copies', async () => {
  const root = memoryDirectory();
  root.putFile('video.mp4', bytes);
  const cache = environment();
  const session = await cache.openLibrary(root, profile);
  const child = session.directoryHandle;
  const preview = await session.previewReport(report());
  root.state.hook = event => {
    if (event.operation === 'write' && event.path.endsWith('/video.mp4')) throw namedError('QuotaExceededError');
    if (event.operation === 'remove' && event.path.endsWith('/video.mp4')) throw namedError('NotAllowedError');
  };
  await assert.rejects(session.importReport(preview), error => error.code === 'CACHE_RECONCILIATION_REQUIRED' && error.message.includes('video.mp4'));
  assert.deepEqual(child.videoNames, ['video.mp4']);
  assert.equal((await child.json(CACHE)).pending[item.mediaId].relativePath, 'video.mp4');
  assert.deepEqual((await child.json(CACHE)).saved, {});
  root.state.hook = undefined;
  await assert.rejects(session.importReport(preview), { code: 'CACHE_RECONCILIATION_REQUIRED' });
  assert.deepEqual(child.videoNames, ['video.mp4']);
  session.close();
  await assert.rejects(cache.openLibrary(root, profile), { code: 'CACHE_RECONCILIATION_REQUIRED' });
  assert.deepEqual(root.videoNames, ['video.mp4']);
});

test('report preview cancellation stops between files without adopting or copying entries', async () => {
  const root = memoryDirectory();
  root.putFile('video.mp4', bytes);
  root.putFile('second.mp4', bytes);
  const session = await environment().openLibrary(root, profile);
  const controller = new AbortController();
  root.state.hook = event => {
    if (event.operation === 'read' && event.path.endsWith('/video.mp4')) controller.abort();
  };
  await assert.rejects(session.previewReport(report([
    { ...item, state: 'saved', filename: 'video.mp4', bytesWritten: bytes.byteLength },
    { mediaId: '2', shortcode: 'C', state: 'saved', filename: 'second.mp4', bytesWritten: bytes.byteLength },
  ]), { signal: controller.signal }), { code: 'CACHE_IMPORT_CANCELLED' });
  assert.equal(session.recordedCount, 0);
  assert.deepEqual(session.directoryHandle.videoNames, []);
  assert.equal(root.state.calls.some(event => event.operation === 'read' && event.path.endsWith('/second.mp4')), false);
  session.close();
});

test('profile cache initialization precedes index commit and failed index writes are discoverable', async () => {
  const root = memoryDirectory();
  root.state.hook = event => { if (event.operation === 'close' && event.path.endsWith(`/${INDEX}`)) throw namedError('QuotaExceededError'); };
  const cache = environment();
  await assert.rejects(cache.openLibrary(root, profile), { code: 'CACHE_WRITE_FAILED' });
  const child = root.lookup(profile.username);
  assert.equal((await child.json(CACHE)).profile.id, profile.id);
  root.state.hook = undefined;
  const session = await cache.openLibrary(root, profile);
  assert.equal(session.directoryHandle, child);
  assert.equal(root.names.filter(name => root.lookup(name).kind === 'directory').length, 1);
  session.close();
});
