import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptKey } from "../src/background/browser-receipts.js";

const extensionId = "bulk-test-extension";
const profile = { id: "900", username: "creator" };
const profileUrl = "https://www.instagram.com/creator/reels/";
const item = { mediaId: "1", shortcode: "B" };
const secondItem = { mediaId: "2", shortcode: "C" };
const thirdItem = { mediaId: "3", shortcode: "D" };
const activeKey = "reel-saver:bulk-active";
const memberKey = (jobId, id = "1") => `reel-saver:bulk:${jobId}:member:${id}`;
const operationKey = (jobId, id = "1") => `reel-saver:bulk:${jobId}:operation:${id}`;
const sender = (tabId = 7, documentId = "document-one") => ({
  id: extensionId, frameId: 0, documentId, tab: { id: tabId, url: profileUrl }, url: profileUrl,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const state = {
    session: {}, local: {}, calls: [], downloads: [], sourceCalls: [],
    tabs: new Map([[7, { id: 7, url: profileUrl, autoDiscardable: true }], [8, { id: 8, url: profileUrl, autoDiscardable: true }]]),
  };
  const area = name => ({
    async get(key) {
      if (key == null) return structuredClone(state[name]);
      if (typeof key === "string") return { [key]: structuredClone(state[name][key]) };
      return Object.fromEntries(key.map(value => [value, structuredClone(state[name][value])]));
    },
    async set(values) {
      if (state.failSessionWrite && name === "session") {
        state.failSessionWrite = false;
        throw new Error("Storage unavailable");
      }
      if (state.failLocalWrite && name === "local" && Object.keys(values).some(key => key.startsWith("reelnest:browser-receipt:v1:"))) {
        state.failLocalWrite = false;
        throw new Error("Local storage unavailable");
      }
      if (name === "local" && state.localWriteGate && Object.keys(values).some(key => key.startsWith("reelnest:browser-receipt:v1:"))) {
        state.localWriting?.resolve();
        await state.localWriteGate.promise;
      }
      state[name] = { ...state[name], ...structuredClone(values) };
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete state[name][key];
    },
  });
  const chrome = {
    runtime: { id: extensionId }, storage: { session: area("session"), local: area("local") },
    tabs: {
      async get(id) {
        if (!state.tabs.has(id)) throw new Error("Tab closed");
        return { ...state.tabs.get(id) };
      },
      async update(id, change) {
        if (!state.tabs.has(id)) throw new Error("Tab closed");
        Object.assign(state.tabs.get(id), change);
        state.calls.push({ type: "tab-update", id, change });
        return { ...state.tabs.get(id) };
      },
    },
    scripting: { async executeScript(options) {
      const request = options.args[0];
      state.sourceCalls.push(structuredClone(request));
      if (state.injectionError) throw state.injectionError;
      if (state.source) return [{ frameId: 0, result: await state.source(request) }];
      if (request.action === "identify") return [{ frameId: 0, result: { ok: true, profile } }];
      if (request.action === "page") return [{ frameId: 0, result: {
        ok: true, profile, page: { items: [item, secondItem], nextCursor: null, hasMore: false },
      } }];
      const mediaItem = request.item;
      if (state.resolveGate) await state.resolveGate.promise;
      return [{ frameId: 0, result: { ok: true, profile, media: {
        mediaId: mediaItem.mediaId, shortcode: mediaItem.shortcode,
        pageUrl: `https://www.instagram.com/reel/${mediaItem.shortcode}/`, username: state.mediaUsername || "creator",
        url: state.videoUrl || "https://scontent.cdninstagram.com/video/reel.mp4?local=fixture",
        width: 720, height: 1280,
      } } }];
    } },
    downloads: {
      async download(options) {
        state.calls.push({ type: "download", options });
        if (state.downloadError) throw new Error("Chrome rejected download");
        const id = state.downloads.length + 1;
        state.downloads.push({ id, byExtensionId: extensionId, filename: options.filename,
          url: options.url, state: state.completeDownload ? "complete" : "in_progress", startTime: new Date().toISOString(), exists: true, mime: "video/mp4", fileSize: 2048 });
        if (state.failAcceptanceRecord) {
          state.failAcceptanceRecord = false;
          state.failSessionWrite = true;
        }
        if (state.downloadGate) await state.downloadGate.promise;
        return id;
      },
      async search(query) {
        state.calls.push({ type: "search", query });
        if (state.search) return state.search(query);
        const matches = state.downloads.filter(value =>
          (query.id == null || value.id === query.id) &&
          (!query.state || value.state === query.state) &&
          (query.exists === undefined || value.exists === query.exists) &&
          (!query.filenameRegex || new RegExp(query.filenameRegex).test(value.filename)));
        if (query.orderBy?.includes("-startTime")) matches.sort((a, b) => b.startTime.localeCompare(a.startTime));
        return structuredClone(matches.slice(0, query.limit || matches.length));
      },
      async cancel(id) {
        state.calls.push({ type: "cancel", id });
        const download = state.downloads.find(value => value.id === id);
        if (download?.state === "in_progress") { download.state = "interrupted"; download.error = "USER_CANCELED"; }
      },
    },
  };
  return { state, chrome };
}

let moduleNumber = 0;
async function load(f) {
  globalThis.chrome = f.chrome;
  return import(`../src/background/bulk-background.js?bulk-test=${++moduleNumber}`);
}

function message(action, extra = {}) { return { type: `REEL_SAVER_BULK_${action}`, ...extra }; }
const options = (destination = "downloads") => ({ mode: "batches", batchSize: 35, destination });
async function start(api, source = sender(), destination = "downloads", maxNewVideos) {
  const result = await api.handleBulkMessage(message("START", { options: { ...options(destination),
    ...(maxNewVideos !== undefined ? { maxNewVideos } : {}) } }), source);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.job;
}
async function discover(api, job, source = sender(), cursor = null) {
  return api.handleBulkMessage(message("PAGE", { jobId: job.jobId, cursor }), source);
}
function operation(action, job, attemptId = "attempt-one", extra = {}) {
  return message(action, { jobId: job.jobId, item, attemptId, ...extra });
}
async function waitUntil(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("Fixture operation did not reach expected stage");
}

test("bulk settings default to 35 and validate mode and bounded integer size", async () => {
  const f = fixture(); const api = await load(f);
  assert.deepEqual(await api.handleBulkMessage(message("SETTINGS_GET"), sender()), {
    ok: true, settings: { mode: "batches", batchSize: 35, maxNewVideos: null },
  });
  const stored = await api.handleBulkMessage(message("SETTINGS_SET", { settings: { mode: "scan_all", batchSize: 50 } }), sender());
  assert.equal(stored.settings.mode, "scan_all");
  for (const batchSize of [0, -1, 501, 1.5, "35", NaN]) {
    assert.equal((await api.handleBulkMessage(message("SETTINGS_SET", { settings: { mode: "batches", batchSize } }), sender())).error.code, "INVALID_SETTINGS");
  }
  assert.equal((await api.handleBulkMessage(message("SETTINGS_SET", { settings: { mode: "unknown", batchSize: 35 } }), sender())).ok, false);
  assert.equal(f.state.local["reel-saver:bulk-prefs"].batchSize, 50);
});

function historyRecord(overrides = {}) {
  return { id: 500, byExtensionId: extensionId, filename: "C:\\Downloads\\Reel Saver\\creator_B.mp4",
    url: "https://scontent.cdninstagram.com/video/reel.mp4?fixture=history", state: "complete", exists: true,
    mime: "video/mp4", fileSize: 2048, startTime: "2026-01-01T00:00:00.000Z", ...overrides };
}
const existing = (api, job, entry = item, source = sender()) =>
  api.handleBulkMessage(message("CHECK_EXISTING", { jobId: job.jobId, item: entry }), source);

test("browser history recognizes earlier owned MP4s, Windows paths, and unique-copy suffixes without consuming allowance", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  for (const filename of ["C:\\Downloads\\Reel Saver\\creator_B.mp4", "C:/Downloads/Reel Saver/CREATOR_B (1).mp4"]) {
    f.state.downloads = [historyRecord({ filename })];
    const response = await existing(api, job);
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { cacheHit: true, filename: filename.split(/[\\/]/).pop(), bytesWritten: 2048,
      downloadId: 500, verification: "browser_history" });
  }
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal(f.state.sourceCalls.filter(request => request.action === "resolve").length, 0);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 0);
});

