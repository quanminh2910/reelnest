import { isInstagramMediaUrl } from "../shared/core.js";

// These receipts identify media independently of filenames and usernames. They
// contain no local paths, directory capabilities, or signed media addresses.
export const RECEIPT_PREFIX = "reelnest:browser-receipt:v1:";
export const CLAIM_PREFIX = "reelnest:browser-download-claim:v1:";
const INDEX = "reelnest:browser-receipt-index";
export const MAX_RECEIPTS = 20_000;
export const MAX_CLAIMS = 20_000;
const MAX_REPORT_ITEMS = 50_000;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATES = 200;
let mutationTail = Promise.resolve();

const problem = (code, message) => Object.assign(new Error(message), { code, stage: "history" });
const object = value => value && typeof value === "object" && !Array.isArray(value);
const profileIdentity = value => typeof value === "string" && /^[1-9][0-9]{0,29}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const downloadIdentity = value => Number.isSafeInteger(value) && value >= 0;
const safeFilename = value => typeof value === "string" && value.length > 0 && value.length <= 200 &&
  !/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/.test(value) &&
  !/[. ]$/.test(value) && /\.mp4$/i.test(value);
const basename = value => typeof value === "string" ? value.replaceAll("\\", "/").split("/").pop() : "";
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function identity(profileId, item) {
  if (!profileIdentity(profileId) || !object(item) || typeof item.mediaId !== "string" ||
      !/^[1-9][0-9]{0,31}$/.test(item.mediaId) || typeof item.shortcode !== "string" ||
      !/^[A-Za-z0-9_-]{1,28}$/.test(item.shortcode) || item.shortcode.length > 1 && item.shortcode.startsWith("A")) {
    throw problem("CACHE_RECEIPT_INVALID", "A verified profile and Reel identity are required for browser history.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const mediaId = [...item.shortcode].reduce((value, character) => value * 64n + BigInt(alphabet.indexOf(character)), 0n).toString();
  if (mediaId !== item.mediaId) throw problem("CACHE_RECEIPT_INVALID", "The Reel code does not match its numeric identity.");
  return { profileId, mediaId, shortcode: item.shortcode };
}

export function receiptKey(profileId, item) {
  const value = identity(profileId, item);
  return `${RECEIPT_PREFIX}${value.profileId}:${value.mediaId}`;
}

function validateReceipt(value, expected) {
  if (!object(value) || !Number.isInteger(value.schemaVersion)) {
    throw problem("CACHE_RECEIPT_CORRUPT", "A browser download receipt is damaged. Restore its history before continuing.");
  }
  if (value.schemaVersion !== 1) throw problem("CACHE_RECEIPT_UNSUPPORTED", "This browser history was created by a newer ReelNest version and was kept unchanged.");
  let checked;
  try { checked = identity(value.profileId, value); } catch {
    throw problem("CACHE_RECEIPT_CORRUPT", "A browser download receipt has an invalid identity.");
  }
  if (expected && (checked.profileId !== expected.profileId || checked.mediaId !== expected.mediaId || checked.shortcode !== expected.shortcode) ||
      !downloadIdentity(value.downloadId) || !safeFilename(value.filename) || !positive(value.bytesWritten) || !positive(value.savedAt)) {
    throw problem("CACHE_RECEIPT_CORRUPT", "A browser download receipt has invalid file metadata.");
  }
  return { schemaVersion: 1, ...checked, downloadId: value.downloadId, filename: value.filename,
    bytesWritten: value.bytesWritten, savedAt: value.savedAt };
}

async function read(key) {
  try { return (await chrome.storage.local.get(key))[key]; }
  catch { throw problem("CACHE_RECEIPT_READ_FAILED", "Browser download receipts could not be read. Retry before downloading more videos."); }
}

async function write(values) {
  try { await chrome.storage.local.set(values); }
  catch { throw problem("CACHE_RECEIPT_WRITE_FAILED", "The video is saved, but its browser receipt could not be recorded. Retry its history update without downloading another copy."); }
}

async function locked(action) {
  const previous = mutationTail;
  let release;
  mutationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await action(); } finally { release(); }
}

async function allReceipts() {
  let values;
  try { values = await chrome.storage.local.get(null); }
  catch { throw problem("CACHE_RECEIPT_READ_FAILED", "Browser download receipts could not be read. Retry before importing history."); }
  const records = [];
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(RECEIPT_PREFIX)) continue;
    const receipt = validateReceipt(value);
    if (key !== receiptKey(receipt.profileId, receipt)) throw problem("CACHE_RECEIPT_CORRUPT", "A browser receipt is stored under the wrong identity.");
    records.push(receipt);
    if (records.length > MAX_RECEIPTS) throw problem("CACHE_RECEIPT_LIMIT", "Browser history exceeds the supported 20,000 receipts. Use a Library folder for a larger collection.");
  }
  return records;
}

