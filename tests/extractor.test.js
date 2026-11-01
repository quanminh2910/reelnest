import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractReel } from "../src/instagram/extractor.js";

const shortcode = "CabcDEF_12-";
const reelUrl = `https://www.instagram.com/reel/${shortcode}/`;
const smallUrl = "https://scontent.cdninstagram.com/small.mp4?token=example";
const largeUrl = "https://scontent.cdninstagram.com/large.mp4?token=example";

function apiItem(overrides = {}) {
  return {
    code: shortcode,
    media_type: 2,
    user: { username: "reel_author" },
    video_versions: [
      { url: smallUrl, width: 360, height: 640 },
      { url: largeUrl, width: 1080, height: 1920 },
    ],
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/poster.jpg", width: 1080, height: 1920 }] },
    ...overrides,
  };
}

function environment({ href = reelUrl, apiGet, require: requireModule, scripts = [], meta = {}, videos = [], timeout } = {}) {
  const window = {
    location: { href }, innerHeight: 900, innerWidth: 1200,
    ...(apiGet ? { require: () => ({ apiGet }) } : {}),
    ...(requireModule ? { require: requireModule } : {}),
  };
  window.top = window;
  const document = {
    querySelectorAll(selector) {
      return selector === "video" ? videos : scripts.map(value => ({ textContent: typeof value === "string" ? value : JSON.stringify(value) }));
    },
    querySelector(selector) {
      const property = selector.match(/meta\[property="([^"]+)"\]/)?.[1];
      return property && meta[property] ? { content: meta[property] } : null;
    },
  };
  return { window, document, URL, setTimeout: timeout || setTimeout, clearTimeout, expectedShortcode: shortcode };
}

async function run(context) {
  // This deliberately serializes the injected function, as Chrome does.
  const result = await vm.runInNewContext(`(${extractReel.toString()})(expectedShortcode)`, context);
  return JSON.parse(JSON.stringify(result));
}

test("standalone injected function selects the largest progressive video and preserves signed URL", async () => {
  let requestedPath;
  const result = await run(environment({ apiGet: async path => {
    requestedPath = path;
    return { data: { items: [apiItem()] } };
  } }));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const expectedId = [...shortcode].reduce((id, character) => id * 64n + BigInt(alphabet.indexOf(character)), 0n);
  assert.equal(requestedPath, `/api/v1/media/${expectedId}/info/`);
  assert.equal(result.ok, true);
  assert.equal(result.media.url, largeUrl);
  assert.equal(result.media.width, 1080);
  assert.equal(result.media.username, "reel_author");
  assert.equal(result.media.source, "instagram-api");
  assert.equal(result.media.mediaId, expectedId.toString());
});

test("author identity belongs to the exact matched first-party media record", async () => {
  const result = await run(environment({ apiGet: async () => ({ data: { items: [
    apiItem({ code: "another_reel", user: { pk: "111", username: "recommendation" } }),
    apiItem({ user: { pk: "1234567890", username: "reel_author" } }),
  ] } }) }));
  assert.deepEqual(result.media.ownerProfile, { id: "1234567890", username: "reel_author" });
  const embedded = await run(environment({ scripts: [{
    shortcode, video_url: largeUrl, owner: { id: "12345678901234567890", username: "embedded_author" },
  }] }));
  assert.deepEqual(embedded.media.ownerProfile, { id: "12345678901234567890", username: "embedded_author" });
});

test("missing or invalid author IDs never borrow identity from recommendations or profile context", async () => {
  for (const user of [
    { username: "reel_author" }, { pk: "0", username: "reel_author" },
    { pk: "123_456", username: "reel_author" },
    { pk: Number.MAX_SAFE_INTEGER + 1, username: "reel_author" },
    { pk: "123", username: "../other_profile" }, { pk: "123" },
  ]) {
    const result = await run(environment({ apiGet: async () => ({ data: { items: [apiItem({
      user, recommendations: [{ user: { pk: "999", username: "another_author" } }],
    })] } }) }));
    assert.equal(result.ok, true);
    assert.equal(result.media.ownerProfile, undefined);
  }
  const pair = await run(environment({ apiGet: async () => ({ data: { items: [apiItem({
    user: { pk: "123" }, owner: { username: "unpaired_name" },
  })] } }) }));
  assert.equal(pair.media.ownerProfile, undefined);
});

test("rejects other sites, lookalike hosts, feed pages, and post routes", async () => {
  for (const href of ["https://instagram.com.evil.test/reel/abc/", "https://www.instagram.com:8443/reel/abc/", "https://www.instagram.com/reel/abcdefghijklmnopqrstuvwxyz123/", "https://www.instagram.com/", "https://www.instagram.com/p/abc/", "http://www.instagram.com/reel/abc/"]) {
    assert.equal((await run(environment({ href }))).error.code, "NOT_REEL");
  }
});

test("accepts /reels/ route and query parameters", async () => {
  const result = await run(environment({ href: `https://www.instagram.com/reels/${shortcode}/?share=1`, apiGet: async () => ({ data: { items: [apiItem()] } }) }));
  assert.equal(result.ok, true);
  assert.equal(result.media.pageUrl, reelUrl);
});