test("browser history rejects incomplete, missing, foreign, ambiguous, and invalid MP4 records", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job);
  for (const change of [
    { byExtensionId: "another-extension" }, { state: "interrupted" }, { exists: false },
    { fileSize: 0 }, { fileSize: -1 }, { fileSize: undefined }, { mime: "text/html" }, { mime: "" },
    { url: "https://cdninstagram.com.attacker.example/reel.mp4" },
    { finalUrl: "https://attacker.example/reel.mp4" },
    { filename: "C:/Downloads/creator_b.mp4" }, { filename: "C:/Downloads/other_B.mp4" },
    { filename: "C:/Downloads/creator_AB.mp4" }, { filename: "C:/Downloads/creator_B.mp4.html" },
  ]) {
    f.state.downloads = [historyRecord(change)];
    assert.equal((await existing(api, job)).result, null, JSON.stringify(change));
  }
  // Current legacy filename sanitization drops a trailing underscore. It must
  // not be guessed as the already-downloaded identity of this distinct Reel.
  const ambiguous = { mediaId: "127", shortcode: "B_" };
  f.state.session[memberKey(job.jobId, ambiguous.mediaId)] = ambiguous;
  f.state.downloads = [historyRecord()];
  assert.equal((await existing(api, job, ambiguous)).result, null);
});

test("browser history lookup is limited to discovered members and rejects navigation after its asynchronous query", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job);
  assert.equal((await existing(api, job, thirdItem)).error.code, "INVALID_ITEM");
  assert.equal((await existing(api, job, item, sender(8))).error.code, "STALE_JOB");
  const querying = deferred(); const finishQuery = deferred();
  f.state.search = async () => { querying.resolve(); await finishQuery.promise; return [historyRecord()]; };
  const pendingResult = existing(api, job);
  await querying.promise;
  f.state.tabs.get(7).url = "https://www.instagram.com/another_creator/reels/";
  finishQuery.resolve();
  assert.equal((await pendingResult).error.code, "PAGE_CHANGED");
});

test("history query failures and bounded-result overflow pause rather than silently downloading duplicates", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job);
  f.state.search = async () => { throw new Error("Chrome history unavailable"); };
  assert.equal((await existing(api, job)).error.code, "CACHE_HISTORY_UNAVAILABLE");
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job), sender())).error.code, "CACHE_HISTORY_UNAVAILABLE");
  f.state.search = async () => Array.from({ length: 201 }, (_, index) => historyRecord({ id: index }));
  assert.equal((await existing(api, job)).error.code, "CACHE_HISTORY_LIMIT");
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 0);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
});

test("DOWNLOAD rechecks prior browser history before resolving media or reserving a save", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  assert.equal((await existing(api, job)).result, null);
  f.state.downloads = [historyRecord()];
  const response = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  assert.equal(response.alreadySaved, true);
  assert.equal(response.result.cacheHit, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal(f.state.sourceCalls.filter(request => request.action === "resolve").length, 0);
});

test("skip-off runs deliberately create another browser copy while invalid skip preferences are rejected", async () => {
  const f = fixture(); const api = await load(f);
  for (const skipExisting of [null, "false", 1]) {
    assert.equal((await api.handleBulkMessage(message("START", { options: { ...options(), skipExisting } }), sender())).error.code, "INVALID_SETTINGS");
  }
  const started = await api.handleBulkMessage(message("START", { options: { ...options(), skipExisting: false } }), sender());
  const job = started.job;
  await discover(api, job);
  f.state.downloads = [historyRecord()];
  assert.equal((await existing(api, job)).result, null);
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job), sender())).ok, true);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
});

test("a lost completion response remains a new save in its own run across worker restart", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads[0].state = "complete"; f.state.downloads[0].fileSize = 2048;
  api = await load(f);
  assert.equal((await existing(api, job)).result, null, "own-operation receipt cannot become an older history hit");
  const response = await api.handleBulkMessage(operation("DOWNLOAD", job, "retry"), sender());
  assert.equal(response.download.state, "complete");
  assert.equal(response.alreadySaved, undefined);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
});

test("an own-run resolving reservation is not stranded by a matching older history record after restart", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  // Recreate the journal boundary of a worker terminated after reserving a
  // lookup, before Chrome accepted a file. An earlier copy appears meanwhile.
  f.state.session[activeKey].reservationMediaId = item.mediaId;
  f.state.session[operationKey(job.jobId)] = { jobId: job.jobId, ...item, attemptId: "old-attempt",
    state: "resolving", quotaState: "reserved", startedAt: Date.now(), destination: "downloads" };
  f.state.downloads = [historyRecord()];
  api = await load(f);
  const response = await api.handleBulkMessage(operation("DOWNLOAD", job, "retry"), sender());
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.alreadySaved, undefined);
  assert.equal(response.download.state, "in_progress");
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
  f.state.downloads.at(-1).state = "complete"; f.state.downloads.at(-1).fileSize = 2048;
  await api.handleBulkMessage(operation("STATUS", job, "retry"), sender());
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
});

test("a 25-save browser run followed by a limit of 10 skips the first 25 across worker restart", async () => {
  const f = fixture(); let api = await load(f);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const code = value => { let n = BigInt(value), result = ""; do { result = alphabet[Number(n % 64n)] + result; n /= 64n; } while (n); return result; };
  const entries = Array.from({ length: 36 }, (_, index) => ({ mediaId: String(100001 + index), shortcode: code(100001 + index) }));
  const job = await start(api, sender(), "downloads", 25);
  const register = async current => {
    f.state.source = () => ({ ok: true, profile, page: { items: entries, nextCursor: null, hasMore: false } });
    assert.equal((await discover(api, current)).ok, true);
    delete f.state.source;
  };
  await register(job);
  for (const entry of entries.slice(0, 25)) {
    const response = await api.handleBulkMessage(operation("DOWNLOAD", job, `first-${entry.mediaId}`, { item: entry }), sender());
    assert.equal(response.ok, true, JSON.stringify(response));
    const download = f.state.downloads.at(-1); download.state = "complete"; download.fileSize = 2048;
    assert.equal((await api.handleBulkMessage(operation("STATUS", job, `first-${entry.mediaId}`, { item: entry }), sender())).ok, true);
  }
  assert.equal(f.state.session[activeKey].committedNewSaves, 25);
  assert.equal((await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "completed" }), sender())).ok, true);
  api = await load(f);
  const nextJob = await start(api, sender(), "downloads", 10);
  await register(nextJob);
  let hits = 0;
  for (const entry of entries.slice(0, 35)) {
    const cached = await existing(api, nextJob, entry);
    if (cached.result) { hits++; continue; }
    const attemptId = `next-${entry.mediaId}`;
    const response = await api.handleBulkMessage(operation("DOWNLOAD", nextJob, attemptId, { item: entry }), sender());
    assert.equal(response.ok, true, JSON.stringify(response));
    const download = f.state.downloads.at(-1); download.state = "complete"; download.fileSize = 2048;
    await api.handleBulkMessage(operation("STATUS", nextJob, attemptId, { item: entry }), sender());
  }
  assert.equal(hits, 25);
  assert.equal(f.state.downloads.length, 35);
  assert.equal(new Set(f.state.downloads.map(download => download.filename)).size, 35);
  assert.equal(f.state.session[activeKey].committedNewSaves, 10);
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", nextJob, "over-limit", { item: entries[35] }), sender())).error.code, "PROFILE_LIMIT_REACHED");
});

test("profile identification is read-only and does not acquire or replace a batch owner", async () => {
  const f = fixture(); const api = await load(f);
  assert.equal(api.isBulkMessage(message("IDENTIFY")), true);
  assert.deepEqual(await api.handleBulkMessage(message("IDENTIFY"), sender()), { ok: true, profile });
  assert.deepEqual(f.state.sourceCalls, [{ action: "identify" }]);
  assert.deepEqual(f.state.session, {});
  assert.deepEqual(f.state.local, {});
  assert.deepEqual(f.state.calls, []);
  const job = await start(api);
  const prior = structuredClone(f.state.session);
  assert.deepEqual(await api.handleBulkMessage(message("IDENTIFY"), sender(8)), { ok: true, profile });
  assert.deepEqual(f.state.session, prior);
  assert.equal(f.state.session[activeKey].jobId, job.jobId);
  assert.equal(f.state.tabs.get(8).autoDiscardable, true);
});

test("profile identification keeps sender, source route and returned identity fences", async () => {
  const f = fixture(); const api = await load(f);
  for (const invalid of [
    { ...sender(), id: "other-extension" }, { ...sender(), frameId: 1 },
    { ...sender(), url: "https://instagram.com.evil.test/creator/" },
    { ...sender(), url: "http://www.instagram.com/creator/" },
  ]) assert.equal((await api.handleBulkMessage(message("IDENTIFY"), invalid)).error.code, "INVALID_SENDER");
  assert.equal((await api.handleBulkMessage(message("IDENTIFY", { tabId: 8 }), sender())).error.code, "INVALID_SENDER");
  assert.equal(f.state.sourceCalls.length, 0);
  f.state.tabs.get(7).url = "https://www.instagram.com/reel/B/";
  assert.equal((await api.handleBulkMessage(message("IDENTIFY"), sender())).error.code, "PAGE_CHANGED");
  assert.equal(f.state.sourceCalls.length, 0);
  f.state.tabs.get(7).url = profileUrl;
  f.state.source = () => ({ ok: true, profile: { id: "not-numeric", username: "creator" } });
  assert.equal((await api.handleBulkMessage(message("IDENTIFY"), sender())).error.code, "SCHEMA_CHANGED");
  f.state.source = () => ({ ok: true, profile: { id: "123", username: "another_creator" } });
  assert.equal((await api.handleBulkMessage(message("IDENTIFY"), sender())).error.code, "PAGE_CHANGED");
  f.state.source = () => {
    f.state.tabs.get(7).url = "https://www.instagram.com/another_creator/reels/";
    return { ok: true, profile };
  };
  assert.equal((await api.handleBulkMessage(message("IDENTIFY"), sender())).error.code, "PAGE_CHANGED");
  assert.deepEqual(f.state.session, {});
  assert.deepEqual(f.state.local, {});
  assert.deepEqual(f.state.calls, []);
});

