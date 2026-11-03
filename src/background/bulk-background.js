import { profileSource } from "../instagram/profile-source.js";
import { buildFilename, validateMedia, summarizeDownload, sanitizeFilenamePart, isInstagramMediaUrl } from "../shared/core.js";
import "../shared/download-limits.js";
import { getReceipt, verifyReceipt, recordReceipt, assertReceiptCapacity, isDownloadClaimedByOtherMedia, normalizeReport, previewReport } from "./browser-receipts.js";
import { queueStore } from "./profile-queue-store.js";
import { assertOrdinaryStart, queueBinding } from "./profile-queue-owner.js";

const limits = globalThis.ReelSaverDownloadLimits;

const ACTIVE = "reel-saver:bulk-active";
const PREFS = "reel-saver:bulk-prefs";
const prefix = (jobId) => `reel-saver:bulk:${jobId}:`;
const memberKey = (jobId, id) => `${prefix(jobId)}member:${id}`;
const operationKey = (jobId, id) => `${prefix(jobId)}operation:${id}`;
const cancellationKey = (jobId, id, attemptId) => `${operationKey(jobId, id)}:${attemptId}`;
const pending = new Map();
const canceled = new Set();
const canceledImports = new Set();
const MAX_HISTORY_CANDIDATES = 200;
let registration = Promise.resolve();
let journal = Promise.resolve();
const actions = new Set([
  "START", "PAGE", "RESOLVE", "DOWNLOAD", "STATUS", "CANCEL_ITEM", "ITEM_RESULT",
  "END", "REOPEN", "HEARTBEAT", "IDENTIFY", "SETTINGS_GET", "SETTINGS_SET", "CHECK_EXISTING",
  "BROWSER_IMPORT_PREVIEW", "BROWSER_IMPORT_COMMIT", "BROWSER_IMPORT_CANCEL",
  "NATIVE_INTENT",
].map((action) => `REEL_SAVER_BULK_${action}`));

export const isBulkMessage = (message) => actions.has(message?.type);

function problem(code, message, stage = "queue", retryable = false) {
  return Object.assign(new Error(message), { code, stage, retryable });
}

// MAIN-world results are untrusted. Keep only bounded diagnostic facts, never
// request payloads, credentials, response bodies, or signed media addresses.
function sanitizeDiagnostic(value) {
  if (!value || typeof value !== "object") return undefined;
  const identifier = entry => typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(entry);
  const diagnostic = {};
  for (const name of ["queryName", "adapterVersion"]) if (identifier(value[name])) diagnostic[name] = value[name];
  if (["environment.execute", "fetchQuery"].includes(value.executionMethod)) diagnostic.executionMethod = value.executionMethod;
  if (Array.isArray(value.connectionPath) && value.connectionPath.length > 0 && value.connectionPath.length <= 8 &&
      value.connectionPath.every(identifier)) diagnostic.connectionPath = [...value.connectionPath];
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) diagnostic.httpStatus = value.httpStatus;
  if (Number.isSafeInteger(value.serverCode) || (typeof value.serverCode === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value.serverCode))) diagnostic.serverCode = value.serverCode;
  if (typeof value.serverMessage === "string") diagnostic.serverMessage = value.serverMessage
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL omitted]")
    .replace(/\bBearer\s+[^\s;,"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:authorization|set-cookie|cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, "[credential omitted]")
    .replace(/\b(?:x-csrftoken|csrftoken|csrf[_-]?token|access[_-]?token|refresh_token|id_token|sessionid|session_key|token|lsd|fb_dtsg|password|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, "[credential omitted]")
    .replace(/[A-Za-z]:[\\/][^\r\n;]+/g, "[path omitted]").slice(0, 500);
  if (Array.isArray(value.variableNames)) diagnostic.variableNames = [...new Set(value.variableNames.filter(identifier))].slice(0, 40);
  if (Array.isArray(value.unsetVariableNames)) diagnostic.unsetVariableNames = [...new Set(value.unsetVariableNames.filter(identifier))].slice(0, 40);
  const shapeIdentifier = entry => typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(entry);
  for (const name of ["selectionKinds", "fieldNames", "fragmentNames"]) {
    if (Array.isArray(value[name])) diagnostic[name] = [...new Set(value[name].filter(shapeIdentifier))].slice(0, 60);
  }
  if (Number.isInteger(value.connectionMatchCount) && value.connectionMatchCount >= 0 && value.connectionMatchCount <= 2000) {
    diagnostic.connectionMatchCount = value.connectionMatchCount;
  }
  return Object.keys(diagnostic).length ? diagnostic : undefined;
}

function instagramUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["instagram.com", "www.instagram.com"].includes(url.hostname) ? url : null;
  } catch { return null; }
}

function profileUsername(value) {
  const url = instagramUrl(value);
  const match = url && /^\/([A-Za-z0-9._]{1,30})(?:\/(?:reels|tagged))?\/?$/.exec(url.pathname);
  const reserved = new Set(["accounts", "about", "api", "challenge", "checkpoint", "direct", "explore", "p", "reel", "reels", "stories", "settings", "web", "legal", "privacy", "share", "notifications"]);
  return match && !reserved.has(match[1].toLowerCase()) ? match[1].toLowerCase() : null;
}

function context(sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 ||
      !Number.isInteger(sender.tab?.id) || sender.tab.id < 0 ||
      !instagramUrl(sender.url) || !instagramUrl(sender.tab.url)) {
    throw problem("INVALID_SENDER", "Open the bulk controls on an Instagram profile.");
  }
  return { tabId: sender.tab.id, documentId: sender.documentId };
}

function options(value) {
  if (!value || !["batches", "scan_all"].includes(value.mode) ||
      !Number.isSafeInteger(value.batchSize) || value.batchSize < 1 || value.batchSize > 500 ||
      !["folder", "downloads"].includes(value.destination) ||
      (value.skipExisting !== undefined && typeof value.skipExisting !== "boolean")) {
    throw problem("INVALID_SETTINGS", "Choose a download mode, a batch size from 1 to 500, and a folder or Downloads.");
  }
  return { mode: value.mode, batchSize: value.batchSize, destination: value.destination,
    maxNewVideos: limits.normalize(value.maxNewVideos), skipExisting: value.skipExisting !== false };
}

async function get(key) { return (await chrome.storage.session.get(key))[key]; }
async function put(values) {
  try { await chrome.storage.session.set(values); }
  catch { throw problem("STORAGE_FAILED", "The batch record could not be saved. Pause and reopen the panel before continuing."); }
}

async function locked(action) {
  const before = registration;
  let release;
  registration = new Promise((resolve) => { release = resolve; });
  await before;
  try { return await action(); } finally { release(); }
}
export const withJobRegistration = action => locked(action);

