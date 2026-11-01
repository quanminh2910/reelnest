// Shared by classic content scripts and the module service worker.
(() => {
  'use strict';
  if (globalThis.ReelSaverDownloadLimits) return;

  const MAX_NEW_VIDEOS = 50_000;

  function normalize(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_NEW_VIDEOS) {
      throw Object.assign(new Error('Choose Unlimited or a whole number from 1 to 50,000 new videos.'), {
        code: 'INVALID_LIMIT', stage: 'start',
      });
    }
    return value;
  }

  function remaining(limit, committed, reserved = 0) {
    const maximum = normalize(limit);
    if (![committed, reserved].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw Object.assign(new Error('The download allowance could not be verified.'), {
        code: 'INVALID_ACCOUNTING', stage: 'queue',
      });
    }
    return maximum === null ? Infinity : Math.max(0, maximum - committed - reserved);
  }

  function reached(limit, committed) {
    return remaining(limit, committed) === 0;
  }

  Object.defineProperty(globalThis, 'ReelSaverDownloadLimits', {
    value: Object.freeze({ normalize, remaining, reached }), configurable: true,
  });
})();