test("one bulk owner is registered and automatic tab discard is restored on end", async () => {
  const f = fixture(); const api = await load(f);
  const first = await start(api);
  assert.deepEqual(first.profile, profile);
  assert.equal(f.state.tabs.get(7).autoDiscardable, false);
  const duplicate = await api.handleBulkMessage(message("START", { options: options() }), sender(8));
  assert.equal(duplicate.error.code, "BULK_BUSY");
  assert.equal(f.state.session[activeKey].jobId, first.jobId);
  assert.equal((await api.handleBulkMessage(message("END", { jobId: first.jobId, state: "stopped" }), sender())).ok, true);
  assert.equal(f.state.tabs.get(7).autoDiscardable, true);
});

test("simultaneous Start requests cannot create two active owners", async () => {
  const f = fixture(); const api = await load(f);
  const results = await Promise.all([7, 8].map(id => api.handleBulkMessage(message("START", { options: options() }), sender(id))));
  assert.equal(results.filter(value => value.ok).length, 1);
  assert.equal(results.filter(value => value.error?.code === "BULK_BUSY").length, 1);
});

test("foreign, framed, insecure, cross-tab and stale-document requests are rejected", async () => {
  const f = fixture(); const api = await load(f);
  for (const invalid of [
    { ...sender(), id: "other-extension" }, { ...sender(), frameId: 1 },
    { ...sender(), url: "https://instagram.com.evil.test/creator/" },
    { ...sender(), url: "http://www.instagram.com/creator/" },
  ]) assert.equal((await api.handleBulkMessage(message("SETTINGS_GET"), invalid)).error.code, "INVALID_SENDER");
  const job = await start(api);
  assert.equal((await api.handleBulkMessage(message("PAGE", { jobId: job.jobId, tabId: 8 }), sender())).error.code, "INVALID_SENDER");
  assert.equal((await discover(api, job, sender(8))).error.code, "STALE_JOB");
  assert.equal((await discover(api, job, sender(7, "different-document"))).error.code, "STALE_JOB");
});

test("profile identification cannot register another profile's response", async () => {
  const f = fixture(); const api = await load(f);
  f.state.source = async () => ({ ok: true, profile: { id: "99", username: "someone_else" } });
  const result = await api.handleBulkMessage(message("START", { options: options() }), sender());
  assert.equal(result.error.code, "PAGE_CHANGED");
  assert.equal(f.state.session[activeKey], undefined);
});

test("page registrations preserve all members, replay the same cursor without requests, and reject out-of-sequence paging", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  f.state.source = async request => ({ ok: true, profile,
    page: request.cursor ? { items: [thirdItem], nextCursor: null, hasMore: false }
      : { items: [item, secondItem], nextCursor: "NEXT", hasMore: true } });
  const first = await discover(api, job);
  assert.equal(first.page.items.length, 2);
  const beforeReplay = f.state.sourceCalls.length;
  assert.deepEqual(await discover(api, job), first);
  assert.equal(f.state.sourceCalls.length, beforeReplay);
  assert.equal((await discover(api, job, sender(), "WRONG")).error.code, "PAGINATION_STALLED");
  const last = await discover(api, job, sender(), "NEXT");
  assert.equal(last.page.hasMore, false);
  for (const id of ["1", "2", "3"]) assert.ok(f.state.session[memberKey(job.jobId, id)]);
  assert.equal(f.state.session[activeKey].exhausted, true);
});

test("repeated or malformed source cursors never mark discovery complete", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  f.state.source = async () => ({ ok: true, profile, page: { items: [item], hasMore: true, nextCursor: "NEXT" } });
  assert.equal((await discover(api, job)).ok, true);
  const repeated = await discover(api, job, sender(), "NEXT");
  assert.equal(repeated.error.code, "PAGINATION_STALLED");
  assert.equal(f.state.session[activeKey].exhausted, false);
  assert.equal(f.state.session[activeKey].cursor, "NEXT");
});

test("discovery diagnostics survive the worker boundary without raw request data", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  f.state.source = async () => ({ ok: false, error: {
    code: "QUERY_FAILED", stage: "discovery", message: "Instagram rejected the profile query.", retryable: false,
    diagnostic: {
      queryName: "PolarisProfileReelsTabContentQuery_connection", adapterVersion: "profile-relay-v2",
      httpStatus: 400, serverCode: "1675030", variableNames: ["data", "scale", "scale"],
      executionMethod: "environment.execute", connectionPath: ["node", "xdt_api__v1__clips__user__connection_v2"],
      unsetVariableNames: ["after", "after", "not a name"],
      selectionKinds: ["LinkedField", "FragmentSpread", "FragmentSpread", "https://secret/kind"],
      fieldNames: ["node", "xdt_api__v1__clips__user__connection_v2", { name: "secretFieldValue" }],
      fragmentNames: ["ProfileReelsQuery", "bad fragment"], connectionMatchCount: 0,
      serverMessage: "Required scale missing; x-csrftoken=secretCsrf; lsd=secretLsd; fb_dtsg=secretDtsg; token=secretToken; url=https://cdninstagram.com/a.mp4?sig=secretSig\nCookie: csrftoken=first; sessionid=secretSession; unknown=secretUnknown\nSet-Cookie: sessionid=secretOtherSession; Path=/\nrefresh_token=secretRefresh; id_token=secretId; session_key=secretKey",
      variables: { password: "secretPassword" }, headers: { Cookie: "secretCookie" }, stack: "secretStack",
    },
  } });
  const failed = await discover(api, job);
  assert.equal(failed.error.code, "QUERY_FAILED");
  assert.equal(failed.error.retryable, false);
  const diagnostic = failed.error.diagnostic;
  assert.equal(diagnostic.queryName, "PolarisProfileReelsTabContentQuery_connection");
  assert.equal(diagnostic.adapterVersion, "profile-relay-v2");
  assert.equal(diagnostic.httpStatus, 400);
  assert.equal(diagnostic.serverCode, "1675030");
  assert.deepEqual(diagnostic.variableNames, ["data", "scale"]);
  assert.equal(diagnostic.executionMethod, "environment.execute");
  assert.deepEqual(diagnostic.connectionPath, ["node", "xdt_api__v1__clips__user__connection_v2"]);
  assert.deepEqual(diagnostic.unsetVariableNames, ["after"]);
  assert.deepEqual(diagnostic.selectionKinds, ["LinkedField", "FragmentSpread"]);
  assert.deepEqual(diagnostic.fieldNames, ["node", "xdt_api__v1__clips__user__connection_v2"]);
  assert.deepEqual(diagnostic.fragmentNames, ["ProfileReelsQuery"]);
  assert.equal(diagnostic.connectionMatchCount, 0);
  assert.match(diagnostic.serverMessage, /Required scale missing/);
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(JSON.stringify(failed).includes("https://"), false);
  assert.equal(Object.hasOwn(diagnostic, "variables"), false);
  assert.equal(f.state.session[activeKey].exhausted, false);
});

test("resolve accepts only discovered IDs and leaves signed video URLs out of the operation registry", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder");
  const unknown = await api.handleBulkMessage(operation("RESOLVE", job), sender());
  assert.equal(unknown.error.code, "INVALID_ITEM");
  await discover(api, job);
  const resolved = await api.handleBulkMessage(operation("RESOLVE", job), sender());
  assert.equal(resolved.ok, true);
  assert.match(resolved.media.url, /^https:\/\/scontent/);
  assert.equal(resolved.filename, "creator_B.mp4");
  assert.equal(JSON.stringify(f.state.session).includes("cdninstagram"), false);
  const mismatch = await api.handleBulkMessage(operation("RESOLVE", job, "attempt-two", { item: { ...item, shortcode: "WRONG" } }), sender());
  assert.equal(mismatch.error.code, "INVALID_ITEM");
});

test("native resolve rejects untrusted video data and a changed source profile", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder");
  await discover(api, job);
  f.state.videoUrl = "https://cdninstagram.com.attacker.test/video.mp4";
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job), sender())).ok, false);
  f.state.tabs.get(7).url = "https://www.instagram.com/other_creator/reels/";
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "attempt-two"), sender())).error.code, "PAGE_CHANGED");
});