// Only the parent coordinator calls this entry point. Source tab routing is
// derived from its registered binding, never accepted from a runtime message.
export async function startQueueChild(ctx, value) {
  return locked(async () => {
    const old = await get(ACTIVE);
    if (old?.active || old?.reservationMediaId) throw problem("JOB_BUSY", "Release the current profile before starting another one.");
    const selected = options(value.options);
    const profile = checkProfile(value.profile);
    const job = { schema: 1, jobId: value.jobId, tabId: ctx.tabId, documentId: ctx.documentId,
      profile, options: selected, queue: { ...value.queue }, active: true, state: "running", cursor: null,
      exhausted: false, visited: [], createdAt: Date.now(), updatedAt: Date.now(),
      committedNewSaves: 0, reservationMediaId: null };
    const owner = await queueBinding(job, ctx);
    if (owner.control !== "running") throw problem("QUEUE_PAUSED", "Resume the queue before starting another profile.");
    await put({ [ACTIVE]: job,
      ...Object.fromEntries((value.retryItems || []).map(item => [memberKey(job.jobId, item.mediaId), { ...checkItem(item), username: profile.username }])) });
    try {
      const latest = await queueBinding(job, ctx);
      if (latest.control !== "running") throw problem("QUEUE_PAUSED", "The queue paused before this profile started.");
    } catch (error) {
      await put({ [ACTIVE]: { ...job, active: false, state: "stopped" } });
      throw error;
    }
    if (old) {
      const all = await chrome.storage.session.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith(prefix(old.jobId)));
      if (keys.length) await chrome.storage.session.remove(keys);
    }
    return { jobId: job.jobId, profile, options: selected, queue: job.queue,
      ...(value.retryItems ? { retryItems: value.retryItems } : {}) };
  });
}

export async function rebindQueueChild(ctx, jobId, binding) {
  return mutate(async () => {
    const job = await currentJob(ctx, jobId, { inactive: true, profile: false });
    const next = { ...job, queue: { ...binding } };
    await queueBinding(next, ctx);
    await put({ [ACTIVE]: next });
  });
}

// The registration lock can wait for a transfer during Stop. Keep short journal
// transactions separate so that transfer can settle without waiting on Stop.
async function mutate(action) {
  const before = journal;
  let release;
  journal = new Promise(resolve => { release = resolve; });
  await before;
  try { return await action(); } finally { release(); }
}

function allowance(job) {
  return { committed: Number.isSafeInteger(job.committedNewSaves) ? job.committedNewSaves : 0,
    reserved: typeof job.reservationMediaId === "string" ? job.reservationMediaId : null };
}

function assertAllowance(job) {
  if (limits.reached(job.options.maxNewVideos, allowance(job).committed)) {
    throw problem("PROFILE_LIMIT_REACHED", "The new-video limit for this run has been reached. Start a new run to download more.", "limit");
  }
}

async function reserveOperation(ctx, jobId, item, attemptId) {
  return mutate(async () => {
    const job = await currentJob(ctx, jobId);
    const quota = allowance(job);
    const previous = await get(operationKey(jobId, item.mediaId));
    if (canceled.has(cancellationKey(jobId, item.mediaId, attemptId))) {
      throw problem("SAVE_CANCELLED", "The download was canceled.");
    }
    if (["unknown", "prepared"].includes(previous?.state)) {
      throw problem("RECONCILIATION_REQUIRED", "The previous folder save must be confirmed before this video can be attempted again.", "limit");
    }
    if (quota.reserved && quota.reserved !== item.mediaId) {
      throw problem("RECONCILIATION_REQUIRED", "The previous video's save must be confirmed before another video can start.", "limit");
    }
    assertAllowance(job);
    if (job.queue) await queueStore.reserve(job.queue.runId, job.queue.entryId, item, attemptId);
    const operation = { jobId, mediaId: item.mediaId, shortcode: item.shortcode, attemptId,
      state: "resolving", quotaState: "reserved", startedAt: Date.now(), destination: job.options.destination };
    try {
      await put({ [operationKey(jobId, item.mediaId)]: operation,
        [ACTIVE]: { ...job, committedNewSaves: quota.committed, reservationMediaId: item.mediaId, updatedAt: Date.now() } });
    } catch (error) {
      if (job.queue) await queueStore.settle(job.queue.runId, job.queue.entryId, item, attemptId, { state: "failed", error: { code: "STORAGE_FAILED", message: "The save never started because its reservation could not be recorded." } });
      throw error;
    }
    return operation;
  });
}

async function writeOperation(ctx, jobId, mediaId, attemptId, patch, outcome) {
  return mutate(async () => {
    const job = await currentJob(ctx, jobId, { inactive: true, profile: false });
    const key = operationKey(jobId, mediaId);
    const previous = await get(key);
    if (!previous || previous.attemptId !== attemptId) throw problem("STALE_OPERATION", "This result belongs to an older download attempt.");
    // A receipt can be delivered more than once, including while Stop settles.
    // A late cancellation/failure can never undo a committed physical save.
    if (previous.quotaState === "committed") return previous;
    if (previous.quotaState === "released") {
      if (outcome === "released") return previous;
      throw problem("STALE_OPERATION", "This attempt already ended without a saved file. Its late result cannot start or commit another save.");
    }
    const quota = allowance(job);
    const next = { ...previous, ...patch };
    let committed = quota.committed;
    let reserved = quota.reserved;
    if (outcome === "saved") {
      if (previous.quotaState !== "reserved" || quota.reserved !== mediaId) {
        throw problem("RECONCILIATION_REQUIRED", "This saved file does not have an active allowance reservation.", "limit");
      }
      if (limits.reached(job.options.maxNewVideos, committed)) {
        throw problem("RECONCILIATION_REQUIRED", "A saved video could not be matched to its remaining allowance. Check the destination before continuing.", "limit");
      }
      next.quotaState = "committed";
      committed++;
      if (reserved === mediaId) reserved = null;
    } else if (outcome === "released") {
      next.quotaState = "released";
      if (reserved === mediaId) reserved = null;
    } else if (outcome === "unknown") {
      next.quotaState = "reserved";
      if (reserved && reserved !== mediaId) throw problem("RECONCILIATION_REQUIRED", "Another video still has an unresolved save.", "limit");
      reserved = mediaId;
    }
    if (job.queue && Number.isInteger(next.downloadId) && previous.downloadId !== next.downloadId) {
      // Chrome's acceptance must survive a failure of the separate durable
      // queue archive, just as it survives a browser-receipt storage failure.
      await put({ [key]: { ...previous, downloadId: next.downloadId, filename: next.filename, state: "in_progress" } });
    }
    if (job.queue && (["saved", "released", "unknown"].includes(outcome) || next.quotaState === "reserved" && next.filename)) {
      const item = await get(memberKey(jobId, mediaId));
      await queueStore.settle(job.queue.runId, job.queue.entryId, item, attemptId, {
        state: outcome === "saved" ? "saved" : outcome === "released" ? next.state : "unknown",
        ...(next.filename ? { filename: next.filename.split(/[\\/]/).pop() } : {}),
        ...(next.bytesWritten != null ? { bytesWritten: next.bytesWritten } : {}),
        ...(Number.isInteger(next.downloadId) ? { downloadId: next.downloadId } : {}),
        ...(next.error ? { error: next.error } : {}),
      });
    }
    await put({ [key]: next, [ACTIVE]: { ...job, committedNewSaves: committed,
      reservationMediaId: reserved, updatedAt: Date.now() } });
    return next;
  });
}