function validateIndex(index) {
  if (index !== undefined && (!object(index) || !Number.isInteger(index.schemaVersion))) {
    throw problem("CACHE_RECEIPT_CORRUPT", "The browser receipt index is damaged. Restore its history before continuing.");
  }
  if (index !== undefined && (index.schemaVersion !== 1 || index.claimsVersion !== undefined && index.claimsVersion !== 1)) {
    throw problem("CACHE_RECEIPT_UNSUPPORTED", "The browser receipt index uses a newer format and was kept unchanged.");
  }
  if (index !== undefined && (!Number.isSafeInteger(index.count) || index.count < 0 || index.count > MAX_RECEIPTS ||
      index.claimsVersion === 1 && (!Number.isSafeInteger(index.claimsCount) || index.claimsCount < 0 || index.claimsCount > MAX_CLAIMS))) {
    throw problem("CACHE_RECEIPT_CORRUPT", "The browser receipt index has invalid counts.");
  }
  return index;
}

function validateClaim(value, downloadId) {
  if (!object(value) || !Number.isInteger(value.schemaVersion)) throw problem("CACHE_RECEIPT_CORRUPT", "A browser download identity claim is damaged.");
  if (value.schemaVersion !== 1) throw problem("CACHE_RECEIPT_UNSUPPORTED", "A browser download identity claim uses a newer format and was kept unchanged.");
  if (!downloadIdentity(value.downloadId) || value.downloadId !== downloadId ||
      typeof value.mediaId !== "string" || !/^[1-9][0-9]{0,31}$/.test(value.mediaId) || !positive(value.recordedAt)) {
    throw problem("CACHE_RECEIPT_CORRUPT", "A browser download identity claim has invalid metadata.");
  }
  return { schemaVersion: 1, downloadId: value.downloadId, mediaId: value.mediaId, recordedAt: value.recordedAt };
}

async function readClaim(downloadId) {
  const value = await read(`${CLAIM_PREFIX}${downloadId}`);
  return value === undefined ? null : validateClaim(value, downloadId);
}

async function allClaims() {
  let values;
  try { values = await chrome.storage.local.get(null); }
  catch { throw problem("CACHE_RECEIPT_READ_FAILED", "Browser download identities could not be read. Retry before importing history."); }
  const claims = new Map();
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(CLAIM_PREFIX)) continue;
    const suffix = key.slice(CLAIM_PREFIX.length);
    if (!/^(0|[1-9][0-9]*)$/.test(suffix)) throw problem("CACHE_RECEIPT_CORRUPT", "A browser identity claim is stored under an invalid download ID.");
    const claim = validateClaim(value, Number(suffix));
    claims.set(claim.downloadId, claim);
    if (claims.size > MAX_CLAIMS) throw problem("CACHE_RECEIPT_LIMIT", "Browser history exceeds the supported 20,000 download identities. Use a Library folder for a larger collection.");
  }
  return claims;
}

// Migrate old receipt rows only once. A claim remains after another copy
// replaces the latest receipt: the older Chrome file may still be present.
async function ensureClaims() {
  const index = validateIndex(await read(INDEX));
  if (index?.claimsVersion === 1) return index;
  const receipts = await allReceipts();
  const claims = await allClaims();
  for (const receipt of receipts) {
    const previous = claims.get(receipt.downloadId);
    if (previous && previous.mediaId !== receipt.mediaId) throw problem("CACHE_RECEIPT_CORRUPT", "A browser download is recorded for conflicting Reel identities.");
    if (!previous) claims.set(receipt.downloadId, { schemaVersion: 1, downloadId: receipt.downloadId,
      mediaId: receipt.mediaId, recordedAt: receipt.savedAt });
  }
  if (claims.size > MAX_CLAIMS) throw problem("CACHE_RECEIPT_LIMIT", "The browser download identity limit has been reached. Use a Library folder for further downloads.");
  const next = { schemaVersion: 1, count: receipts.length, claimsVersion: 1, claimsCount: claims.size };
  await write({ ...Object.fromEntries([...claims].map(([id, value]) => [`${CLAIM_PREFIX}${id}`, value])), [INDEX]: next });
  return next;
}

