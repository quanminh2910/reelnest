// A single profile's queue child. The host keeps its directory capability;
// source-tab and document ownership are enforced by the background worker.
(() => {
  'use strict';
  if (globalThis.ReelNestProfileJobRunner) return;

  const M = 'REEL_SAVER_BULK_';
  const terminals = new Set(['completed', 'completed_with_errors', 'stopped']);
  const error = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
  const aborted = () => error('SAVE_CANCELLED', 'The download was canceled.');
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(aborted()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });

  async function create({ request, job, target, skipExisting, onChange, onLibraryDestination,
    pollIntervalMs = 800 } = {}) {
    if (typeof request !== 'function' || !job?.jobId || !job.profile || !job.options ||
        !['folder', 'downloads'].includes(target?.kind) || job.options.destination !== target.kind ||
        target.kind === 'folder' && !target.handle || !globalThis.ReelSaverBulkQueue) {
      throw error('INVALID_JOB', 'A registered profile job and its selected destination are required.');
    }
    globalThis.ReelSaverBulkQueue.validateOptions({ ...job.options, jobId: job.jobId, profile: job.profile });
    if (job.retryItems !== undefined && (!Array.isArray(job.retryItems) || job.retryItems.length > 50_000)) {
      throw error('INVALID_JOB', 'The registered retry list is invalid.');
    }
    const selected = { ...target, skipExisting: skipExisting ?? (job.options.skipExisting !== false) };
    if (typeof selected.skipExisting !== 'boolean') throw error('INVALID_JOB', 'The duplicate preference is invalid.');
    const pollInterval = Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 0 ? pollIntervalMs : 800;
    const nativeReceipts = new Map();
    const failedNativeReceipts = new Map();
    let state = null;
    let started = false;
    let finalized = false;
    let finalizing = null;

    function showLibrary() {
      if (!selected.cache) return;
      try { onLibraryDestination?.({ rootHandle: selected.rootHandle, folderName: selected.cache.folderName,
        profile: selected.cache.profile }); } catch {}
    }
    if (selected.kind === 'folder') {
      if (!globalThis.ReelSaverProfileCache || !globalThis.ReelSaverFolderWriter) {
        throw error('CACHE_UNAVAILABLE', 'Reload this Instagram tab to load library history.');
      }
      selected.cache = await globalThis.ReelSaverProfileCache.openLibrary(selected.handle, job.profile);
      selected.rootHandle = selected.handle;
      selected.handle = selected.cache.directoryHandle;
      showLibrary();
    }

    async function settleNativeReceipt(item, receipt) {
      if (!receipt.cacheCommitted) {
        try {
          await selected.cache.commitSaved(item, receipt.result);
          receipt.cacheCommitted = true;
          showLibrary();
        } catch {
          throw error('CACHE_WRITE_FAILED', `The video ${receipt.result.filename} was saved, but its history could not be updated. Resume to record it without another download.`, { stage: 'cache' });
        }
      }
      try {
        await request({ type: M + 'ITEM_RESULT', jobId: job.jobId, mediaId: item.mediaId,
          attemptId: receipt.attemptId, result: { state: 'saved', ...receipt.result } });
      } catch {
        throw error('RECONCILIATION_REQUIRED', `The file ${receipt.result.filename} is already saved. Its result still needs recording; no second file was written.`);
      }
      nativeReceipts.delete(item.mediaId);
      return receipt.result;
    }

    async function settleFailedNativeReceipt(receipt) {
      let cleanupError;
      if (receipt.needsAbandon) {
        try {
          await selected.cache.abandonWrite(receipt.item);
          receipt.needsAbandon = false;
          if (receipt.cleanupFailed) {
            receipt.cleanupFailed = false;
            receipt.acknowledged = false;
          }
        } catch (cause) { cleanupError = cause; }
      }
      if (!receipt.acknowledged) {
        try {
          await request({ type: M + 'ITEM_RESULT', jobId: job.jobId, mediaId: receipt.item.mediaId,
            attemptId: receipt.attemptId, result: { state: receipt.state, error: { ...receipt.error,
              ...(receipt.cleanupFailed ? { cleanupFailed: true, leftoverFilename: receipt.leftoverFilename } : {}) } } });
        } catch (cause) {
          // This also fences a delayed RESOLVE that had not registered a writer.
          if (!(receipt.beforeWriter && receipt.error.code && cause.code === 'STALE_OPERATION')) {
            throw error('RECONCILIATION_REQUIRED', 'The interrupted video still needs its result recorded. Resume or Stop before downloading again.');
          }
        }
        receipt.acknowledged = true;
      }
      if (cleanupError) throw error('CACHE_WRITE_FAILED', 'The partial-file history could not be updated. Retry releasing this profile before downloading again.', { stage: 'cache' });
      if (receipt.cleanupFailed) throw error('RECONCILIATION_REQUIRED', 'Partial-file cleanup still needs confirmation before this profile can be released.');
      failedNativeReceipts.delete(receipt.item.mediaId);
    }

    function failedNativeReceipt(item, attemptId, cause, signal, details) {
      return { item, attemptId, state: signal.aborted ? 'canceled' : 'failed', acknowledged: false,
        cleanupFailed: cause.cleanupFailed === true, leftoverFilename: cause.leftoverFilename,
        error: { code: cause.code || cause.name || 'SAVE_FAILED', message: cause.message }, ...details };
    }

    async function cancelBrowser(item, attemptId) {
      await request({ type: M + 'CANCEL_ITEM', jobId: job.jobId, mediaId: item.mediaId, attemptId }).catch(() => {});
    }

    async function saveItem({ item, attemptId, signal, onProgress }) {
      if (signal.aborted) throw aborted();
      if (selected.kind === 'folder') {
        const completed = nativeReceipts.get(item.mediaId);
        if (completed) return settleNativeReceipt(item, completed);
        const failed = failedNativeReceipts.get(item.mediaId);
        if (failed) await settleFailedNativeReceipt(failed);
        if (signal.aborted) throw aborted();
        if (selected.skipExisting) {
          const existing = await selected.cache.verifyItem(item);
          if (signal.aborted) throw aborted();
          if (existing) return existing;
        }
        let response;
        try {
          response = await request({ type: M + 'RESOLVE', jobId: job.jobId, item, attemptId });
          if (response.alreadySaved) return response.result;
          if (signal.aborted) throw aborted();
        } catch (cause) {
          const receipt = failedNativeReceipt(item, attemptId, cause, signal, { beforeWriter: true, needsAbandon: false });
          failedNativeReceipts.set(item.mediaId, receipt);
          await settleFailedNativeReceipt(receipt);
          throw cause;
        }
        let saved;
        let intentStarted = false;
        try {
          saved = await globalThis.ReelSaverFolderWriter.saveToFolder({ directoryHandle: selected.handle,
            media: response.media, filename: response.filename, signal, onProgress,
            reservedNames: selected.cache.reservedNamesFor(item),
            beforeCreate: async reservation => {
              intentStarted = true;
              await selected.cache.beginWrite(item, reservation);
              if (job.queue) await request({ type: M + 'NATIVE_INTENT', jobId: job.jobId,
                mediaId: item.mediaId, attemptId, filename: reservation.filename });
            } });
        } catch (cause) {
          const receipt = failedNativeReceipt(item, attemptId, cause, signal, { beforeWriter: false, needsAbandon: intentStarted });
          failedNativeReceipts.set(item.mediaId, receipt);
          await settleFailedNativeReceipt(receipt);
          throw cause;
        }
        const receipt = { item, attemptId, result: saved, cacheCommitted: false };
        nativeReceipts.set(item.mediaId, receipt);
        return settleNativeReceipt(item, receipt);
      }

      let response;
      try { response = await request({ type: M + 'DOWNLOAD', jobId: job.jobId, item, attemptId }); }
      catch (cause) {
        if (signal.aborted) await cancelBrowser(item, attemptId);
        throw cause;
      }
      if (response.alreadySaved) return response.result;
      let info = response.download;
      if (!info) throw error('RECONCILIATION_REQUIRED', "Chrome's download result is uncertain. Check Downloads before retrying.");
      const cancel = () => { cancelBrowser(item, attemptId); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (info.state === 'in_progress') {
          if (signal.aborted) { await cancelBrowser(item, attemptId); throw aborted(); }
          await wait(pollInterval, signal);
          response = await request({ type: M + 'STATUS', jobId: job.jobId, mediaId: item.mediaId, attemptId });
          info = response.download;
          if (!info) throw error('RECONCILIATION_REQUIRED', "Chrome's download result is uncertain. Check Downloads before retrying.");
          if (info.bytesReceived !== undefined) onProgress({ bytesWritten: info.bytesReceived, totalBytes: info.totalBytes });
        }
        if (info.state !== 'complete') {
          const code = info.reason || info.errorCode || 'DOWNLOAD_INTERRUPTED';
          throw error(code, info.error || 'Chrome could not finish this video.', {
            retryable: /^NETWORK_|SERVER_FAILED|DOWNLOAD_INTERRUPTED/.test(code), stage: 'download' });
        }
        const size = info.bytesWritten ?? info.totalBytes;
        return { filename: info.filename || response.filename || `reel_${item.shortcode}.mp4`, downloadId: info.id,
          ...(positive(size) ? { bytesWritten: size } : {}) };
      } finally { signal.removeEventListener('abort', cancel); }
    }

    const retryItems = Array.isArray(job.retryItems) ? job.retryItems.map(item => ({ ...item })) : null;
    const controller = globalThis.ReelSaverBulkQueue.create({
      discoverPage: async ({ cursor, signal }) => {
        if (signal.aborted) throw aborted();
        if (retryItems) {
          const offset = cursor == null ? 0 : Number(cursor);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > retryItems.length) throw error('INVALID_CURSOR', 'The retry list position is invalid.');
          const end = Math.min(retryItems.length, offset + 1000);
          return { items: retryItems.slice(offset, end), nextCursor: end < retryItems.length ? String(end) : null,
            hasMore: end < retryItems.length };
        }
        const response = await request({ type: M + 'PAGE', jobId: job.jobId, cursor });
        if (signal.aborted) throw aborted();
        return response.page;
      },
      ...(selected.skipExisting ? {
        checkExisting: async ({ item, signal }) => {
          if (signal.aborted) throw aborted();
          const result = selected.kind === 'folder' ? await selected.cache.verifyItem(item)
            : (await request({ type: M + 'CHECK_EXISTING', jobId: job.jobId, item })).result;
          if (signal.aborted) throw aborted();
          return result;
        },
      } : {}),
      saveItem,
      onChange(value) { state = value; onChange?.(value); },
    });
    state = controller.snapshot();

    function start() {
      if (started || finalized) throw error('JOB_BUSY', 'This profile job has already started.');
      started = true;
      return controller.start({ ...job.options, jobId: job.jobId, profile: job.profile });
    }
    function assertOpen() {
      if (finalized || finalizing) throw error('JOB_BUSY', 'This profile is being released or has already ended.');
    }
    function matchingReceipt(previous, receipt) {
      return previous?.state === 'saved' && previous.filename === receipt.filename && previous.downloadId === receipt.downloadId &&
        (receipt.bytesWritten === undefined || receipt.bytesWritten === previous.bytesWritten);
    }
    async function finalize(requestedState) {
      if (finalized) return state;
      if (finalizing) return finalizing;
      finalizing = (async () => {
        if (requestedState === 'stopped' && started && !terminals.has(state.state)) controller.stop();
        await controller.waitForIdle();
        const ending = requestedState || (started ? state.state : 'stopped');
        if (!terminals.has(ending) || started && !terminals.has(state.state)) {
          throw error('JOB_BUSY', 'Stop or finish this profile before releasing it.');
        }
        for (const receipt of [...failedNativeReceipts.values()]) await settleFailedNativeReceipt(receipt);
        for (const receipt of [...nativeReceipts.values()]) {
          await settleNativeReceipt(receipt.item, receipt);
          controller.recordSaved(receipt.item.mediaId, receipt.result);
        }
        const released = await request({ type: M + 'END', jobId: job.jobId, state: ending });
        const recorded = new Map((state.items || []).map(item => [item.mediaId, item]));
        for (const receipt of released.savedResults || []) {
          if (!matchingReceipt(recorded.get(receipt.mediaId), receipt)) controller.recordSaved(receipt.mediaId, receipt);
        }
        await selected.cache?.close();
        finalized = true;
        return state;
      })();
      try { return await finalizing; }
      finally { finalizing = null; }
    }

    return Object.freeze({ start,
      pause(reason) { assertOpen(); return controller.pause(reason); },
      resume() { assertOpen(); return controller.resume(); },
      stop() { if (finalized) return state; return controller.stop(); },
      snapshot: () => state,
      waitForIdle: () => controller.waitForIdle(),
      flush: () => controller.waitForIdle(),
      retryFailed() { assertOpen(); return controller.retryFailed(); },
      finalize,
    });
  }

  Object.defineProperty(globalThis, 'ReelNestProfileJobRunner', { value: Object.freeze({ create }), configurable: true });
})();