async function recordBrowser(ctx, jobId, mediaId, attemptId, download, patch = {}) {
  const outcome = download?.state === "complete" ? "saved" : download?.state === "interrupted" ? "released" : "unknown";
  if (outcome === "saved") {
    const job = await currentJob(ctx, jobId, { inactive: true, profile: false });
    const item = await get(memberKey(jobId, mediaId));
    // Chrome has already returned this ID. Keep that acceptance proof in the
    // session journal before a durable-receipt write can fail; filename/time
    // reconciliation could otherwise confuse a rapid deliberate older copy.
    await writeOperation(ctx, jobId, mediaId, attemptId, { ...patch, attemptId, state: "in_progress", downloadId: download.id,
      ...(download.filename ? { filename: download.filename } : {}) }, "unknown");
    const raw = await rawOwnDownload(download.id);
    if (!item || !raw) throw problem("CACHE_RECEIPT_UNCONFIRMED", "The saved video's Chrome record could not be confirmed. Retry its status before downloading again.", "history");
    // Persist identity before releasing the allowance. A lost storage write or
    // worker response replays this same Chrome download rather than saving again.
    await recordReceipt(job.profile.id, item, raw, { check: async () => {
      await currentJob(ctx, jobId, { inactive: true, profile: false });
      const operation = await get(operationKey(jobId, mediaId));
      if (!operation || operation.attemptId !== attemptId) throw problem("STALE_OPERATION", "This receipt belongs to an older download attempt.");
    } });
  }
  return writeOperation(ctx, jobId, mediaId, attemptId, { ...patch,
    state: outcome === "saved" ? "saved" : outcome === "released" ? "failed" : "in_progress",
    ...(Number.isInteger(download?.id) ? { downloadId: download.id } : {}),
    ...(download?.filename ? { filename: download.filename } : {}),
    ...(download?.bytesWritten != null ? { bytesWritten: download.bytesWritten } : {}),
  }, outcome);
}

async function tabAtProfile(tabId, username) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { throw problem("TAB_CLOSED", "The source Instagram tab is no longer open."); }
  const current = profileUsername(tab.url);
  if (!current || (username && current !== username.toLowerCase())) {
    throw problem("PAGE_CHANGED", "Return to the batch's original profile to continue.");
  }
  return tab;
}

async function currentJob(ctx, jobId, { inactive = false, profile = true, importing = false } = {}) {
  const job = await get(ACTIVE);
  if (!job || job.jobId !== jobId || job.tabId !== ctx.tabId ||
      (ctx.documentId && job.documentId && ctx.documentId !== job.documentId)) {
    throw problem("STALE_JOB", "This batch belongs to a different tab or an older page. Start a new batch here.");
  }
  if (!inactive && !job.active) throw problem("STALE_JOB", "This batch has ended. Start a new batch or retry its failed items.");
  if (job.kind === "browser_import" && !importing) throw problem("JOB_BUSY", "Finish or cancel the browser history import before downloading.");
  if (job.queue) {
    await queueBinding(job, ctx, { settling: !profile });
    if (profile) await tabAtProfile(job.queue.sourceTabId, job.profile.username);
  } else if (profile) await tabAtProfile(ctx.tabId, job.profile.username);
  return job;
}

async function source(ctx, request) {
  let result;
  const job = await get(ACTIVE);
  const queued = job?.active && job.queue && request.action !== "identify" && job.tabId === ctx.tabId && job.documentId === ctx.documentId ? job : null;
  if (queued) await queueBinding(queued, ctx);
  const target = queued ? { tabId: queued.queue.sourceTabId, documentIds: [queued.queue.sourceDocumentId] } : { tabId: ctx.tabId };
  try {
    const frames = await chrome.scripting.executeScript({
      target, world: "MAIN", func: profileSource, args: [request],
    });
    result = frames.find((frame) => frame.frameId === 0)?.result;
  } catch {
    throw problem("PAGE_UNAVAILABLE", "Instagram could not be read. Reload the profile and start a new batch.", request.action, false);
  }
  if (queued) {
    await queueBinding(queued, ctx);
    await tabAtProfile(queued.queue.sourceTabId, queued.profile.username);
  }
  if (!result?.ok) {
    const e = result?.error || {};
    const diagnostic = sanitizeDiagnostic(e.diagnostic);
    throw Object.assign(problem(e.code || "ADAPTER_UNAVAILABLE", e.message || "Instagram's profile data is unavailable. Open its Reels tab and try again.", e.stage || request.action, e.retryable === true),
      Number.isFinite(e.retryAfterMs) ? { retryAfterMs: e.retryAfterMs } : {}, diagnostic ? { diagnostic } : {});
  }
  return result;
}

function checkProfile(profile) {
  if (!profile || !/^\d{1,30}$/.test(profile.id) || !/^[A-Za-z0-9._]{1,30}$/.test(profile.username)) {
    throw problem("SCHEMA_CHANGED", "Instagram did not return a valid profile identity.", "discovery");
  }
  return { id: profile.id, username: profile.username };
}

function checkItem(item) {
  if (!item || !/^\d{1,30}$/.test(item.mediaId) || !/^[A-Za-z0-9_-]{1,28}$/.test(item.shortcode)) {
    throw problem("INVALID_ITEM", "A Reel in this batch has an invalid identity.");
  }
  return { mediaId: item.mediaId, shortcode: item.shortcode };
}

function attempt(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw problem("INVALID_ATTEMPT", "The download attempt is invalid. Reopen the bulk panel.");
  }
  return value;
}

async function knownMember(ctx, message, allowInactive = false, requireProfile = true) {
  const job = await currentJob(ctx, message.jobId, { inactive: allowInactive, profile: requireProfile });
  const item = checkItem(message.item || { mediaId: message.mediaId, shortcode: "_" });
  const known = await get(memberKey(job.jobId, item.mediaId));
  if (!known || (message.item && known.shortcode !== item.shortcode)) {
    throw problem("INVALID_ITEM", "This Reel was not discovered for the current profile batch.");
  }
  return { job, item: known };
}

async function member(ctx, message, allowInactive = false, requireProfile = true) {
  return { ...await knownMember(ctx, message, allowInactive, requireProfile), attemptId: attempt(message.attemptId) };
}

async function restoreTab(job) {
  if (typeof job?.previousAutoDiscardable === "boolean" && chrome.tabs.update) {
    await chrome.tabs.update(job.tabId, { autoDiscardable: job.previousAutoDiscardable }).catch(() => {});
  }
}