export async function isDownloadClaimedByOtherMedia(downloadId, mediaId) {
  if (!downloadIdentity(downloadId) || typeof mediaId !== "string" || !/^[1-9][0-9]{0,31}$/.test(mediaId)) {
    throw problem("CACHE_RECEIPT_INVALID", "A verified download and Reel identity are required for browser history.");
  }
  return locked(async () => {
    await ensureClaims();
    const claim = await readClaim(downloadId);
    return !!claim && claim.mediaId !== mediaId;
  });
}

async function indexCount({ repair = false } = {}) {
  const index = validateIndex(await read(INDEX));
  if (index === undefined || repair) return (await allReceipts()).length;
  return index.count;
}

export async function getReceipt(profileId, item) {
  const expected = identity(profileId, item);
  const value = await read(receiptKey(profileId, item));
  return value === undefined ? null : validateReceipt(value, expected);
}

export async function assertReceiptCapacity(profileId, item) {
  identity(profileId, item);
  return locked(async () => {
    const old = await getReceipt(profileId, item);
    let count = await indexCount();
    if (!old && count >= MAX_RECEIPTS) count = await indexCount({ repair: true });
    if (!old && count >= MAX_RECEIPTS) throw problem("CACHE_RECEIPT_LIMIT", "The browser receipt limit of 20,000 has been reached. Choose a Library folder before starting another download.");
    const index = await ensureClaims();
    if (index.claimsCount >= MAX_CLAIMS) throw problem("CACHE_RECEIPT_LIMIT", "The browser download identity limit of 20,000 has been reached. Choose a Library folder before starting another download.");
  });
}

function validDownload(download) {
  return object(download) && download.byExtensionId === chrome.runtime.id && downloadIdentity(download.id) &&
    download.state === "complete" && download.exists === true && safeFilename(basename(download.filename)) &&
    typeof download.mime === "string" && /^(video\/mp4|application\/(octet-stream|mp4))(?:;|$)/i.test(download.mime) &&
    isInstagramMediaUrl(download.url, { video: true }) && (!download.finalUrl || isInstagramMediaUrl(download.finalUrl, { video: true }));
}

async function search(query) {
  try {
    const result = await chrome.downloads.search(query);
    if (!Array.isArray(result)) throw new Error("Invalid browser history response");
    return result;
  } catch { throw problem("CACHE_HISTORY_UNAVAILABLE", "Chrome's download history could not be checked. Retry before downloading more videos."); }
}

export async function recordReceipt(profileId, item, download, { check } = {}) {
  const expected = identity(profileId, item);
  if (!validDownload(download) || !positive(download.fileSize)) {
    throw problem("CACHE_RECEIPT_UNVERIFIED", "The completed video's browser metadata is not yet confirmed. Check Chrome Downloads, then retry recording its history without another download.");
  }
  return locked(async () => {
    await check?.();
    const old = await getReceipt(profileId, item);
    let count = await indexCount();
    if (!old && count >= MAX_RECEIPTS) count = await indexCount({ repair: true });
    if (!old && count >= MAX_RECEIPTS) throw problem("CACHE_RECEIPT_LIMIT", "The browser receipt limit of 20,000 has been reached. Use a Library folder for further downloads.");
    const index = await ensureClaims();
    count = await indexCount();
    const claim = await readClaim(download.id);
    if (claim && claim.mediaId !== expected.mediaId) throw problem("CACHE_RECEIPT_IDENTITY_CONFLICT", "This Chrome download is already recorded for another Reel. Its history was kept unchanged.");
    if (!claim && index.claimsCount >= MAX_CLAIMS) throw problem("CACHE_RECEIPT_LIMIT", "The browser download identity limit of 20,000 has been reached. Use a Library folder for further downloads.");
    const value = { schemaVersion: 1, ...expected, downloadId: download.id, filename: basename(download.filename),
      bytesWritten: download.fileSize, savedAt: old?.downloadId === download.id ? old.savedAt : Date.now() };
    validateReceipt(value, expected);
    await check?.();
    await write({ [receiptKey(profileId, item)]: value,
      ...(!claim ? { [`${CLAIM_PREFIX}${download.id}`]: { schemaVersion: 1, downloadId: download.id,
        mediaId: expected.mediaId, recordedAt: value.savedAt } } : {}),
      [INDEX]: { schemaVersion: 1, count: count + (old ? 0 : 1), claimsVersion: 1, claimsCount: index.claimsCount + (claim ? 0 : 1) } });
    return value;
  });
}