test("browser Download deduplicates attempts and captures job destination rather than global preference", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job);
  f.state.local["reel-saver:settings"] = { destination: "ask" };
  const first = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  const duplicate = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  assert.equal(first.ok, true); assert.equal(duplicate.ok, true);
  assert.equal(first.download.id, duplicate.download.id);
  assert.equal(f.state.downloads.length, 1);
  assert.equal(f.state.calls.find(value => value.type === "download").options.saveAs, false);
  const folderJob = await api.handleBulkMessage(operation("RESOLVE", job, "attempt-two", { item: secondItem }), sender());
  assert.equal(folderJob.error.code, "INVALID_DESTINATION");
});

test("browser status reconciles real completion after worker restart", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api);
  await discover(api, job);
  const started = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads[0].state = "complete"; f.state.downloads[0].fileSize = 1024;
  api = await load(f);
  const result = await api.handleBulkMessage(operation("STATUS", job), sender());
  assert.equal(result.ok, true);
  assert.equal(result.download.id, started.download.id);
  assert.equal(result.download.state, "complete");
  assert.equal(f.state.session[operationKey(job.jobId)].state, "saved");
  assert.equal(f.state.downloads.length, 1);
});

test("a lost acceptance journal write is reconciled before any second browser download", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api);
  await discover(api, job); f.state.failAcceptanceRecord = true;
  const first = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  assert.equal(first.error.code, "RECONCILE_REQUIRED");
  assert.equal(f.state.downloads.length, 1);
  api = await load(f);
  const attached = await api.handleBulkMessage(operation("DOWNLOAD", job, "attempt-two"), sender());
  assert.equal(attached.ok, true);
  assert.equal(attached.download.id, 1);
  assert.equal(f.state.downloads.length, 1);
  const status = await api.handleBulkMessage(operation("STATUS", job, "attempt-two"), sender());
  assert.equal(status.ok, true);
});

test("an ambiguous accepted download outcome never blindly starts another file", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api);
  await discover(api, job); f.state.failAcceptanceRecord = true;
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads.push({ ...f.state.downloads[0], id: 99 });
  api = await load(f);
  const result = await api.handleBulkMessage(operation("DOWNLOAD", job, "attempt-two"), sender());
  assert.equal(result.error.code, "RECONCILE_REQUIRED");
  assert.equal(f.state.calls.filter(value => value.type === "download").length, 1);
});

test("stale status or cancellation cannot mutate a newer download attempt", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads[0].state = "interrupted"; f.state.downloads[0].error = "NETWORK_FAILED";
  const retried = await api.handleBulkMessage(operation("DOWNLOAD", job, "attempt-two"), sender());
  assert.equal(retried.ok, true); assert.equal(retried.download.id, 2);
  const staleStatus = await api.handleBulkMessage(operation("STATUS", job, "attempt-one"), sender());
  assert.equal(staleStatus.error.code, "STALE_OPERATION");
  const staleCancel = await api.handleBulkMessage(operation("CANCEL_ITEM", job, "attempt-one"), sender());
  assert.equal(staleCancel.error.code, "STALE_OPERATION");
  assert.equal(f.state.downloads[1].state, "in_progress");
  assert.equal(f.state.session[operationKey(job.jobId)].attemptId, "attempt-two");
});

test("cancelling during native resolution rejects the pending result before any write preparation", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder");
  await discover(api, job); f.state.resolveGate = deferred();
  const pending = api.handleBulkMessage(operation("RESOLVE", job), sender());
  await waitUntil(() => f.state.sourceCalls.some(value => value.action === "resolve"));
  const cancel = api.handleBulkMessage(operation("CANCEL_ITEM", job), sender());
  await new Promise(resolve => setTimeout(resolve, 0));
  f.state.resolveGate.resolve();
  assert.equal((await pending).error.code, "SAVE_CANCELLED");
  assert.equal((await cancel).ok, true);
  assert.equal(f.state.downloads.length, 0);
  assert.equal(f.state.session[operationKey(job.jobId)].state, "canceled");
});

test("cancelling while Chrome accepts a file cancels that accepted download", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job); f.state.downloadGate = deferred();
  const pending = api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  await waitUntil(() => f.state.downloads.length === 1);
  const cancel = api.handleBulkMessage(operation("CANCEL_ITEM", job), sender());
  await new Promise(resolve => setTimeout(resolve, 0));
  f.state.downloadGate.resolve();
  assert.equal((await pending).error.code, "SAVE_CANCELLED");
  assert.equal((await cancel).ok, true);
  assert.equal(f.state.downloads[0].state, "interrupted");
});

test("native file results fence attempts and preserve real output bytes and basename", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder");
  await discover(api, job);
  await api.handleBulkMessage(operation("RESOLVE", job, "attempt-two"), sender());
  const stale = await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "saved" } }), sender());
  assert.equal(stale.error.code, "STALE_OPERATION");
  const result = await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-two", {
    result: { state: "saved", filename: "C:\\private\\folder\\creator_B (1).mp4", bytesWritten: 2048 },
  }), sender());
  assert.equal(result.ok, true);
  assert.equal(f.state.session[operationKey(job.jobId)].filename, "creator_B (1).mp4");
  assert.equal(f.state.session[operationKey(job.jobId)].bytesWritten, 2048);
});

test("ended jobs can reopen in the same document, but old owners cannot replace a newer job", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "completed" }), sender());
  assert.equal(f.state.session[activeKey].active, false);
  assert.equal((await api.handleBulkMessage(message("REOPEN", { jobId: job.jobId }), sender())).ok, true);
  assert.equal(f.state.tabs.get(7).autoDiscardable, false);
  await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender());
  const newer = await start(api, sender(8));
  const stale = await api.handleBulkMessage(message("REOPEN", { jobId: job.jobId }), sender());
  assert.equal(stale.error.code, "STALE_JOB");
  assert.equal(f.state.session[activeKey].jobId, newer.jobId);
});

test("a refreshed document can replace its old in-tab job and closed tabs release ownership", async () => {
  const f = fixture(); const api = await load(f); const old = await start(api);
  const refreshed = await start(api, sender(7, "document-two"));
  assert.notEqual(refreshed.jobId, old.jobId);
  assert.equal((await discover(api, refreshed, sender())).error.code, "STALE_JOB");
  await api.cleanupBulkTab(7);
  assert.equal(f.state.session[activeKey].state, "interrupted");
  assert.equal(f.state.session[activeKey].active, false);
  assert.equal(f.state.tabs.get(7).autoDiscardable, true);
});

test("failed registration storage restores the tab without leaving an active job", async () => {
  const f = fixture(); const api = await load(f); f.state.failSessionWrite = true;
  const result = await api.handleBulkMessage(message("START", { options: options() }), sender());
  assert.equal(result.error.code, "STORAGE_FAILED");
  assert.equal(f.state.session[activeKey], undefined);
  assert.equal(f.state.tabs.get(7).autoDiscardable, true);
});

test("Stop waits for pending Chrome acceptance and cancels it before a new owner can delete the old journal", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job); f.state.downloadGate = deferred();
  const transfer = api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  await waitUntil(() => f.state.downloads.length === 1);
  const stop = api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender());
  await waitUntil(() => f.state.session[activeKey].state === "stopped");
  let nextSettled = false;
  const next = api.handleBulkMessage(message("START", { options: options() }), sender(8))
    .then(result => { nextSettled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(nextSettled, false, "registration stays locked until cancellation is settled");
  assert.ok(f.state.session[operationKey(job.jobId)], "old operation still exists while acceptance is pending");
  f.state.downloadGate.resolve();
  assert.equal((await stop).ok, true);
  assert.equal((await transfer).error.code, "SAVE_CANCELLED");
  const replacement = await next;
  assert.equal(replacement.ok, true);
  assert.notEqual(replacement.job.jobId, job.jobId);
  assert.equal(f.state.downloads[0].state, "interrupted");
  assert.equal(f.state.session[activeKey].jobId, replacement.job.jobId);
});

test("a saved native receipt returns alreadySaved without another media lookup or write preparation", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder");
  await discover(api, job);
  await api.handleBulkMessage(operation("RESOLVE", job), sender());
  assert.equal((await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", {
    result: { state: "saved", filename: "creator_B (1).mp4", bytesWritten: 4096 },
  }), sender())).ok, true);
  const lookupsBefore = f.state.sourceCalls.filter(value => value.action === "resolve").length;
  const repeated = await api.handleBulkMessage(operation("RESOLVE", job, "attempt-two"), sender());
  assert.equal(repeated.ok, true);
  assert.equal(repeated.alreadySaved, true);
  assert.deepEqual(repeated.result, { filename: "creator_B (1).mp4", bytesWritten: 4096 });
  assert.equal(repeated.media, undefined, "no signed URL is returned for an already-written file");
  assert.equal(f.state.sourceCalls.filter(value => value.action === "resolve").length, lookupsBefore);
});

