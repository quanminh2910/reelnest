import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/folder-writer.js', import.meta.url), 'utf8');
const url = 'https://scontent.cdninstagram.com/video/reel.mp4?token=example';
const mp4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 109, 100, 97, 116]);

function namedError(name) {
  const result = new Error(name);
  result.name = name;
  return result;
}

function directory({ permission = 'granted', existing = [], writeError, onWrite } = {}) {
  const files = new Map(existing.map(name => [name, { existing: true }]));
  const children = new Map();
  const state = { files, children, creates: 0, writes: 0, aborts: 0, closes: 0, removals: [] };
  const handle = {
    name: 'Chosen folder',
    async queryPermission() { return permission; },
    async getDirectoryHandle(name) {
      if (!children.has(name)) children.set(name, directory());
      return children.get(name).handle;
    },
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) throw namedError('NotFoundError');
      if (!files.has(name)) {
        files.set(name, { chunks: [] });
        state.creates += 1;
      }
      return {
        async createWritable() {
          return {
            async write(chunk) {
              state.writes += 1;
              if (writeError) throw writeError;
              files.get(name).chunks.push(new Uint8Array(chunk));
              onWrite?.();
            },
            async abort() { state.aborts += 1; },
            async close() { state.closes += 1; },
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); state.removals.push(name); },
  };
  return { handle, state };
}

function response({ bytes = mp4, chunks, mime = 'video/mp4', length = bytes.byteLength, readError, status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks || [bytes.subarray(0, 7), bytes.subarray(7)]) controller.enqueue(chunk);
      if (readError) controller.error(readError);
      else controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': mime, 'content-length': String(length) } });
}

function environment(options = {}) {
  const calls = [];
  const context = vm.createContext({
    window: { ...(options.picker ? { showDirectoryPicker: options.picker } : {}) },
    URL, Uint8Array, AbortController,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout,
    fetch: async (...args) => {
      calls.push(args);
      if (options.fetch) return options.fetch(...args);
      return response(options.response);
    },
  });
  vm.runInContext(source, context);
  return { writer: context.ReelSaverFolderWriter, calls };
}

function save(writer, dir, overrides = {}) {
  return writer.saveToFolder({ directoryHandle: dir.handle, media: { url }, filename: 'creator_ABC.mp4', ...overrides });
}

test('folder picker runs immediately in the click activation and cancellation is distinct', async () => {
  const dir = directory();
  let invoked = false;
  const { writer } = environment({ picker: () => { invoked = true; return Promise.resolve(dir.handle); } });
  assert.equal(writer.isSupported(), true);
  const selection = writer.chooseFolder();
  assert.equal(invoked, true);
  assert.equal(await selection, dir.handle);
  const canceled = environment({ picker: () => Promise.reject(namedError('AbortError')) }).writer;
  await assert.rejects(canceled.chooseFolder(), { code: 'PICKER_CANCELLED' });
  const absent = environment().writer;
  assert.equal(absent.isSupported(), false);
  await assert.rejects(absent.chooseFolder(), { code: 'FOLDER_UNSUPPORTED' });
});

test('streams a validated MP4 and reports completion only after the writable closes', async () => {
  const dir = directory();
  const { writer, calls } = environment();
  const progress = [];
  const result = await save(writer, dir, { onProgress: event => progress.push(event) });
  assert.equal(result.filename, 'creator_ABC.mp4');
  assert.equal(result.bytesWritten, mp4.length);
  assert.equal(dir.state.closes, 1);
  assert.equal(dir.state.aborts, 0);
  assert.equal(dir.state.writes, 2);
  assert.equal(progress.at(-1).bytesWritten, mp4.length);
  assert.equal(progress.at(-1).totalBytes, mp4.length);
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(calls[0][1].redirect, 'error');
});

test('an origin referrer avoids the CDN redirect rejected by strict redirect handling', async () => {
  const dir = directory();
  const { writer, calls } = environment({ fetch: async (address, options) => {
    // The live CDN redirects this request when its referrer is omitted. Keep
    // refusing redirects rather than relaxing destination validation.
    if (options.referrerPolicy === 'no-referrer' && options.redirect === 'error') {
      throw new TypeError('Failed to fetch');
    }
    return response();
  } });
  const result = await save(writer, dir);
  assert.equal(result.bytesWritten, mp4.length);
  assert.equal(dir.state.closes, 1);
  assert.equal(calls[0][1].referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].redirect, 'error');
});

