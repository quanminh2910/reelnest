import { extractReel } from "../instagram/extractor.js";
import { handleBulkMessage, isBulkMessage, cleanupBulkTab, withJobRegistration } from "./bulk-background.js";
import { handleProfileQueueMessage, isProfileQueueMessage, cleanupProfileQueueTab } from "./profile-queue-background.js";
import { assertNoProfileQueue } from "./profile-queue-owner.js";
import {
  ReelError, parseReelUrl, validateMedia, publicMedia, buildFilename, summarizeDownload,
} from "../shared/core.js";

const cache = new Map();
const pendingDownloads = new Map();
const CACHE_TTL = 30_000;
const recordKey = (tabId) => `reel-saver:tab:${tabId}`;
const SETTINGS_KEY = "reel-saver:settings";
const supportedTypes = new Set([
  "REEL_SAVER_INSPECT", "REEL_SAVER_DOWNLOAD", "REEL_SAVER_STATUS",
  "REEL_SAVER_SETTINGS_GET", "REEL_SAVER_SETTINGS_SET", "REEL_SAVER_RESOLVE",
]);

function isInstagramPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && !url.username && !url.password &&
      ["instagram.com", "www.instagram.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function senderContext(sender, message) {
  if (sender?.id !== chrome.runtime.id) return null;
  if (sender.url === chrome.runtime.getURL("src/popup/popup.html")) {
    return { kind: "popup", tabId: message.tabId };
  }
  if (Number.isInteger(sender.tab?.id) && sender.tab.id >= 0 && sender.frameId === 0 &&
      isInstagramPage(sender.url) && isInstagramPage(sender.tab.url) &&
      (message.tabId === undefined || message.tabId === sender.tab.id)) {
    return { kind: "content", tabId: sender.tab.id };
  }
  return null;
}

async function getSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return { destination: stored?.destination === "ask" ? "ask" : "downloads" };
}

async function setSettings(settings) {
  if (!settings || !["downloads", "ask"].includes(settings.destination)) {
    throw new ReelError("INVALID_SETTINGS", "Choose Downloads or Ask each time as the browser save location.");
  }
  const value = { destination: settings.destination };
  await chrome.storage.local.set({ [SETTINGS_KEY]: value });
  return value;
}

async function currentReel(tabId, expectedShortcode) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new ReelError("INVALID_TAB", "Open an Instagram Reel in a browser tab first.");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new ReelError("TAB_CLOSED", "That tab is no longer open. Open the Reel and try again.");
  }
  const reel = parseReelUrl(tab.url);
  if (!reel) {
    throw new ReelError("NOT_REEL", "Open a Reel on instagram.com, then click ReelNest.");
  }
  if (expectedShortcode && expectedShortcode !== reel.shortcode) {
    throw new ReelError("PAGE_CHANGED", "The Reel changed. Open ReelNest again on the Reel you want.");
  }
  return reel;
}

async function inspect(tabId, expectedShortcode, fresh = false) {
  const reel = await currentReel(tabId, expectedShortcode);
  const stored = cache.get(tabId);
  if (!fresh && stored?.media.shortcode === reel.shortcode && Date.now() - stored.at < CACHE_TTL) {
    return stored.media;
  }
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: extractReel,
      args: [reel.shortcode],
    });
  } catch {
    throw new ReelError("PAGE_UNAVAILABLE", "Chrome could not read this Reel. Reload the page, then reopen ReelNest.");
  }
  const result = frames.find((frame) => frame.frameId === 0)?.result;
  if (!result?.ok) {
    throw new ReelError(result?.error?.code || "MEDIA_UNAVAILABLE",
      result?.error?.message || "No video was found. Play the Reel, then try again.");
  }
  await currentReel(tabId, reel.shortcode);
  const media = validateMedia(result.media, reel.shortcode);
  cache.set(tabId, { at: Date.now(), media });
  return media;
}

async function ownDownload(downloadId) {
  if (!Number.isInteger(downloadId) || downloadId < 0) return null;
  const items = await chrome.downloads.search({ id: downloadId });
  const item = items.find((entry) => entry.id === downloadId && entry.byExtensionId === chrome.runtime.id);
  return item ? summarizeDownload(item) : null;
}

async function previousDownload(tabId, shortcode) {
  const key = recordKey(tabId);
  const record = (await chrome.storage.session.get(key))[key];
  if (!record || record.shortcode !== shortcode) return null;
  return ownDownload(record.downloadId);
}