test("an unavailable queued Reel receives a skipped operation result rather than remaining resolving", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder");
  await discover(api, job);
  f.state.source = async () => ({ ok: false, error: {
    code: "MEDIA_UNAVAILABLE", message: "This Reel is no longer available.", stage: "resolve", retryable: false,
  } });
  const result = await api.handleBulkMessage(operation("RESOLVE", job), sender());
  assert.equal(result.error.code, "MEDIA_UNAVAILABLE");
  const recorded = f.state.session[operationKey(job.jobId)];
  assert.equal(recorded.state, "skipped");
  assert.equal(recorded.error.code, "MEDIA_UNAVAILABLE");
  assert.equal(recorded.mediaId, item.mediaId);
  assert.equal(f.state.downloads.length, 0);
});

test("terminal pagination still rejects contradictory cursors, mismatched profile IDs and navigation before commit", async () => {
  for (const scenario of ["contradictory-end", "wrong-profile", "navigation"]) {
    const f = fixture(); const api = await load(f); const job = await start(api);
    f.state.source = async () => {
      if (scenario === "navigation") f.state.tabs.get(7).url = "https://www.instagram.com/other_profile/reels/";
      return { ok: true, profile: scenario === "wrong-profile" ? { ...profile, id: "999" } : profile,
        page: { items: [item], hasMore: false, nextCursor: scenario === "contradictory-end" ? "NOT_AN_END" : null } };
    };
    const result = await discover(api, job);
    assert.equal(result.ok, false, scenario);
    assert.ok(["SCHEMA_CHANGED", "PAGE_CHANGED"].includes(result.error.code), scenario);
    assert.equal(f.state.session[activeKey].exhausted, false, scenario);
    assert.equal(f.state.session[activeKey].cursor, null, scenario);
    assert.equal(f.state.session[memberKey(job.jobId)], undefined, scenario);
  }
});

test("accepted downloads missing from Chrome history require reconciliation and never start a duplicate", async () => {
  for (const previousState of ["in_progress", "saved"]) {
    const f = fixture(); const api = await load(f); const job = await start(api);
    await discover(api, job);
    assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job), sender())).ok, true);
    if (previousState === "saved") {
      f.state.downloads[0].state = "complete";
      assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).ok, true);
    }
    f.state.downloads = [];
    const status = await api.handleBulkMessage(operation("STATUS", job), sender());
    assert.equal(status.error.code, "RECONCILE_REQUIRED", previousState);
    const retry = await api.handleBulkMessage(operation("DOWNLOAD", job, "attempt-two"), sender());
    assert.equal(retry.error.code, "RECONCILE_REQUIRED", previousState);
    assert.equal(f.state.calls.filter(value => value.type === "download").length, 1, previousState);
  }
});

test("a known interrupted download can be retried even after its history entry is removed", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads[0].state = "interrupted";
  f.state.downloads[0].error = "NETWORK_FAILED";
  const failed = await api.handleBulkMessage(operation("STATUS", job), sender());
  assert.equal(failed.download.state, "interrupted");
  assert.equal(f.state.session[operationKey(job.jobId)].state, "failed");
  f.state.downloads = [];
  const retry = await api.handleBulkMessage(operation("DOWNLOAD", job, "attempt-two"), sender());
  assert.equal(retry.ok, true);
  assert.equal(f.state.calls.filter(value => value.type === "download").length, 2);
});

test("cleanup queued behind a refreshed Start cannot interrupt the newly registered document", async () => {
  const f = fixture(); const api = await load(f); const old = await start(api);
  const identifying = deferred();
  const continueStart = deferred();
  f.state.source = async request => {
    assert.equal(request.action, "identify");
    identifying.resolve();
    await continueStart.promise;
    return { ok: true, profile };
  };
  const replacement = api.handleBulkMessage(message("START", { options: options() }), sender(7, "document-two"));
  await identifying.promise;
  let cleanupSettled = false;
  const cleanup = api.cleanupBulkTab(7).then(() => { cleanupSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cleanupSettled, false, "cleanup must wait for the same registration lock");
  continueStart.resolve();
  const started = await replacement;
  assert.equal(started.ok, true);
  assert.notEqual(started.job.jobId, old.jobId);
  await cleanup;
  assert.equal(f.state.session[activeKey].jobId, started.job.jobId);
  assert.equal(f.state.session[activeKey].documentId, "document-two");
  assert.equal(f.state.session[activeKey].active, true);
  assert.equal(f.state.tabs.get(7).autoDiscardable, false);
});

test("save limits validate settings and starts, persist defaults, and freeze the active run", async () => {
  const f = fixture(); const api = await load(f);
  for (const maxNewVideos of [null, 1, 50000]) {
    const response = await api.handleBulkMessage(message("SETTINGS_SET", { settings: { ...options(), maxNewVideos } }), sender());
    assert.equal(response.ok, true);
    assert.equal(response.settings.maxNewVideos, maxNewVideos);
    assert.equal((await api.handleBulkMessage(message("SETTINGS_GET"), sender())).settings.maxNewVideos, maxNewVideos);
  }
  for (const maxNewVideos of [0, -1, 50001, 1.5, "1", "", NaN, Infinity]) {
    for (const action of ["SETTINGS_SET", "START"]) {
      const result = await api.handleBulkMessage(message(action, {
        [action === "START" ? "options" : "settings"]: { ...options(), maxNewVideos },
      }), sender());
      assert.equal(result.error.code, "INVALID_LIMIT");
    }
  }
  const job = await start(api, sender(), "folder", 1);
  assert.equal(job.options.maxNewVideos, 1);
  await api.handleBulkMessage(message("SETTINGS_SET", { settings: { ...options(), maxNewVideos: 100 } }), sender());
  assert.equal(f.state.session[activeKey].options.maxNewVideos, 1, "preferences never change a running allowance");
});

test("legacy or corrupt saved limit preferences read as unlimited", async () => {
  const f = fixture(); const api = await load(f);
  for (const pref of [{ mode: "batches", batchSize: 35 }, { maxNewVideos: "20" }, { maxNewVideos: 50001 }]) {
    f.state.local["reel-saver:bulk-prefs"] = pref;
    assert.equal((await api.handleBulkMessage(message("SETTINGS_GET"), sender())).settings.maxNewVideos, null);
  }
  const job = await start(api);
  assert.equal(job.options.maxNewVideos, null);
});

test("native saves reserve the allowance, count once across restart, and block lookups after the cap", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job), sender())).ok, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(f.state.session[activeKey].reservationMediaId, "1");
  const before = f.state.sourceCalls.length;
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "two", { item: secondItem }), sender())).error.code, "RECONCILIATION_REQUIRED");
  assert.equal(f.state.sourceCalls.length, before);
  const receipt = operation("ITEM_RESULT", job, "attempt-one", { result: { state: "saved", filename: "creator_B.mp4", bytesWritten: 2048 } });
  assert.equal((await api.handleBulkMessage(receipt, sender())).ok, true);
  api = await load(f);
  assert.equal((await api.handleBulkMessage(receipt, sender())).ok, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "two", { item: secondItem }), sender())).error.code, "PROFILE_LIMIT_REACHED");
  assert.equal(f.state.sourceCalls.length, before);
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "repeat"), sender())).alreadySaved, true);
  await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "completed" }), sender());
  assert.equal((await api.handleBulkMessage(message("REOPEN", { jobId: job.jobId }), sender())).error.code, "PROFILE_LIMIT_REACHED");
  const next = await start(api, sender(), "folder", 1);
  assert.notEqual(next.jobId, job.jobId);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0, "a deliberate new run has a new allowance");
});

test("reaching the save cap never dispatches another discovery request", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  f.state.source = () => ({ ok: true, profile, page: { items: [item, secondItem], nextCursor: "NEXT", hasMore: true } });
  await discover(api, job);
  delete f.state.source;
  await api.handleBulkMessage(operation("RESOLVE", job), sender());
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "saved", filename: "creator_B.mp4", bytesWritten: 2048 } }), sender());
  const before = f.state.sourceCalls.length;
  assert.equal((await discover(api, job, sender(), "NEXT")).error.code, "PROFILE_LIMIT_REACHED");
  assert.equal(f.state.sourceCalls.length, before);
  assert.equal(f.state.session[activeKey].exhausted, false);
});

test("failed and unavailable native items release their reservation without consuming the cap", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  f.state.source = () => ({ ok: false, error: { code: "MEDIA_UNAVAILABLE", message: "Unavailable" } });
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job), sender())).error.code, "MEDIA_UNAVAILABLE");
  delete f.state.source;
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  await api.handleBulkMessage(operation("RESOLVE", job, "two", { item: secondItem }), sender());
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "two", { item: secondItem, result: { state: "failed", error: { message: "Network failed" } } }), sender());
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "retry", { item: secondItem }), sender())).ok, true);
});

test("an unrecorded native receipt holds the last slot until its acknowledgement is replayed", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("RESOLVE", job), sender());
  const receipt = operation("ITEM_RESULT", job, "attempt-one", { result: { state: "saved", filename: "creator_B.mp4", bytesWritten: 2048 } });
  f.state.failSessionWrite = true;
  assert.equal((await api.handleBulkMessage(receipt, sender())).error.code, "STORAGE_FAILED");
  api = await load(f);
  const before = f.state.sourceCalls.length;
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "two", { item: secondItem }), sender())).error.code, "RECONCILIATION_REQUIRED");
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job), sender())).error.code, "RECONCILIATION_REQUIRED");
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "retry"), sender())).error.code, "RECONCILIATION_REQUIRED");
  assert.equal(f.state.sourceCalls.length, before);
  assert.equal((await api.handleBulkMessage(receipt, sender())).ok, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
});

