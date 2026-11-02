import { queueStore } from './profile-queue-store.js';
import { getReceipt, recordReceipt, verifyReceipt } from './browser-receipts.js';

const problem = message => Object.assign(new Error(message), { code: 'RECONCILIATION_REQUIRED', stage: 'queue' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const downloadId = value => Number.isSafeInteger(value) && value >= 0;
const basename = value => typeof value === 'string' ? value.replaceAll('\\', '/').split('/').pop() : '';
const validFilename = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  !/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/.test(value) && !/[. ]$/.test(value) && /\.mp4$/i.test(value);
let recoveryTail = Promise.resolve();

async function locked(action) {
  const before = recoveryTail; let release;
  recoveryTail = new Promise(resolve => { release = resolve; });
  await before;
  try { return await action(); } finally { release(); }
}

export async function getQueueRecovery(runId) {
  const run = await queueStore.getRun(runId);
  if (!run.reservation) return null;
  if (run.state !== 'interrupted') throw problem('Stop the active queue before checking an interrupted save.');
  const reservation = run.reservation;
  const entry = run.entries.find(value => value.id === reservation.entryId);
  if (!entry?.profile || !/^[1-9][0-9]{0,29}$/.test(entry.profile.id || '')) throw problem('The interrupted save has no verified profile identity. Its results were kept unchanged.');
  let offset = 0;
  do {
    const page = await queueStore.getItems(run.id, entry.id, { offset, limit: 1000 });
    const item = page.items.find(value => value.mediaId === reservation.mediaId);
    if (item) {
      if (item.attemptId !== reservation.attemptId || !['resolving', 'saving', 'unknown'].includes(item.state)) {
        throw problem('The interrupted save does not match its recorded attempt. Its results were kept unchanged.');
      }
      return { run, entry, item };
    }
    offset = page.nextOffset;
  } while (offset !== null);
  throw problem('The interrupted save is missing its discovered Reel identity. Its results were kept unchanged.');
}

async function current(recovery) {
  const run = await queueStore.getRun(recovery.run.id);
  const expected = recovery.run.reservation, actual = run.reservation;
  if (run.state !== 'interrupted' || actual?.entryId !== expected.entryId || actual?.mediaId !== expected.mediaId || actual?.attemptId !== expected.attemptId) {
    throw problem('The interrupted save changed while it was being checked. Open its recovery controls again.');
  }
  return run;
}

async function ownDownload(id) {
  let values;
  try { values = await chrome.downloads.search({ id }); }
  catch { throw Object.assign(problem('Chrome download history could not be checked. Retry before starting another queue.'), { code: 'CACHE_HISTORY_UNAVAILABLE' }); }
  if (!Array.isArray(values)) throw problem('Chrome returned unknown download history. The interrupted save was kept unchanged.');
  return values.find(value => value?.id === id && value.byExtensionId === chrome.runtime.id) || null;
}

function expectedFilename(recovery, actual) {
  const expected = recovery.item.filename;
  if (!validFilename(actual) || expected && actual !== expected) throw problem('The recovered file does not match the interrupted save’s recorded filename. No history was changed.');
}

async function settleBrowser(recovery, raw) {
  await current(recovery);
  if (!raw) throw problem('The accepted download is missing from Chrome history. Check its saved file before retrying; another copy was not started.');
  if (raw.state === 'interrupted' && raw.exists === false) {
    return queueStore.settle(recovery.run.id, recovery.entry.id, recovery.item, recovery.run.reservation.attemptId,
      { state: 'canceled', ...(recovery.item.filename ? { filename: recovery.item.filename } : {}) });
  }
  if (raw.state !== 'complete' || raw.exists !== true || !positive(raw.fileSize)) {
    throw problem('Chrome has not confirmed a complete saved video or an interrupted download with no remaining file. Check Downloads, then retry this history check.');
  }
  const filename = basename(raw.filename);
  expectedFilename(recovery, filename);
  // recordReceipt verifies ownership, accepted MIME, trusted source URLs,
  // positive size, and historical claims before changing durable history.
  await recordReceipt(recovery.entry.profile.id, recovery.item, raw, { check: () => current(recovery) });
  await current(recovery);
  return queueStore.settle(recovery.run.id, recovery.entry.id, recovery.item, recovery.run.reservation.attemptId,
    { state: 'saved', filename, bytesWritten: raw.fileSize, downloadId: raw.id });
}

export async function reconcileQueue(runId, { result, destination } = {}) {
  return locked(async () => {
    const recovery = await getQueueRecovery(runId);
    if (!recovery) return queueStore.getRun(runId);
    const kind = recovery.run.options.destination;
    if (destination !== undefined && destination !== kind) throw problem('Use the interrupted queue’s original save location to check its saved output.');
    const { run, entry, item } = recovery;
    if (item.state === 'resolving' && !item.filename && !downloadId(item.downloadId)) {
      // Both destination paths journal a filename/intent before they can start
      // an external save. An earlier lookup-only reservation has no file output.
      await current(recovery);
      return queueStore.settle(run.id, entry.id, item, run.reservation.attemptId, { state: 'canceled' });
    }
    if (kind === 'downloads') {
      if (downloadId(item.downloadId)) return settleBrowser(recovery, await ownDownload(item.downloadId));
      const receipt = await getReceipt(entry.profile.id, item);
      if (!receipt || !await verifyReceipt(entry.profile.id, item)) {
        throw problem('This interrupted download has no accepted Chrome ID or verified receipt. Import its successful download report if available, then retry this history check.');
      }
      const raw = await ownDownload(receipt.downloadId);
      const startedAt = Date.parse(raw?.startTime);
      if (!Number.isFinite(startedAt) || startedAt < run.createdAt) {
        throw problem('The matching browser receipt cannot be proved to belong to this queue run. Its earlier download history was kept unchanged.');
      }
      return settleBrowser(recovery, raw);
    }
    // This proof comes only from the registered host after reopening the
    // original library and verifying its file or a confirmed absent pending path.
    if (!object(result) || !['saved', 'canceled'].includes(result.state) ||
        result.profileId !== undefined && result.profileId !== entry.profile.id ||
        result.mediaId !== undefined && result.mediaId !== item.mediaId ||
        result.shortcode !== undefined && result.shortcode !== item.shortcode) {
      throw problem('Choose the original library and verify the interrupted Reel before recording its outcome.');
    }
    if (!item.filename || !validFilename(result.filename) || result.filename !== item.filename) {
      throw problem('The library proof does not match the interrupted video’s expected filename. No history was changed.');
    }
    if (result.state === 'saved' && !positive(result.bytesWritten) ||
        result.state === 'canceled' && (result.error?.cleanupFailed === true || result.bytesWritten != null && result.bytesWritten !== 0)) {
      throw problem('The interrupted file still has an uncertain outcome. Verify its complete bytes or confirm that its expected path is absent.');
    }
    await current(recovery);
    return queueStore.settle(run.id, entry.id, item, run.reservation.attemptId,
      { state: result.state, filename: result.filename, ...(result.state === 'saved' ? { bytesWritten: result.bytesWritten } : {}) });
  });
}
