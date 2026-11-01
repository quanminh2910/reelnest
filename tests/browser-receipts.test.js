import assert from "node:assert/strict";
import { test } from "node:test";

const extensionId = "receipt-fixture-extension";
const profileId = "12345";
const item = { mediaId: "127", shortcode: "B_" };
const other = { mediaId: "128", shortcode: "CA" };
const complete = (extra = {}) => ({ id: 7, byExtensionId: extensionId,
  filename: "C:/Fixture Downloads/Reel Saver/coauthor_B_.mp4", fileSize: 2048,
  state: "complete", exists: true, mime: "video/mp4",
  url: "https://scontent.cdninstagram.com/fixture.mp4?local=fixture",
  finalUrl: "https://scontent.cdninstagram.com/fixture.mp4?local=fixture", ...extra });

function fixture() {
  const state = { local: {}, downloads: [], searches: [], writes: 0, removes: 0, snapshots: [] };
  const chrome = { runtime: { id: extensionId }, storage: { local: {
    async get(key) {
      if (state.failRead) throw new Error("Storage read unavailable");
      if (key == null) return structuredClone(state.local);
      return { [key]: structuredClone(state.local[key]) };
    },
    async set(values) {
      state.writes++;
      if (state.failWrite) { state.failWrite = false; throw new Error("Quota exceeded"); }
      state.local = { ...state.local, ...structuredClone(values) };
      state.snapshots.push(structuredClone(values));
    },
    async remove(key) {
      state.removes++;
      if (state.failRemove) throw new Error("Storage remove unavailable");
      delete state.local[key];
    },
  } }, downloads: {
    async search(query) {
      state.searches.push(structuredClone(query));
      if (state.failSearch) throw new Error("Chrome history unavailable");
      if (state.searchResult) return structuredClone(state.searchResult);
      const values = state.downloads.filter(value => (query.id === undefined || value.id === query.id) &&
        (!query.state || value.state === query.state) && (query.exists === undefined || value.exists === query.exists) &&
        (!query.filenameRegex || new RegExp(query.filenameRegex).test(value.filename)));
      return structuredClone(values.slice(0, query.limit || values.length));
    },
  } };
  return { state, chrome };
}

let serial = 0;
async function load(f) {
  globalThis.chrome = f.chrome;
  return import(`../src/background/browser-receipts.js?test=${++serial}`);
}

const report = (items = [{ ...item, state: "saved", filename: "coauthor_B.mp4", bytesWritten: 2048 }]) =>
  ({ version: 1, profile: { id: profileId, username: "creator" }, items });

test("receipts retain exact media identity across worker restarts and differing owner usernames", async () => {
  const f = fixture(); let api = await load(f);
  const download = complete(); f.state.downloads.push(download);
  const written = await api.recordReceipt(profileId, item, download);
  assert.equal(written.profileId, profileId);
  assert.equal(written.mediaId, "127");
  assert.equal(written.shortcode, "B_");
  assert.equal(written.filename, "coauthor_B_.mp4");
  assert.equal(written.downloadId, 7);
  assert.equal(written.bytesWritten, 2048);
  assert.ok(written.savedAt > 0);
  assert.equal(written.username, undefined);
  api = await load(f);
  assert.deepEqual(await api.verifyReceipt(profileId, { ...item, username: "renamed_creator" }), {
    cacheHit: true, filename: "coauthor_B_.mp4", bytesWritten: 2048, downloadId: 7, verification: "browser_receipt",
  });
  assert.deepEqual(f.state.searches, [{ id: 7 }]);
  assert.equal(await api.getReceipt("67890", item), null, "another viewed profile has separate history");
});

test("stored receipts omit paths, addresses, credentials, and unnecessary Chrome fields", async () => {
  const f = fixture(); const api = await load(f);
  await api.recordReceipt(profileId, item, complete({ cookie: "private fixture", referrer: "https://www.instagram.com/" }));
  const serialized = JSON.stringify(f.state.local);
  assert.equal(serialized.includes("https:"), false);
  assert.equal(serialized.includes("C:"), false);
  assert.equal(serialized.includes("private fixture"), false);
  assert.equal(serialized.includes("referrer"), false);
  assert.deepEqual(Object.keys(await api.getReceipt(profileId, item)).sort(),
    ["schemaVersion", "profileId", "mediaId", "shortcode", "downloadId", "filename", "bytesWritten", "savedAt"].sort());
});