export async function removeReceipt(profileId, mediaId, expected, { forgetDownload = false } = {}) {
  if (!profileIdentity(profileId) || typeof mediaId !== "string" || !/^[1-9][0-9]{0,31}$/.test(mediaId)) {
    throw problem("CACHE_RECEIPT_INVALID", "A verified profile and Reel identity are required to update browser history.");
  }
  return locked(async () => {
    const key = `${RECEIPT_PREFIX}${profileId}:${mediaId}`;
    const value = await read(key);
    if (value === undefined) return false;
    const receipt = validateReceipt(value);
    if (receipt.profileId !== profileId || receipt.mediaId !== mediaId) throw problem("CACHE_RECEIPT_CORRUPT", "A browser receipt has mismatched ownership.");
    // A slow existence check must not delete a newer completed save's receipt.
    if (expected && (receipt.downloadId !== expected.downloadId || receipt.filename !== expected.filename || receipt.bytesWritten !== expected.bytesWritten)) return false;
    const index = await ensureClaims();
    const count = await indexCount();
    const claim = forgetDownload ? await readClaim(receipt.downloadId) : null;
    const forgetClaim = claim?.mediaId === mediaId;
    try { await chrome.storage.local.remove(forgetClaim ? [key, `${CLAIM_PREFIX}${receipt.downloadId}`] : key); }
    catch { throw problem("CACHE_RECEIPT_WRITE_FAILED", "A stale browser receipt could not be removed. Retry its history update before downloading."); }
    await write({ [INDEX]: { schemaVersion: 1, count: Math.max(0, count - 1), claimsVersion: 1,
      claimsCount: Math.max(0, index.claimsCount - (forgetClaim ? 1 : 0)) } });
    return true;
  });
}

const cacheHit = receipt => ({ cacheHit: true, filename: receipt.filename, bytesWritten: receipt.bytesWritten,
  downloadId: receipt.downloadId, verification: "browser_receipt" });

export async function verifyReceipt(profileId, item, retryReplacement = true) {
  const receipt = await getReceipt(profileId, item);
  if (!receipt) return null;
  if (await isDownloadClaimedByOtherMedia(receipt.downloadId, item.mediaId)) {
    throw problem("CACHE_RECEIPT_IDENTITY_CONFLICT", "This browser receipt conflicts with another recorded Reel identity. Its history was kept unchanged.");
  }
  const matches = await search({ id: receipt.downloadId });
  const download = matches.find(value => value.id === receipt.downloadId);
  if (validDownload(download) && !positive(download.fileSize)) {
    throw problem("CACHE_RECEIPT_UNVERIFIED", "Chrome has not confirmed the saved video's size. Check Downloads, then retry its history check.");
  }
  if (!validDownload(download) || download.fileSize !== receipt.bytesWritten || basename(download.filename) !== receipt.filename) {
    const removed = await removeReceipt(profileId, item.mediaId, receipt, { forgetDownload: !download || download.exists === false });
    if (!removed && retryReplacement) return verifyReceipt(profileId, item, false);
    return null;
  }
  return cacheHit(receipt);
}

