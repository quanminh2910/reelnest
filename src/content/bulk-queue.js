// Pure in-tab controller. The page panel supplies discovery and save adapters;
// this module never holds signed media URLs, folder handles, or Chrome APIs.
(() => {
  'use strict';
  if (globalThis.ReelSaverBulkQueue) return;
  let serial = 0;
  const terminals = new Set(['completed', 'completed_with_errors', 'stopped']);
  const pauseCodes = new Set([
    'LOGIN_REQUIRED', 'CHECKPOINT_REQUIRED', 'RATE_LIMITED', 'FOLDER_PERMISSION',
    'FOLDER_REQUIRED', 'FOLDER_FULL', 'FILE_NO_SPACE', 'FILE_ACCESS_DENIED',
    'DRIVE_DISCONNECTED', 'FOLDER_SAVE_FAILED', 'FOLDER_UNAVAILABLE',
    'SAVE_CANCELLED', 'DOWNLOAD_CANCELED', 'USER_CANCELED',
    'RECONCILIATION_REQUIRED', 'DOWNLOAD_UNCERTAIN',
    'UNKNOWN_OUTCOME', 'PROFILE_CHANGED', 'PAGE_CHANGED', 'SOURCE_CHANGED',
    'CONTEXT_CHANGED', 'JOB_LOST', 'JOB_EXPIRED', 'LEASE_LOST', 'INVALID_JOB',
    'SCHEMA_CHANGED', 'SCHEMA_ERROR', 'ADAPTER_UNAVAILABLE', 'UNSUPPORTED_SOURCE',
    'RECONCILE_REQUIRED', 'STORAGE_FAILED', 'STALE_JOB', 'STALE_OPERATION',
    'ADAPTER_ERROR', 'PROFILE_UNAVAILABLE', 'MEDIA_MISMATCH', 'INVALID_ITEM', 'FILE_FAILED',
  ]);
  const skipCodes = new Set(['MEDIA_UNAVAILABLE', 'MEDIA_NOT_FOUND', 'NOT_FOUND', 'DELETED', 'NO_MP4']);
  const transientCodes = new Set(['NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'TRANSFER_TIMEOUT', 'LOOKUP_TIMEOUT', 'SERVER_ERROR', 'VIDEO_REQUEST_FAILED', 'SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED']);
  const pauses = code => pauseCodes.has(code) || /^CACHE_/.test(code);

  function problem(code, message, stage, retryable = false) {
    const error = new Error(message);
    Object.assign(error, { code, stage, retryable });
    return error;
  }

  function validateOptions(value) {
    const options = value || {};
    const profile = options.profile;
    if (!profile || !/^[1-9]\d{0,31}$/.test(String(profile.id || '')) ||
        typeof profile.username !== 'string' || !/^[A-Za-z0-9._]{1,30}$/.test(profile.username)) {
      throw problem('INVALID_OPTIONS', 'A valid Instagram profile is required.', 'start');
    }
    const mode = options.mode ?? 'batches';
    const batchSize = options.batchSize ?? 35;
    if (!['batches', 'scan_all'].includes(mode) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw problem('INVALID_OPTIONS', 'Choose a download mode and a batch size from 1 to 500.', 'start');
    }
    if (options.jobId !== undefined && (typeof options.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(options.jobId))) {
      throw problem('INVALID_OPTIONS', 'The bulk job identifier is invalid.', 'start');
    }
    return { profile: { id: String(profile.id), username: profile.username }, mode, batchSize,
      ...(options.jobId ? { jobId: options.jobId } : {}) };
  }

  function cleanMessage(value) {
    return String(value || 'The request could not be completed.').replace(/https?:\/\/\S+/g, '[link]').slice(0, 500);
  }

  // Share this whitelist with the panel's runtime and report boundaries. Only
  // variable names are useful here; variable values can contain session data.
  function sanitizeDiagnostic(value) {
    if (!value || typeof value !== 'object') return undefined;
    const identifier = entry => typeof entry === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(entry);
    const diagnostic = {};
    for (const name of ['queryName', 'adapterVersion']) if (identifier(value[name])) diagnostic[name] = value[name];
    if (['environment.execute', 'fetchQuery'].includes(value.executionMethod)) diagnostic.executionMethod = value.executionMethod;
    if (Array.isArray(value.connectionPath) && value.connectionPath.length > 0 && value.connectionPath.length <= 8 &&
        value.connectionPath.every(identifier)) diagnostic.connectionPath = Object.freeze([...value.connectionPath]);
    if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) diagnostic.httpStatus = value.httpStatus;
    if (Number.isSafeInteger(value.serverCode) || (typeof value.serverCode === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value.serverCode))) diagnostic.serverCode = value.serverCode;
    if (typeof value.serverMessage === 'string') diagnostic.serverMessage = value.serverMessage
      .replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitted]')
      .replace(/\bBearer\s+[^\s;,"']+/gi, 'Bearer [redacted]')
      .replace(/\b(?:authorization|set-cookie|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '[credential omitted]')
      .replace(/\b(?:x-csrftoken|csrftoken|csrf[_-]?token|access[_-]?token|refresh_token|id_token|sessionid|session_key|token|lsd|fb_dtsg|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, '[credential omitted]')
      .replace(/[A-Za-z]:[\\/][^\r\n;]+/g, '[path omitted]').slice(0, 500);
    if (Array.isArray(value.variableNames)) diagnostic.variableNames = Object.freeze([...new Set(value.variableNames.filter(identifier))].slice(0, 40));
    if (Array.isArray(value.unsetVariableNames)) diagnostic.unsetVariableNames = Object.freeze([...new Set(value.unsetVariableNames.filter(identifier))].slice(0, 40));
    const shapeIdentifier = entry => typeof entry === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(entry);
    for (const name of ['selectionKinds', 'fieldNames', 'fragmentNames']) {
      if (Array.isArray(value[name])) diagnostic[name] = Object.freeze([...new Set(value[name].filter(shapeIdentifier))].slice(0, 60));
    }
    if (Number.isInteger(value.connectionMatchCount) && value.connectionMatchCount >= 0 && value.connectionMatchCount <= 2000) {
      diagnostic.connectionMatchCount = value.connectionMatchCount;
    }
    return Object.keys(diagnostic).length ? Object.freeze(diagnostic) : undefined;
  }

  function normalizeError(cause, stage) {
    const value = cause?.error || cause || {};
    const code = typeof value.code === 'string' ? value.code.slice(0, 80) :
      value.name === 'AbortError' ? 'SAVE_CANCELLED' : 'UNEXPECTED_ERROR';
    const wait = Number(value.retryAfterMs);
    const diagnostic = sanitizeDiagnostic(value.diagnostic);
    return Object.freeze({ code, message: cleanMessage(value.message), stage: value.stage || stage,
      retryable: value.retryable === true || transientCodes.has(code),
      ...(Number.isFinite(wait) && wait > 0 ? { retryAfterMs: Math.min(wait, 86_400_000) } : {}),
      ...(diagnostic ? { diagnostic } : {}),
      ...(value.cleanupFailed ? { cleanupFailed: true } : {}),
      ...(typeof value.leftoverFilename === 'string' ? {
        leftoverFilename: value.leftoverFilename.replaceAll('\\', '/').split('/').pop().slice(0, 200),
      } : {}) });
  }

  function defaultSleep(milliseconds, signal) {
    if (!milliseconds) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(problem('SAVE_CANCELLED', 'The job was stopped.', 'wait')); return; }
      const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(problem('SAVE_CANCELLED', 'The job was stopped.', 'wait'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  function create(dependencies) {
    if (typeof dependencies?.discoverPage !== 'function' || typeof dependencies?.saveItem !== 'function') {
      throw problem('INVALID_ADAPTER', 'Discovery and saving adapters are required.', 'start');
    }
    const now = dependencies.now || Date.now;
    const sleep = dependencies.sleep || defaultSleep;
    const retryDelays = Array.isArray(dependencies.retryDelays) ? dependencies.retryDelays.slice(0, 5).map(value =>
      Math.min(60_000, Math.max(0, Number(value) || 0))) : [1000, 3000];
    const onChange = dependencies.onChange;
    let options = null;
    let state = 'idle';
    let phase = 'ready';
    let cursor = null;
    let exhausted = false;
    let batchNumber = 0;
    let batch = [];
    let offset = 0;
    let pending = [];
    let records = new Map();
    let order = [];
    let counters = { saved: 0, alreadyDownloaded: 0, failed: 0, skipped: 0, queued: 0, canceled: 0 };
    let seenCursors = new Set();
    let noProgressPages = 0;
    let consecutiveFailures = 0;
    let activeId = null;
    let operation = null;
    let generation = 0;
    let pumping = null;
    let pauseRequested = false;
    let stopRequested = false;
    let approved = false;
    let error = null;
    let pauseReason = null;
    let retryAt = 0;
    let startedAt = null;
    let endedAt = null;
    let lastProgressAt = 0;

    function update(id, patch) {
      const previous = records.get(id);
      if (!previous) return;
      const previousCounter = previous.state === 'already_downloaded' ? 'alreadyDownloaded' : previous.state;
      if (Object.hasOwn(counters, previousCounter)) counters[previousCounter]--;
      const next = Object.freeze({ ...previous, ...patch });
      records.set(id, next);
      const nextCounter = next.state === 'already_downloaded' ? 'alreadyDownloaded' : next.state;
      if (Object.hasOwn(counters, nextCounter)) counters[nextCounter]++;
    }

    function snapshot() {
      const active = activeId ? records.get(activeId) : null;
      return {
        jobId: options?.jobId || null, profile: options ? { ...options.profile } : null,
        mode: options?.mode || 'batches', batchSize: options?.batchSize || 35,
        state, phase, batchNumber, sourceExhausted: exhausted, cursor,
        counts: { discovered: records.size, ...counters },
        active: active ? { mediaId: active.mediaId, shortcode: active.shortcode,
          ...(active.filename ? { filename: active.filename } : {}),
          ...(active.progress ? { progress: { ...active.progress } } : {}) } : null,
        items: order.map(id => records.get(id)),
        ...(error ? { error: { ...error } } : {}),
        ...(pauseReason ? { pauseReason } : {}),
        ...(retryAt ? { retryAt } : {}), startedAt, ...(endedAt !== null ? { endedAt } : {}),
      };
    }

    function emit() {
      if (typeof onChange === 'function') {
        try { onChange(snapshot()); } catch {}
      }
    }

    function assertAvailable() {
      if (pumping || !['idle', ...terminals].includes(state)) {
        throw problem('JOB_BUSY', 'Stop or finish the current bulk job before starting another.', 'start');
      }
    }

    function pauseAtBoundary() {
      if (!pauseRequested) return false;
      state = 'paused';
      activeId = null;
      pauseRequested = false;
      emit();
      return true;
    }

    function finishStopped() {
      for (const [id, item] of records) {
        if (['queued', 'resolving', 'saving'].includes(item.state)) update(id, { state: 'canceled' });
      }
      activeId = null;
      operation = null;
      state = 'stopped';
      endedAt = now();
      pauseRequested = false;
      emit();
    }

    function finishCompleted() {
      activeId = null;
      state = counters.failed ? 'completed_with_errors' : 'completed';
      endedAt = now();
      error = null;
      pauseReason = null;
      emit();
    }

    function typedPage(page) {
      if (!page || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean' || page.items.length > 2000) {
        throw problem('SCHEMA_CHANGED', 'Instagram returned an unrecognized profile page. The scan is incomplete.', 'discovery');
      }
      const next = page.nextCursor == null ? null : String(page.nextCursor);
      if (next !== null && (!next || next.length > 4096) || page.hasMore && !next) {
        throw problem('SCHEMA_CHANGED', 'Instagram did not return a usable next-page cursor. The scan is incomplete.', 'discovery');
      }
      const items = page.items.map(item => {
        const mediaId = String(item?.mediaId || '');
        if (!/^[1-9]\d{0,31}$/.test(mediaId) || typeof item.shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,28}$/.test(item.shortcode)) {
          throw problem('SCHEMA_CHANGED', 'Instagram returned an unrecognized Reel identifier. The scan is incomplete.', 'discovery');
        }
        return { mediaId, shortcode: item.shortcode,
          username: typeof item.username === 'string' ? item.username.slice(0, 64) : options.profile.username };
      });
      if (page.hasMore && (next === cursor || seenCursors.has(next))) {
        throw problem('CURSOR_REPEATED', 'Instagram repeated a profile page. Resume to retry the incomplete scan.', 'discovery');
      }
      return { items, nextCursor: next, hasMore: page.hasMore };
    }

    async function discover(expectedGeneration) {
      const controller = new AbortController();
      operation = controller;
      let page;
      let unique;
      let existing;
      let retries = 0;
      try {
        while (expectedGeneration === generation && !stopRequested) {
          try {
            page = typedPage(await dependencies.discoverPage({ cursor, signal: controller.signal }));
            unique = new Map();
            existing = new Map();
            for (const item of page.items) if (!records.has(item.mediaId)) unique.set(item.mediaId, item);
            if (typeof dependencies.checkExisting === 'function') {
              for (const item of unique.values()) {
                if (expectedGeneration !== generation || stopRequested) return false;
                let cached;
                try { cached = await dependencies.checkExisting({ item: { ...item }, signal: controller.signal }); }
                catch (cause) {
                  if (typeof (cause?.error?.code || cause?.code) === 'string' && pauses(cause?.error?.code || cause.code)) throw cause;
                  throw problem('CACHE_CHECK_FAILED', 'Download history could not be checked. Retry before downloading this page.', 'cache');
                }
                if (cached != null) existing.set(item.mediaId, cacheResult(cached));
              }
            }
            break;
          } catch (cause) {
            if (expectedGeneration !== generation || stopRequested) return false;
            const failed = normalizeError(cause, 'discovery');
            if (pauseRequested) { error = failed; pauseAtBoundary(); return false; }
            if (failed.retryable && !pauses(failed.code) && retries < retryDelays.length) {
              error = failed;
              emit();
              await sleep(Math.max(retryDelays[retries++], failed.retryAfterMs || 0), controller.signal);
              if (pauseAtBoundary()) return false;
              continue;
            }
            error = failed;
            retryAt = error.retryAfterMs ? now() + error.retryAfterMs : 0;
            state = pauses(error.code) && !/^SCHEMA|ADAPTER|UNSUPPORTED/.test(error.code) ? 'paused' : 'incomplete';
            pauseReason = error.message;
            emit();
            return false;
          }
        }
      } finally {
        if (operation === controller) operation = null;
      }
      if (expectedGeneration !== generation || stopRequested) return false;
      const nextNoProgress = unique.size ? 0 : noProgressPages + 1;
      if (page.hasMore && nextNoProgress >= 5) {
        error = normalizeError(problem('NO_DISCOVERY_PROGRESS', 'Instagram returned several pages without new Reels. The scan is incomplete.', 'discovery'), 'discovery');
        state = 'incomplete';
        pauseReason = error.message;
        emit();
        return false;
      }
      // Commit cursor and every returned item together, including page overflow.
      for (const item of unique.values()) {
        const cached = existing.get(item.mediaId);
        records.set(item.mediaId, Object.freeze({ ...item, state: cached ? 'already_downloaded' : 'queued', attempts: 0,
          ...(cached ? { ...cached, reason: 'already_downloaded' } : {}) }));
        order.push(item.mediaId);
        if (cached) counters.alreadyDownloaded++;
        else { pending.push(item.mediaId); counters.queued++; }
      }
      if (page.hasMore) seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
      exhausted = !page.hasMore;
      noProgressPages = nextNoProgress;
      error = null;
      emit();
      return true;
    }

    function cacheResult(value) {
      if (value?.cacheHit !== true || typeof value.filename !== 'string' || !value.filename || value.filename.length > 1024 ||
          !Number.isSafeInteger(value.bytesWritten) || value.bytesWritten <= 0) {
        throw problem('CACHE_ENTRY_INVALID', 'Download history returned an invalid file result. Repair it before downloading.', 'cache');
      }
      const filename = value.filename.replaceAll('\\', '/').split('/').pop();
      if (!filename || !/\.mp4$/i.test(filename) || /[\u0000-\u001f<>:"|?*]/.test(filename)) {
        throw problem('CACHE_ENTRY_INVALID', 'Download history returned an invalid filename. Repair it before downloading.', 'cache');
      }
      return { filename, bytesWritten: value.bytesWritten, cacheHit: true };
    }

    async function save(id, expectedGeneration) {
      let retries = 0;
      while (expectedGeneration === generation && !stopRequested) {
        if (pauseAtBoundary()) return false;
        const item = records.get(id);
        const attempt = item.attempts + 1;
        const attemptId = `${options.jobId}_${id}_${attempt}`;
        const controller = new AbortController();
        operation = controller;
        activeId = id;
        lastProgressAt = 0;
        update(id, { state: 'resolving', attempts: attempt, attemptId, error: undefined, progress: undefined });
        emit();
        try {
          const result = await dependencies.saveItem({
            item: { mediaId: item.mediaId, shortcode: item.shortcode, username: item.username },
            attemptId, signal: controller.signal,
            onProgress(value) {
              if (expectedGeneration !== generation || operation !== controller || controller.signal.aborted) return;
              const progress = {};
              for (const key of ['bytesWritten', 'totalBytes']) {
                if (Number.isFinite(value?.[key]) && value[key] >= 0) progress[key] = value[key];
              }
              const filename = typeof value?.filename === 'string' ? value.filename.slice(0, 200) : undefined;
              update(id, { state: 'saving', progress: Object.freeze(progress), ...(filename ? { filename } : {}) });
              if (now() - lastProgressAt >= 100) { lastProgressAt = now(); emit(); }
            },
          });
          if (expectedGeneration !== generation) return false;
          const cached = result?.cacheHit === true ? cacheResult(result) : null;
          if (!result || typeof result.filename !== 'string' || !result.filename || result.filename.length > 1024) {
            throw problem('RECONCILIATION_REQUIRED', 'The save result could not be confirmed. Check the destination before resuming.', 'save');
          }
          const filename = result.filename.replaceAll('\\', '/').split('/').pop();
          update(id, { state: cached ? 'already_downloaded' : 'saved', filename, progress: undefined,
            ...(cached ? { cacheHit: true, reason: 'already_downloaded' } : {}),
            ...(Number.isFinite(result.bytesWritten) && result.bytesWritten >= 0 ? { bytesWritten: result.bytesWritten } : {}),
            ...(Number.isInteger(result.downloadId) ? { downloadId: result.downloadId } : {}), error: undefined });
          activeId = null;
          consecutiveFailures = 0;
          error = null;
          emit();
          return true;
        } catch (cause) {
          if (expectedGeneration !== generation) return false;
          if (stopRequested) { update(id, { state: 'canceled', progress: undefined }); activeId = null; return false; }
          const failed = normalizeError(cause, 'save');
          if (pauses(failed.code) || failed.cleanupFailed) {
            update(id, { state: 'queued', error: failed, progress: undefined });
            activeId = null;
            error = failed;
            retryAt = failed.retryAfterMs ? now() + failed.retryAfterMs : 0;
            state = 'paused';
            pauseReason = failed.message;
            pauseRequested = false;
            emit();
            return false;
          }
          if (skipCodes.has(failed.code)) {
            update(id, { state: 'skipped', error: failed, progress: undefined });
            activeId = null;
            consecutiveFailures = 0;
            emit();
            return true;
          }
          if (pauseRequested) {
            update(id, { state: 'queued', error: failed, progress: undefined });
            activeId = null;
            pauseAtBoundary();
            return false;
          }
          if (failed.retryable && retries < retryDelays.length) {
            update(id, { error: failed, progress: undefined });
            emit();
            const delay = Math.max(retryDelays[retries++], failed.retryAfterMs || 0);
            try { await sleep(delay, controller.signal); } catch {
              if (stopRequested) { update(id, { state: 'canceled' }); activeId = null; return false; }
              throw problem('RECONCILIATION_REQUIRED', 'The retry wait was interrupted. Resume to continue this item.', 'wait');
            }
            if (pauseRequested) {
              update(id, { state: 'queued' });
              activeId = null;
              pauseAtBoundary();
              return false;
            }
            continue;
          }
          // A refreshed signed URL was already tried within the retry budget.
          // Repeated refusal may reflect account access, so stop scheduling.
          if (['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED'].includes(failed.code)) {
            update(id, { state: 'queued', error: failed, progress: undefined });
            activeId = null;
            error = failed;
            state = 'paused';
            pauseReason = failed.message;
            emit();
            return false;
          }
          update(id, { state: 'failed', error: failed, progress: undefined });
          activeId = null;
          consecutiveFailures++;
          if (consecutiveFailures >= 3 && (counters.queued > 0 || !exhausted)) {
            error = normalizeError(problem('REPEATED_FAILURES', 'Several videos failed in a row. Check Instagram and the save location before resuming.', 'save'), 'save');
            state = 'paused';
            pauseReason = error.message;
          }
          emit();
          return true;
        } finally {
          if (operation === controller) operation = null;
        }
      }
      return false;
    }

    async function pump(expectedGeneration) {
      while (expectedGeneration === generation && ['running', 'pausing', 'stopping'].includes(state)) {
        if (stopRequested) { finishStopped(); return; }
        if (exhausted && counters.queued === 0 && activeId === null) { finishCompleted(); return; }
        if (pauseAtBoundary()) return;
        if (phase === 'discovering') {
          const fullScan = options.mode === 'scan_all' && !approved;
          if (!exhausted && (fullScan || pending.length < options.batchSize)) {
            if (!await discover(expectedGeneration)) {
              if (stopRequested) finishStopped();
              return;
            }
            continue;
          }
          if (fullScan && exhausted && records.size) {
            phase = 'ready'; state = 'paused'; pauseReason = 'Ready to download all discovered Reels.';
            emit(); return;
          }
          if (!pending.length && exhausted) { finishCompleted(); return; }
          phase = 'downloading';
        }
        if (phase === 'downloading') {
          if (offset >= batch.length) {
            batch = []; offset = 0;
            if (pending.length) {
              batch = pending.splice(0, options.batchSize);
              batchNumber++;
              emit();
            } else if (exhausted) { finishCompleted(); return; }
            else { phase = 'discovering'; emit(); continue; }
          }
          if (!await save(batch[offset], expectedGeneration)) {
            if (stopRequested) finishStopped();
            return;
          }
          offset++;
          if (offset >= batch.length && options.mode === 'batches') phase = 'discovering';
        }
      }
    }

    function launch() {
      if (pumping) return;
      const expectedGeneration = generation;
      pumping = Promise.resolve().then(() => pump(expectedGeneration)).catch(cause => {
        if (expectedGeneration !== generation) return;
        if (stopRequested) { finishStopped(); return; }
        if (activeId) update(activeId, { state: 'queued' });
        activeId = null;
        error = normalizeError(cause, phase === 'discovering' ? 'discovery' : 'save');
        state = phase === 'discovering' ? 'incomplete' : 'paused';
        pauseReason = error.message;
        emit();
      }).finally(() => {
        pumping = null;
        if (state === 'running' || state === 'stopping') launch();
      });
    }

    function start(value) {
      assertAvailable();
      const valid = validateOptions(value);
      generation++;
      options = { ...valid, jobId: valid.jobId || `bulk-${now()}-${++serial}` };
      state = 'running'; phase = 'discovering'; cursor = null; exhausted = false;
      batchNumber = 0; batch = []; offset = 0; pending = []; records = new Map(); order = [];
      counters = { saved: 0, alreadyDownloaded: 0, failed: 0, skipped: 0, queued: 0, canceled: 0 };
      seenCursors = new Set(); noProgressPages = 0; consecutiveFailures = 0; activeId = null; operation = null;
      pauseRequested = false; stopRequested = false; approved = false;
      error = null; pauseReason = null; retryAt = 0; startedAt = now(); endedAt = null;
      emit(); launch(); return snapshot();
    }

    function pause(reason) {
      if (state === 'running' || state === 'pausing') {
        pauseRequested = true; state = 'pausing';
        pauseReason = cleanMessage(reason || 'Paused by you.');
        emit();
      }
      return snapshot();
    }

    function resume() {
      if (!['paused', 'incomplete', 'pausing'].includes(state)) return snapshot();
      if (retryAt > now()) { emit(); return snapshot(); }
      // The worker can replay the last fetched page after a lost response. An
      // explicit retry grants a fresh no-progress budget without discarding
      // that cached page, pending overflow, or any previously seen media IDs.
      if (error?.code === 'NO_DISCOVERY_PROGRESS') noProgressPages = 0;
      if (phase === 'ready') { approved = true; phase = 'downloading'; }
      state = 'running'; pauseRequested = false; error = null; pauseReason = null; retryAt = 0;
      consecutiveFailures = 0;
      emit(); launch(); return snapshot();
    }

    function stop() {
      if (state === 'idle' || terminals.has(state)) return snapshot();
      stopRequested = true; pauseRequested = false; state = 'stopping';
      operation?.abort();
      emit(); launch(); return snapshot();
    }

    function retryFailed() {
      if (pumping || state !== 'completed_with_errors') {
        throw problem('JOB_BUSY', 'Retry failed items after the current full-profile pass finishes.', 'retry');
      }
      const failed = order.filter(id => records.get(id).state === 'failed');
      if (!failed.length) return snapshot();
      for (const id of failed) update(id, { state: 'queued', error: undefined });
      pending = failed; batch = []; offset = 0; approved = true;
      state = 'running'; phase = 'downloading'; endedAt = null;
      pauseRequested = false; stopRequested = false; error = null; pauseReason = null;
      consecutiveFailures = 0;
      emit(); launch(); return snapshot();
    }

    // The adapter may finish a physical save while Stop is settling. Record its
    // durable receipt without restarting discovery or scheduling another file.
    function recordSaved(mediaId, result) {
      if (!terminals.has(state)) throw problem('JOB_BUSY', 'Settle physical receipts after the queue stops.', 'cache');
      const previous = records.get(mediaId);
      if (!previous || !result || typeof result.filename !== 'string' || !result.filename ||
          !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.cacheHit) {
        throw problem('INVALID_RESULT', 'A known physical-save receipt is required.', 'cache');
      }
      update(mediaId, { state: 'saved', result: { filename: result.filename, bytesWritten: result.bytesWritten },
        filename: result.filename, bytesWritten: result.bytesWritten, error: undefined });
      if (/^CACHE_/.test(error?.code || '') || error?.code === 'RECONCILIATION_REQUIRED') {
        error = null;
        pauseReason = null;
      }
      emit();
      return snapshot();
    }

    async function waitForIdle() {
      while (pumping) await pumping;
      return snapshot();
    }

    return Object.freeze({ start, pause, resume, stop, retryFailed, recordSaved, snapshot, waitForIdle });
  }

  Object.defineProperty(globalThis, 'ReelSaverBulkQueue', {
    value: Object.freeze({ create, validateOptions, sanitizeDiagnostic }), configurable: true,
  });
})();