test("receipt write failure retains no false completion and metadata-only replay is idempotent", async () => {
  const f = fixture(); const api = await load(f); const download = complete();
  f.state.failWrite = true;
  await assert.rejects(api.recordReceipt(profileId, item, download), { code: "CACHE_RECEIPT_WRITE_FAILED" });
  assert.equal(await api.getReceipt(profileId, item), null);
  const first = await api.recordReceipt(profileId, item, download);
  const second = await api.recordReceipt(profileId, item, download);
  assert.deepEqual(second, first);
  assert.equal(Object.values(f.state.local).find(value => value?.count !== undefined).count, 1);
  assert.equal(f.state.searches.length, 0, "recording an already confirmed completion never starts or resolves a download");
});

test("known missing files and cleared Chrome history remove stale receipts", async () => {
  const f = fixture(); const api = await load(f); const download = complete();
  await api.recordReceipt(profileId, item, download);
  f.state.downloads.push({ ...download, exists: false });
  assert.equal(await api.verifyReceipt(profileId, item), null);
  assert.equal(await api.getReceipt(profileId, item), null);
  assert.equal(Object.values(f.state.local).find(value => value?.count !== undefined).count, 0);
  await api.recordReceipt(profileId, item, download);
  f.state.downloads = [];
  assert.equal(await api.verifyReceipt(profileId, item), null);
  assert.equal(await api.getReceipt(profileId, item), null);
});

test("foreign, interrupted, moved, altered-size, HTML, and untrusted records cannot establish a cache hit", async () => {
  for (const change of [{ byExtensionId: "other-extension" }, { state: "interrupted" },
    { filename: "C:/Fixture Downloads/other.mp4" }, { fileSize: 4096 }, { mime: "text/html" },
    { url: "https://evil.example/video.mp4" }, { finalUrl: "http://scontent.cdninstagram.com/video.mp4" }]) {
    const f = fixture(); const api = await load(f); const download = complete();
    await api.recordReceipt(profileId, item, download);
    f.state.downloads.push({ ...download, ...change });
    assert.equal(await api.verifyReceipt(profileId, item), null, JSON.stringify(change));
    assert.equal(await api.getReceipt(profileId, item), null);
  }
});

test("unknown browser metadata and history errors preserve receipts and pause instead of redownloading", async () => {
  const f = fixture(); const api = await load(f); const download = complete();
  await api.recordReceipt(profileId, item, download);
  f.state.downloads.push({ ...download, fileSize: -1 });
  await assert.rejects(api.verifyReceipt(profileId, item), { code: "CACHE_RECEIPT_UNVERIFIED" });
  assert.ok(await api.getReceipt(profileId, item));
  f.state.failSearch = true;
  await assert.rejects(api.verifyReceipt(profileId, item), { code: "CACHE_HISTORY_UNAVAILABLE" });
  assert.ok(await api.getReceipt(profileId, item));
  for (const change of [{ fileSize: -1 }, { fileSize: 0 }, { exists: false }, { state: "in_progress" }, { mime: "text/html" }, { byExtensionId: "other" }]) {
    await assert.rejects(api.recordReceipt(profileId, other, complete(change)), { code: "CACHE_RECEIPT_UNVERIFIED" });
  }
});

test("corrupt and newer receipts or indexes fail closed and remain unchanged", async () => {
  const f = fixture(); const api = await load(f);
  const key = api.receiptKey(profileId, item);
  f.state.local[key] = { schemaVersion: 2 };
  await assert.rejects(api.getReceipt(profileId, item), { code: "CACHE_RECEIPT_UNSUPPORTED" });
  f.state.local[key] = { schemaVersion: 1, profileId, ...item, downloadId: 7, filename: "../../escape.mp4", bytesWritten: 2048, savedAt: 1 };
  await assert.rejects(api.getReceipt(profileId, item), { code: "CACHE_RECEIPT_CORRUPT" });
  const before = structuredClone(f.state.local);
  await assert.rejects(api.recordReceipt(profileId, item, complete()), { code: "CACHE_RECEIPT_CORRUPT" });
  assert.deepEqual(f.state.local, before);
  f.state.local = { "reelnest:browser-receipt-index": { schemaVersion: 2 } };
  await assert.rejects(api.recordReceipt(profileId, item, complete()), { code: "CACHE_RECEIPT_UNSUPPORTED" });
});