export function normalizeReport(profileId, report) {
  let bytes;
  try { bytes = new TextEncoder().encode(JSON.stringify(report)).length; } catch { bytes = Infinity; }
  if (!profileIdentity(profileId) || !object(report) || report.version !== 1 || !object(report.profile) ||
      report.profile.id !== profileId || !Array.isArray(report.items) || report.items.length > MAX_REPORT_ITEMS || bytes > MAX_REPORT_BYTES) {
    throw problem("CACHE_RECEIPT_REPORT_INVALID", "Choose a supported download report for this Instagram profile (up to 16 MiB and 50,000 items).");
  }
  const items = new Map();
  const claims = new Map();
  let ignored = 0;
  for (const entry of report.items) {
    if (entry?.state !== "saved") { ignored++; continue; }
    let checked;
    try { checked = identity(profileId, entry); } catch {
      throw problem("CACHE_RECEIPT_REPORT_INVALID", "A saved report entry has an invalid Reel identity.");
    }
    if (!safeFilename(entry.filename) || !positive(entry.bytesWritten)) throw problem("CACHE_RECEIPT_REPORT_INVALID", "A saved report entry needs an exact MP4 filename and positive file size.");
    const next = { mediaId: checked.mediaId, shortcode: checked.shortcode, filename: entry.filename, bytesWritten: entry.bytesWritten };
    const previous = items.get(checked.mediaId);
    const claimed = claims.get(entry.filename.toLowerCase());
    if (previous && (previous.filename !== next.filename || previous.bytesWritten !== next.bytesWritten) || claimed && claimed !== checked.mediaId) {
      throw problem("CACHE_RECEIPT_REPORT_INVALID", "The report assigns conflicting files or Reel identities. Its history was kept unchanged.");
    }
    if (previous) { ignored++; continue; }
    claims.set(entry.filename.toLowerCase(), checked.mediaId);
    items.set(checked.mediaId, next);
  }
  return { profileId, items: [...items.values()], ignored, total: report.items.length };
}

export async function verifyReportEntry(entry) {
  if (!object(entry) || !safeFilename(entry.filename) || !positive(entry.bytesWritten)) {
    throw problem("CACHE_RECEIPT_REPORT_INVALID", "A report entry needs an exact MP4 filename and positive file size.");
  }
  const filenameRegex = `(?:^|[\\\\/])${escapePattern(entry.filename)}$`;
  const matches = await search({ state: "complete", exists: true, filenameRegex, limit: MAX_CANDIDATES + 1, orderBy: ["-startTime"] });
  if (matches.length > MAX_CANDIDATES) throw problem("CACHE_RECEIPT_LIMIT", "Too many matching Chrome download records were returned. Narrow the report before importing.");
  return matches.find(value => validDownload(value) && basename(value.filename) === entry.filename && value.fileSize === entry.bytesWritten) || null;
}

export async function previewReport(profileId, report, { check } = {}) {
  await check?.();
  const normalized = normalizeReport(profileId, report);
  const current = await allReceipts();
  const historical = await allClaims();
  const claims = new Map([...historical].map(([id, value]) => [id, value.mediaId]));
  for (const value of current) {
    if (claims.has(value.downloadId) && claims.get(value.downloadId) !== value.mediaId) throw problem("CACHE_RECEIPT_CORRUPT", "A browser download is recorded for conflicting Reel identities.");
    claims.set(value.downloadId, value.mediaId);
  }
  const items = [];
  let missing = 0;
  for (const entry of normalized.items) {
    await check?.();
    const download = await verifyReportEntry(entry);
    await check?.();
    if (!download) { missing++; continue; }
    if (claims.has(download.id) && claims.get(download.id) !== entry.mediaId) {
      throw problem("CACHE_RECEIPT_REPORT_INVALID", "A matching download is already recorded for a different Reel. Its history was kept unchanged.");
    }
    claims.set(download.id, entry.mediaId);
    items.push({ ...entry, downloadId: download.id });
  }
  const recorded = new Set(current.filter(value => value.profileId === profileId).map(value => value.mediaId));
  const newRecords = items.filter(value => !recorded.has(value.mediaId)).length;
  if (current.length + newRecords > MAX_RECEIPTS) throw problem("CACHE_RECEIPT_LIMIT", "This report exceeds the remaining browser receipt capacity. Import a smaller report or use a Library folder.");
  const newClaims = new Set(items.filter(value => !claims.has(value.downloadId)).map(value => value.downloadId));
  if (claims.size + newClaims.size > MAX_CLAIMS) throw problem("CACHE_RECEIPT_LIMIT", "This report exceeds the remaining browser download identity capacity. Import a smaller report or use a Library folder.");
  return { profileId, items, counts: { total: normalized.total, eligible: items.length, missing, ignored: normalized.ignored } };
}

export async function importReport(profileId, report, options = {}) {
  const preview = await previewReport(profileId, report, options);
  let imported = 0;
  let missing = preview.counts.missing;
  for (const entry of preview.items) {
    await options.check?.();
    const download = await verifyReportEntry(entry);
    await options.check?.();
    if (!download) { missing++; continue; }
    await recordReceipt(profileId, entry, download, options);
    imported++;
  }
  return { imported, missing, ignored: preview.counts.ignored };
}
