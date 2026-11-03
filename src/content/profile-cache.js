// Folder capabilities and history stay in the isolated content-script world.
(() => {
  'use strict';
  if (globalThis.ReelSaverProfileCache) return;

  const CACHE = '.reel-saver-cache.json';
  const BACKUP = '.reel-saver-cache.backup.json';
  const INDEX = '.reel-saver-library.json';
  const MAX_BYTES = 16 * 1024 * 1024;
  const MAX_ITEMS = 50000;
  const MAX_CHILDREN = 20000;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let metadataTail = Promise.resolve();
  let useActive = false;

  function failure(code, message) {
    return Object.assign(new Error(message), { code, stage: 'cache', pause: true, retryable: false });
  }
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const id = value => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
  const username = value => typeof value === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(value);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const map = () => Object.create(null);
  const stamp = () => new Date().toISOString();

  function safePart(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && value !== '.' && value !== '..' &&
      !/[\\/\u0000-\u001f\u007f-\u009f<>:"|?*\u202a-\u202e\u2066-\u2069]/.test(value) &&
      !/[. ]$/.test(value) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
  }
  function safeVideo(value) { return safePart(value) && /\.mp4$/i.test(value); }
  function profileFor(value) {
    if (!record(value) || !id(value.id) || !username(value.username)) throw failure('CACHE_INVALID_PROFILE', 'A verified Instagram profile is required for this library.');
    return { id: value.id, username: value.username };
  }
  function itemFor(value) {
    if (!record(value) || !id(value.mediaId) || typeof value.shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,28}$/.test(value.shortcode)) {
      throw failure('CACHE_INVALID_ITEM', 'A verified Reel identity is required for download history.');
    }
    let number = 0n;
    for (const letter of value.shortcode) number = number * 64n + BigInt(alphabet.indexOf(letter));
    if (number.toString() !== value.mediaId) throw failure('CACHE_INVALID_ITEM', 'The Reel ID and shortcode do not agree.');
    return { mediaId: value.mediaId, shortcode: value.shortcode };
  }
  function revision(value) { return Number.isSafeInteger(value) && value >= 0; }
  function validStamp(value) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }

  // JSON.parse alone would silently accept conflicting duplicate object keys.
  function rejectDuplicateKeys(text) {
    const stack = [];
    let keys = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '"') {
        const start = index;
        while (++index < text.length) {
          if (text[index] === '\\') index++;
          else if (text[index] === '"') break;
        }
        const frame = stack.at(-1);
        if (frame?.object && frame.key) {
          const key = JSON.parse(text.slice(start, index + 1));
          if (frame.keys.has(key)) throw failure('CACHE_CORRUPT', 'Download history contains duplicate keys. Restore its backup or import a report.');
          if (++keys > 1000000) throw failure('CACHE_LIMIT', 'Download history contains too many metadata fields.');
          frame.keys.add(key);
        }
      } else if (character === '{') stack.push({ object: true, key: true, keys: new Set() });
      else if (character === '[') stack.push({ object: false });
      else if (character === '}' || character === ']') stack.pop();
      else if (character === ':' && stack.at(-1)?.object) stack.at(-1).key = false;
      else if (character === ',' && stack.at(-1)?.object) stack.at(-1).key = true;
    }
  }
  function parse(text) {
    try {
      const result = JSON.parse(text, (key, value) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw failure('CACHE_CORRUPT', 'Download history contains an unsafe metadata key.');
        return value;
      });
      rejectDuplicateKeys(text);
      return result;
    } catch (cause) {
      if (cause?.code?.startsWith('CACHE_')) throw cause;
      throw failure('CACHE_CORRUPT', 'Download history is not valid JSON. Restore its backup or import a report.');
    }
  }

  async function fileHandle(directory, name, directoryIsOccupied = false) {
    try { return await directory.getFileHandle(name); }
    catch (cause) {
      if (cause?.name === 'NotFoundError') return null;
      if (cause?.name === 'TypeMismatchError') {
        if (directoryIsOccupied) return { kind: 'directory', name };
        throw failure('CACHE_CORRUPT', 'A history filename is occupied by a directory. Resolve it before continuing.');
      }
      throw failure('CACHE_PERMISSION', 'Library access is unavailable. Choose the library folder again.');
    }
  }
  async function readJson(directory, name) {
    const handle = await fileHandle(directory, name);
    if (!handle) return undefined;
    let file;
    try { file = await handle.getFile(); }
    catch { throw failure('CACHE_PERMISSION', 'The history file could not be read. Choose the library folder again.'); }
    if (file.size > MAX_BYTES) throw failure('CACHE_LIMIT', 'The history file exceeds the supported 16 MiB limit.');
    let text;
    try { text = await file.text(); }
    catch { throw failure('CACHE_PERMISSION', 'The history file could not be read. Choose the library folder again.'); }
    if (text.length > MAX_BYTES) throw failure('CACHE_LIMIT', 'The history file exceeds the supported size limit.');
    return parse(text);
  }
  async function writeJson(directory, name, value) {
    const text = JSON.stringify(value, null, 2);
    if (text.length > MAX_BYTES || new Blob([text]).size > MAX_BYTES) throw failure('CACHE_LIMIT', 'The history file exceeds the supported 16 MiB limit.');
    let stream;
    try {
      const handle = await directory.getFileHandle(name, { create: true });
      stream = await handle.createWritable({ keepExistingData: false });
      await stream.write(text);
      await stream.close();
    } catch {
      if (stream) await stream.abort().catch(() => {});
      throw failure('CACHE_WRITE_FAILED', 'Download history could not be recorded. Retry recording it before downloading more videos.');
    }
  }
  async function metadata(action) {
    const before = metadataTail;
    let release;
    metadataTail = new Promise(resolve => { release = resolve; });
    await before;
    try {
      if (globalThis.navigator?.locks?.request) return await navigator.locks.request('reel-saver-library-metadata', { mode: 'exclusive' }, action);
      return await action();
    } finally { release(); }
  }
  async function acquireUse() {
    if (useActive) throw failure('CACHE_BUSY', 'Another library operation is active. Finish or stop it before starting here.');
    useActive = true;
    let release;
    try {
      if (globalThis.navigator?.locks?.request) {
        const held = new Promise(resolve => { release = resolve; });
        let ready;
        let rejectReady;
        const acquired = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
        navigator.locks.request('reel-saver-library-use', { mode: 'exclusive', ifAvailable: true }, async lock => {
          ready(!!lock);
          if (lock) await held;
        }).catch(rejectReady);
        if (!await acquired) throw failure('CACHE_BUSY', 'Another tab is using a ReelNest library. Finish or stop that operation first.');
      }
      let closed = false;
      return () => { if (!closed) { closed = true; useActive = false; release?.(); } };
    } catch (cause) {
      useActive = false;
      if (cause?.code) throw cause;
      throw failure('CACHE_BUSY', 'The library could not be locked for this operation. Retry after other library operations finish.');
    }
  }

  function validateCache(value, expectedId) {
    if (!record(value) || !Number.isInteger(value.schemaVersion)) throw failure('CACHE_CORRUPT', 'The profile history format is invalid.');
    if (value.schemaVersion !== 1) throw failure('CACHE_UNSUPPORTED', 'This profile history uses an unsupported version. It was kept unchanged.');
    const profile = profileFor(value.profile);
    if (expectedId && profile.id !== expectedId) throw failure('CACHE_PROFILE_MISMATCH', 'The profile folder belongs to a different Instagram account.');
    if (!revision(value.revision) || !validStamp(value.updatedAt) || !record(value.saved) || !record(value.pending)) throw failure('CACHE_CORRUPT', 'The profile history metadata is incomplete.');
    if (new Set([...Object.keys(value.saved), ...Object.keys(value.pending)]).size > MAX_ITEMS) throw failure('CACHE_LIMIT', 'This profile exceeds the supported 50,000-Reel history limit.');
    const saved = map();
    const pending = map();
    const paths = new Map();
    const reservePath = (path, mediaId) => {
      const key = path.toLowerCase();
      if (paths.has(key) && paths.get(key) !== mediaId) throw failure('CACHE_CORRUPT', 'Different Reels claim the same video filename. Resolve their history before continuing.');
      paths.set(key, mediaId);
    };
    for (const [mediaId, entry] of Object.entries(value.saved)) {
      itemFor({ mediaId, shortcode: entry?.shortcode });
      if (!safeVideo(entry.relativePath) || !positive(entry.bytesWritten) || !validStamp(entry.recordedAt) || !['download', 'report-import'].includes(entry.origin)) throw failure('CACHE_CORRUPT', 'A saved history entry is invalid.');
      reservePath(entry.relativePath, mediaId);
      saved[mediaId] = { shortcode: entry.shortcode, relativePath: entry.relativePath, bytesWritten: entry.bytesWritten,
        recordedAt: entry.recordedAt, origin: entry.origin };
    }
    for (const [mediaId, entry] of Object.entries(value.pending)) {
      itemFor({ mediaId, shortcode: entry?.shortcode });
      if (!safeVideo(entry.relativePath) || entry.expectedBytes !== null && !positive(entry.expectedBytes) || !validStamp(entry.recordedAt) || !['download', 'report-import'].includes(entry.origin)) throw failure('CACHE_CORRUPT', 'A pending history entry is invalid.');
      reservePath(entry.relativePath, mediaId);
      if (saved[mediaId] && saved[mediaId].shortcode !== entry.shortcode) throw failure('CACHE_CORRUPT', 'The saved and pending Reel identities conflict.');
      pending[mediaId] = { shortcode: entry.shortcode, relativePath: entry.relativePath, expectedBytes: entry.expectedBytes,
        recordedAt: entry.recordedAt, origin: entry.origin };
    }
    return { schemaVersion: 1, profile, revision: value.revision, updatedAt: value.updatedAt, saved, pending };
  }
  async function readCache(directory, expectedId) {
    let primary;
    let primaryError;
    try {
      const raw = await readJson(directory, CACHE);
      if (raw !== undefined) primary = validateCache(raw, expectedId);
    } catch (cause) { primaryError = cause; }
    if (primary) return { data: primary, recovered: false };
    if (primaryError && !['CACHE_CORRUPT', 'CACHE_INVALID_PROFILE', 'CACHE_INVALID_ITEM'].includes(primaryError.code)) throw primaryError;
    let backup;
    let backupError;
    try {
      const raw = await readJson(directory, BACKUP);
      if (raw !== undefined) backup = validateCache(raw, expectedId);
    } catch (cause) { backupError = cause; }
    if (backup) return { data: backup, recovered: true };
    if (primaryError || backupError) throw primaryError || backupError;
    return null;
  }
  function freshCache(profile) {
    return { schemaVersion: 1, profile: { ...profile }, revision: 0, updatedAt: stamp(), saved: map(), pending: map() };
  }
  function validateIndex(value) {
    if (!record(value) || value.schemaVersion !== 1 || !record(value.profiles) || !revision(value.revision)) throw failure('CACHE_INDEX_CORRUPT', 'The library lookup needs to be rebuilt.');
    const profiles = map();
    if (Object.keys(value.profiles).length > MAX_ITEMS) throw failure('CACHE_LIMIT', 'The library contains too many profile mappings.');
    for (const [profileId, entry] of Object.entries(value.profiles)) {
      if (!id(profileId) || !record(entry) || !safePart(entry.folderName) || !username(entry.username)) throw failure('CACHE_INDEX_CORRUPT', 'The library lookup contains an invalid profile mapping.');
      profiles[profileId] = { folderName: entry.folderName, username: entry.username };
    }
    return { schemaVersion: 1, revision: value.revision, profiles };
  }
  async function readIndex(root) {
    try {
      const value = await readJson(root, INDEX);
      if (value === undefined) return { schemaVersion: 1, revision: 0, profiles: map() };
      if (record(value) && Number.isInteger(value.schemaVersion) && value.schemaVersion !== 1) throw failure('CACHE_UNSUPPORTED', 'This library lookup uses a newer version. It was kept unchanged.');
      return validateIndex(value);
    } catch (cause) {
      if (['CACHE_CORRUPT', 'CACHE_INDEX_CORRUPT'].includes(cause.code)) return { schemaVersion: 1, revision: 0, profiles: map() };
      throw cause;
    }
  }
  async function entries(directory) {
    const result = [];
    try {
      const iterator = typeof directory.entries === 'function' ? directory.entries() : typeof directory.values === 'function' ? directory.values() : null;
      if (!iterator) throw new Error('Directory enumeration unavailable');
      for await (const entry of iterator) {
        const pair = Array.isArray(entry) ? entry : [entry.name, entry];
        if (result.length >= MAX_CHILDREN) throw failure('CACHE_LIMIT', 'This library contains too many immediate entries to inspect safely.');
        result.push(pair);
      }
    } catch (cause) {
      if (cause?.code?.startsWith('CACHE_')) throw cause;
      throw failure('CACHE_PERMISSION', 'The library could not be inspected. Choose the library folder again.');
    }
    return result;
  }
  function folderLabel(profile) {
    let name = profile.username.replace(/[. ]+$/g, '');
    if (!safePart(name)) name = `profile_${name.replace(/[^A-Za-z0-9._-]/g, '') || profile.id}`;
    if (!safePart(name)) name = `profile_${profile.id}`;
    return name.slice(0, 160);
  }
  async function verifyFile(directory, filename, bytes) {
    if (!safeVideo(filename) || !positive(bytes)) return false;
    const handle = await fileHandle(directory, filename, true);
    if (!handle || handle.kind === 'directory') return false;
    let file;
    try { file = await handle.getFile(); }
    catch { throw failure('CACHE_PERMISSION', 'A recorded video could not be read. Choose the library folder again.'); }
    if (file.size !== bytes || file.size < 12) return false;
    let prefix;
    try { prefix = new Uint8Array(await file.slice(0, 12).arrayBuffer()); }
    catch { throw failure('CACHE_PERMISSION', 'A recorded video could not be read. Choose the library folder again.'); }
    return String.fromCharCode(...prefix.subarray(4, 8)) === 'ftyp';
  }
  function receipt(item, entry) {
    return { filename: entry.relativePath, bytesWritten: entry.bytesWritten, cacheHit: true };
  }
  function stopped(signal) { if (signal?.aborted) throw failure('CACHE_IMPORT_CANCELLED', 'History import was canceled. Completed copies were kept.'); }

  async function openLibrary(root, rawProfile, options = {}) {
    const profile = profileFor(rawProfile);
    if (!root || typeof root.getDirectoryHandle !== 'function' || typeof root.getFileHandle !== 'function') throw failure('CACHE_LIBRARY_REQUIRED', 'Choose a library folder first.');
    const releaseUse = await acquireUse();
    let closed = false;
    let state;
    let directory;
    let folderName;
    let recovered = false;
    let previews = new WeakMap();
    let historyEpoch = 0;
    let clearingHistory = false;
    let resetReceipt = null;
    let activeImports = 0;
    const completedCopies = new Map();
    const assertOpen = () => { if (closed) throw failure('CACHE_CLOSED', 'This library operation has ended. Open the library again.'); };
    const assertReady = () => {
      assertOpen();
      if (clearingHistory || resetReceipt) throw failure('CACHE_RESET_INCOMPLETE', 'Profile history is being cleared. Finish or retry that operation before downloading again.');
    };
    function reservedNames(item) {
      return [...new Set([...Object.entries(state.saved), ...Object.entries(state.pending)]
        .filter(([mediaId]) => mediaId !== item.mediaId).map(([, entry]) => entry.relativePath))];
    }
    function claimedByOther(filename, item) {
      const key = filename.toLowerCase();
      return reservedNames(item).some(name => name.toLowerCase() === key);
    }
    async function occupiedNames() {
      const names = new Set();
      try {
        const iterator = typeof directory.keys === 'function' ? directory.keys() :
          typeof directory.entries === 'function' ? directory.entries() : directory.values();
        for await (const entry of iterator) {
          const name = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : entry.name;
          if (names.size >= MAX_ITEMS * 2) throw failure('CACHE_LIMIT', 'The profile folder has too many entries to choose a safe filename.');
          names.add(name.toLowerCase());
        }
      } catch (cause) {
        if (cause?.code?.startsWith('CACHE_')) throw cause;
        throw failure('CACHE_PERMISSION', 'The profile folder could not be inspected. Choose the library folder again.');
      }
      return names;
    }

    async function mutate(action) {
      assertReady();
      return metadata(async () => {
        assertReady();
        const latest = await readCache(directory, profile.id);
        if (!latest) throw failure('CACHE_RECONCILIATION_REQUIRED', 'The profile history disappeared during this operation. Stop and reopen the library.');
        if (state && latest.data.revision !== state.revision) throw failure('CACHE_CONCURRENT_CHANGE', 'Download history changed outside this operation. Stop and reopen the library before continuing.');
        const old = latest.data;
        const current = validateCache(old, profile.id);
        const changed = await action(current);
        const renamed = current.profile.username !== profile.username;
        current.profile.username = profile.username;
        if (changed === false && !latest.recovered && !renamed) { state = current; return; }
        current.revision++;
        current.updatedAt = stamp();
        validateCache(current, profile.id);
        if (!latest.recovered) await writeJson(directory, BACKUP, old);
        try { await writeJson(directory, CACHE, current); }
        catch (cause) {
          // A failed close can have an uncertain outcome. Accept only this exact
          // validated revision; otherwise retain the physical-save receipt.
          const reopened = await readCache(directory, profile.id).catch(() => null);
          if (!reopened || reopened.recovered || JSON.stringify(reopened.data) !== JSON.stringify(current)) throw cause;
        }
        state = current;
      });
    }
    async function clearHistory() {
      assertOpen();
      if (clearingHistory || activeImports || completedCopies.size) throw failure('CACHE_BUSY', 'Finish the current library operation before clearing profile history.');
      clearingHistory = true;
      try {
        return await metadata(async () => {
          assertOpen();
          if (activeImports || completedCopies.size) throw failure('CACHE_BUSY', 'Finish the current library operation before clearing profile history.');
          const latest = await readCache(directory, profile.id);
          if (!latest) throw failure('CACHE_RECONCILIATION_REQUIRED', 'The profile history disappeared. Reopen the library before clearing it.');
          if (Object.keys(latest.data.pending).length) throw failure('CACHE_RECONCILIATION_REQUIRED', 'An interrupted save still needs to be reconciled. Finish it before clearing profile history.');
          if (resetReceipt) {
            const actual = JSON.stringify(latest.data);
            if (actual !== JSON.stringify(resetReceipt.before) && actual !== JSON.stringify(resetReceipt.after)) {
              throw failure('CACHE_CONCURRENT_CHANGE', 'Download history changed while clearing it. Reopen the library before continuing.');
            }
          } else {
            if (latest.data.revision !== state.revision) throw failure('CACHE_CONCURRENT_CHANGE', 'Download history changed outside this operation. Reopen the library before clearing it.');
            const next = freshCache(profile);
            next.revision = latest.data.revision + 1;
            validateCache(next, profile.id);
            resetReceipt = { before: latest.data, after: next, cleared: Object.keys(latest.data.saved).length };
          }
          const pending = resetReceipt;
          // Clear recovery data first. A successful primary reset can then
          // never resurrect old records from the ordinary automatic backup.
          await writeJson(directory, BACKUP, pending.after);
          try { await writeJson(directory, CACHE, pending.after); }
          catch (cause) {
            const reopened = await readCache(directory, profile.id).catch(() => null);
            if (!reopened || reopened.recovered || JSON.stringify(reopened.data) !== JSON.stringify(pending.after)) throw cause;
          }
          state = pending.after;
          resetReceipt = null;
          previews = new WeakMap();
          historyEpoch++;
          return { cleared: pending.cleared };
        });
      } finally { clearingHistory = false; }
    }
    async function reconcile() {
      let uncertain = false;
      await mutate(async current => {
        let changed = false;
        for (const [mediaId, pending] of Object.entries(current.pending)) {
          const handle = await fileHandle(directory, pending.relativePath, true);
          if (!handle) { delete current.pending[mediaId]; changed = true; continue; }
          if (positive(pending.expectedBytes) && await verifyFile(directory, pending.relativePath, pending.expectedBytes)) {
            current.saved[mediaId] = { shortcode: pending.shortcode, relativePath: pending.relativePath, bytesWritten: pending.expectedBytes,
              recordedAt: stamp(), origin: pending.origin };
            delete current.pending[mediaId];
            changed = true;
          } else uncertain = true;
        }
        return changed;
      });
      if (uncertain) throw failure('CACHE_RECONCILIATION_REQUIRED', 'An interrupted save has an uncertain file. Check that profile folder before downloading it again.');
    }
    async function beginWrite(rawItem, output, origin = 'download') {
      const item = itemFor(rawItem);
      if (!safeVideo(output?.filename) || output.expectedBytes != null && !positive(output.expectedBytes)) throw failure('CACHE_INVALID_OUTPUT', 'The reserved video filename or size is invalid.');
      await mutate(current => {
        const previous = current.pending[item.mediaId];
        if (previous && (previous.relativePath !== output.filename || previous.shortcode !== item.shortcode)) throw failure('CACHE_RECONCILIATION_REQUIRED', 'This Reel already has an interrupted save to reconcile.');
        if (Object.keys(current.saved).length + Object.keys(current.pending).length >= MAX_ITEMS && !own(current.saved, item.mediaId) && !own(current.pending, item.mediaId)) throw failure('CACHE_LIMIT', 'This profile exceeds the supported history entry limit.');
        current.pending[item.mediaId] = { shortcode: item.shortcode, relativePath: output.filename, expectedBytes: output.expectedBytes ?? null, recordedAt: stamp(), origin };
      });
    }
    async function commitSaved(rawItem, output, origin = 'download') {
      const item = itemFor(rawItem);
      if (!safeVideo(output?.filename) || !positive(output.bytesWritten)) throw failure('CACHE_INVALID_OUTPUT', 'The saved video result is invalid.');
      if (!await verifyFile(directory, output.filename, output.bytesWritten)) throw failure('CACHE_RECONCILIATION_REQUIRED', 'The saved video could not be verified. It was not added to download history.');
      await mutate(current => {
        const pending = current.pending[item.mediaId];
        if (pending && (pending.shortcode !== item.shortcode || pending.relativePath !== output.filename)) throw failure('CACHE_RECONCILIATION_REQUIRED', 'The completed video does not match its pending history record.');
        const previous = current.saved[item.mediaId];
        if (!pending && previous?.shortcode === item.shortcode && previous.relativePath === output.filename && previous.bytesWritten === output.bytesWritten) return false;
        current.saved[item.mediaId] = { shortcode: item.shortcode, relativePath: output.filename, bytesWritten: output.bytesWritten, recordedAt: stamp(), origin: pending?.origin || origin };
        delete current.pending[item.mediaId];
      });
    }

    try {
      await metadata(async () => {
        if (await root.queryPermission?.({ mode: 'readwrite' }) !== 'granted') throw failure('CACHE_PERMISSION', 'Library access is unavailable. Choose the library folder again.');
        if (await fileHandle(root, CACHE) || await fileHandle(root, BACKUP)) throw failure('CACHE_NOT_LIBRARY', 'You selected a profile folder. Choose its parent library folder instead.');
        const index = await readIndex(root);
        const listed = await entries(root);
        const mapped = index.profiles[profile.id]?.folderName;
        const expected = folderLabel(profile);
        const matches = [];
        const occupied = new Map(listed.map(([name, handle]) => [name.toLowerCase(), { name, handle }]));
        for (const [name, handle] of listed) {
          if (handle.kind !== 'directory' || !safePart(name)) continue;
          let found;
          try { found = await readCache(handle); }
          catch (cause) {
            if (name === mapped || name.toLowerCase() === expected.toLowerCase()) throw cause;
            continue;
          }
          if (found?.data.profile.id === profile.id) matches.push({ name, handle, found });
          else if (name === mapped && found) throw failure('CACHE_PROFILE_MISMATCH', 'The indexed profile folder belongs to a different account. Its contents were kept unchanged.');
        }
        if (matches.length > 1) throw failure('CACHE_FOLDER_CONFLICT', 'More than one profile folder has this account ID. Choose which collection to keep before continuing.');
        if (matches.length) {
          ({ name: folderName, handle: directory } = matches[0]);
          state = matches[0].found.data;
          recovered = matches[0].found.recovered;
        } else {
          if (options.existingOnly === true) throw failure('CACHE_RECONCILIATION_REQUIRED', 'Choose the original library containing this profile’s verified history before recovering its interrupted save.');
          if (mapped && occupied.has(mapped.toLowerCase())) throw failure('CACHE_RECONCILIATION_REQUIRED', 'The indexed profile folder no longer has verified history. Restore its cache or import its report before downloading again.');
          for (let suffix = 0; suffix < 1000; suffix++) {
            const candidate = suffix === 0 ? expected : suffix === 1 ? `${expected}__${profile.id}` : `${expected}__${profile.id}_${suffix}`;
            const existing = occupied.get(candidate.toLowerCase());
            if (existing && (existing.handle.kind !== 'directory' || (await entries(existing.handle)).length)) continue;
            folderName = existing?.name || candidate;
            try { directory = existing?.handle || await root.getDirectoryHandle(folderName, { create: true }); }
            catch { throw failure('CACHE_WRITE_FAILED', 'The profile folder could not be created. Check library access and available space.'); }
            state = freshCache(profile);
            await writeJson(directory, CACHE, state);
            break;
          }
          if (!directory) throw failure('CACHE_FOLDER_CONFLICT', 'A safe folder name could not be chosen for this profile.');
        }
        if (recovered) await writeJson(directory, CACHE, state);
        index.profiles[profile.id] = { folderName, username: profile.username };
        index.revision++;
        await writeJson(root, INDEX, index);
      });
      await reconcile();
    } catch (cause) { releaseUse(); throw cause; }

    const session = {
      directoryHandle: directory,
      folderName,
      profile: Object.freeze({ ...profile }),
      get recordedCount() { return Object.keys(state.saved).length; },
      get recovered() { return recovered; },
      reservedNamesFor(rawItem) {
        assertReady();
        return Object.freeze(reservedNames(itemFor(rawItem)));
      },
      close() { if (!closed) { closed = true; releaseUse(); } },
      async verifyItem(rawItem) {
        assertReady();
        const item = itemFor(rawItem);
        const entry = state.saved[item.mediaId];
        if (!entry || entry.shortcode !== item.shortcode || !await verifyFile(directory, entry.relativePath, entry.bytesWritten)) return null;
        return receipt(item, entry);
      },
      beginWrite,
      commitSaved,
      clearHistory,
      reconcile,
      async abandonWrite(rawItem) {
        const item = itemFor(rawItem);
        await mutate(async current => {
          const pending = current.pending[item.mediaId];
          if (!pending) return false;
          if (await fileHandle(directory, pending.relativePath, true)) throw failure('CACHE_RECONCILIATION_REQUIRED', 'An interrupted video file remains. Check it before clearing its pending history.');
          delete current.pending[item.mediaId];
        });
      },
      async previewReport(report, { signal } = {}) {
        assertReady();
        const epoch = historyEpoch;
        stopped(signal);
        if (!record(report) || report.version !== 1 || !Array.isArray(report.items) || profileFor(report.profile).id !== profile.id) throw failure('CACHE_INVALID_REPORT', 'Choose a supported download report for this Instagram profile.');
        if (report.items.length > MAX_ITEMS) throw failure('CACHE_LIMIT', 'This report exceeds the supported 50,000-Reel history limit.');
        const summary = { saved: 0, ready: 0, alreadyRecorded: 0, missing: 0, conflicts: 0, copies: 0, adopted: 0 };
        const candidates = [];
        const seen = new Map();
        const paths = new Map();
        for (const row of report.items) {
          stopped(signal);
          if (row?.state !== 'saved') continue;
          summary.saved++;
          const item = itemFor(row);
          const filename = row.filename;
          const bytes = row.bytesWritten ?? row.result?.bytesWritten;
          if (!safeVideo(filename) || !positive(bytes)) throw failure('CACHE_INVALID_REPORT', 'A saved report entry has an unsafe filename or invalid byte size.');
          const pathKey = filename.toLowerCase();
          if (paths.has(pathKey) && paths.get(pathKey) !== item.mediaId) throw failure('CACHE_INVALID_REPORT', 'Different Reels in this report claim the same video filename.');
          paths.set(pathKey, item.mediaId);
          const previous = seen.get(item.mediaId);
          if (previous) {
            if (previous.filename !== filename || previous.bytes !== bytes || previous.shortcode !== item.shortcode) throw failure('CACHE_INVALID_REPORT', 'The report contains conflicting saved entries for one Reel.');
            continue;
          }
          seen.set(item.mediaId, { filename, bytes, shortcode: item.shortcode });
          if (await session.verifyItem(item)) { summary.alreadyRecorded++; continue; }
          const claimed = claimedByOther(filename, item);
          const inChild = !claimed && await verifyFile(directory, filename, bytes);
          const inRoot = !inChild && await verifyFile(root, filename, bytes);
          if (inChild || inRoot) {
            candidates.push({ item, filename, bytesWritten: bytes, source: inChild ? 'child' : 'root' });
            summary.ready++;
            if (inChild) summary.adopted++; else summary.copies++;
          } else {
            const exists = await fileHandle(directory, filename, true) || await fileHandle(root, filename, true);
            if (exists || claimed) summary.conflicts++; else summary.missing++;
          }
        }
        stopped(signal);
        assertReady();
        if (epoch !== historyEpoch) throw failure('CACHE_INVALID_REPORT', 'Profile history changed. Preview this report again before importing it.');
        const preview = Object.freeze({ profile: Object.freeze({ ...profile }), folderName, summary: Object.freeze({ ...summary }) });
        previews.set(preview, { candidates, summary });
        return preview;
      },
      async importReport(preview, { signal, onProgress } = {}) {
        assertReady();
        const prepared = previews.get(preview);
        if (!prepared) throw failure('CACHE_INVALID_REPORT', 'Preview this report again before importing it.');
        activeImports++;
        try {
          const summary = { imported: 0, copied: 0, alreadyRecorded: prepared.summary.alreadyRecorded, missing: prepared.summary.missing, conflicts: prepared.summary.conflicts };
          for (const candidate of prepared.candidates) {
            stopped(signal);
            const { item, bytesWritten } = candidate;
            if (await session.verifyItem(item)) { summary.alreadyRecorded++; continue; }
            const completion = completedCopies.get(item.mediaId);
            if (completion) {
              await commitSaved(item, completion, 'report-import');
              completedCopies.delete(item.mediaId);
              summary.imported++;
              if (completion.copied) summary.copied++;
              continue;
            }
            if (candidate.source === 'child') {
              if (claimedByOther(candidate.filename, item) || !await verifyFile(directory, candidate.filename, bytesWritten)) { summary.conflicts++; continue; }
              await commitSaved(item, { filename: candidate.filename, bytesWritten }, 'report-import');
              summary.imported++;
            } else {
              if (!await verifyFile(root, candidate.filename, bytesWritten)) { summary.conflicts++; continue; }
              const stem = candidate.filename.slice(0, -4);
              const occupied = await occupiedNames();
              for (const name of reservedNames(item)) occupied.add(name.toLowerCase());
              let filename;
              for (let suffix = 0; suffix < 10000; suffix++) {
                const preferred = suffix ? `${stem} (${suffix}).mp4` : candidate.filename;
                if (safeVideo(preferred) && !occupied.has(preferred.toLowerCase()) && !await fileHandle(directory, preferred, true)) { filename = preferred; break; }
              }
              if (!filename) throw failure('CACHE_FOLDER_CONFLICT', 'A free filename could not be chosen for an imported video.');
              await beginWrite(item, { filename, expectedBytes: bytesWritten }, 'report-import');
              let target;
              let stream;
              let reader;
              let physical = false;
              try {
                stopped(signal);
                if ((await occupiedNames()).has(filename.toLowerCase()) || await fileHandle(directory, filename, true)) throw failure('CACHE_FOLDER_CONFLICT', 'The reserved import filename was created by another writer.');
                const sourceFile = await (await root.getFileHandle(candidate.filename)).getFile();
                target = await directory.getFileHandle(filename, { create: true });
                stream = await target.createWritable();
                reader = sourceFile.stream().getReader();
                let total = 0;
                while (true) {
                  stopped(signal);
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  await stream.write(chunk.value);
                  total += chunk.value.byteLength;
                }
                if (total !== bytesWritten) throw failure('CACHE_IMPORT_FAILED', 'The import copy changed size while reading. Its original was kept.');
                await stream.close();
                physical = true;
                const saved = { filename, bytesWritten, copied: true };
                completedCopies.set(item.mediaId, saved);
                await commitSaved(item, saved, 'report-import');
                completedCopies.delete(item.mediaId);
                summary.imported++;
                summary.copied++;
              } catch (cause) {
                if (!physical) {
                  if (stream) await stream.abort().catch(() => {});
                  if (target) await directory.removeEntry(filename).catch(() => {});
                  // A failed removal must leave its durable intent in place.
                  // Confirm absence independently before clearing metadata.
                  let remains = true;
                  try { remains = !!await fileHandle(directory, filename, true); } catch {}
                  if (remains) throw failure('CACHE_RECONCILIATION_REQUIRED', `The interrupted import "${filename}" could not be cleaned up. Check that file before retrying; its pending history was kept.`);
                  await session.abandonWrite(item);
                }
                if (cause?.code?.startsWith('CACHE_')) throw cause;
                throw failure('CACHE_IMPORT_FAILED', 'A video could not be copied into the profile folder. Its original was kept.');
              } finally {
                if (reader) { await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
              }
            }
            try { onProgress?.({ ...summary, total: prepared.candidates.length }); } catch {}
          }
          return summary;
        } finally { activeImports--; }
      },
    };
    return Object.freeze(session);
  }

  Object.defineProperty(globalThis, 'ReelSaverProfileCache', {
    value: Object.freeze({ openLibrary }), configurable: true,
  });
})();