test("never uses a response for another Reel", async () => {
  const result = await run(environment({ apiGet: async () => ({ data: { items: [apiItem({ code: "different_reel" })] } }) }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MEDIA_UNAVAILABLE");
});

test("accepts a matching numeric media ID if Instagram omits the shortcode", async () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const id = [...shortcode].reduce((value, character) => value * 64n + BigInt(alphabet.indexOf(character)), 0n).toString();
  const result = await run(environment({ apiGet: async () => ({ data: { items: [apiItem({ code: undefined, pk: id })] } }) }));
  assert.equal(result.ok, true);
});

test("rejects navigation while the media request is running", async () => {
  const context = environment();
  context.window.require = () => ({ apiGet: async () => {
    context.window.location.href = "https://www.instagram.com/reel/another_one/";
    return { data: { items: [apiItem()] } };
  } });
  assert.equal((await run(context)).error.code, "PAGE_CHANGED");
});

test("rejects a stale expected shortcode before making a request", async () => {
  let requested = false;
  const context = environment({ apiGet: async () => { requested = true; } });
  context.expectedShortcode = "another_one";
  assert.equal((await run(context)).error.code, "PAGE_CHANGED");
  assert.equal(requested, false);
});

test("reports login, account challenge, and rate limit errors", async () => {
  for (const [message, expected] of [["login_required", "LOGIN_REQUIRED"], ["challenge_required", "CHECKPOINT_REQUIRED"], ["Please wait a few minutes", "RATE_LIMITED"]]) {
    const result = await run(environment({ apiGet: async () => { throw new Error(message); } }));
    assert.equal(result.error.code, expected);
  }
  const result = await run(environment({ apiGet: async () => ({ data: { status: "fail", message: "login_required" } }) }));
  assert.equal(result.error.code, "LOGIN_REQUIRED");
});

test("uses embedded JSON only when its own media record matches the current shortcode", async () => {
  const result = await run(environment({ scripts: [
    { data: apiItem({ code: "different_reel" }) },
    { data: { shortcode, video_url: largeUrl, dimensions: { width: 1080, height: 1920 }, owner: { username: "embedded_author" } } },
  ] }));
  assert.equal(result.ok, true);
  assert.equal(result.media.username, "embedded_author");
  assert.equal(result.media.source, "page-data");
});

test("does not take a nested recommendation's video for a matching non-video record", async () => {
  const result = await run(environment({ scripts: [{ shortcode, recommendations: [apiItem({ code: "other" })] }] }));
  assert.equal(result.error.code, "MEDIA_UNAVAILABLE");
});

test("requires current-Reel identity for Open Graph fallback", async () => {
  const valid = await run(environment({ meta: { "og:url": reelUrl, "og:video": largeUrl } }));
  assert.equal(valid.ok, true);
  assert.equal(valid.media.source, "page-metadata");
  assert.equal(typeof valid.media.mediaId, "string");
  assert.equal(valid.media.ownerProfile, undefined);
  const stale = await run(environment({ meta: { "og:url": "https://www.instagram.com/reel/other/", "og:video": largeUrl } }));
  assert.equal(stale.error.code, "MEDIA_UNAVAILABLE");
  const absent = await run(environment({ meta: { "og:video": largeUrl } }));
  assert.equal(absent.error.code, "MEDIA_UNAVAILABLE");
});

test("rejects blob, insecure, playlist, credential-bearing, and foreign media URLs", async () => {
  for (const url of ["blob:https://www.instagram.com/123", "http://scontent.cdninstagram.com/video.mp4", "https://scontent.cdninstagram.com/video.mpd", "https://scontent.cdninstagram.com/poster.jpg", "https://evil.test/video.mp4", "https://cdninstagram.com.evil.test/video.mp4", "https://user:pass@scontent.cdninstagram.com/video.mp4"]) {
    const result = await run(environment({ apiGet: async () => ({ data: { items: [apiItem({ video_versions: [{ url, width: 1080, height: 1920 }] })] } }) }));
    assert.equal(result.error.code, "MEDIA_UNAVAILABLE", url);
  }
});

function video({ permalink = reelUrl, src = largeUrl, audio = true, visible = true } = {}) {
  return {
    currentSrc: src, webkitAudioDecodedByteCount: audio ? 100 : 0, videoWidth: 720, videoHeight: 1280,
    closest: () => ({ querySelectorAll: () => [{ href: permalink }] }),
    getBoundingClientRect: () => ({ top: visible ? 0 : 1000, bottom: visible ? 500 : 1500, left: 0, right: 300, width: 300, height: 500 }),
  };
}

test("DOM fallback requires a visible, scoped, complete video with audio", async () => {
  const result = await run(environment({ videos: [video()] }));
  assert.equal(result.ok, true);
  assert.equal(result.media.source, "page-video");
  assert.equal(typeof result.media.mediaId, "string");
  assert.equal(result.media.ownerProfile, undefined);
  for (const candidate of [video({ permalink: "https://www.instagram.com/reel/other/" }), video({ src: "blob:https://www.instagram.com/1" }), video({ audio: false }), video({ visible: false })]) {
    assert.equal((await run(environment({ videos: [candidate] }))).error.code, "MEDIA_UNAVAILABLE");
  }
});

test("bounds stalled API lookups and still permits matching page-data fallback", async () => {
  const timeout = callback => setTimeout(callback, 5);
  const stalled = () => new Promise(() => {});
  const result = await run(environment({ apiGet: stalled, timeout }));
  assert.equal(result.error.code, "LOOKUP_TIMEOUT");
  const fallback = await run(environment({ apiGet: stalled, timeout, scripts: [apiItem()] }));
  assert.equal(fallback.ok, true);
  assert.equal(fallback.media.source, "page-data");
});
