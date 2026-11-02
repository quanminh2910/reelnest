import '../shared/download-limits.js';
import '../shared/profile-queue-config.js';

// The worker's extension origin owns this database. Content scripts never open
// page-origin IndexedDB to store queue data, and directory handles stay in memory.
export const MAX_QUEUE_BYTES = 64 * 1024 * 1024;
export const MAX_PROFILE_REPORT_BYTES = 16 * 1024 * 1024;
const RECEIPT_HEADROOM = 64 * 1024;
const DB_NAME = 'reelnest-profile-queue';
const config = globalThis.ReelNestProfileQueueConfig;
const limits = globalThis.ReelSaverDownloadLimits;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const numeric = value => typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value);
const runStates = new Set(['idle', 'starting', 'running', 'pausing', 'paused', 'stopping', 'incomplete', 'completed', 'completed_with_errors', 'stopped', 'interrupted']);
const entryStates = new Set(['pending', 'starting', 'loading', 'running', 'pausing', 'paused', 'finishing', 'incomplete', 'completed', 'completed_with_errors', 'skipped', 'duplicate', 'stopped', 'not_run', 'interrupted', 'failed', 'needs_attention']);
const terminalRuns = new Set(['completed', 'completed_with_errors', 'stopped', 'interrupted']);
const itemStates = new Set(['queued', 'resolving', 'saving', 'unknown', 'saved', 'failed', 'skipped', 'canceled', 'already_downloaded', 'deferred']);
const clone = value => structuredClone(value);
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const emptyCounts = () => ({ discovered: 0, saved: 0, alreadyDownloaded: 0, failed: 0, skipped: 0, queued: 0, canceled: 0, deferred: 0 });
const problem = (code, message) => Object.assign(new Error(message), { code, stage: 'queue' });

