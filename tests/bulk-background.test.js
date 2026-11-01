import assert from "node:assert/strict";
import { test } from "node:test";

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
        pageUrl: `https://www.instagram.com/reel/${mediaItem.shortcode}/`, username: "creator",
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
          url: options.url, state: "in_progress", startTime: new Date().toISOString(), exists: true, mime: "video/mp4" });
        if (state.failAcceptanceRecord) {
          state.failAcceptanceRecord = false;
          state.failSessionWrite = true;
        }
        if (state.downloadGate) await state.downloadGate.promise;
        return id;
      },
      async search(query) {
        state.calls.push({ type: "search", query });
        return structuredClone(query.id == null ? state.downloads : state.downloads.filter(value => value.id === query.id));
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
async function start(api, source = sender(), destination = "downloads") {
  const result = await api.handleBulkMessage(message("START", { options: options(destination) }), source);
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
    ok: true, settings: { mode: "batches", batchSize: 35 },
  });
  const stored = await api.handleBulkMessage(message("SETTINGS_SET", { settings: { mode: "scan_all", batchSize: 50 } }), sender());
  assert.equal(stored.settings.mode, "scan_all");
  for (const batchSize of [0, -1, 501, 1.5, "35", NaN]) {
    assert.equal((await api.handleBulkMessage(message("SETTINGS_SET", { settings: { mode: "batches", batchSize } }), sender())).error.code, "INVALID_SETTINGS");
  }
  assert.equal((await api.handleBulkMessage(message("SETTINGS_SET", { settings: { mode: "unknown", batchSize: 35 } }), sender())).ok, false);
  assert.equal(f.state.local["reel-saver:bulk-prefs"].batchSize, 50);
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
