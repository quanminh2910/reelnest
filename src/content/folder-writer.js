// Runs in the extension's isolated content-script world. Directory handles stay
// with the panel controller; none are exposed to the Instagram page or worker.
(() => {
  if (globalThis.ReelSaverFolderWriter) return;
  const queues = new WeakMap();

  function error(code, message) {
    const result = new Error(message);
    result.code = code;
    return result;
  }

  function isSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  function chooseFolder() {
    if (!isSupported()) {
      return Promise.reject(error('FOLDER_UNSUPPORTED', 'Folder selection is unavailable here. Use Browser Save As instead.'));
    }
    // Call the native picker immediately while the click's user activation is
    // available. In particular, do not load settings or message the worker first.
    let selection;
    try {
      selection = window.showDirectoryPicker({ id: 'reel-saver', mode: 'readwrite', startIn: 'downloads' });
    } catch (cause) {
      selection = Promise.reject(cause);
    }
    return Promise.resolve(selection).catch((cause) => {
      if (cause?.name === 'AbortError') throw error('PICKER_CANCELLED', 'Folder selection was canceled.');
      throw error('FOLDER_UNAVAILABLE', 'The folder picker could not open. Try again, or use Browser Save As.');
    });
  }

  async function getPermission(directoryHandle) {
    if (!directoryHandle || typeof directoryHandle.queryPermission !== 'function') return 'denied';
    try {
      return await directoryHandle.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }

  function trustedVideoUrl(value) {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      const host = url.hostname;
      const allowed = ['cdninstagram.com', 'fbcdn.net'].some((domain) =>
        host === domain || host.endsWith(`.${domain}`)) ||
        ['instagram.com', 'www.instagram.com'].includes(host);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        allowed && /\.mp4$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function filenameParts(value) {
    if (typeof value !== 'string' || value.length > 1024 || !value ||
        /[\\\u0000-\u001f\u007f-\u009f<>:"|?*\u202a-\u202e\u2066-\u2069]/.test(value)) {
      throw error('INVALID_FILENAME', 'The video filename is invalid. Reopen the panel and try again.');
    }
    const parts = value.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 200 ||
        /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) ||
        !/\.mp4$/i.test(parts.at(-1))) {
      throw error('INVALID_FILENAME', 'The video filename is invalid. Reopen the panel and try again.');
    }
    return parts;
  }

  function abortError() {
    return error('SAVE_CANCELLED', 'The download was canceled.');
  }

  function checkAborted(signal) {
    if (signal?.aborted) throw abortError();
  }

  async function occupiedNames(directory, signal) {
    const occupied = new Set();
    const iterator = typeof directory.keys === 'function' ? directory.keys()
      : typeof directory.entries === 'function' ? directory.entries()
        : typeof directory.values === 'function' ? directory.values() : null;
    if (iterator) {
      for await (const entry of iterator) {
        checkAborted(signal);
        const name = typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : entry?.name;
        if (typeof name === 'string') occupied.add(name.toLowerCase());
      }
    }
    return occupied;
  }

  async function uniqueFilename(directory, preferredName, signal, reservedNames) {
    // Preserve portable names even when the selected filesystem distinguishes
    // case. A later copy to Windows must not merge different Reels' files.
    const occupied = await occupiedNames(directory, signal);
    for (const name of reservedNames) occupied.add(name.toLowerCase());
    const stem = preferredName.slice(0, -4);
    const extension = preferredName.slice(-4);
    for (let index = 0; index < 10000; index += 1) {
      checkAborted(signal);
      const name = index ? `${stem} (${index})${extension}` : preferredName;
      if (occupied.has(name.toLowerCase())) continue;
      try {
        await directory.getFileHandle(name);
      } catch (cause) {
        if (cause?.name === 'TypeMismatchError') continue;
        if (cause?.name !== 'NotFoundError') throw cause;
        return name;
      }
    }
    throw error('FOLDER_FULL', 'Too many files have the same name. Choose another folder and retry.');
  }

  function saveToFolder(options) {
    const handle = options?.directoryHandle;
    if (!handle || typeof handle !== 'object' || typeof handle.getFileHandle !== 'function') {
      return Promise.reject(error('FOLDER_REQUIRED', 'Choose a folder before downloading.'));
    }
    // Serialize writes to a given chosen directory so two upcoming queue items
    // cannot choose the same free filename. Failed saves do not block the queue.
    const previous = queues.get(handle) || Promise.resolve();
    const request = previous.catch(() => {}).then(() => transfer(options));
    queues.set(handle, request);
    request.finally(() => {
      if (queues.get(handle) === request) queues.delete(handle);
    }).catch(() => {});
    return request;
  }

  async function transfer({ directoryHandle, media, filename, onProgress, signal, beforeCreate, reservedNames = [] }) {
    const parts = filenameParts(filename);
    if (!Array.isArray(reservedNames) || reservedNames.length > 50000 || reservedNames.some(name => {
      try { return filenameParts(name).length !== 1; } catch { return true; }
    })) throw Object.assign(error('CACHE_INVALID_RESERVATIONS', 'The download history contains invalid filename reservations.'), { stage: 'cache' });
    if (!trustedVideoUrl(media?.url)) {
      throw error('INVALID_VIDEO_URL', 'The video link is invalid. Reload the Reel, then retry.');
    }
    checkAborted(signal);
    if (await getPermission(directoryHandle) !== 'granted') {
      throw error('FOLDER_PERMISSION', 'Folder access is no longer available. Click Choose folder again.');
    }
    checkAborted(signal);

    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let timer;
    let timedOut = false;
    function armTimeout() {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
    }
    const progress = (bytesWritten, totalBytes) => {
      if (typeof onProgress === 'function') {
        try { onProgress({ bytesWritten, ...(totalBytes ? { totalBytes } : {}) }); } catch {}
      }
    };
    let reader;
    let writable;
    let destination;
    let file;
    let completed = false;
    let stage = 'fetch';
    try {
      armTimeout();
      const response = await fetch(media.url, {
        // Instagram's CDN can redirect requests that omit the referring origin.
        // Send only the origin cross-site while continuing to reject redirects.
        credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) {
          const wait = response.headers.get('retry-after');
          const retryAfterMs = wait && /^\d+$/.test(wait) ? Number(wait) * 1000 : wait ? Date.parse(wait) - Date.now() : 0;
          throw Object.assign(error('RATE_LIMITED', 'Instagram asked you to wait before downloading more videos.'),
            Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs: Math.min(retryAfterMs, 86400000) } : {});
        }
        if (response.status >= 500) throw Object.assign(error('SERVER_ERROR', 'Instagram temporarily could not send this video. Please retry.'), { retryable: true });
        if (response.status === 403 || response.status === 401) throw Object.assign(error(
          response.status === 403 ? 'SERVER_FORBIDDEN' : 'SERVER_UNAUTHORIZED',
          'The video link expired or was refused. Resolve the Reel again before retrying.'), { retryable: true });
        throw error('VIDEO_REQUEST_FAILED', response.status === 403 || response.status === 401
          ? 'The video link expired or was refused. Reload the Reel and retry.'
          : 'Instagram could not send the video. Retry, or use Browser Save As.');
      }
      if (response.url && !trustedVideoUrl(response.url)) {
        throw error('INVALID_VIDEO_URL', 'The video response came from an unexpected address.');
      }
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (mime && !['video/mp4', 'application/mp4', 'application/octet-stream'].includes(mime)) {
        throw error('NOT_MP4', 'Instagram returned a different file instead of an MP4. Reload the Reel and retry.');
      }
      if (!response.body?.getReader) throw error('EMPTY_VIDEO', 'The video response was empty. Please retry.');
      const declaredLength = Number(response.headers.get('content-length'));
      const totalBytes = Number.isSafeInteger(declaredLength) && declaredLength > 0 ? declaredLength : 0;
      reader = response.body.getReader();
      stage = 'transfer';
      const buffered = [];
      let prefixLength = 0;
      // Validate the ISO BMFF ftyp box before creating a file in the chosen folder.
      while (prefixLength < 12) {
        checkAborted(controller.signal);
        const chunk = await reader.read();
        if (chunk.done) throw error('NOT_MP4', 'The video was incomplete. Reload the Reel and retry.');
        if (chunk.value?.byteLength) {
          buffered.push(chunk.value);
          prefixLength += chunk.value.byteLength;
          armTimeout();
        }
      }
      const prefix = new Uint8Array(12);
      let copied = 0;
      for (const chunk of buffered) {
        const count = Math.min(12 - copied, chunk.byteLength);
        prefix.set(chunk.subarray(0, count), copied);
        copied += count;
        if (copied === 12) break;
      }
      if (String.fromCharCode(...prefix.subarray(4, 8)) !== 'ftyp') {
        throw error('NOT_MP4', 'The response is not an MP4 video. Reload the Reel and retry.');
      }
      checkAborted(controller.signal);
      stage = 'write';
      destination = directoryHandle;
      for (const part of parts.slice(0, -1)) {
        destination = await destination.getDirectoryHandle(part, { create: true });
      }
      const name = await uniqueFilename(destination, parts.at(-1), controller.signal, reservedNames);
      if (typeof beforeCreate === 'function') {
        stage = 'cache';
        try {
          await beforeCreate({ filename: [...parts.slice(0, -1), name].join('/'), expectedBytes: totalBytes || null });
        } catch (cause) {
          if (typeof cause?.code === 'string') throw cause;
          throw Object.assign(error('CACHE_WRITE_FAILED', 'Download history could not be recorded. No video file was created.'), { cause });
        }
        checkAborted(controller.signal);
        stage = 'write';
        // A history commit can await filesystem work. Do not overwrite a file
        // that appeared under its reserved name while that commit was pending.
        let appeared = (await occupiedNames(destination, controller.signal)).has(name.toLowerCase());
        try { await destination.getFileHandle(name); appeared = true; }
        catch (cause) { if (cause?.name !== 'NotFoundError') throw cause; }
        if (appeared) throw error('RECONCILIATION_REQUIRED', 'The reserved video filename now exists. Check its history before retrying; no file was overwritten.');
      }
      checkAborted(controller.signal);
      file = { name, handle: await destination.getFileHandle(name, { create: true }) };
      checkAborted(controller.signal);
      writable = await file.handle.createWritable();
      let bytesWritten = 0;
      progress(bytesWritten, totalBytes);
      for (const chunk of buffered) {
        checkAborted(controller.signal);
        await writable.write(chunk);
        bytesWritten += chunk.byteLength;
        armTimeout();
        progress(bytesWritten, totalBytes);
      }
      while (true) {
        stage = 'transfer';
        checkAborted(controller.signal);
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!chunk.value?.byteLength) continue;
        stage = 'write';
        await writable.write(chunk.value);
        bytesWritten += chunk.value.byteLength;
        armTimeout();
        progress(bytesWritten, totalBytes);
      }
      checkAborted(controller.signal);
      if (totalBytes && bytesWritten !== totalBytes) {
        throw error('INCOMPLETE_VIDEO', 'The video transfer was incomplete. Please retry.');
      }
      stage = 'write';
      await writable.close();
      completed = true;
      const savedPath = [...parts.slice(0, -1), file.name].join('/');
      return { filename: savedPath, bytesWritten };
    } catch (cause) {
      let cleanupFailed = false;
      if (writable && !completed) await writable.abort().catch(() => { cleanupFailed = true; });
      if (file && destination && !completed) await destination.removeEntry(file.name).catch((cleanupError) => {
        if (cleanupError?.name !== 'NotFoundError') cleanupFailed = true;
      });
      const annotated = (value) => {
        if (!value.stage) value.stage = stage;
        if (!cleanupFailed) return value;
        Object.assign(value, { cleanupFailed: true, ...(file ? { leftoverFilename: file.name } : {}) });
        value.message += file ? ` A partial file may remain: ${file.name}. Check it before retrying.` : ' Partial-file cleanup could not be confirmed.';
        return value;
      };
      if (signal?.aborted) throw annotated(abortError());
      if (timedOut) throw annotated(error('TRANSFER_TIMEOUT', 'The video stopped responding. Retry, or use Browser Save As.'));
      if (cause?.code && typeof cause.code === 'string') throw annotated(cause);
      if (cause?.name === 'NotAllowedError' || cause?.name === 'SecurityError') {
        throw annotated(error('FOLDER_PERMISSION', 'Chrome could not write to this folder. Choose it again, or use Browser Save As.'));
      }
      if (cause?.name === 'QuotaExceededError') {
        throw annotated(error('FOLDER_FULL', 'The chosen drive is full. Free some space or choose another folder.'));
      }
      if (cause?.name === 'AbortError') throw annotated(abortError());
      const message = stage === 'fetch'
        ? 'The video transfer was blocked or could not start. Retry, or use Browser Downloads.'
        : stage === 'transfer'
          ? 'The video transfer stopped before it finished. Retry, or use Browser Downloads.'
          : 'The video could not be saved to this folder. Try Browser Save As, or choose the folder again.';
      throw annotated(error('FOLDER_SAVE_FAILED', message));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (!completed) controller.abort();
      if (reader) {
        if (!completed) await reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch {}
      }
    }
  }

  Object.defineProperty(globalThis, 'ReelSaverFolderWriter', {
    value: Object.freeze({ isSupported, chooseFolder, getPermission, saveToFolder }),
    configurable: true,
  });
})();