function sanitizedText(value, maximum = 500) {
  return String(value ?? '').slice(0, 4000)
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitted]')
    .replace(/\bBearer\s+[^\s;,"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:authorization|set-cookie|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '[credential omitted]')
    .replace(/\b(?:x-csrftoken|csrftoken|csrf[_-]?token|access[_-]?token|refresh_token|id_token|sessionid|session_key|token|lsd|fb_dtsg|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, '[credential omitted]')
    .replace(/[A-Za-z]:[\\/][^\r\n;]+/g, '[path omitted]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximum);
}

function sanitizeError(value) {
  if (value == null) return null;
  if (!object(value)) return { code: 'QUEUE_ERROR', message: sanitizedText(value) };
  return { code: typeof value.code === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.code) ? value.code : 'QUEUE_ERROR',
    ...(typeof value.stage === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(value.stage) ? { stage: value.stage } : {}),
    message: sanitizedText(value.message || 'The queue operation could not finish.'),
    ...(value.cleanupFailed === true ? { cleanupFailed: true } : {}) };
}

function filename(value, required = false) {
  if (value == null || value === '') {
    if (required) throw problem('INVALID_RESULT', 'A saved video needs its confirmed MP4 filename.');
    return undefined;
  }
  const name = typeof value === 'string' ? value.replaceAll('\\', '/').split('/').pop() : '';
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/.test(name) ||
      /[. ]$/.test(name) || !/\.mp4$/i.test(name)) throw problem('INVALID_RESULT', 'The video filename is invalid.');
  return name;
}

function mediaIdentity(value) {
  if (!object(value) || !numeric(value.mediaId) || typeof value.shortcode !== 'string' ||
      !/^[A-Za-z0-9_-]{1,28}$/.test(value.shortcode) || value.shortcode.length > 1 && value.shortcode.startsWith('A')) {
    throw problem('INVALID_ITEM', 'A discovered Reel identity is invalid.');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const decoded = [...value.shortcode].reduce((result, character) => result * 64n + BigInt(alphabet.indexOf(character)), 0n).toString();
  if (decoded !== value.mediaId) throw problem('INVALID_ITEM', 'The Reel code does not match its numeric identity.');
  return { mediaId: value.mediaId, shortcode: value.shortcode };
}

function summary(run) {
  const result = clone(run);
  delete result._itemBytes;
  for (const entry of result.entries) { delete entry._itemBytes; delete entry._nextOrder; }
  return result;
}

function validatedRun(value) {
  if (!object(value) || !Number.isInteger(value.schemaVersion)) throw problem('CACHE_QUEUE_CORRUPT', 'The saved queue results are damaged and were kept unchanged.');
  if (value.schemaVersion !== 1) throw problem('CACHE_QUEUE_UNSUPPORTED', 'These queue results use a newer format and were kept unchanged.');
  if (!id(value.id) || value.runId !== value.id || !runStates.has(value.state) || !integer(value.currentIndex) ||
      !integer(value.committedNewSaves) || !integer(value.revision) || !integer(value._itemBytes) ||
      !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 100 || value.currentIndex > value.entries.length ||
      !object(value.options) || !['folder', 'downloads'].includes(value.options.destination) || typeof value.options.skipExisting !== 'boolean') {
    throw problem('CACHE_QUEUE_CORRUPT', 'The saved queue run has invalid metadata.');
  }
  let draft;
  try { draft = config.normalizeDraft(value.draft); } catch { throw problem('CACHE_QUEUE_CORRUPT', 'The saved queue draft is invalid.'); }
  if (draft.entries.length !== value.entries.length) throw problem('CACHE_QUEUE_CORRUPT', 'The saved queue has inconsistent profile entries.');
  let committed = 0;
  value.entries.forEach((entry, index) => {
    if (!object(entry) || entry.id !== draft.entries[index].id || entry.username !== config.normalizeProfileInput(entry.username) ||
        !entryStates.has(entry.state) || !integer(entry.committedNewSaves) || !integer(entry._itemBytes) || !integer(entry._nextOrder) ||
        entry.effectiveLimit !== config.effectiveLimit(draft, draft.entries[index]) || !object(entry.counts) ||
        !Object.keys(emptyCounts()).every(key => integer(entry.counts[key])) || entry.counts.saved !== entry.committedNewSaves ||
        entry.profile != null && (!object(entry.profile) || !numeric(entry.profile.id) || entry.profile.username !== config.normalizeProfileInput(entry.profile.username))) {
      throw problem('CACHE_QUEUE_CORRUPT', 'A saved queue profile has invalid metadata.');
    }
    committed += entry.committedNewSaves;
  });
  if (committed !== value.committedNewSaves) throw problem('CACHE_QUEUE_CORRUPT', 'The saved queue totals do not match their profiles.');
  if (value.reservation !== null && (!object(value.reservation) || !id(value.reservation.entryId) || !numeric(value.reservation.mediaId) ||
      !id(value.reservation.attemptId) || !value.entries.some(entry => entry.id === value.reservation.entryId))) {
    throw problem('CACHE_QUEUE_CORRUPT', 'The saved queue reservation is invalid.');
  }
  return value;
}

function storageError(error, write) {
  if (typeof error?.code === 'string') return error;
  if (error?.name === 'VersionError') return problem('CACHE_QUEUE_UNSUPPORTED', 'The queue database uses a newer format and was kept unchanged.');
  if (error?.name === 'QuotaExceededError') return problem('CACHE_QUEUE_LIMIT', 'Queue result storage is full. Stop and export the results before starting a smaller run.');
  return problem(write ? 'CACHE_QUEUE_WRITE_FAILED' : 'CACHE_QUEUE_READ_FAILED', write
    ? 'The queue result could not be recorded. Retry its history update before downloading another copy.'
    : 'Saved queue results could not be read. Retry before downloading more videos.');
}

export function createMemoryQueueBackend() {
  const state = { latest: null, items: new Map(), failRead: false, failWrite: false };
  let tail = Promise.resolve();
  return {
    state,
    async transaction(mode, action) {
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        if (state.failRead) throw new Error('Read unavailable');
        const working = mode === 'readwrite' ? { latest: clone(state.latest), items: clone(state.items) } : state;
        const access = {
          getRun: async () => clone(working.latest),
          putRun: async value => { working.latest = clone(value); },
          getItem: async (runId, entryId, mediaId) => clone(working.items.get(`${runId}:${entryId}:${mediaId}`)),
          putItem: async value => { working.items.set(`${value.runId}:${value.entryId}:${value.mediaId}`, clone(value)); },
          listItems: async (runId, entryId) => [...working.items.values()].filter(value => value.runId === runId && value.entryId === entryId).map(clone),
          clearItems: async () => { working.items.clear(); },
        };
        const result = await action(access);
        if (mode === 'readwrite') {
          if (state.failWrite) { state.failWrite = false; throw new Error('Write unavailable'); }
          state.latest = working.latest; state.items = working.items;
        }
        return result;
      } finally { release(); }
    },
  };
}

function createIndexedDBBackend() {
  let opened;
  function open() {
    if (!opened) opened = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('run');
        database.createObjectStore('items', { keyPath: ['runId', 'entryId', 'mediaId'] });
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Queue database blocked'));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); opened = undefined; };
        resolve(database);
      };
    }).catch(error => { opened = undefined; throw error; });
    return opened;
  }
  const requestValue = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    async transaction(mode, action) {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction(['run', 'items'], mode), run = tx.objectStore('run'), items = tx.objectStore('items');
        let result, failure;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || new Error('Queue transaction aborted'));
        tx.onerror = () => {};
        const access = {
          getRun: () => requestValue(run.get('latest')),
          putRun: value => requestValue(run.put(value, 'latest')),
          getItem: (runId, entryId, mediaId) => requestValue(items.get([runId, entryId, mediaId])),
          putItem: value => requestValue(items.put(value)),
          listItems: (runId, entryId) => requestValue(items.getAll(IDBKeyRange.bound([runId, entryId, ''], [runId, entryId, '\uffff']))),
          clearItems: () => requestValue(items.clear()),
        };
        Promise.resolve().then(() => action(access)).then(value => { result = value; }, error => {
          failure = error;
          try { tx.abort(); } catch { reject(error); }
        });
      });
    },
  };
}