test("identity validation rejects forged media IDs, noncanonical codes, and invalid profile keys", async () => {
  const f = fixture(); const api = await load(f);
  for (const [profile, media] of [["0", item], ["001", item], [profileId, { mediaId: "127", shortcode: "B" }],
    [profileId, { mediaId: "1", shortcode: "AB" }], [profileId, { mediaId: "0", shortcode: "A" }]]) {
    await assert.rejects(api.recordReceipt(profile, media, complete()), { code: "CACHE_RECEIPT_INVALID" });
  }
  assert.deepEqual(f.state.local, {});
});

test("ordinary writes use sparse keys without rescanning all receipts", async () => {
  const f = fixture(); const api = await load(f);
  await api.recordReceipt(profileId, item, complete());
  let allReads = 0; const get = f.chrome.storage.local.get;
  f.chrome.storage.local.get = async key => { if (key == null) allReads++; return get(key); };
  await api.recordReceipt(profileId, other, complete({ id: 8, filename: "C:/Fixture Downloads/coauthor_CA.mp4" }));
  await api.recordReceipt(profileId, item, complete());
  assert.equal(allReads, 0);
  assert.equal(Object.values(f.state.local).find(value => value?.count !== undefined).count, 2);
});

test("report preview adopts explicit old trimmed shortcode filenames without writing receipts", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads.push(complete({ filename: "C:\\Fixture Downloads\\coauthor_B.mp4" }));
  const input = report([{ ...item, state: "saved", filename: "coauthor_B.mp4", bytesWritten: 2048 },
    { ...other, state: "canceled" }]);
  const preview = await api.previewReport(profileId, input);
  assert.deepEqual(preview.counts, { total: 2, eligible: 1, missing: 0, ignored: 1 });
  assert.deepEqual(preview.items, [{ ...item, filename: "coauthor_B.mp4", bytesWritten: 2048, downloadId: 7 }]);
  assert.deepEqual(f.state.local, {});
  const imported = await api.importReport(profileId, input);
  assert.deepEqual(imported, { imported: 1, missing: 0, ignored: 1 });
  assert.equal((await api.verifyReceipt(profileId, item)).filename, "coauthor_B.mp4");
  assert.deepEqual(await api.importReport(profileId, input), imported, "replaying import updates metadata without another file");
});

test("report migration rechecks file presence and exact positive size on confirmation", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads.push(complete({ filename: "C:/Fixture Downloads/coauthor_B.mp4" }));
  assert.equal((await api.previewReport(profileId, report())).counts.eligible, 1);
  f.state.downloads[0].exists = false;
  assert.deepEqual(await api.importReport(profileId, report()), { imported: 0, missing: 1, ignored: 0 });
  assert.deepEqual(f.state.local, {});
  f.state.downloads[0].exists = true;
  f.state.downloads[0].fileSize = 100;
  assert.equal((await api.previewReport(profileId, report())).counts.missing, 1);
});

test("unsafe, conflicting, foreign-profile and forged report entries are rejected before import", async () => {
  const f = fixture(); const api = await load(f);
  const good = report().items[0];
  for (const input of [{ ...report(), profile: { id: "67890" } }, { ...report(), version: 2 },
    report([{ ...good, filename: "C:/secret.mp4" }]), report([{ ...good, bytesWritten: 0 }]),
    report([{ ...good, mediaId: "128" }]), report([good, { ...good, filename: "different.mp4" }]),
    report([good, { ...good, ...other }])]) {
    await assert.rejects(api.importReport(profileId, input), { code: "CACHE_RECEIPT_REPORT_INVALID" });
  }
  assert.deepEqual(f.state.local, {});
});