async function start(ctx, message, kind) {
  return locked(async () => {
    await assertOrdinaryStart();
    const selected = options(message.options);
    const old = await get(ACTIVE);
    if (old?.reservationMediaId) {
      const tab = await chrome.tabs.get(old.tabId).catch(() => null);
      const lostHost = !tab || old.state === "interrupted" ||
        old.tabId === ctx.tabId && old.documentId && ctx.documentId && old.documentId !== ctx.documentId;
      throw problem("RECONCILIATION_REQUIRED", lostHost
        ? "A previous save could not be confirmed. Check the destination or Chrome Downloads, then reload ReelNest at chrome://extensions and refresh Instagram before starting a new run."
        : "A previous video's save is unresolved. Return to its original panel and confirm the save before starting another run.");
    }
    if (old?.active) {
      const tab = await chrome.tabs.get(old.tabId).catch(() => null);
      if (tab && (!old.documentId || old.tabId !== ctx.tabId || old.documentId === ctx.documentId)) {
        throw problem("BULK_BUSY", "Another bulk batch is active. Pause or stop it in its source tab first.");
      }
      await restoreTab(old);
    }
    const tab = await tabAtProfile(ctx.tabId);
    const identified = await source(ctx, { action: "identify" });
    const profile = checkProfile(identified.profile);
    await tabAtProfile(ctx.tabId, profile.username);
    const job = {
      schema: 1, jobId: crypto.randomUUID(), tabId: ctx.tabId, documentId: ctx.documentId,
      profile, options: selected, active: true, state: "running", cursor: null,
      exhausted: false, visited: [], createdAt: Date.now(), updatedAt: Date.now(),
      committedNewSaves: 0, reservationMediaId: null,
      ...(kind ? { kind } : {}),
      ...(typeof tab.autoDiscardable === "boolean" ? { previousAutoDiscardable: tab.autoDiscardable } : {}),
    };
    // Discard prevention is best effort. The queue still handles document loss.
    if (chrome.tabs.update) await chrome.tabs.update(ctx.tabId, { autoDiscardable: false }).catch(() => {});
    try {
      await mutate(async () => {
        const latest = await get(ACTIVE);
        if (latest?.reservationMediaId) throw problem("RECONCILIATION_REQUIRED", "The previous video's save must be confirmed before another run can start.");
        await put({ [ACTIVE]: job });
      });
    } catch (error) { await restoreTab(job); throw error; }
    // Only the latest in-tab job is resumable. Remove previous jobs' metadata.
    if (old && old.jobId !== job.jobId) {
      const all = await chrome.storage.session.get(null).catch(() => ({}));
      const keys = Object.keys(all).filter((key) => key.startsWith(prefix(old.jobId)));
      if (keys.length) await chrome.storage.session.remove(keys).catch(() => {});
    }
    return { ok: true, job: { jobId: job.jobId, profile, options: selected } };
  });
}

async function page(ctx, message) {
  const job = await currentJob(ctx, message.jobId);
  const cursor = message.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 4096)) throw problem("INVALID_CURSOR", "The profile cursor is invalid.", "discovery");
  if (job.lastPage?.inputCursor === cursor) return { ok: true, profile: job.profile, page: job.lastPage.page };
  assertAllowance(job);
  if (job.cursor !== cursor || job.exhausted) throw problem("PAGINATION_STALLED", "The profile scan is out of sequence. Resume the original scan.", "discovery");
  const response = await source(ctx, { action: "page", profile: job.profile, cursor });
  const output = response.page;
  if (response.profile?.id !== job.profile.id || !output || !Array.isArray(output.items) ||
      output.items.length > 1000 || typeof output.hasMore !== "boolean" ||
      (output.hasMore && (typeof output.nextCursor !== "string" || !output.nextCursor || output.nextCursor.length > 4096)) ||
      (!output.hasMore && output.nextCursor != null)) {
    throw problem("SCHEMA_CHANGED", "Instagram's pagination response changed. The scan is incomplete.", "discovery");
  }
  if (output.hasMore && (output.nextCursor === cursor || job.visited.includes(output.nextCursor))) {
    throw problem("PAGINATION_STALLED", "Instagram repeated a page cursor. The scan is incomplete.", "discovery");
  }
  const items = output.items.map((entry) => ({ ...checkItem(entry), username: job.profile.username }));
  if (job.queue) await queueStore.discover(job.queue.runId, job.queue.entryId, items);
  const nextPage = { items, nextCursor: output.hasMore ? output.nextCursor : null, hasMore: output.hasMore };
  await locked(() => mutate(async () => {
    const current = await currentJob(ctx, job.jobId);
    if (current.cursor !== cursor) throw problem("STALE_PAGE", "A newer page result already advanced this scan.", "discovery", true);
    await put({
      ...Object.fromEntries(items.map((item) => [memberKey(job.jobId, item.mediaId), item])),
      [ACTIVE]: { ...current, cursor: nextPage.nextCursor, exhausted: !nextPage.hasMore,
        visited: output.hasMore ? [...current.visited, output.nextCursor] : current.visited,
        lastPage: { inputCursor: cursor, page: nextPage }, updatedAt: Date.now() },
    });
  }));
  return { ok: true, profile: job.profile, page: nextPage };
}

async function getOwnDownload(id) {
  const item = await rawOwnDownload(id);
  if (!item) return null;
  return { ...summarizeDownload(item), ...(item.error ? { errorCode: item.error } : {}),
    ...(Number.isFinite(item.bytesReceived) && item.bytesReceived >= 0 ? { bytesReceived: item.bytesReceived } : {}),
    ...(Number.isFinite(item.totalBytes) && item.totalBytes > 0 ? { totalBytes: item.totalBytes } : {}),
    ...(Number.isFinite(item.fileSize) && item.fileSize >= 0 ? { bytesWritten: item.fileSize } : {}) };
}

