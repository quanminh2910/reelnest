import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseReelUrl, isInstagramMediaUrl, validateMedia, publicMedia, buildFilename, summarizeDownload,
} from "../src/shared/core.js";

test("accepts individual Reel URLs and canonicalizes tracking parameters", () => {
  assert.deepEqual(parseReelUrl("https://instagram.com/reels/Ab_12-/?igsh=example#video"), {
    shortcode: "Ab_12-", pageUrl: "https://www.instagram.com/reel/Ab_12-/",
  });
  for (const value of [
    "https://instagram.com/creator/reels/", "https://instagram.com/reels/",
    "https://instagram.com/p/ABC/", "https://instagram.com/reel/ABC/extra",
    "https://instagram.com.attacker.test/reel/ABC/", "http://instagram.com/reel/ABC/",
    "https://user:password@instagram.com/reel/ABC/", "https://instagram.com:8443/reel/ABC/",
    "javascript:alert(1)", "https://instagram.com/reel/%2F/",
  ]) assert.equal(parseReelUrl(value), null, value);
});

test("media trust requires HTTPS, exact domain boundaries and a progressive MP4 path", () => {
  assert.equal(isInstagramMediaUrl("https://scontent.cdninstagram.com/v/file.mp4?token=one", { video: true }), true);
  assert.equal(isInstagramMediaUrl("https://video.xx.fbcdn.net/file.MP4", { video: true }), true);
  for (const url of [
    "https://cdninstagram.com.evil.test/file.mp4", "https://evilfbcdn.net/file.mp4",
    "https://person:secret@scontent.cdninstagram.com/file.mp4",
    "https://scontent.cdninstagram.com:8443/file.mp4",
    "https://scontent.cdninstagram.com/login", "https://scontent.cdninstagram.com/video.mpd",
    "blob:https://www.instagram.com/one", "http://scontent.cdninstagram.com/file.mp4",
  ]) assert.equal(isInstagramMediaUrl(url, { video: true }), false, url);
});

test("media is bound to the requested Reel and untrusted thumbnails are dropped", () => {
  const media = {
    shortcode: "ABC", pageUrl: "https://www.instagram.com/reel/ABC/",
    url: "https://scontent.cdninstagram.com/video.mp4", username: "creator",
    width: 720, height: 1280, thumbnailUrl: "https://evil.test/image.jpg",
  };
  assert.equal(validateMedia(media, "ABC").thumbnailUrl, undefined);
  assert.throws(() => validateMedia(media, "OTHER"), { code: "PAGE_CHANGED" });
});

test("media identity is decoded without losing precision and conflicts are rejected", () => {
  const shortcode = "CabcDEF_12-";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const mediaId = [...shortcode].reduce((id, character) => id * 64n + BigInt(alphabet.indexOf(character)), 0n).toString();
  const media = { shortcode, pageUrl: `https://www.instagram.com/reel/${shortcode}/`,
    url: "https://scontent.cdninstagram.com/video.mp4" };
  assert.equal(validateMedia(media, shortcode).mediaId, mediaId);
  assert.equal(validateMedia({ ...media, mediaId }, shortcode).mediaId, mediaId);
  for (const invalid of ["1", `${mediaId}_900`, `0${mediaId}`, Number(mediaId), {}]) {
    assert.throws(() => validateMedia({ ...media, mediaId: invalid }, shortcode), { code: "MEDIA_MISMATCH" });
  }
});

test("public media preserves a validated owner pair without requiring it for browser saves", () => {
  const media = { shortcode: "B", pageUrl: "https://www.instagram.com/reel/B/",
    url: "https://scontent.cdninstagram.com/video.mp4", username: "legacy_author" };
  const identity = { id: "1234567890", username: "the.owner", token: "discard" };
  const validated = validateMedia({ ...media, ownerProfile: identity }, "B");
  assert.deepEqual(validated.ownerProfile, { id: identity.id, username: identity.username });
  assert.equal(validated.username, identity.username);
  assert.notEqual(validated.ownerProfile, identity);
  const display = publicMedia(validated);
  assert.equal(display.url, undefined);
  assert.equal(display.mediaId, "1");
  assert.deepEqual(display.ownerProfile, validated.ownerProfile);
  assert.equal(validateMedia(media, "B").ownerProfile, undefined);
  for (const ownerProfile of [
    { id: "0", username: "author" }, { id: "001", username: "author" },
    { id: "1_2", username: "author" }, { id: "1".repeat(31), username: "author" },
    { id: Number.MAX_SAFE_INTEGER + 1, username: "author" },
    { id: "1", username: "../folder" }, { id: "1", username: "a".repeat(31) },
    { id: "1" }, { username: "author" },
  ]) {
    const fallback = validateMedia({ ...media, ownerProfile }, "B");
    assert.equal(fallback.ownerProfile, undefined);
    assert.equal(fallback.username, "legacy_author");
  }
});

test("filenames stay inside a fixed download subfolder and retain the Reel ID", () => {
  assert.equal(buildFilename({ username: "creator.name", shortcode: "Ab_12-" }),
    "Reel Saver/creator_name_Ab_12-.mp4");
  const filename = buildFilename({ username: "../../CON:\\folder\u202e\u0000", shortcode: "ABC" });
  assert.equal(filename.split("/").length, 2);
  assert.ok(!filename.includes(".."));
  assert.ok(!/[\u0000\u202e\\:]/.test(filename));
  assert.equal(buildFilename({ shortcode: "ABC" }), "Reel Saver/reel_ABC.mp4");
});

test("only completed MP4 downloads produce a saved state", () => {
  assert.equal(summarizeDownload({ id: 1, state: "in_progress", mime: "video/mp4" }).state, "in_progress");
  assert.equal(summarizeDownload({ id: 1, state: "complete", mime: "video/mp4", exists: true }).state, "complete");
  const wrongType = summarizeDownload({ id: 1, state: "complete", mime: "text/html" });
  assert.equal(wrongType.state, "interrupted");
  assert.match(wrongType.error, /instead of an MP4/);
  const deleted = summarizeDownload({ id: 1, state: "complete", exists: false });
  assert.equal(deleted.state, "interrupted");
  assert.match(deleted.error, /moved or removed/);
});

test("download errors are actionable and local paths are not exposed to popup", () => {
  const result = summarizeDownload({
    id: 2, state: "interrupted", error: "SERVER_FORBIDDEN", filename: "C:\\Users\\someone\\Downloads\\reel.mp4",
  });
  assert.match(result.error, /expired or was refused/);
  assert.equal(result.filename, "reel.mp4");
});