test("migration ignores invalid Chrome records and bounds matching history results", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads.push(complete({ filename: "C:/Fixture Downloads/coauthor_B.mp4", byExtensionId: "other-extension" }));
  assert.equal((await api.previewReport(profileId, report())).counts.eligible, 0);
  f.state.searchResult = Array.from({ length: 201 }, (_, i) => complete({ id: i }));
  await assert.rejects(api.previewReport(profileId, report()), { code: "CACHE_RECEIPT_LIMIT" });
});

test("a stale browser existence result cannot delete a replacement receipt", async () => {
  const f = fixture(); const api = await load(f); const old = complete();
  await api.recordReceipt(profileId, item, old);
  const replacement = complete({ id: 8, filename: "C:/Fixture Downloads/coauthor_B_ (1).mp4" });
  const search = f.chrome.downloads.search;
  f.chrome.downloads.search = async query => {
    if (query.id === 7) {
      await api.recordReceipt(profileId, item, replacement);
      f.state.downloads = [replacement];
      return [{ ...old, exists: false }];
    }
    return search(query);
  };
  assert.equal((await api.verifyReceipt(profileId, item)).downloadId, 8);
  assert.equal((await api.getReceipt(profileId, item)).downloadId, 8);
});

test("report guards stop a preview and a queued import before another query or write", async () => {
  const f = fixture(); const api = await load(f);
  f.state.downloads.push(complete({ filename: "C:/Fixture Downloads/coauthor_B.mp4" }));
  let canceled = false;
  const check = async () => { if (canceled) throw Object.assign(new Error("Import canceled"), { code: "IMPORT_CANCELED" }); };
  const search = f.chrome.downloads.search;
  f.chrome.downloads.search = async query => { const values = await search(query); canceled = true; return values; };
  await assert.rejects(api.previewReport(profileId, report(), { check }), { code: "IMPORT_CANCELED" });
  assert.equal(f.state.searches.length, 1);
  assert.deepEqual(f.state.local, {});
  await assert.rejects(api.recordReceipt(profileId, item, complete(), { check }), { code: "IMPORT_CANCELED" });
  assert.deepEqual(f.state.local, {});
});

test("receipt limits never evict earlier records and allow updating an existing receipt", async () => {
  const f = fixture(); const api = await load(f);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const code = input => { let value = BigInt(input), output = ""; do { output = alphabet[Number(value % 64n)] + output; value /= 64n; } while (value); return output; };
  for (let value = 1; value <= api.MAX_RECEIPTS; value++) {
    const media = { mediaId: String(value), shortcode: code(value) };
    f.state.local[api.receiptKey(profileId, media)] = { schemaVersion: 1, profileId, ...media,
      downloadId: value, filename: `creator_${media.shortcode}.mp4`, bytesWritten: 2048, savedAt: 1 };
  }
  f.state.local["reelnest:browser-receipt-index"] = { schemaVersion: 1, count: api.MAX_RECEIPTS };
  const next = { mediaId: "999999", shortcode: code(999999) };
  await assert.rejects(api.assertReceiptCapacity(profileId, next), { code: "CACHE_RECEIPT_LIMIT" });
  await api.assertReceiptCapacity(profileId, item);
  await assert.rejects(api.recordReceipt(profileId, next, complete()), { code: "CACHE_RECEIPT_LIMIT" });
  assert.equal(Object.keys(f.state.local).length, api.MAX_RECEIPTS + 1);
  assert.equal(f.state.writes, 0);
  await api.recordReceipt(profileId, item, complete());
  assert.equal(Object.values(f.state.local).find(value => value?.count !== undefined).count, api.MAX_RECEIPTS);
});

test("oversized reports and browser-storage failures fail closed", async () => {
  const f = fixture(); const api = await load(f);
  await assert.rejects(api.previewReport(profileId, report(Array.from({ length: 50001 }, () => ({ state: "canceled" })))), { code: "CACHE_RECEIPT_REPORT_INVALID" });
  await assert.rejects(api.previewReport(profileId, { ...report(), excess: "x".repeat(16 * 1024 * 1024) }), { code: "CACHE_RECEIPT_REPORT_INVALID" });
  f.state.failRead = true;
  await assert.rejects(api.getReceipt(profileId, item), { code: "CACHE_RECEIPT_READ_FAILED" });
});