export function createQueueStore({ backend = createIndexedDBBackend(), now = Date.now,
  idFactory = () => crypto.randomUUID(), maxBytes = MAX_QUEUE_BYTES, maxProfileBytes = MAX_PROFILE_REPORT_BYTES } = {}) {
  const headroom = Math.min(RECEIPT_HEADROOM, Math.floor(Math.min(maxBytes, maxProfileBytes) / 8));
  const transact = async (write, action) => {
    try { return await backend.transaction(write ? 'readwrite' : 'readonly', action); }
    catch (error) { throw storageError(error, write); }
  };
  async function load(tx, runId) {
    const stored = await tx.getRun();
    if (!stored) {
      if (runId) throw problem('STALE_QUEUE', 'This queue no longer owns the latest results.');
      return null;
    }
    const run = validatedRun(stored);
    if (runId && run.id !== runId) throw problem('STALE_QUEUE', 'This queue belongs to an older run.');
    return run;
  }
  const entryFor = (run, entryId) => {
    const entry = run.entries.find(value => value.id === entryId);
    if (!entry) throw problem('INVALID_ENTRY', 'This profile is not part of the queue run.');
    return entry;
  };
  function assertCapacity(run, final = false) {
    const allowance = final ? 0 : headroom;
    const metaBytes = size(run);
    if (metaBytes + run._itemBytes > maxBytes - allowance || run.entries.some(entry => entry._itemBytes + 4096 > maxProfileBytes - allowance)) {
      throw problem('CACHE_QUEUE_LIMIT', 'The queue result archive reached its size limit. Stop and export its reports before starting a smaller run.');
    }
  }
  async function saveRun(tx, run, final = false) {
    run.revision++; run.updatedAt = now();
    assertCapacity(run, final);
    await tx.putRun(run);
    return summary(run);
  }
  function checkedRecord(run, entry, value) {
    if (!object(value) || value.runId !== run.id || value.entryId !== entry.id || !itemStates.has(value.state) ||
        !integer(value.order) || !integer(value.attempts)) throw problem('CACHE_QUEUE_CORRUPT', 'A saved queue item has invalid metadata.');
    mediaIdentity(value);
    return value;
  }
  async function known(tx, run, entry, item) {
    const identity = mediaIdentity(item);
    const value = await tx.getItem(run.id, entry.id, identity.mediaId);
    if (!value || checkedRecord(run, entry, value).shortcode !== identity.shortcode) {
      throw problem('INVALID_ITEM', 'This Reel was not discovered for the current queue profile.');
    }
    return value;
  }
  const counter = state => state === 'already_downloaded' ? 'alreadyDownloaded' : state;
  async function putItem(tx, run, entry, previous, next) {
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    const before = previous ? size(previous) : 0;
    if (previous) {
      const key = counter(previous.state);
      if (Object.hasOwn(entry.counts, key)) entry.counts[key]--;
    } else entry.counts.discovered++;
    const key = counter(next.state);
    if (Object.hasOwn(entry.counts, key)) entry.counts[key]++;
    const delta = size(next) - before;
    entry._itemBytes += delta; run._itemBytes += delta;
    await tx.putItem(next);
  }
  const ownedReservation = (run, entry, item, attemptId) => run.reservation?.entryId === entry.id &&
    run.reservation?.mediaId === item.mediaId && run.reservation?.attemptId === attemptId;
  function checkedAttempt(attemptId) {
    if (!id(attemptId) || attemptId.length > 100) throw problem('INVALID_ATTEMPT', 'The queue download attempt is invalid.');
  }
  function reportItem(value) {
    return { mediaId: value.mediaId, shortcode: value.shortcode, state: value.state, attempts: value.attempts,
      ...(value.filename ? { filename: value.filename } : {}),
      ...(positive(value.bytesWritten) ? { bytesWritten: value.bytesWritten } : {}),
      ...(integer(value.downloadId) ? { downloadId: value.downloadId } : {}),
      ...(value.reason ? { reason: value.reason } : {}), ...(value.error ? { error: clone(value.error) } : {}) };
  }
  async function profileReport(tx, run, entry) {
    const records = (await tx.listItems(run.id, entry.id)).map(value => checkedRecord(run, entry, value)).sort((a, b) => a.order - b.order);
    const report = { version: 1, jobId: entry.childJobId || `${run.id}-${entry.id}`, profile: entry.profile || { id: null, username: entry.username },
      mode: 'batches', batchSize: run.draft.batchSize, maxNewVideos: entry.effectiveLimit,
      committedNewSaves: entry.committedNewSaves, destination: run.options.destination, skipExisting: run.options.skipExisting,
      state: entry.state, sourceExhausted: entry.sourceExhausted, startedAt: entry.startedAt || run.createdAt,
      ...(entry.endedAt ? { endedAt: entry.endedAt } : {}), phase: entry.phase || 'discovering',
      ...(entry.completionReason ? { completionReason: entry.completionReason } : {}),
      ...(entry.error ? { error: clone(entry.error) } : {}), counts: clone(entry.counts), items: records.map(reportItem) };
    if (size(report) > maxProfileBytes) throw problem('CACHE_QUEUE_LIMIT', 'This profile report exceeds its supported export size.');
    return report;
  }

  return Object.freeze({
    getLatest: () => transact(false, async tx => { const run = await load(tx); return run ? summary(run) : null; }),
    getRun: runId => transact(false, async tx => summary(await load(tx, runId))),
    create(draftValue, options) {
      const draft = config.normalizeDraft(draftValue);
      if (!draft.entries.length) throw problem('INVALID_QUEUE', 'Add at least one profile before starting the queue.');
      if (!object(options) || !['folder', 'downloads'].includes(options.destination) ||
          options.skipExisting !== undefined && typeof options.skipExisting !== 'boolean') throw problem('INVALID_SETTINGS', 'Choose a library folder or Browser Downloads for the queue.');
      return transact(true, async tx => {
        const previous = await load(tx);
        if (previous && (!terminalRuns.has(previous.state) || previous.reservation)) {
          throw problem('QUEUE_BUSY', 'Stop or reconcile the previous queue before replacing its results.');
        }
        const runId = idFactory();
        if (!id(runId)) throw problem('INVALID_QUEUE', 'The new queue identifier is invalid.');
        const createdAt = now();
        const run = { schemaVersion: 1, id: runId, runId, draft, options: { destination: options.destination, skipExisting: options.skipExisting !== false },
          state: 'running', currentIndex: 0, committedNewSaves: 0, reservation: null, revision: 0, createdAt, updatedAt: createdAt,
          _itemBytes: 0, entries: draft.entries.map(entry => ({ id: entry.id, username: entry.username, profile: null, state: 'pending',
            effectiveLimit: config.effectiveLimit(draft, entry), committedNewSaves: 0, counts: emptyCounts(), sourceExhausted: false,
            childJobId: null, _itemBytes: 0, _nextOrder: 0 })) };
        assertCapacity(run);
        await tx.clearItems(); await tx.putRun(run);
        return summary(run);
      });
    },
    updateRun(runId, patch) {
      const allowed = new Set(['state', 'currentIndex', 'completionReason', 'error', 'endedAt', 'pausedAt']);
      if (!object(patch) || Object.keys(patch).some(key => !allowed.has(key))) throw problem('INVALID_QUEUE', 'The queue update contains protected fields.');
      return transact(true, async tx => {
        const run = await load(tx, runId);
        if (patch.state !== undefined && !runStates.has(patch.state)) throw problem('INVALID_STATE', 'The queue state is invalid.');
        if (patch.currentIndex !== undefined && (!integer(patch.currentIndex) || patch.currentIndex > run.entries.length)) throw problem('INVALID_ENTRY', 'The current profile position is invalid.');
        if (patch.currentIndex !== undefined && patch.currentIndex !== run.currentIndex && run.reservation) throw problem('RECONCILIATION_REQUIRED', 'Confirm the active video before moving to another queue profile.');
        if (patch.state && terminalRuns.has(patch.state) && patch.state !== 'interrupted' && run.reservation) throw problem('RECONCILIATION_REQUIRED', 'A saved video still needs confirmation before this queue can finish.');
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'error') run.error = sanitizeError(value);
          else if (key === 'completionReason') { if (value === null) delete run[key]; else if (typeof value === 'string' && /^[a-z_]{1,80}$/.test(value)) run[key] = value; else throw problem('INVALID_QUEUE', 'The queue completion reason is invalid.'); }
          else if (key.endsWith('At')) { if (value === null) delete run[key]; else if (positive(value)) run[key] = value; else throw problem('INVALID_QUEUE', 'The queue timestamp is invalid.'); }
          else run[key] = value;
        }
        return saveRun(tx, run, true);
      });
    },
    updateEntry(runId, entryId, patch) {
      const allowed = new Set(['profile', 'childJobId', 'state', 'completionReason', 'sourceExhausted', 'error', 'startedAt', 'endedAt', 'phase']);
      if (!object(patch) || Object.keys(patch).some(key => !allowed.has(key))) throw problem('INVALID_QUEUE', 'The profile update contains protected fields.');
      return transact(true, async tx => {
        const run = await load(tx, runId), entry = entryFor(run, entryId);
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'profile') {
            if (!object(value) || !numeric(value.id)) throw problem('INVALID_PROFILE', 'The queue profile needs a numeric Instagram identity.');
            const profile = { id: value.id, username: config.normalizeProfileInput(value.username) };
            if (entry.profile && entry.profile.id !== profile.id) throw problem('PROFILE_CHANGED', 'This queue profile now resolves to a different Instagram account.');
            entry.profile = profile; entry.username = profile.username;
          } else if (key === 'error') entry.error = sanitizeError(value);
          else if (key === 'state') { if (!entryStates.has(value)) throw problem('INVALID_STATE', 'The profile state is invalid.'); entry.state = value; }
          else if (key === 'sourceExhausted') { if (typeof value !== 'boolean') throw problem('INVALID_QUEUE', 'Profile pagination completion is invalid.'); entry[key] = value; }
          else if (key === 'childJobId') { if (value !== null && !id(value)) throw problem('INVALID_QUEUE', 'The profile job identifier is invalid.'); entry[key] = value; }
          else if (key.endsWith('At')) { if (value === null) delete entry[key]; else if (positive(value)) entry[key] = value; else throw problem('INVALID_QUEUE', 'The profile timestamp is invalid.'); }
          else { if (value === null) delete entry[key]; else if (typeof value === 'string' && /^[a-z_]{1,80}$/.test(value)) entry[key] = value; else throw problem('INVALID_QUEUE', 'The profile result metadata is invalid.'); }
        }
        return saveRun(tx, run, true);
      });
    },
    discover(runId, entryId, values) {
      if (!Array.isArray(values) || values.length > 2000) throw problem('INVALID_ITEM', 'The queue discovery page is invalid.');
      const items = values.map(mediaIdentity);
      return transact(true, async tx => {
        const run = await load(tx, runId), entry = entryFor(run, entryId);
        for (const item of items) {
          const previous = await tx.getItem(run.id, entry.id, item.mediaId);
          if (previous) { if (checkedRecord(run, entry, previous).shortcode !== item.shortcode) throw problem('INVALID_ITEM', 'A discovered Reel changed identity.'); continue; }
          if (entry._nextOrder >= 50_000) throw problem('CACHE_QUEUE_LIMIT', 'This profile reached the supported 50,000 report entries.');
          await putItem(tx, run, entry, null, { runId: run.id, entryId: entry.id, ...item, order: entry._nextOrder++, state: 'queued', attempts: 0 });
        }
        return saveRun(tx, run);
      });
    },
    reserve(runId, entryId, itemValue, attemptId) {
      checkedAttempt(attemptId);
      return transact(true, async tx => {
        const run = await load(tx, runId), entry = entryFor(run, entryId), previous = await known(tx, run, entry, itemValue);
        if (run.state !== 'running' || run.entries[run.currentIndex]?.id !== entry.id || !entry.profile) throw problem('STALE_QUEUE', 'Resume the queue on its current identified profile before saving another video.');
        if (previous.state === 'saved') throw problem('RECONCILIATION_REQUIRED', 'This queue already recorded that video as saved. Reconcile its acknowledgement before retrying.');
        if (run.reservation) {
          if (ownedReservation(run, entry, previous, attemptId)) return summary(run);
          throw problem('RECONCILIATION_REQUIRED', 'The previous queue save must be confirmed before another attempt can start.');
        }
        if (limits.reached(entry.effectiveLimit, entry.committedNewSaves)) throw problem('PROFILE_LIMIT_REACHED', 'This profile reached its new-video limit.');
        if (limits.reached(run.draft.totalLimit, run.committedNewSaves)) throw problem('QUEUE_LIMIT_REACHED', 'The queue reached its total new-video limit.');
        if (previous.attemptId === attemptId && ['failed', 'skipped', 'canceled'].includes(previous.state)) throw problem('STALE_OPERATION', 'This download attempt has already ended.');
        run.reservation = { entryId: entry.id, mediaId: previous.mediaId, attemptId };
        await putItem(tx, run, entry, previous, { ...previous, state: 'resolving', attemptId, attempts: previous.attempts + 1, error: undefined });
        return saveRun(tx, run);
      });
    },
    settle(runId, entryId, itemValue, attemptId, result) {
      checkedAttempt(attemptId);
      if (!object(result) || !['saved', 'failed', 'skipped', 'canceled', 'unknown'].includes(result.state)) throw problem('INVALID_RESULT', 'The queue save result is invalid.');
      const savedName = filename(result.filename, result.state === 'saved');
      if (result.state === 'saved' && !positive(result.bytesWritten)) throw problem('INVALID_RESULT', 'A saved queue video requires a confirmed positive byte count.');
      if (result.downloadId !== undefined && !integer(result.downloadId)) throw problem('INVALID_RESULT', 'The Chrome download identifier is invalid.');
      return transact(true, async tx => {
        const run = await load(tx, runId), entry = entryFor(run, entryId), previous = await known(tx, run, entry, itemValue);
        if (previous.state === 'saved') {
          if (result.state === 'saved' && (previous.filename !== savedName || previous.bytesWritten !== result.bytesWritten || previous.downloadId !== result.downloadId)) {
            throw problem('RECONCILIATION_REQUIRED', 'The repeated queue receipt does not match the recorded saved file.');
          }
          return summary(run);
        }
        if (previous.attemptId !== attemptId) throw problem('STALE_OPERATION', 'This result belongs to an older queue download attempt.');
        if (!ownedReservation(run, entry, previous, attemptId)) {
          if (['failed', 'skipped', 'canceled'].includes(previous.state) && ['failed', 'skipped', 'canceled'].includes(result.state)) return summary(run);
          throw problem('RECONCILIATION_REQUIRED', 'The queue save result has no matching allowance reservation.');
        }
        const next = { ...previous, state: result.state, ...(savedName ? { filename: savedName } : {}),
          ...(positive(result.bytesWritten) ? { bytesWritten: result.bytesWritten } : {}),
          ...(integer(result.downloadId) ? { downloadId: result.downloadId } : {}),
          ...(result.error ? { error: sanitizeError(result.error) } : { error: undefined }) };
        if (result.state === 'saved') {
          if (limits.reached(entry.effectiveLimit, entry.committedNewSaves) || limits.reached(run.draft.totalLimit, run.committedNewSaves)) {
            throw problem('RECONCILIATION_REQUIRED', 'The saved file cannot be matched to its queue allowance.');
          }
          entry.committedNewSaves++; run.committedNewSaves++;
        }
        if (result.state !== 'unknown') run.reservation = null;
        await putItem(tx, run, entry, previous, next);
        return saveRun(tx, run, true);
      });
    },
    recordItems(runId, entryId, values) {
      if (!Array.isArray(values) || values.length > 50_000) throw problem('INVALID_ITEM', 'The profile result update is invalid.');
      return transact(true, async tx => {
        const run = await load(tx, runId), entry = entryFor(run, entryId);
        for (const value of values) {
          const previous = await known(tx, run, entry, value);
          if (!itemStates.has(value.state)) throw problem('INVALID_RESULT', 'A profile item result is invalid.');
          if (previous.state === 'saved' || value.state === 'saved' || run.reservation?.entryId === entry.id && run.reservation?.mediaId === previous.mediaId) continue;
          const next = { ...previous, state: value.state, attempts: integer(value.attempts) ? Math.max(previous.attempts, value.attempts) : previous.attempts,
            ...(value.error ? { error: sanitizeError(value.error) } : { error: undefined }) };
          const name = filename(value.result?.filename || value.filename);
          if (name) next.filename = name;
          const bytesWritten = value.result?.bytesWritten ?? value.bytesWritten;
          if (positive(bytesWritten)) next.bytesWritten = bytesWritten;
          const downloadId = value.result?.downloadId ?? value.downloadId;
          if (integer(downloadId)) next.downloadId = downloadId;
          if (['already_downloaded', 'profile_limit_reached', 'queue_limit_reached', 'user_skipped', 'user_stopped'].includes(value.reason)) next.reason = value.reason;
          else delete next.reason;
          await putItem(tx, run, entry, previous, next);
        }
        return saveRun(tx, run, true);
      });
    },
    finishEntry(runId, entryId, result = {}) {
      return transact(true, async tx => {
        const run = await load(tx, runId), entry = entryFor(run, entryId);
        if (run.reservation) throw problem('RECONCILIATION_REQUIRED', 'Confirm the current saved file before advancing to another profile.');
        const state = result.state || (entry.counts.failed ? 'completed_with_errors' : 'completed');
        if (!entryStates.has(state)) throw problem('INVALID_STATE', 'The completed profile state is invalid.');
        const reason = result.completionReason || 'feed_exhausted';
        if (typeof reason !== 'string' || !/^[a-z_]{1,80}$/.test(reason)) throw problem('INVALID_RESULT', 'The profile completion reason is invalid.');
        const records = await tx.listItems(run.id, entry.id);
        for (const raw of records) {
          const previous = checkedRecord(run, entry, raw);
          if (!['queued', 'resolving', 'saving', 'unknown'].includes(previous.state)) continue;
          const deferred = ['profile_limit_reached', 'queue_limit_reached'].includes(reason);
          await putItem(tx, run, entry, previous, { ...previous, state: deferred ? 'deferred' : 'canceled', reason });
        }
        entry.state = state; entry.completionReason = reason; entry.endedAt = now();
        if (typeof result.sourceExhausted === 'boolean') entry.sourceExhausted = result.sourceExhausted;
        if (result.error) entry.error = sanitizeError(result.error); else delete entry.error;
        if (typeof result.phase === 'string' && /^[a-z_]{1,80}$/.test(result.phase)) entry.phase = result.phase;
        return saveRun(tx, run, true);
      });
    },
    getItems(runId, entryId, { states, offset = 0, limit = 200 } = {}) {
      if (!integer(offset) || !positive(limit) || limit > 1000 || states !== undefined && (!Array.isArray(states) || states.some(state => !itemStates.has(state)))) {
        return Promise.reject(problem('INVALID_QUEUE', 'The profile report page is invalid.'));
      }
      return transact(false, async tx => {
        const run = await load(tx, runId), entry = entryFor(run, entryId);
        const records = (await tx.listItems(run.id, entry.id)).map(value => checkedRecord(run, entry, value))
          .filter(value => !states || states.includes(value.state)).sort((a, b) => a.order - b.order);
        const items = records.slice(offset, offset + limit).map(value => ({ ...reportItem(value), ...(value.attemptId ? { attemptId: value.attemptId } : {}) }));
        return { items, total: records.length, nextOffset: offset + items.length < records.length ? offset + items.length : null };
      });
    },
    getProfileReport: (runId, entryId) => transact(false, async tx => { const run = await load(tx, runId); return profileReport(tx, run, entryFor(run, entryId)); }),
    getQueueReport: runId => transact(false, async tx => {
      const run = await load(tx, runId), profiles = [];
      for (const entry of run.entries) profiles.push({ entry: summary(run).entries.find(value => value.id === entry.id), report: await profileReport(tx, run, entry) });
      const report = { type: 'reelnest-profile-queue', version: 1, run: summary(run), profiles };
      if (size(report) > maxBytes) throw problem('CACHE_QUEUE_LIMIT', 'The queue report exceeds its supported export size. Export individual profile reports.');
      return report;
    }),
  });
}

export let queueStore = createQueueStore();

// Node integration tests share the same module imports as the real worker;
// replace only the persistence adapter, never any validation or accounting.
export function setQueueStoreBackendForTests(backend, options = {}) {
  if (!globalThis.process?.versions?.node) throw new Error('The test backend is available only in Node.');
  queueStore = createQueueStore({ ...options, backend });
  return queueStore;
}