async function rawOwnDownload(id) {
  if (!Number.isInteger(id) || id < 0) return null;
  return (await chrome.downloads.search({ id })).find((entry) => entry.byExtensionId === chrome.runtime.id && entry.id === id) || null;
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function existingBrowserDownload(ctx, job, item) {
  if (job.options.skipExisting === false) return null;
  const recorded = await verifyReceipt(job.profile.id, item);
  await currentJob(ctx, job.jobId);
  if (recorded) return recorded;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const numericId = [...item.shortcode].reduce((value, character) => value * 64n + BigInt(alphabet.indexOf(character)), 0n).toString();
  if (numericId !== item.mediaId || item.shortcode.length > 1 && item.shortcode.startsWith("A")) {
    throw problem("INVALID_ITEM", "This Reel's shortcode does not match its numeric identity.", "history");
  }
  // Older releases trimmed leading/trailing underscores from shortcodes when
  // naming files. Those legacy names cannot prove which Reel was saved.
  if (sanitizeFilenamePart(item.shortcode) !== item.shortcode) return null;
  const author = sanitizeFilenamePart(job.profile.username) || "reel";
  const foldedAuthor = [...author].map(character => /[A-Za-z]/.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]` : escapePattern(character)).join("");
  const suffix = `${escapePattern(item.shortcode)}(?: \\([1-9][0-9]*\\))?\\.mp4$`;
  const filenameRegex = `(?:^|[\\\\/])${foldedAuthor}_${suffix}`;
  const basenamePattern = new RegExp(`^(.+)_${suffix}`);
  let matches;
  try {
    matches = await chrome.downloads.search({ state: "complete", exists: true, filenameRegex,
      limit: MAX_HISTORY_CANDIDATES + 1, orderBy: ["-startTime"] });
  } catch {
    throw problem("CACHE_HISTORY_UNAVAILABLE", "Chrome's download history could not be checked. Retry before downloading more videos.", "history");
  }
  await currentJob(ctx, job.jobId);
  if (!Array.isArray(matches) || matches.length > MAX_HISTORY_CANDIDATES) {
    throw problem("CACHE_HISTORY_LIMIT", "Too many matching download records were returned. Check Chrome Downloads or use a Library folder before retrying.", "history");
  }
  for (const download of matches) {
    const filename = typeof download?.filename === "string" ? download.filename.replaceAll("\\", "/").split("/").pop() : "";
    const name = basenamePattern.exec(filename);
    if (download?.byExtensionId !== chrome.runtime.id || !Number.isInteger(download.id) || download.id < 0 ||
        download.state !== "complete" || download.exists !== true || !Number.isSafeInteger(download.fileSize) || download.fileSize <= 0 ||
        typeof download.mime !== "string" || !/^(video\/mp4|application\/(octet-stream|mp4))(?:;|$)/i.test(download.mime) ||
        !isInstagramMediaUrl(download.url, { video: true }) ||
        download.finalUrl && !isInstagramMediaUrl(download.finalUrl, { video: true }) ||
        !name || name[1].toLowerCase() !== author.toLowerCase()) continue;
    if (await isDownloadClaimedByOtherMedia(download.id, item.mediaId)) continue;
    try {
      await recordReceipt(job.profile.id, item, download, { check: async () => {
        await currentJob(ctx, job.jobId);
        if (await get(operationKey(job.jobId, item.mediaId))) throw problem("STALE_OPERATION", "This Reel already has an active save in the current run.");
      } });
    } catch (error) {
      if (error?.code === "CACHE_RECEIPT_IDENTITY_CONFLICT") continue;
      throw error;
    }
    await currentJob(ctx, job.jobId);
    return { cacheHit: true, filename, bytesWritten: download.fileSize, downloadId: download.id, verification: "browser_history" };
  }
  return null;
}

async function checkExisting(ctx, message) {
  const { job, item } = await knownMember(ctx, message);
  if (job.options.destination !== "downloads") throw problem("INVALID_DESTINATION", "Use the selected library's file history for folder saves.");
  // Own-run receipts must be reconciled as new saves, including after a lost
  // acknowledgement. They must never become history hits for the same run.
  if (pending.has(operationKey(job.jobId, item.mediaId)) || await get(operationKey(job.jobId, item.mediaId))) {
    return { ok: true, result: null };
  }
  return { ok: true, result: await existingBrowserDownload(ctx, job, item) };
}

async function reconcile(operation) {
  if (Number.isInteger(operation.downloadId)) {
    const download = await getOwnDownload(operation.downloadId);
    if (!download && !["failed", "canceled"].includes(operation.state)) {
      throw problem("RECONCILE_REQUIRED", "This accepted download is missing from Chrome's history. Check the saved file before retrying; no duplicate was started.");
    }
    return download;
  }
  // An accepted download might outlive a lost response/session write. Match only
  // this extension, this item filename, and the operation's acceptance window.
  if (!["intent", "unknown"].includes(operation.state)) return null;
  const items = await chrome.downloads.search({ startedAfter: new Date(operation.startedAt - 1000).toISOString(), limit: 100, orderBy: ["-startTime"] });
  const escaped = operation.shortcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = new RegExp(`(?:_|/)${escaped}(?: \\(\\d+\\))?\\.mp4$`);
  const matches = items.filter((item) => item.byExtensionId === chrome.runtime.id && name.test((item.filename || "").replaceAll("\\", "/")));
  if (matches.length !== 1) throw problem("RECONCILE_REQUIRED", "The previous download outcome is uncertain. Check Chrome Downloads before retrying this item.");
  operation.downloadId = matches[0].id;
  return getOwnDownload(operation.downloadId);
}

async function resolve(ctx, message, browser = false) {
  const entry = await member(ctx, message);
  const { job, item, attemptId } = entry;
  if (browser ? job.options.destination !== "downloads" : job.options.destination !== "folder") {
    throw problem("INVALID_DESTINATION", browser ? "This batch uses its chosen folder." : "This batch uses browser Downloads.");
  }
  const key = operationKey(job.jobId, item.mediaId);
  if (pending.has(key)) return pending.get(key);
  const run = (async () => {
    const previous = await get(key);
    if (browser && previous && (Number.isInteger(previous.downloadId) || ["intent", "unknown"].includes(previous.state))) {
      const download = await reconcile(previous);
      if (download && download.state !== "interrupted") {
        await recordBrowser(ctx, job.jobId, item.mediaId, previous.attemptId, download, { attemptId });
        return { ok: true, download, filename: previous.filename };
      }
      if (download?.state === "interrupted") await recordBrowser(ctx, job.jobId, item.mediaId, previous.attemptId, download);
    }
    if (previous?.state === "saved" && !browser) return { ok: true, alreadySaved: true,
      filename: previous.filename, result: { filename: previous.filename, ...(previous.bytesWritten != null ? { bytesWritten: previous.bytesWritten } : {}) } };
    // A resumed own-run attempt must settle as a new save in this run, even
    // if another matching historical download appears while it is suspended.
    // Returning a history hit here would strand its existing allowance slot.
    if (browser && !previous) {
      const existing = await existingBrowserDownload(ctx, job, item);
      if (existing) return { ok: true, alreadySaved: true, result: existing };
    }
    const cancelKey = cancellationKey(job.jobId, item.mediaId, attemptId);
    if (canceled.has(cancelKey)) throw problem("SAVE_CANCELLED", "The download was canceled.");
    if (browser) await assertReceiptCapacity(job.profile.id, item);
    await reserveOperation(ctx, job.jobId, item, attemptId);
    const response = await source(ctx, { action: "resolve", profile: job.profile, item });
    await currentJob(ctx, job.jobId);
    const media = validateMedia(response.media, item.shortcode);
    if (String(response.media?.mediaId) !== item.mediaId || response.profile?.id !== job.profile.id) throw problem("MEDIA_MISMATCH", "Instagram returned a different Reel for this item.", "resolve");
    if (canceled.has(cancelKey)) throw problem("SAVE_CANCELLED", "The download was canceled.");
    const filename = buildFilename(media);
    if (!browser) {
      await writeOperation(ctx, job.jobId, item.mediaId, attemptId, { state: "prepared", filename: filename.split("/").pop() });
      return { ok: true, media, filename: filename.split("/").pop() };
    }
    await writeOperation(ctx, job.jobId, item.mediaId, attemptId, { state: "intent", filename });
    let id;
    try { id = await chrome.downloads.download({ url: media.url, filename, conflictAction: "uniquify", saveAs: false }); }
    catch { await writeOperation(ctx, job.jobId, item.mediaId, attemptId, { state: "failed", filename }, "released"); throw problem("DOWNLOAD_FAILED", "Chrome could not start this video. Retry it after checking Downloads.", "save", true); }
    const stillCurrent = await currentJob(ctx, job.jobId, { profile: false }).catch(() => null);
    if (canceled.has(cancelKey) || !stillCurrent) {
      await chrome.downloads.cancel(id).catch(() => {});
      const download = await getOwnDownload(id);
      await recordBrowser(ctx, job.jobId, item.mediaId, attemptId, download, { filename, downloadId: id });
      if (!download || download.state === "in_progress") throw problem("RECONCILE_REQUIRED", "The canceled video's outcome is uncertain. Check Chrome Downloads before continuing.");
      if (download.state === "complete") return { ok: true, download, filename };
      throw problem("SAVE_CANCELLED", "The download was canceled.");
    }
    const download = await getOwnDownload(id) || { id, state: "in_progress" };
    try { await recordBrowser(ctx, job.jobId, item.mediaId, attemptId, download, { filename, downloadId: id }); }
    catch (error) {
      if (/^CACHE_RECEIPT_/.test(error?.code || "")) throw error;
      throw problem("RECONCILE_REQUIRED", "Chrome started the video but its status could not be recorded. Check Chrome Downloads before retrying.");
    }
    return { ok: true, download, filename };
  })();
  pending.set(key, run);
  try { return await run; }
  catch (error) {
    const operation = await get(key);
    if (operation?.attemptId === attemptId && operation.state === "resolving") {
      await writeOperation(ctx, job.jobId, item.mediaId, attemptId, {
        state: error.code === "SAVE_CANCELLED" ? "canceled" : error.code === "MEDIA_UNAVAILABLE" ? "skipped" : "failed",
        error: { code: error.code || "RESOLVE_FAILED", message: String(error.message).slice(0, 300) } }, "released");
    }
    throw error;
  } finally { if (pending.get(key) === run) pending.delete(key); }
}

async function operationStatus(ctx, message) {
  const { job, item, attemptId } = await member(ctx, message, true, false);
  const key = operationKey(job.jobId, item.mediaId);
  const operation = await get(key);
  if (!operation) throw problem("DOWNLOAD_MISSING", "No download operation exists for this Reel.");
  if (operation.attemptId !== attemptId) throw problem("STALE_OPERATION", "This status belongs to an older download attempt.");
  const download = await reconcile(operation);
  if (!download) throw problem("DOWNLOAD_MISSING", "This video is no longer in Chrome Downloads.");
  await recordBrowser(ctx, job.jobId, item.mediaId, attemptId, download);
  return { ok: true, download };
}

async function cancelItem(ctx, message) {
  const { job, item, attemptId } = await member(ctx, message, true, false);
  const key = operationKey(job.jobId, item.mediaId);
  canceled.add(cancellationKey(job.jobId, item.mediaId, attemptId));
  let operation = await get(key);
  if (operation && operation.attemptId !== attemptId) throw problem("STALE_OPERATION", "This cancellation belongs to an older download attempt.");
  if (operation?.downloadId != null) await chrome.downloads.cancel(operation.downloadId).catch(() => {});
  if (pending.has(key)) await pending.get(key).catch(() => {});
  operation = await get(key);
  if (operation && operation.attemptId !== attemptId) throw problem("STALE_OPERATION", "This cancellation belongs to an older download attempt.");
  if (operation?.downloadId != null) await chrome.downloads.cancel(operation.downloadId).catch(() => {});
  if (operation?.quotaState === "released") return { ok: true, canceled: true };
  let download;
  if (operation?.destination === "downloads" && operation.state === "saved") download = await reconcile(operation);
  if (operation && operation.state !== "saved") {
    if (job.options.destination === "downloads" && (Number.isInteger(operation.downloadId) || ["intent", "unknown"].includes(operation.state))) {
      download = await reconcile(operation);
      await recordBrowser(ctx, job.jobId, item.mediaId, attemptId, download);
      if (!download || download.state === "in_progress") throw problem("RECONCILE_REQUIRED", "The canceled video's outcome is uncertain. Check Chrome Downloads before continuing.");
    } else if (operation.state === "prepared" || operation.state === "unknown") {
      // A prepared native transfer belongs to the host. Only its writer knows
      // whether bytes were committed or its incomplete file was removed.
      throw problem("RECONCILIATION_REQUIRED", "The folder writer must confirm this video's outcome before the batch can be released.");
    } else await writeOperation(ctx, job.jobId, item.mediaId, attemptId, { state: "canceled" }, "released");
  }
  return { ok: true, ...(download ? { download } : { canceled: true }) };
}

async function nativeResult(ctx, message) {
  const { job, item, attemptId } = await member(ctx, message, true, false);
  if (job.options.destination !== "folder") throw problem("INVALID_DESTINATION", "Use Chrome's download status for browser-managed files.");
  const result = message.result;
  if (!result || !["saved", "skipped", "failed", "canceled"].includes(result.state)) throw problem("INVALID_RESULT", "The file result is invalid.");
  const unresolved = result.error?.cleanupFailed === true;
  // A host can know it never invoked the writer even if its RESOLVE response
  // was lost before the worker registered that attempt. Fence that exact
  // attempt before reading its journal so a delayed resolve cannot claim a slot.
  if (["failed", "canceled"].includes(result.state) && !unresolved) canceled.add(cancellationKey(job.jobId, item.mediaId, attemptId));
  const key = operationKey(job.jobId, item.mediaId);
  const operation = await get(key);
  if (!operation || operation.attemptId !== attemptId) throw problem("STALE_OPERATION", "This result belongs to an older download attempt.");
  if (result.state === "saved" && (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0)) {
    throw problem("INVALID_RESULT", "A saved file requires a confirmed positive byte count.");
  }
  const filename = typeof result.filename === "string" ? result.filename.split(/[\\/]/).pop().slice(0, 200) : operation.filename;
  await writeOperation(ctx, job.jobId, item.mediaId, attemptId, { state: unresolved ? "unknown" : result.state, filename,
    ...(Number.isFinite(result.bytesWritten) && result.bytesWritten >= 0 ? { bytesWritten: result.bytesWritten } : {}),
    ...(result.error ? { error: String(result.error.message || result.error).slice(0, 300) } : {}), completedAt: Date.now() },
    result.state === "saved" ? "saved" : unresolved ? "unknown" : "released");
  return { ok: true };
}

async function nativeIntent(ctx, message) {
  const { job, item, attemptId } = await member(ctx, message);
  if (!job.queue || job.options.destination !== "folder" || typeof message.filename !== "string" ||
      message.filename.length > 200 || !/\.mp4$/i.test(message.filename) || /[\\/\u0000-\u001f<>:"|?*]/.test(message.filename)) throw problem("INVALID_RESULT", "The reserved video filename is invalid.");
  const operation = await get(operationKey(job.jobId, item.mediaId));
  if (operation?.state !== "prepared" || operation.attemptId !== attemptId) throw problem("STALE_OPERATION", "This file intent belongs to an older save.");
  await writeOperation(ctx, job.jobId, item.mediaId, attemptId, { filename: message.filename, state: "prepared" }, "unknown");
  return { ok: true };
}

async function end(ctx, message) {
  return locked(async () => {
    const job = await currentJob(ctx, message.jobId, { inactive: true, profile: false });
    const terminal = ["completed", "completed_with_errors", "stopped"].includes(message.state);
    if (!terminal && !["paused", "incomplete", "running"].includes(message.state)) throw problem("INVALID_STATE", "The batch state is invalid.");
    await mutate(async () => {
      const current = await currentJob(ctx, job.jobId, { inactive: true, profile: false });
      // Retain ownership through cancellation and receipt settlement. A failed
      // release must not let a new owner delete an unresolved operation.
      await put({ [ACTIVE]: { ...current, active: true, state: message.state, updatedAt: Date.now() } });
    });
    if (message.state === "stopped") {
      // Stop owns cancellation until in-flight acceptance settles. A following
      // job cannot delete this journal before an accepted Chrome file is canceled.
      const all = await chrome.storage.session.get(null);
      const operations = Object.entries(all).filter(([key]) => key.startsWith(`${prefix(job.jobId)}operation:`));
      for (const [, operation] of operations) {
        if (operation.state === "saved") continue;
        canceled.add(cancellationKey(job.jobId, operation.mediaId, operation.attemptId));
        if (Number.isInteger(operation.downloadId)) await chrome.downloads.cancel(operation.downloadId).catch(() => {});
      }
      await Promise.allSettled([...pending.entries()].filter(([key]) => key.startsWith(prefix(job.jobId))).map(([, promise]) => promise));
      const latest = await chrome.storage.session.get(null);
      for (const [key, operation] of Object.entries(latest)) {
        if (!key.startsWith(`${prefix(job.jobId)}operation:`) || operation.state === "saved") continue;
        if (Number.isInteger(operation.downloadId)) await chrome.downloads.cancel(operation.downloadId).catch(() => {});
        if (operation.quotaState === "released") continue;
        if (operation.destination === "downloads" && (Number.isInteger(operation.downloadId) || ["intent", "unknown"].includes(operation.state))) {
          const download = await reconcile(operation);
          await recordBrowser(ctx, job.jobId, operation.mediaId, operation.attemptId, download);
          if (!download || download.state === "in_progress") throw problem("RECONCILE_REQUIRED", "A stopped video's outcome is uncertain. Check Chrome Downloads before releasing this batch.");
        } else if (["prepared", "unknown"].includes(operation.state)) {
          throw problem("RECONCILIATION_REQUIRED", "A folder save still needs confirmation. Record its history before releasing this batch.");
        } else await writeOperation(ctx, job.jobId, operation.mediaId, operation.attemptId, { state: "canceled" }, "released");
      }
    }
    const settled = await currentJob(ctx, job.jobId, { inactive: true, profile: false });
    if (terminal && allowance(settled).reserved) throw problem("RECONCILIATION_REQUIRED", "A video's save is still unresolved. Confirm its result before releasing this batch.");
    let savedResults;
    if (terminal) {
      if (message.state === "stopped" && job.options.destination === "downloads") {
        const all = await chrome.storage.session.get(null);
        savedResults = Object.entries(all)
          .filter(([key, entry]) => key.startsWith(`${prefix(job.jobId)}operation:`) && entry.state === "saved" && entry.quotaState === "committed")
          .map(([, entry]) => ({ mediaId: entry.mediaId, filename: entry.filename, downloadId: entry.downloadId,
            ...(Number.isFinite(entry.bytesWritten) && entry.bytesWritten > 0 ? { bytesWritten: entry.bytesWritten } : {}) }));
      }
      await mutate(async () => {
        const current = await currentJob(ctx, job.jobId, { inactive: true, profile: false });
        if (allowance(current).reserved) throw problem("RECONCILIATION_REQUIRED", "A video's save is still unresolved.");
        await put({ [ACTIVE]: { ...current, active: false, updatedAt: Date.now() } });
      });
      await restoreTab(job);
    }
    return { ok: true, committedNewSaves: allowance(settled).committed, ...(savedResults ? { savedResults } : {}) };
  });
}

async function browserImportPreview(ctx, message) {
  // Validate the selected report before acquiring the shared job owner. The
  // profile's numeric identity is rechecked after the page identifies itself.
  if (!message.report || message.report.version !== 1 || !Array.isArray(message.report.items) ||
      message.report.items.length > 50000 || JSON.stringify(message.report).length > 16 * 1024 * 1024) {
    throw problem("CACHE_RECEIPT_INVALID_REPORT", "Choose a supported ReelNest download report of at most 16 MiB and 50,000 entries.", "import");
  }
  const registered = await start(ctx, { options: { mode: "batches", batchSize: 35, destination: "downloads", skipExisting: true } }, "browser_import");
  const jobId = registered.job.jobId;
  try {
    const normalized = normalizeReport(registered.job.profile.id, message.report);
    const verified = await previewReport(registered.job.profile.id, message.report, { check: () => browserImportCurrent(ctx, jobId) });
    const summary = { saved: normalized.items.length, ready: 0, alreadyRecorded: 0, missing: verified.counts.missing, conflicts: 0, ignored: normalized.ignored || 0 };
    const candidates = [];
    for (const entry of verified.items) {
      if (canceledImports.has(jobId)) throw problem("SAVE_CANCELLED", "The history import was canceled.", "import");
      await currentJob(ctx, jobId, { importing: true });
      const recorded = await getReceipt(registered.job.profile.id, entry);
      candidates.push(entry);
      if (recorded?.downloadId === entry.downloadId && recorded.filename === entry.filename && recorded.bytesWritten === entry.bytesWritten) {
        summary.alreadyRecorded++;
        continue;
      }
      summary.ready++;
    }
    await mutate(async () => {
      const job = await currentJob(ctx, jobId, { importing: true });
      if (canceledImports.has(jobId)) throw problem("SAVE_CANCELLED", "The history import was canceled.", "import");
      await put({ [ACTIVE]: { ...job, browserImport: { items: candidates, summary }, updatedAt: Date.now() } });
    });
    return { ok: true, previewId: jobId, profile: registered.job.profile, summary };
  } catch (error) {
    await releaseBrowserImport(ctx, jobId).catch(() => {});
    throw error;
  }
}

async function browserImportCommit(ctx, message) {
  return locked(async () => {
    const job = await browserImportCurrent(ctx, message.previewId);
    if (job.kind !== "browser_import" || !job.browserImport) throw problem("CACHE_RECEIPT_INVALID_PREVIEW", "Open a report preview before importing browser history.", "import");
    const identified = checkProfile((await source(ctx, { action: "identify" })).profile);
    await browserImportCurrent(ctx, job.jobId);
    if (identified.id !== job.profile.id || identified.username.toLowerCase() !== job.profile.username.toLowerCase()) {
      throw problem("CACHE_RECEIPT_PROFILE_CHANGED", "The profile identity changed. Cancel this preview and open the report again.", "import");
    }
    const result = { imported: 0, alreadyRecorded: 0,
      missing: job.browserImport.summary.missing, conflicts: job.browserImport.summary.conflicts };
    for (const entry of job.browserImport.items) {
      if (canceledImports.has(job.jobId)) break;
      await browserImportCurrent(ctx, job.jobId);
      if (await verifyReceipt(job.profile.id, entry)) { result.alreadyRecorded++; continue; }
      const raw = await rawOwnDownload(entry.downloadId);
      if (canceledImports.has(job.jobId)) break;
      await browserImportCurrent(ctx, job.jobId);
      const filename = typeof raw?.filename === "string" ? raw.filename.replaceAll("\\", "/").split("/").pop() : "";
      if (!raw || filename !== entry.filename || raw.fileSize !== entry.bytesWritten) { result.missing++; continue; }
      // The selected report binds this exact filename/size to the Reel ID;
      // recordReceipt revalidates the Chrome provenance and completed output.
      try { await recordReceipt(job.profile.id, entry, raw, { check: () => browserImportCurrent(ctx, job.jobId) }); result.imported++; }
      catch (error) {
        if (error?.code === "SAVE_CANCELLED") break;
        if (error?.code === "CACHE_RECEIPT_UNVERIFIED") { result.missing++; continue; }
        throw error;
      }
    }
    return { ok: true, ...result, canceled: canceledImports.has(job.jobId) };
  });
}

async function browserImportCurrent(ctx, jobId) {
  if (canceledImports.has(jobId)) throw problem("SAVE_CANCELLED", "The browser history import was canceled.", "import");
  return currentJob(ctx, jobId, { importing: true });
}

async function releaseBrowserImport(ctx, previewId) {
  return locked(() => mutate(async () => {
    const observed = await get(ACTIVE);
    if (!observed || observed.kind !== "browser_import" || (previewId && observed.jobId !== previewId)) return { ok: true };
    const job = await currentJob(ctx, observed.jobId, { inactive: true, profile: false, importing: true });
    await put({ [ACTIVE]: { ...job, active: false, state: "stopped", updatedAt: Date.now() } });
    await restoreTab(job);
    return { ok: true };
  }));
}

async function browserImportCancel(ctx, message) {
  const observed = await get(ACTIVE);
  if (!observed || observed.kind !== "browser_import" || message.previewId && message.previewId !== observed.jobId) return { ok: true };
  await currentJob(ctx, observed.jobId, { inactive: true, profile: false, importing: true });
  canceledImports.add(observed.jobId);
  return releaseBrowserImport(ctx, observed.jobId);
}

export async function handleBulkMessage(message, sender) {
  if (!isBulkMessage(message)) return undefined;
  try {
    const ctx = context(sender);
    if (message.tabId !== undefined && message.tabId !== ctx.tabId) throw problem("INVALID_SENDER", "A batch can control only its source Instagram tab.");
    const action = message.type.slice("REEL_SAVER_BULK_".length);
    if (action === "SETTINGS_GET") {
      const prefs = (await chrome.storage.local.get(PREFS))[PREFS];
      let maxNewVideos = null;
      try { maxNewVideos = limits.normalize(prefs?.maxNewVideos); } catch { /* Ignore an invalid stored preference. */ }
      return { ok: true, settings: { mode: prefs?.mode === "scan_all" ? "scan_all" : "batches",
        batchSize: Number.isSafeInteger(prefs?.batchSize) && prefs.batchSize > 0 && prefs.batchSize <= 500 ? prefs.batchSize : 35,
        maxNewVideos } };
    }
    if (action === "SETTINGS_SET") {
      const selected = options({ ...message.settings, destination: "downloads" });
      const settings = { mode: selected.mode, batchSize: selected.batchSize, maxNewVideos: selected.maxNewVideos };
      await chrome.storage.local.set({ [PREFS]: settings });
      return { ok: true, settings };
    }
    if (action === "IDENTIFY") {
      await tabAtProfile(ctx.tabId);
      const profile = checkProfile((await source(ctx, { action: "identify" })).profile);
      await tabAtProfile(ctx.tabId, profile.username);
      return { ok: true, profile };
    }
    if (action === "BROWSER_IMPORT_PREVIEW") return await browserImportPreview(ctx, message);
    if (action === "BROWSER_IMPORT_COMMIT") return await browserImportCommit(ctx, message);
    if (action === "BROWSER_IMPORT_CANCEL") return await browserImportCancel(ctx, message);
    if (action === "START") return await start(ctx, message);
    if (action === "PAGE") return await page(ctx, message);
    if (action === "CHECK_EXISTING") return await checkExisting(ctx, message);
    if (action === "RESOLVE") return await resolve(ctx, message, false);
    if (action === "DOWNLOAD") return await resolve(ctx, message, true);
    if (action === "STATUS") return await operationStatus(ctx, message);
    if (action === "CANCEL_ITEM") return await cancelItem(ctx, message);
    if (action === "ITEM_RESULT") return await nativeResult(ctx, message);
    if (action === "NATIVE_INTENT") return await nativeIntent(ctx, message);
    if (action === "END") return await end(ctx, message);
    if (action === "REOPEN") return await locked(() => mutate(async () => {
      const job = await currentJob(ctx, message.jobId, { inactive: true });
      assertAllowance(job);
      await put({ [ACTIVE]: { ...job, active: true, state: "running", updatedAt: Date.now() } });
      if (chrome.tabs.update) await chrome.tabs.update(job.tabId, { autoDiscardable: false }).catch(() => {});
      return { ok: true, job: { jobId: job.jobId, profile: job.profile, options: job.options } };
    }));
    if (action === "HEARTBEAT") {
      await locked(() => mutate(async () => { const job = await currentJob(ctx, message.jobId, { profile: false }); await put({ [ACTIVE]: { ...job, updatedAt: Date.now() } }); }));
      return { ok: true };
    }
  } catch (error) {
    const diagnostic = sanitizeDiagnostic(error.diagnostic);
    return { ok: false, error: { code: error.code || "BULK_ERROR", message: error.message || "This batch could not continue.",
      stage: error.stage || "queue", retryable: error.retryable === true,
      ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(diagnostic ? { diagnostic } : {}) } };
  }
}

export async function cleanupBulkTab(tabId) {
  const observed = await get(ACTIVE);
  if (observed?.tabId !== tabId) return;
  await locked(() => mutate(async () => {
    const current = await get(ACTIVE);
    if (current?.jobId !== observed.jobId || current.documentId !== observed.documentId) return;
    await put({ [ACTIVE]: { ...current, active: current.queue ? false : !!allowance(current).reserved, state: "interrupted", updatedAt: Date.now() } });
    await restoreTab(current);
  }));
}

export async function interruptQueueChild(jobId) {
  return mutate(async () => {
    const current = await get(ACTIVE);
    if (current?.jobId === jobId && current.queue) await put({ [ACTIVE]: { ...current, active: false, state: "interrupted", updatedAt: Date.now() } });
  });
}
