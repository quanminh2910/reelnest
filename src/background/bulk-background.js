import { profileSource } from "../instagram/profile-source.js";
import { buildFilename, validateMedia, summarizeDownload } from "../shared/core.js";

const ACTIVE = "reel-saver:bulk-active";
const PREFS = "reel-saver:bulk-prefs";
const prefix = (jobId) => `reel-saver:bulk:${jobId}:`;
const memberKey = (jobId, id) => `${prefix(jobId)}member:${id}`;
const operationKey = (jobId, id) => `${prefix(jobId)}operation:${id}`;
const cancellationKey = (jobId, id, attemptId) => `${operationKey(jobId, id)}:${attemptId}`;
const pending = new Map();
const canceled = new Set();
let registration = Promise.resolve();
const actions = new Set([
  "START", "PAGE", "RESOLVE", "DOWNLOAD", "STATUS", "CANCEL_ITEM", "ITEM_RESULT",
  "END", "REOPEN", "HEARTBEAT", "IDENTIFY", "SETTINGS_GET", "SETTINGS_SET",
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
      !["folder", "downloads"].includes(value.destination)) {
    throw problem("INVALID_SETTINGS", "Choose a download mode, a batch size from 1 to 500, and a folder or Downloads.");
  }
  return { mode: value.mode, batchSize: value.batchSize, destination: value.destination };
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

async function currentJob(ctx, jobId, { inactive = false, profile = true } = {}) {
  const job = await get(ACTIVE);
  if (!job || job.jobId !== jobId || job.tabId !== ctx.tabId ||
      (ctx.documentId && job.documentId && ctx.documentId !== job.documentId)) {
    throw problem("STALE_JOB", "This batch belongs to a different tab or an older page. Start a new batch here.");
  }
  if (!inactive && !job.active) throw problem("STALE_JOB", "This batch has ended. Start a new batch or retry its failed items.");
  if (profile) await tabAtProfile(ctx.tabId, job.profile.username);
  return job;
}

async function source(ctx, request) {
  let result;
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId }, world: "MAIN", func: profileSource, args: [request],
    });
    result = frames.find((frame) => frame.frameId === 0)?.result;
  } catch {
    throw problem("PAGE_UNAVAILABLE", "Instagram could not be read. Reload the profile and start a new batch.", request.action, false);
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

async function member(ctx, message, allowInactive = false, requireProfile = true) {
  const job = await currentJob(ctx, message.jobId, { inactive: allowInactive, profile: requireProfile });
  const item = checkItem(message.item || { mediaId: message.mediaId, shortcode: "_" });
  const known = await get(memberKey(job.jobId, item.mediaId));
  if (!known || (message.item && known.shortcode !== item.shortcode)) {
    throw problem("INVALID_ITEM", "This Reel was not discovered for the current profile batch.");
  }
  return { job, item: known, attemptId: attempt(message.attemptId) };
}

async function restoreTab(job) {
  if (typeof job?.previousAutoDiscardable === "boolean" && chrome.tabs.update) {
    await chrome.tabs.update(job.tabId, { autoDiscardable: job.previousAutoDiscardable }).catch(() => {});
  }
}

async function start(ctx, message) {
  return locked(async () => {
    const selected = options(message.options);
    const old = await get(ACTIVE);
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
      ...(typeof tab.autoDiscardable === "boolean" ? { previousAutoDiscardable: tab.autoDiscardable } : {}),
    };
    // Discard prevention is best effort. The queue still handles document loss.
    if (chrome.tabs.update) await chrome.tabs.update(ctx.tabId, { autoDiscardable: false }).catch(() => {});
    try { await put({ [ACTIVE]: job }); } catch (error) { await restoreTab(job); throw error; }
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
  const nextPage = { items, nextCursor: output.hasMore ? output.nextCursor : null, hasMore: output.hasMore };
  await locked(async () => {
    const current = await currentJob(ctx, job.jobId);
    if (current.cursor !== cursor) throw problem("STALE_PAGE", "A newer page result already advanced this scan.", "discovery", true);
    await put({
      ...Object.fromEntries(items.map((item) => [memberKey(job.jobId, item.mediaId), item])),
      [ACTIVE]: { ...current, cursor: nextPage.nextCursor, exhausted: !nextPage.hasMore,
        visited: output.hasMore ? [...current.visited, output.nextCursor] : current.visited,
        lastPage: { inputCursor: cursor, page: nextPage }, updatedAt: Date.now() },
    });
  });
  return { ok: true, profile: job.profile, page: nextPage };
}

async function getOwnDownload(id) {
  if (!Number.isInteger(id)) return null;
  const item = (await chrome.downloads.search({ id })).find((entry) => entry.byExtensionId === chrome.runtime.id && entry.id === id);
  if (!item) return null;
  return { ...summarizeDownload(item), ...(item.error ? { errorCode: item.error } : {}),
    ...(Number.isFinite(item.bytesReceived) && item.bytesReceived >= 0 ? { bytesReceived: item.bytesReceived } : {}),
    ...(Number.isFinite(item.totalBytes) && item.totalBytes > 0 ? { totalBytes: item.totalBytes } : {}),
    ...(Number.isFinite(item.fileSize) && item.fileSize >= 0 ? { bytesWritten: item.fileSize } : {}) };
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
  const key = operationKey(job.jobId, item.mediaId);
  if (pending.has(key)) return pending.get(key);
  const run = (async () => {
    const previous = await get(key);
    if (browser && previous && (Number.isInteger(previous.downloadId) || ["intent", "unknown"].includes(previous.state))) {
      const download = await reconcile(previous);
      if (download && download.state !== "interrupted") {
        await put({ [key]: { ...previous, attemptId, state: download.state === "complete" ? "saved" : "in_progress", downloadId: download.id } });
        return { ok: true, download, filename: previous.filename };
      }
    }
    if (previous?.state === "saved" && !browser) return { ok: true, alreadySaved: true,
      filename: previous.filename, result: { filename: previous.filename, ...(previous.bytesWritten != null ? { bytesWritten: previous.bytesWritten } : {}) } };
    const operation = { jobId: job.jobId, mediaId: item.mediaId, shortcode: item.shortcode, attemptId,
      state: "resolving", startedAt: Date.now(), destination: job.options.destination };
    const cancelKey = cancellationKey(job.jobId, item.mediaId, attemptId);
    if (canceled.has(cancelKey)) throw problem("SAVE_CANCELLED", "The download was canceled.");
    await put({ [key]: operation });
    const response = await source(ctx, { action: "resolve", profile: job.profile, item });
    await currentJob(ctx, job.jobId);
    const media = validateMedia(response.media, item.shortcode);
    if (String(response.media?.mediaId) !== item.mediaId || response.profile?.id !== job.profile.id) throw problem("MEDIA_MISMATCH", "Instagram returned a different Reel for this item.", "resolve");
    if (canceled.has(cancelKey)) throw problem("SAVE_CANCELLED", "The download was canceled.");
    const filename = buildFilename(media);
    if (!browser) {
      if (job.options.destination !== "folder") throw problem("INVALID_DESTINATION", "This batch uses browser Downloads.");
      await put({ [key]: { ...operation, state: "prepared", filename: filename.split("/").pop() } });
      return { ok: true, media, filename: filename.split("/").pop() };
    }
    if (job.options.destination !== "downloads") throw problem("INVALID_DESTINATION", "This batch uses its chosen folder.");
    await put({ [key]: { ...operation, state: "intent", filename } });
    let id;
    try { id = await chrome.downloads.download({ url: media.url, filename, conflictAction: "uniquify", saveAs: false }); }
    catch { await put({ [key]: { ...operation, state: "failed", filename } }); throw problem("DOWNLOAD_FAILED", "Chrome could not start this video. Retry it after checking Downloads.", "save", true); }
    const stillCurrent = await currentJob(ctx, job.jobId, { profile: false }).catch(() => null);
    if (canceled.has(cancelKey) || !stillCurrent) {
      await chrome.downloads.cancel(id).catch(() => {});
      await put({ [key]: { ...operation, state: "canceled", filename, downloadId: id } });
      throw problem("SAVE_CANCELLED", "The download was canceled.");
    }
    try { await put({ [key]: { ...operation, state: "in_progress", filename, downloadId: id } }); }
    catch { throw problem("RECONCILE_REQUIRED", "Chrome started the video but its status could not be recorded. Check Chrome Downloads before retrying."); }
    return { ok: true, download: await getOwnDownload(id) || { id, state: "in_progress" }, filename };
  })();
  pending.set(key, run);
  try { return await run; }
  catch (error) {
    const operation = await get(key);
    if (operation?.attemptId === attemptId && operation.state === "resolving") {
      await put({ [key]: { ...operation,
        state: error.code === "SAVE_CANCELLED" ? "canceled" : error.code === "MEDIA_UNAVAILABLE" ? "skipped" : "failed",
        error: { code: error.code || "RESOLVE_FAILED", message: String(error.message).slice(0, 300) } } });
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
  await put({ [key]: { ...operation, downloadId: download.id, state: download.state === "complete" ? "saved" : download.state === "interrupted" ? "failed" : "in_progress",
    ...(download.filename ? { filename: download.filename } : {}), ...(download.bytesWritten != null ? { bytesWritten: download.bytesWritten } : {}) } });
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
  if (operation && operation.state !== "saved") await put({ [key]: { ...operation, state: "canceled" } });
  return { ok: true };
}

async function nativeResult(ctx, message) {
  const { job, item, attemptId } = await member(ctx, message, true, false);
  if (job.options.destination !== "folder") throw problem("INVALID_DESTINATION", "Use Chrome's download status for browser-managed files.");
  const key = operationKey(job.jobId, item.mediaId);
  const operation = await get(key);
  if (!operation || operation.attemptId !== attemptId) throw problem("STALE_OPERATION", "This result belongs to an older download attempt.");
  const result = message.result;
  if (!result || !["saved", "skipped", "failed", "canceled"].includes(result.state)) throw problem("INVALID_RESULT", "The file result is invalid.");
  const filename = typeof result.filename === "string" ? result.filename.split(/[\\/]/).pop().slice(0, 200) : operation.filename;
  await put({ [key]: { ...operation, state: result.state, filename,
    ...(Number.isFinite(result.bytesWritten) && result.bytesWritten >= 0 ? { bytesWritten: result.bytesWritten } : {}),
    ...(result.error ? { error: String(result.error.message || result.error).slice(0, 300) } : {}), completedAt: Date.now() } });
  return { ok: true };
}

async function end(ctx, message) {
  return locked(async () => {
    const job = await currentJob(ctx, message.jobId, { inactive: true, profile: false });
    const terminal = ["completed", "completed_with_errors", "stopped"].includes(message.state);
    if (!terminal && !["paused", "incomplete", "running"].includes(message.state)) throw problem("INVALID_STATE", "The batch state is invalid.");
    await put({ [ACTIVE]: { ...job, active: !terminal, state: message.state, updatedAt: Date.now() } });
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
        await put({ [key]: { ...operation, state: "canceled" } });
      }
    }
    if (terminal) await restoreTab(job);
    return { ok: true };
  });
}

export async function handleBulkMessage(message, sender) {
  if (!isBulkMessage(message)) return undefined;
  try {
    const ctx = context(sender);
    if (message.tabId !== undefined && message.tabId !== ctx.tabId) throw problem("INVALID_SENDER", "A batch can control only its source Instagram tab.");
    const action = message.type.slice("REEL_SAVER_BULK_".length);
    if (action === "SETTINGS_GET") {
      const prefs = (await chrome.storage.local.get(PREFS))[PREFS];
      return { ok: true, settings: { mode: prefs?.mode === "scan_all" ? "scan_all" : "batches",
        batchSize: Number.isSafeInteger(prefs?.batchSize) && prefs.batchSize > 0 && prefs.batchSize <= 500 ? prefs.batchSize : 35 } };
    }
    if (action === "SETTINGS_SET") {
      const selected = options({ ...message.settings, destination: "downloads" });
      const settings = { mode: selected.mode, batchSize: selected.batchSize };
      await chrome.storage.local.set({ [PREFS]: settings });
      return { ok: true, settings };
    }
    if (action === "IDENTIFY") {
      await tabAtProfile(ctx.tabId);
      const profile = checkProfile((await source(ctx, { action: "identify" })).profile);
      await tabAtProfile(ctx.tabId, profile.username);
      return { ok: true, profile };
    }
    if (action === "START") return await start(ctx, message);
    if (action === "PAGE") return await page(ctx, message);
    if (action === "RESOLVE") return await resolve(ctx, message, false);
    if (action === "DOWNLOAD") return await resolve(ctx, message, true);
    if (action === "STATUS") return await operationStatus(ctx, message);
    if (action === "CANCEL_ITEM") return await cancelItem(ctx, message);
    if (action === "ITEM_RESULT") return await nativeResult(ctx, message);
    if (action === "END") return await end(ctx, message);
    if (action === "REOPEN") return await locked(async () => {
      const job = await currentJob(ctx, message.jobId, { inactive: true });
      await put({ [ACTIVE]: { ...job, active: true, state: "running", updatedAt: Date.now() } });
      if (chrome.tabs.update) await chrome.tabs.update(job.tabId, { autoDiscardable: false }).catch(() => {});
      return { ok: true, job: { jobId: job.jobId, profile: job.profile, options: job.options } };
    });
    if (action === "HEARTBEAT") {
      await locked(async () => { const job = await currentJob(ctx, message.jobId, { profile: false }); await put({ [ACTIVE]: { ...job, updatedAt: Date.now() } }); });
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
  await locked(async () => {
    const current = await get(ACTIVE);
    if (current?.jobId !== observed.jobId || current.documentId !== observed.documentId) return;
    await put({ [ACTIVE]: { ...current, active: false, state: "interrupted", updatedAt: Date.now() } });
    await restoreTab(current);
  });
}