test('keeps existing files and serializes concurrent downloads to unique names', async () => {
  const dir = directory({ existing: ['creator_ABC.mp4'] });
  const { writer } = environment();
  const [first, second] = await Promise.all([save(writer, dir), save(writer, dir)]);
  assert.equal(first.filename, 'creator_ABC (1).mp4');
  assert.equal(second.filename, 'creator_ABC (2).mp4');
  assert.equal(dir.state.files.get('creator_ABC.mp4').existing, true);
  assert.equal(dir.state.closes, 2);
});

test('unsafe filenames and media addresses are refused before network or filesystem writes', async () => {
  const dir = directory();
  const { writer, calls } = environment();
  for (const filename of ['../reel.mp4', '/reel.mp4', 'a//reel.mp4', 'C:\\reel.mp4', 'reel.html', 'CON/reel.mp4', 'a./reel.mp4', 'reel\u0000.mp4']) {
    await assert.rejects(save(writer, dir, { filename }), { code: 'INVALID_FILENAME' });
  }
  for (const badUrl of ['https://cdninstagram.com.attacker.test/video.mp4', 'http://scontent.cdninstagram.com/video.mp4', 'blob:https://instagram.com/one', 'https://user:pass@cdninstagram.com/video.mp4']) {
    await assert.rejects(save(writer, dir, { media: { url: badUrl } }), { code: 'INVALID_VIDEO_URL' });
  }
  assert.equal(calls.length, 0);
  assert.equal(dir.state.creates, 0);
});

test('relative directory components stay below the explicitly chosen directory', async () => {
  const dir = directory();
  const { writer } = environment();
  const saved = await save(writer, dir, { filename: 'Creator/creator_ABC.mp4' });
  assert.equal(saved.filename, 'Creator/creator_ABC.mp4');
  assert.equal(dir.state.files.size, 0);
  assert.equal(dir.state.children.get('Creator').state.files.size, 1);
});

test('case-sensitive directories reserve portable names without changing existing case variants', async () => {
  const dir = directory({ existing: ['creator_abc.MP4', 'CREATOR_ABC (1).mp4'] });
  dir.handle.keys = async function* () { yield* dir.state.files.keys(); };
  const { writer } = environment();
  let intent;
  const saved = await save(writer, dir, { beforeCreate: async value => { intent = value; } });
  assert.equal(saved.filename, 'creator_ABC (2).mp4');
  assert.equal(intent.filename, saved.filename);
  assert.equal(dir.state.files.get('creator_abc.MP4').existing, true);
  assert.equal(dir.state.files.get('CREATOR_ABC (1).mp4').existing, true);
  assert.equal(dir.state.creates, 1);
});

test('reserves missing filenames claimed by other Reel history before persisting an intent', async () => {
  const dir = directory();
  const { writer, calls } = environment();
  let intent;
  const saved = await save(writer, dir, { reservedNames: ['CREATOR_abc.mp4', 'creator_abc (1).MP4'],
    beforeCreate: async value => { intent = value; } });
  assert.equal(saved.filename, 'creator_ABC (2).mp4');
  assert.equal(intent.filename, saved.filename);
  for (const reservedNames of [['../outside.mp4'], ['child/name.mp4'], 'creator_ABC.mp4']) {
    await assert.rejects(save(writer, dir, { reservedNames }), { code: 'CACHE_INVALID_RESERVATIONS', stage: 'cache' });
  }
  assert.equal(calls.length, 1, 'invalid reservations never start a media request');
});