test("uncertain native cleanup blocks release, another item, and another attempt until confirmed", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("RESOLVE", job), sender());
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "failed", error: { message: "Removal failed", cleanupFailed: true } } }), sender());
  assert.equal(f.state.session[operationKey(job.jobId)].state, "unknown");
  assert.equal(f.state.session[activeKey].reservationMediaId, "1");
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "retry"), sender())).error.code, "RECONCILIATION_REQUIRED");
  assert.equal((await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender())).error.code, "RECONCILIATION_REQUIRED");
  assert.equal(f.state.session[activeKey].active, true);
  assert.equal((await api.handleBulkMessage(message("START", { options: options() }), sender(8))).error.code, "RECONCILIATION_REQUIRED");
  assert.ok(f.state.session[operationKey(job.jobId)]);
  // The original writer can confirm cleanup without starting another transfer.
  assert.equal((await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "canceled" } }), sender())).ok, true);
  assert.equal((await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender())).ok, true);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
});

test("native unresolved reservations survive tab cleanup and cannot be erased by another document", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("RESOLVE", job), sender());
  await api.cleanupBulkTab(7);
  const before = structuredClone(f.state.session);
  const blocked = await api.handleBulkMessage(message("START", { options: options() }), sender(7, "document-two"));
  assert.equal(blocked.error.code, "RECONCILIATION_REQUIRED");
  assert.match(blocked.error.message, /chrome:\/\/extensions/);
  assert.match(blocked.error.message, /refresh Instagram/);
  assert.deepEqual(f.state.session, before);
});

test("browser saves commit once on completion and block the next download after worker restart", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  f.state.downloads[0].state = "complete"; f.state.downloads[0].fileSize = 2048;
  api = await load(f);
  assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).download.state, "complete");
  assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).ok, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  const before = f.state.sourceCalls.length;
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job, "two", { item: secondItem }), sender())).error.code, "PROFILE_LIMIT_REACHED");
  assert.equal(f.state.downloads.length, 1);
  assert.equal(f.state.sourceCalls.length, before);
});

test("a rejected browser download releases its slot and a later successful retry consumes one", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job); f.state.downloadError = true;
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job), sender())).error.code, "DOWNLOAD_FAILED");
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  delete f.state.downloadError;
  await api.handleBulkMessage(operation("DOWNLOAD", job, "retry"), sender());
  f.state.downloads[0].state = "complete";
  await api.handleBulkMessage(operation("STATUS", job, "retry"), sender());
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.downloads.length, 1);
});

test("uncertain Chrome acceptance reserves allowance across restart until reconciliation", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job); f.state.failAcceptanceRecord = true;
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job), sender())).error.code, "RECONCILE_REQUIRED");
  api = await load(f);
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job, "two", { item: secondItem }), sender())).error.code, "RECONCILIATION_REQUIRED");
  assert.equal(f.state.calls.filter(value => value.type === "download").length, 1);
  f.state.downloads[0].state = "complete";
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job, "retry"), sender())).download.state, "complete");
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
});

test("concurrent native requests cannot reserve the last slot twice", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  const results = await Promise.all([item, secondItem].map((entry, index) => api.handleBulkMessage(operation("RESOLVE", job, `attempt-${index}`, { item: entry }), sender())));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.error?.code === "RECONCILIATION_REQUIRED").length, 1);
  assert.equal(f.state.sourceCalls.filter(request => request.action === "resolve").length, 1);
});

test("Stop counts a browser save that completed before cancellation and returns a physical receipt", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads[0].state = "complete"; f.state.downloads[0].fileSize = 2048;
  api = await load(f);
  const stopped = await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender());
  assert.equal(stopped.ok, true);
  assert.equal(stopped.committedNewSaves, 1);
  assert.deepEqual(stopped.savedResults, [{ mediaId: "1", filename: "creator_B.mp4", downloadId: 1, bytesWritten: 2048 }]);
  assert.equal(f.state.session[activeKey].active, false);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  const again = await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender());
  assert.equal(again.committedNewSaves, 1);
});

test("cancellation that leaves Chrome running keeps ownership and the allowance reserved", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.chrome.downloads.cancel = async () => { throw new Error("Chrome unavailable"); };
  assert.equal((await api.handleBulkMessage(operation("CANCEL_ITEM", job), sender())).error.code, "RECONCILE_REQUIRED");
  assert.equal((await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender())).error.code, "RECONCILE_REQUIRED");
  assert.equal(f.state.session[activeKey].active, true);
  assert.equal(f.state.session[activeKey].reservationMediaId, "1");
  assert.equal((await api.handleBulkMessage(message("START", { options: options() }), sender(8))).error.code, "RECONCILIATION_REQUIRED");
  f.state.downloads[0].state = "complete";
  assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).download.state, "complete");
  assert.equal((await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "stopped" }), sender())).ok, true);
});

test("a completed native receipt is immutable against duplicate or late failure acknowledgements", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("RESOLVE", job), sender());
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "saved", filename: "creator_B.mp4", bytesWritten: 2048 } }), sender());
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "failed" } }), sender());
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "saved", filename: "different.mp4", bytesWritten: 4096 } }), sender());
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.session[operationKey(job.jobId)].state, "saved");
  assert.equal(f.state.session[operationKey(job.jobId)].filename, "creator_B.mp4");
  assert.equal(f.state.session[operationKey(job.jobId)].bytesWritten, 2048);
});

test("a negative host receipt fences a late resolve response before another native write can be prepared", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job); f.state.resolveGate = deferred();
  const resolving = api.handleBulkMessage(operation("RESOLVE", job), sender());
  await waitUntil(() => f.state.sourceCalls.some(request => request.action === "resolve"));
  const negative = await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", {
    result: { state: "canceled", error: { message: "Host never started a file write" } },
  }), sender());
  assert.equal(negative.ok, true);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  f.state.resolveGate.resolve();
  assert.equal((await resolving).error.code, "SAVE_CANCELLED");
  assert.equal(f.state.session[operationKey(job.jobId)].state, "canceled");
  assert.equal(f.state.session[operationKey(job.jobId)].quotaState, "released");
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "retry"), sender())).ok, true);
});

test("a released attempt cannot commit a late saved receipt or erase another video's reservation", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 2);
  await discover(api, job);
  await api.handleBulkMessage(operation("RESOLVE", job), sender());
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "failed" } }), sender());
  await api.handleBulkMessage(operation("RESOLVE", job, "two", { item: secondItem }), sender());
  const invalidLateSave = await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", {
    result: { state: "saved", filename: "unexpected.mp4", bytesWritten: 2048 },
  }), sender());
  assert.equal(invalidLateSave.error.code, "STALE_OPERATION");
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", { result: { state: "canceled" } }), sender());
  assert.equal(f.state.session[activeKey].reservationMediaId, "2");
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(f.state.session[operationKey(job.jobId)].state, "failed");
  await api.handleBulkMessage(operation("ITEM_RESULT", job, "two", { item: secondItem,
    result: { state: "saved", filename: "creator_C.mp4", bytesWritten: 2048 } }), sender());
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
});

test("a reservation claimed during refreshed-document identification prevents replacing the old journal", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
  await discover(api, job);
  const identifying = deferred(); const finishIdentify = deferred();
  f.state.source = async request => {
    if (request.action === "identify") {
      identifying.resolve();
      await finishIdentify.promise;
      return { ok: true, profile };
    }
    return { ok: true, profile, media: { mediaId: item.mediaId, shortcode: item.shortcode,
      pageUrl: "https://www.instagram.com/reel/B/", username: "creator", url: "https://scontent.cdninstagram.com/video/reel.mp4" } };
  };
  const replacement = api.handleBulkMessage(message("START", { options: options("folder") }), sender(7, "document-two"));
  await identifying.promise;
  assert.equal((await api.handleBulkMessage(operation("RESOLVE", job), sender())).ok, true);
  finishIdentify.resolve();
  assert.equal((await replacement).error.code, "RECONCILIATION_REQUIRED");
  assert.equal(f.state.session[activeKey].jobId, job.jobId);
  assert.equal(f.state.session[activeKey].reservationMediaId, "1");
  assert.equal(f.state.session[operationKey(job.jobId)].state, "prepared");
});