async function startDownload(tabId, shortcode) {
  if (!shortcode || !/^[A-Za-z0-9_-]{1,28}$/.test(shortcode)) {
    throw new ReelError("INVALID_REEL", "Open ReelNest again to find this Reel.");
  }
  await currentReel(tabId, shortcode);
  const previous = await previousDownload(tabId, shortcode);
  if (previous?.state === "in_progress") {
    const media = cache.get(tabId)?.media;
    return { ok: true, download: previous,
      ...(media?.shortcode === shortcode ? { media: publicMedia(media) } : {}) };
  }
  // Resolve again after clicking Download: signed CDN links may have expired since inspection.
  const media = await inspect(tabId, shortcode, true);
  await currentReel(tabId, shortcode);
  const settings = await getSettings();
  await currentReel(tabId, shortcode);
  let id;
  try {
    id = await withJobRegistration(async () => {
      await assertNoProfileQueue();
      return chrome.downloads.download({ url: media.url, filename: buildFilename(media),
        conflictAction: "uniquify", saveAs: settings.destination === "ask" });
    });
  } catch {
    throw new ReelError("DOWNLOAD_FAILED", "Chrome could not start the download. Reload the Reel, then retry.");
  }
  // Chrome owns the download, so closing the popup does not stop it.
  // Failure to save the optional UI record must not suggest that the download failed.
  await chrome.storage.session.set({
    [recordKey(tabId)]: { shortcode, downloadId: id },
  }).catch(() => {});
  const download = await ownDownload(id).catch(() => null) || { id, state: "in_progress" };
  return { ok: true, download, media: publicMedia(media) };
}

export async function handleMessage(message, sender) {
  if (isProfileQueueMessage(message)) return handleProfileQueueMessage(message, sender);
  if (isBulkMessage(message)) return handleBulkMessage(message, sender);
  if (!supportedTypes.has(message?.type)) return undefined;
  const context = senderContext(sender, message);
  if (!context) {
    return { ok: false, error: { code: "INVALID_SENDER", message: "Open ReelNest from Instagram or the Chrome toolbar." } };
  }
  try {
    if (["REEL_SAVER_RESOLVE", "REEL_SAVER_DOWNLOAD"].includes(message.type)) await assertNoProfileQueue();
    if (message.type === "REEL_SAVER_SETTINGS_GET") {
      return { ok: true, settings: await getSettings() };
    }
    if (message.type === "REEL_SAVER_SETTINGS_SET") {
      return { ok: true, settings: await setSettings(message.settings) };
    }
    if (message.type === "REEL_SAVER_STATUS") {
      if (context.kind === "content") {
        const key = recordKey(context.tabId);
        const record = (await chrome.storage.session.get(key))[key];
        if (record?.downloadId !== message.downloadId) {
          throw new ReelError("DOWNLOAD_MISSING", "No matching download was started from this tab.");
        }
      }
      const download = await ownDownload(message.downloadId);
      if (!download) throw new ReelError("DOWNLOAD_MISSING", "This download is no longer in Chrome Downloads.");
      return { ok: true, download };
    }
    if (message.type === "REEL_SAVER_RESOLVE") {
      if (context.kind !== "content") {
        throw new ReelError("INVALID_SENDER", "Choose a folder from the ReelNest panel on Instagram.");
      }
      if (!/^[A-Za-z0-9_-]{1,28}$/.test(message.shortcode || "")) {
        throw new ReelError("INVALID_REEL", "Open a Reel to save it to your chosen folder.");
      }
      const media = await inspect(context.tabId, message.shortcode, true);
      await currentReel(context.tabId, message.shortcode);
      return { ok: true, media, filename: buildFilename(media).split("/").pop() };
    }
    if (message.type === "REEL_SAVER_INSPECT") {
      const media = await inspect(context.tabId);
      const download = await previousDownload(context.tabId, media.shortcode);
      return { ok: true, media: publicMedia(media), ...(download ? { download } : {}) };
    }
    // Multiple popup requests share one operation per tab until Chrome accepts it.
    const key = `${context.tabId}:${message.shortcode}`;
    if (pendingDownloads.has(key)) return await pendingDownloads.get(key);
    const request = startDownload(context.tabId, message.shortcode);
    pendingDownloads.set(key, request);
    try {
      return await request;
    } finally {
      pendingDownloads.delete(key);
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof ReelError || error.code === "QUEUE_BUSY" ? error.code : "UNEXPECTED_ERROR",
        message: error instanceof ReelError || error.code === "QUEUE_BUSY" ? error.message : "Something went wrong. Reopen ReelNest and try again.",
      },
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!supportedTypes.has(message?.type) && !isBulkMessage(message) && !isProfileQueueMessage(message)) return false;
  handleMessage(message, sender).then(sendResponse, () => sendResponse({
    ok: false,
    error: { code: "UNEXPECTED_ERROR", message: "Something went wrong. Reopen ReelNest and try again." },
  }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cache.delete(tabId);
  chrome.storage.session.remove(recordKey(tabId)).catch(() => {});
  cleanupBulkTab(tabId).catch(() => {});
  cleanupProfileQueueTab(tabId, { closed: true }).catch(() => {});
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.discarded === true) {
    cleanupBulkTab(tabId).catch(() => {});
    cleanupProfileQueueTab(tabId, changeInfo).catch(() => {});
  }
});