test('a case variant appearing during an intent commit is preserved before any video creation', async () => {
  const dir = directory();
  dir.handle.entries = async function* () { for (const name of dir.state.files.keys()) yield [name, { kind: 'file', name }]; };
  const { writer } = environment();
  await assert.rejects(save(writer, dir, { beforeCreate: async () => {
    dir.state.files.set('CREATOR_abc.MP4', { existing: true });
  } }), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(dir.state.files.get('CREATOR_abc.MP4').existing, true);
  assert.equal(dir.state.creates, 0);
  assert.deepEqual(dir.state.removals, []);
});

test('persists an intent with the actual unique relative filename before creating any video file', async () => {
  const dir = directory();
  const child = directory({ existing: ['creator_ABC.mp4'] });
  dir.state.children.set('Creator', child);
  const { writer } = environment();
  const hooks = [];
  const saved = await save(writer, dir, { filename: 'Creator/creator_ABC.mp4', beforeCreate: async intent => {
    hooks.push(JSON.parse(JSON.stringify(intent)));
    assert.equal(child.state.creates, 0);
    assert.equal(child.state.writes, 0);
    await Promise.resolve();
    assert.equal(child.state.files.has('creator_ABC (1).mp4'), false);
  } });
  assert.deepEqual(hooks, [{ filename: 'Creator/creator_ABC (1).mp4', expectedBytes: mp4.length }]);
  assert.equal(saved.filename, hooks[0].filename);
  assert.equal(child.state.closes, 1);
  assert.equal(child.state.files.get('creator_ABC.mp4').existing, true);
});

test('an intent commit failure propagates at the cache stage without creating or removing video files', async () => {
  const dir = directory({ existing: ['creator_ABC.mp4'] });
  const { writer } = environment();
  const failure = Object.assign(new Error('History could not be committed'), { code: 'CACHE_WRITE_FAILED' });
  await assert.rejects(save(writer, dir, { beforeCreate: async () => { throw failure; } }), cause =>
    cause === failure && cause.code === 'CACHE_WRITE_FAILED' && cause.stage === 'cache');
  assert.equal(dir.state.creates, 0);
  assert.equal(dir.state.writes, 0);
  assert.deepEqual(dir.state.removals, []);
  assert.equal(dir.state.files.get('creator_ABC.mp4').existing, true);
});

test('an untyped intent failure remains a cache failure before any video file exists', async () => {
  const dir = directory();
  const { writer } = environment();
  const failure = new Error('Unexpected metadata failure');
  await assert.rejects(save(writer, dir, { beforeCreate: async () => { throw failure; } }), cause =>
    cause.code === 'CACHE_WRITE_FAILED' && cause.stage === 'cache' && cause.cause === failure);
  assert.equal(dir.state.creates, 0);
  assert.deepEqual(dir.state.removals, []);
});

test('canceling immediately after the intent is persisted leaves no video file to clean up', async () => {
  const dir = directory();
  const controller = new AbortController();
  const { writer } = environment();
  let intent;
  await assert.rejects(save(writer, dir, { signal: controller.signal, beforeCreate: async value => {
    intent = value;
    controller.abort();
  } }), { code: 'SAVE_CANCELLED' });
  assert.equal(intent.filename, 'creator_ABC.mp4');
  assert.equal(dir.state.creates, 0);
  assert.equal(dir.state.files.size, 0);
  assert.deepEqual(dir.state.removals, []);
});

test('a file appearing while its intent commits is preserved and requires reconciliation', async () => {
  const dir = directory();
  const { writer } = environment();
  await assert.rejects(save(writer, dir, { beforeCreate: async ({ filename }) => {
    dir.state.files.set(filename, { existing: true });
  } }), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(dir.state.files.get('creator_ABC.mp4').existing, true);
  assert.equal(dir.state.creates, 0);
  assert.equal(dir.state.writes, 0);
  assert.deepEqual(dir.state.removals, []);
});

test('unknown response size is recorded as null, and invalid MP4 responses never persist an intent', async () => {
  const dir = directory();
  const { writer } = environment({ response: { length: 0 } });
  const intents = [];
  await save(writer, dir, { beforeCreate: async value => intents.push(value) });
  assert.equal(intents[0].expectedBytes, null);
  const invalid = environment({ response: { bytes: new TextEncoder().encode('<html>wrong video</html>') } }).writer;
  await assert.rejects(save(invalid, dir, { beforeCreate: async value => intents.push(value) }), { code: 'NOT_MP4' });
  assert.equal(intents.length, 1);
});

test('lost folder permission requires choosing again without requesting late permission', async () => {
  const dir = directory({ permission: 'prompt' });
  const { writer, calls } = environment();
  await assert.rejects(save(writer, dir), { code: 'FOLDER_PERMISSION' });
  assert.equal(calls.length, 0);
  assert.equal(await writer.getPermission(dir.handle), 'prompt');
});

test('rejects HTML and non-MP4 bytes before creating a destination file', async () => {
  for (const options of [
    { mime: 'text/html' },
    { mime: 'video/mp4', bytes: new TextEncoder().encode('<!doctype html>login') },
    { mime: 'application/octet-stream', bytes: Uint8Array.of(1, 2, 3) },
  ]) {
    const dir = directory();
    const { writer } = environment({ response: options });
    await assert.rejects(save(writer, dir), { code: 'NOT_MP4' });
    assert.equal(dir.state.creates, 0);
  }
});

test('failed or incomplete writes are aborted and their newly created files removed', async () => {
  const writeFailure = directory({ writeError: namedError('QuotaExceededError') });
  const { writer } = environment();
  await assert.rejects(save(writer, writeFailure), { code: 'FOLDER_FULL', stage: 'write' });
  assert.equal(writeFailure.state.aborts, 1);
  assert.equal(writeFailure.state.files.size, 0);
  assert.equal(writeFailure.state.closes, 0);
  const incomplete = directory();
  const altered = environment({ response: { length: mp4.length + 100 } }).writer;
  await assert.rejects(save(altered, incomplete), { code: 'INCOMPLETE_VIDEO' });
  assert.equal(incomplete.state.aborts, 1);
  assert.equal(incomplete.state.files.size, 0);
});

test('a stream read failure aborts the writable and removes only the new partial file', async () => {
  const dir = directory({ existing: ['creator_ABC.mp4'] });
  let reads = 0;
  let canceled = false;
  const { writer } = environment({ fetch: async () => ({
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'video/mp4' }),
    body: { getReader: () => ({
      async read() {
        reads += 1;
        if (reads === 1) return { done: false, value: mp4 };
        throw new TypeError('Connection lost while reading');
      },
      async cancel() { canceled = true; },
      releaseLock() {},
    }) },
  }) });
  await assert.rejects(save(writer, dir), cause => cause.code === 'FOLDER_SAVE_FAILED' &&
    cause.stage === 'transfer' && /transfer/.test(cause.message) && !/choose.*folder/i.test(cause.message));
  assert.equal(dir.state.writes, 1);
  assert.equal(dir.state.aborts, 1);
  assert.equal(canceled, true);
  assert.deepEqual([...dir.state.files.keys()], ['creator_ABC.mp4']);
});

