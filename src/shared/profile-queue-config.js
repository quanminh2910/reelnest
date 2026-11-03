// Shared by classic Instagram content scripts and the module service worker.
(() => {
  'use strict';
  if (globalThis.ReelNestProfileQueueConfig) return;
  const MAX_PROFILES = 100;
  const reserved = new Set(['accounts', 'about', 'ads', 'api', 'challenge', 'checkpoint', 'developer',
    'direct', 'directory', 'download', 'emails', 'explore', 'help', 'legal', 'notifications', 'oauth',
    'p', 'privacy', 'reel', 'reels', 'session', 'settings', 'share', 'static', 'stories', 'terms',
    'topics', 'web', 'your_activity']);
  let sequence = 0;
  const problem = message => Object.assign(new Error(message), { code: 'INVALID_QUEUE', stage: 'queue' });
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
  const newId = () => globalThis.crypto?.randomUUID?.() || `profile-${Date.now()}-${++sequence}`;

  function normalizeProfileInput(value) {
    if (typeof value !== 'string' || value.length > 2000) throw problem('Enter an Instagram username or profile URL.');
    let username = value.trim();
    if (/^https?:\/\//i.test(username)) {
      let url;
      try { url = new URL(username); } catch { throw problem('The Instagram profile URL is invalid.'); }
      const match = /^\/([A-Za-z0-9._]{1,30})(?:\/reels)?\/?$/.exec(url.pathname);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !['instagram.com', 'www.instagram.com'].includes(url.hostname) || !match) {
        throw problem('Use an HTTPS Instagram profile or profile Reels URL.');
      }
      username = match[1];
    } else if (username.startsWith('@')) username = username.slice(1);
    if (!/^[A-Za-z0-9._]{1,30}$/.test(username) || reserved.has(username.toLowerCase())) {
      throw problem('Enter a profile username, rather than an Instagram page or individual Reel.');
    }
    return username.toLowerCase();
  }

  function limit(value) {
    if (!globalThis.ReelSaverDownloadLimits) throw problem('Reload ReelNest to load download-limit validation.');
    return globalThis.ReelSaverDownloadLimits.normalize(value);
  }

  function normalizeDraft(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('The queue draft is invalid.');
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      throw Object.assign(problem('This queue draft uses an unsupported format and was kept unchanged.'), { code: 'QUEUE_DRAFT_UNSUPPORTED' });
    }
    const batchSize = value.batchSize ?? 35;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw problem('Choose a batch size from 1 to 500.');
    const input = value.entries ?? [];
    if (!Array.isArray(input) || input.length > MAX_PROFILES) throw problem('A queue can contain up to 100 profiles.');
    const names = new Set(), ids = new Set();
    const entries = input.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw problem('A queue profile is invalid.');
      const username = normalizeProfileInput(raw.username);
      const id = raw.id === undefined ? newId() : raw.id;
      if (!identifier(id) || ids.has(id)) throw problem('Every queued profile needs its own valid identifier.');
      if (names.has(username)) throw problem(`@${username} is already in the queue.`);
      const limitMode = raw.limitMode ?? 'inherit';
      if (!['inherit', 'custom', 'unlimited'].includes(limitMode)) throw problem('Choose Use default, Custom, or Unlimited for each profile.');
      const maxNewVideos = limitMode === 'custom' ? limit(raw.maxNewVideos) : null;
      if (limitMode === 'custom' && maxNewVideos === null) throw problem('Enter a custom whole-number limit from 1 to 50,000.');
      ids.add(id); names.add(username);
      return { id, username, limitMode, maxNewVideos };
    });
    return { schemaVersion: 1, batchSize, defaultLimit: limit(value.defaultLimit), totalLimit: limit(value.totalLimit), entries };
  }

  function effectiveLimit(draft, entry) {
    if (!entry || !['inherit', 'custom', 'unlimited'].includes(entry.limitMode)) throw problem('The profile limit is invalid.');
    if (entry.limitMode === 'unlimited') return null;
    const value = limit(entry.limitMode === 'inherit' ? draft?.defaultLimit : entry.maxNewVideos);
    if (entry.limitMode === 'custom' && value === null) throw problem('Enter a custom whole-number limit from 1 to 50,000.');
    return value;
  }

  function parseLines(text) {
    if (typeof text !== 'string' || text.length > 200_000) throw problem('Paste a profile list of at most 200,000 characters.');
    const entries = [], errors = [], names = new Set();
    const lines = text.split(/\r?\n/);
    if (lines.length > 1000) throw problem('Paste at most 1,000 lines at a time.');
    lines.forEach((input, index) => {
      if (!input.trim()) return;
      try {
        const username = normalizeProfileInput(input);
        if (names.has(username)) throw Object.assign(problem(`@${username} is already in this list.`), { code: 'DUPLICATE_PROFILE' });
        if (entries.length >= MAX_PROFILES) throw problem('A queue can contain up to 100 profiles.');
        names.add(username);
        entries.push({ id: newId(), username, limitMode: 'inherit', maxNewVideos: null });
      } catch (error) {
        errors.push({ line: index + 1, input: input.slice(0, 200), message: error.message, code: error.code || 'INVALID_QUEUE' });
      }
    });
    return { entries, errors };
  }

  Object.defineProperty(globalThis, 'ReelNestProfileQueueConfig', {
    value: Object.freeze({ MAX_PROFILES, normalizeProfileInput, normalizeDraft, effectiveLimit, parseLines }), configurable: true,
  });
})();