test("a no-output acknowledgement before registration fences a delayed resolve and only its exact attempt", async () => {
  for (const delayedRead of [1, 2]) {
    const f = fixture(); const api = await load(f); const job = await start(api, sender(), "folder", 1);
    await discover(api, job);
    const reading = deferred(); const finishRead = deferred();
    const originalGet = f.chrome.storage.session.get;
    let operationReads = 0;
    f.chrome.storage.session.get = async key => {
      if (key === operationKey(job.jobId) && ++operationReads === delayedRead) {
        reading.resolve();
        await finishRead.promise;
      }
      return originalGet(key);
    };
    const resolving = api.handleBulkMessage(operation("RESOLVE", job), sender());
    await reading.promise;
    const negative = await api.handleBulkMessage(operation("ITEM_RESULT", job, "attempt-one", {
      result: { state: "canceled", error: { message: "No host writer was started" } },
    }), sender());
    assert.equal(negative.error.code, "STALE_OPERATION", "an absent journal remains an unregistered result");
    finishRead.resolve();
    assert.equal((await resolving).error.code, "SAVE_CANCELLED");
    assert.equal(f.state.session[operationKey(job.jobId)], undefined);
    assert.equal(f.state.session[activeKey].reservationMediaId, null);
    assert.equal(f.state.sourceCalls.filter(request => request.action === "resolve").length, 0);
    assert.equal((await api.handleBulkMessage(operation("RESOLVE", job, "new-attempt"), sender())).ok, true,
      "a different attempt can use the unconsumed allowance");
  }
});

test("durable receipts recognize a coauthored underscore Reel after worker restart and profile rename", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  const special = { mediaId: "127", shortcode: "B_" };
  await discover(api, job);
  f.state.session[memberKey(job.jobId, special.mediaId)] = special;
  f.state.mediaUsername = "coauthor";
  const first = await api.handleBulkMessage(operation("DOWNLOAD", job, "special", { item: special }), sender());
  assert.equal(first.ok, true, JSON.stringify(first));
  f.state.downloads[0].state = "complete";
  assert.equal((await api.handleBulkMessage(operation("STATUS", job, "special", { item: special }), sender())).ok, true);
  const receipt = f.state.local[receiptKey(profile.id, special)];
  assert.equal(receipt.profileId, profile.id);
  assert.equal(receipt.mediaId, special.mediaId);
  assert.equal(receipt.shortcode, "B_");
  assert.equal(receipt.filename, "coauthor_B_.mp4");
  assert.equal(JSON.stringify(receipt).includes("https:"), false);
  assert.equal(JSON.stringify(receipt).includes("C:"), false);
  assert.equal((await api.handleBulkMessage(message("END", { jobId: job.jobId, state: "completed" }), sender())).ok, true);
  const renamedProfile = { ...profile, username: "renamed_creator" };
  const renamedUrl = "https://www.instagram.com/renamed_creator/reels/";
  f.state.tabs.get(7).url = renamedUrl;
  const renamedSender = { ...sender(), url: renamedUrl, tab: { id: 7, url: renamedUrl } };
  f.state.source = request => request.action === "identify" ? { ok: true, profile: renamedProfile }
    : { ok: true, profile: renamedProfile, page: { items: [special], nextCursor: null, hasMore: false } };
  api = await load(f);
  const next = await start(api, renamedSender, "downloads", 1);
  await discover(api, next, renamedSender);
  const cached = await existing(api, next, special, renamedSender);
  assert.equal(cached.result.verification, "browser_receipt");
  assert.equal(cached.result.filename, "coauthor_B_.mp4");
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", next, "new", { item: special }), renamedSender)).alreadySaved, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
});

test("receipt persistence failures hold allowance and replay metadata without another Chrome transfer", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads[0].state = "complete";
  f.state.failLocalWrite = true;
  const failed = await api.handleBulkMessage(operation("STATUS", job), sender());
  assert.equal(failed.error.code, "CACHE_RECEIPT_WRITE_FAILED");
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(f.state.session[activeKey].reservationMediaId, item.mediaId);
  assert.equal(f.state.local[receiptKey(profile.id, item)], undefined);
  api = await load(f);
  assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).ok, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.ok(f.state.local[receiptKey(profile.id, item)]);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
});

test("low receipt storage blocks new physical saves while accepted downloads can still reconcile metadata", async () => {
  const f = fixture(); let api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  let usedBytes = 9000, capacityChecks = 0;
  f.chrome.storage.local.QUOTA_BYTES = 10000;
  f.chrome.storage.local.getBytesInUse = async key => { assert.equal(key, null); capacityChecks++; return usedBytes; };
  const blocked = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  assert.equal(blocked.error.code, "CACHE_RECEIPT_LIMIT");
  assert.equal(f.state.sourceCalls.filter(request => request.action === "resolve").length, 0);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 0);
  assert.equal(f.state.session[operationKey(job.jobId)], undefined);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  assert.equal(capacityChecks, 1);

  usedBytes = 0;
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job), sender())).ok, true);
  assert.equal(capacityChecks, 2);
  usedBytes = 9000;
  f.state.downloads[0].state = "complete";
  api = await load(f);
  const reconciled = await api.handleBulkMessage(operation("DOWNLOAD", job, "recovered"), sender());
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.equal(reconciled.download.id, 1);
  assert.equal(capacityChecks, 2, "accepted saves replay metadata without reserving another file's headroom");
  assert.equal(f.state.sourceCalls.filter(request => request.action === "resolve").length, 1);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
  assert.equal(f.state.session[activeKey].reservationMediaId, null);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.local[receiptKey(profile.id, item)].downloadId, 1);
});

test("an immediately completed download journals its accepted ID before a receipt failure despite a rapid older copy", async () => {
  const f = fixture(); let api = await load(f);
  const job = (await api.handleBulkMessage(message("START", { options: { ...options(), maxNewVideos: 1, skipExisting: false } }), sender())).job;
  await discover(api, job);
  f.state.downloads = [historyRecord({ filename: "Reel Saver/creator_B.mp4", startTime: new Date().toISOString() })];
  f.state.completeDownload = true;
  f.state.failLocalWrite = true;
  const failed = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  assert.equal(failed.error.code, "CACHE_RECEIPT_WRITE_FAILED");
  assert.equal(f.state.session[operationKey(job.jobId)].downloadId, 2);
  assert.equal(f.state.session[activeKey].reservationMediaId, item.mediaId);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  api = await load(f);
  const retried = await api.handleBulkMessage(operation("DOWNLOAD", job, "retry"), sender());
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.download.id, 2);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.local[receiptKey(profile.id, item)].downloadId, 2);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
});

test("a delayed old-job status cannot overwrite the newer run's durable receipt", async () => {
  const f = fixture(); const api = await load(f); const first = await start(api, sender(), "downloads", 1);
  await discover(api, first);
  await api.handleBulkMessage(operation("DOWNLOAD", first), sender());
  f.state.downloads[0].state = "complete";
  await api.handleBulkMessage(operation("STATUS", first), sender());
  await api.handleBulkMessage(message("END", { jobId: first.jobId, state: "completed" }), sender());
  const querying = deferred(), finishQuery = deferred();
  let oldReads = 0;
  f.state.search = async query => {
    const result = structuredClone(f.state.downloads.filter(value => query.id == null || value.id === query.id));
    if (query.id === 1 && ++oldReads === 2) { querying.resolve(); await finishQuery.promise; }
    return result;
  };
  const oldStatus = api.handleBulkMessage(operation("STATUS", first), sender());
  await querying.promise;
  const next = (await api.handleBulkMessage(message("START", { options: { ...options(), skipExisting: false } }), sender())).job;
  await discover(api, next);
  await api.handleBulkMessage(operation("DOWNLOAD", next, "new"), sender());
  f.state.downloads[1].state = "complete";
  await api.handleBulkMessage(operation("STATUS", next, "new"), sender());
  assert.equal(f.state.local[receiptKey(profile.id, item)].downloadId, 2);
  finishQuery.resolve();
  assert.equal((await oldStatus).error.code, "STALE_JOB");
  assert.equal(f.state.local[receiptKey(profile.id, item)].downloadId, 2);
});

test("unknown completed size remains reserved until Chrome confirms metadata, without a new download", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  f.state.downloads[0].state = "complete";
  f.state.downloads[0].fileSize = -1;
  assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).error.code, "CACHE_RECEIPT_UNVERIFIED");
  assert.equal(f.state.session[activeKey].reservationMediaId, item.mediaId);
  assert.equal(f.state.session[activeKey].committedNewSaves, 0);
  f.state.downloads[0].fileSize = 2048;
  assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).ok, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.downloads.length, 1);
});

test("corrupt durable receipts pause before discovery fallback or another file can start", async () => {
  const f = fixture(); const api = await load(f); const job = await start(api);
  await discover(api, job);
  f.state.local[receiptKey(profile.id, item)] = { schemaVersion: 2 };
  assert.equal((await existing(api, job)).error.code, "CACHE_RECEIPT_UNSUPPORTED");
  assert.equal((await api.handleBulkMessage(operation("DOWNLOAD", job), sender())).error.code, "CACHE_RECEIPT_UNSUPPORTED");
  assert.equal(f.state.downloads.length, 0);
});

function oldBrowserReport(items = [{ ...item, state: "saved", filename: "coauthor_B.mp4", bytesWritten: 2048 }]) {
  return { version: 1, profile: { ...profile }, items };
}