test('canceling an active transfer removes the partial file and preserves prior files', async () => {
  const controller = new AbortController();
  const dir = directory({ existing: ['creator_ABC.mp4'], onWrite: () => controller.abort() });
  const { writer } = environment();
  await assert.rejects(save(writer, dir, { signal: controller.signal }), { code: 'SAVE_CANCELLED' });
  assert.equal(dir.state.aborts, 1);
  assert.deepEqual([...dir.state.files.keys()], ['creator_ABC.mp4']);
});

test('fetch failures identify the transfer stage without asking to choose the folder again', async () => {
  const dir = directory();
  const { writer } = environment({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(save(writer, dir), cause => cause.code === 'FOLDER_SAVE_FAILED' && cause.stage === 'fetch' &&
    /transfer/.test(cause.message) && /Browser Downloads/.test(cause.message) && !/choose.*folder/i.test(cause.message));
  assert.equal(dir.state.creates, 0);
});

test('untyped filesystem write failures retain the folder message and write stage', async () => {
  const dir = directory({ writeError: new TypeError('Filesystem write failed') });
  const { writer } = environment();
  await assert.rejects(save(writer, dir), cause => cause.code === 'FOLDER_SAVE_FAILED' && cause.stage === 'write' &&
    /saved to this folder/.test(cause.message));
  assert.equal(dir.state.aborts, 1);
  assert.equal(dir.state.files.size, 0);
});

test('network stalls time out and propagate a specific retryable error', async () => {
  const dir = directory();
  const { writer } = environment({
    setTimeout: callback => setTimeout(callback, 5),
    fetch: async (address, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(namedError('AbortError')), { once: true });
    }),
  });
  await assert.rejects(save(writer, dir), { code: 'TRANSFER_TIMEOUT' });
  assert.equal(dir.state.creates, 0);
});

test('a canceled queued save does not prevent later saves', async () => {
  const dir = directory();
  const { writer } = environment();
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(save(writer, dir, { signal: canceled.signal }), { code: 'SAVE_CANCELLED' });
  const later = await save(writer, dir);
  assert.equal(later.filename, 'creator_ABC.mp4');
});

test('rate limits and temporary media errors carry distinct retry policies', async () => {
  const dir = directory();
  const limited = environment({ fetch: async () => new Response('', {
    status: 429, headers: { 'retry-after': '60' },
  }) }).writer;
  await assert.rejects(save(limited, dir), cause => cause.code === 'RATE_LIMITED' && cause.retryAfterMs === 60000);
  for (const [status, code] of [[503, 'SERVER_ERROR'], [403, 'SERVER_FORBIDDEN'], [401, 'SERVER_UNAUTHORIZED']]) {
    const writer = environment({ fetch: async () => new Response('', { status }) }).writer;
    await assert.rejects(save(writer, dir), cause => cause.code === code && cause.retryable === true);
  }
  assert.equal(dir.state.creates, 0);
});

test('uncertain partial cleanup is reported with only the relative filename', async () => {
  const dir = directory({ writeError: namedError('QuotaExceededError') });
  dir.handle.removeEntry = async () => { throw namedError('NotAllowedError'); };
  const { writer } = environment();
  await assert.rejects(save(writer, dir), cause => cause.code === 'FOLDER_FULL' && cause.cleanupFailed === true &&
    cause.leftoverFilename === 'creator_ABC.mp4' && /partial file may remain/.test(cause.message));
  assert.equal(dir.state.files.size, 1);
});