test("browser report preview is read-only, owns the global slot, and confirmed migration binds exact report identities", async () => {
  const f = fixture(); let api = await load(f);
  const special = { mediaId: "127", shortcode: "B_" };
  // The old release trimmed B_ to B; only this selected report binds that
  // ambiguous filename to the numeric Reel identity.
  f.state.downloads = [historyRecord({ filename: "C:/Downloads/coauthor_B.mp4" })];
  const report = oldBrowserReport([{ ...special, state: "saved", filename: "coauthor_B.mp4", bytesWritten: 2048 }]);
  const preview = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report }), sender());
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.summary, { saved: 1, ready: 1, alreadyRecorded: 0, missing: 0, conflicts: 0, ignored: 0 });
  assert.deepEqual(f.state.local, {}, "preview does not persist receipts");
  assert.equal((await api.handleBulkMessage(message("START", { options: options() }), sender(8))).error.code, "BULK_BUSY");
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: preview.previewId }), sender(8))).error.code, "STALE_JOB");
  const committed = await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: preview.previewId }), sender());
  assert.equal(committed.imported, 1);
  assert.equal(f.state.local[receiptKey(profile.id, special)].downloadId, 500);
  assert.equal(f.state.session[activeKey].active, true, "the UI explicitly closes its import session");
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: preview.previewId }), sender())).ok, true);
  assert.equal(f.state.session[activeKey].active, false);
  api = await load(f);
  const job = await start(api);
  await discover(api, job);
  f.state.session[memberKey(job.jobId, special.mediaId)] = special;
  assert.equal((await existing(api, job, special)).result.verification, "browser_receipt");
  assert.equal(f.state.calls.some(call => call.type === "download"), false);
});

test("browser report confirmation rechecks files and can retry a failed receipt write without importing another copy", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads = [historyRecord({ filename: "C:/Downloads/coauthor_B.mp4" })];
  const first = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report: oldBrowserReport() }), sender());
  f.state.downloads[0].exists = false;
  const missing = await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: first.previewId }), sender());
  assert.equal(missing.missing, 1);
  assert.deepEqual(f.state.local, {});
  await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: first.previewId }), sender());
  f.state.downloads[0].exists = true;
  const next = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report: oldBrowserReport() }), sender());
  f.state.failLocalWrite = true;
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: next.previewId }), sender())).error.code, "CACHE_RECEIPT_WRITE_FAILED");
  assert.equal(f.state.session[activeKey].active, true);
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: next.previewId }), sender())).imported, 1);
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: next.previewId }), sender())).alreadyRecorded, 1);
  assert.equal(f.state.calls.some(call => call.type === "download"), false);
  await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: next.previewId }), sender());
  const recorded = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report: oldBrowserReport() }), sender());
  assert.equal(recorded.summary.ready, 0);
  assert.equal(recorded.summary.alreadyRecorded, 1);
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: recorded.previewId }), sender())).alreadyRecorded, 1);
});

test("browser import cancellation releases its same-document owner after navigation and invalid report profiles preserve history", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads = [historyRecord({ filename: "C:/Downloads/coauthor_B.mp4" })];
  const bad = { ...oldBrowserReport(), profile: { id: "901", username: "someone_else" } };
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report: bad }), sender())).error.code, "CACHE_RECEIPT_REPORT_INVALID");
  assert.equal(f.state.session[activeKey].active, false);
  assert.deepEqual(f.state.local, {});
  const preview = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report: oldBrowserReport() }), sender());
  f.state.tabs.get(7).url = "https://www.instagram.com/another_creator/reels/";
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: preview.previewId }), sender())).error.code, "PAGE_CHANGED");
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL"), sender())).ok, true);
  assert.equal(f.state.session[activeKey].active, false);
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: preview.previewId }), sender())).ok, true);
});

test("browser import confirmation rejects a changed numeric profile even at the same username URL", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads = [historyRecord({ filename: "C:/Downloads/coauthor_B.mp4" })];
  const preview = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report: oldBrowserReport() }), sender());
  f.state.source = () => ({ ok: true, profile: { ...profile, id: "901" } });
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: preview.previewId }), sender())).error.code, "CACHE_RECEIPT_PROFILE_CHANGED");
  assert.deepEqual(f.state.local, {});
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: preview.previewId }), sender())).ok, true);
});

test("Cancel during browser receipt import stops later rows and holds global ownership until the active write settles", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads = [historyRecord({ filename: "C:/Downloads/coauthor_B.mp4" }),
    historyRecord({ id: 501, filename: "C:/Downloads/coauthor_C.mp4" })];
  const report = oldBrowserReport([item, secondItem].map(entry => ({ ...entry, state: "saved", filename: `coauthor_${entry.shortcode}.mp4`, bytesWritten: 2048 })));
  const preview = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report }), sender());
  const writing = deferred(), finishWrite = deferred();
  f.state.localWriting = writing;
  f.state.localWriteGate = finishWrite;
  const committing = api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: preview.previewId }), sender());
  await writing.promise;
  let canceled = false;
  const canceling = api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: preview.previewId }), sender()).then(result => { canceled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(canceled, false);
  assert.equal(f.state.session[activeKey].active, true);
  let started = false;
  const starting = api.handleBulkMessage(message("START", { options: options() }), sender(8)).then(result => { started = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(started, false);
  finishWrite.resolve();
  const completed = await committing;
  assert.equal(completed.imported, 1);
  assert.equal(completed.canceled, true);
  assert.equal((await canceling).ok, true);
  assert.equal((await starting).ok, true);
  assert.ok(f.state.local[receiptKey(profile.id, item)]);
  assert.equal(f.state.local[receiptKey(profile.id, secondItem)], undefined);
});

test("Cancel before a browser preview response releases its owner and fences the late read-only result", async () => {
  const f = fixture(); const api = await load(f);
  const searching = deferred(), finishSearch = deferred();
  f.state.search = async query => { searching.resolve(); await finishSearch.promise; return [historyRecord({ filename: "C:/Downloads/coauthor_B.mp4" })]; };
  const preparing = api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report: oldBrowserReport() }), sender());
  await searching.promise;
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL"), sender())).ok, true);
  assert.equal(f.state.session[activeKey].active, false);
  finishSearch.resolve();
  assert.equal((await preparing).error.code, "SAVE_CANCELLED");
  assert.deepEqual(f.state.local, {});
  assert.equal(f.state.session[activeKey].active, false);
});

test("an imported trimmed underscore filename cannot become a history hit for a different Reel", async () => {
  const f = fixture(); const api = await load(f);
  const underscored = { mediaId: "4033", shortcode: "_B" };
  f.state.downloads = [historyRecord()];
  const report = oldBrowserReport([{ ...underscored, state: "saved", filename: "creator_B.mp4", bytesWritten: 2048 }]);
  const preview = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report }), sender());
  assert.equal((await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: preview.previewId }), sender())).imported, 1);
  await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: preview.previewId }), sender());
  const job = await start(api, sender(), "downloads", 1);
  await discover(api, job);
  assert.equal((await existing(api, job)).result, null, "creator_B belongs to _B according to the selected report");
  const response = await api.handleBulkMessage(operation("DOWNLOAD", job), sender());
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.alreadySaved, undefined);
  assert.equal(f.state.calls.filter(call => call.type === "download").length, 1);
  f.state.downloads.at(-1).state = "complete";
  assert.equal((await api.handleBulkMessage(operation("STATUS", job), sender())).ok, true);
  assert.equal(f.state.session[activeKey].committedNewSaves, 1);
  assert.equal(f.state.local[receiptKey(profile.id, underscored)].downloadId, 500);
  assert.notEqual(f.state.local[receiptKey(profile.id, item)].downloadId, 500);
});

test("legacy lookup skips a conflicting claimed download and can adopt a later matching unclaimed copy", async () => {
  const f = fixture(); const api = await load(f);
  const underscored = { mediaId: "4033", shortcode: "_B" };
  f.state.downloads = [historyRecord()];
  const report = oldBrowserReport([{ ...underscored, state: "saved", filename: "creator_B.mp4", bytesWritten: 2048 }]);
  const preview = await api.handleBulkMessage(message("BROWSER_IMPORT_PREVIEW", { report }), sender());
  await api.handleBulkMessage(message("BROWSER_IMPORT_COMMIT", { previewId: preview.previewId }), sender());
  await api.handleBulkMessage(message("BROWSER_IMPORT_CANCEL", { previewId: preview.previewId }), sender());
  f.state.downloads.push(historyRecord({ id: 501, filename: "C:/Downloads/creator_B (1).mp4", startTime: "2025-01-01T00:00:00.000Z" }));
  const job = await start(api);
  await discover(api, job);
  const hit = await existing(api, job);
  assert.equal(hit.ok, true, JSON.stringify(hit));
  assert.equal(hit.result.downloadId, 501);
  assert.equal(f.state.local[receiptKey(profile.id, item)].downloadId, 501);
  assert.equal(f.state.local[receiptKey(profile.id, underscored)].downloadId, 500);
  assert.equal(f.state.calls.some(call => call.type === "download"), false);
});
