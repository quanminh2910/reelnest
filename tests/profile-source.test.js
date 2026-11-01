import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { profileSource } from "../src/instagram/profile-source.js";

const profile = { id: "1234567890", username: "example.creator" };
const profileUrl = `https://www.instagram.com/${profile.username}/reels/`;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function codeForId(id) {
  let value = BigInt(id);
  let code = "";
  do { code = alphabet[Number(value % 64n)] + code; value /= 64n; } while (value);
  return code;
}
const item = { mediaId: "9876543210", shortcode: codeForId("9876543210") };
const videoUrl = "https://scontent.cdninstagram.com/reel.mp4?fixture=local";

function media(overrides = {}) {
  return { pk: item.mediaId, code: item.shortcode, media_type: 2,
    user: { username: "collaborating_creator" },
    video_versions: [
      { url: "https://scontent.cdninstagram.com/small.mp4", width: 360, height: 640 },
      { url: videoUrl, width: 1080, height: 1920 },
    ],
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/poster.jpg", width: 1080, height: 1920 }] },
    ...overrides };
}

function connection({ entries = [media()], more = false, cursor = null } = {}) {
  return { xdt_api__v1__clips__user__connection_v2: {
    edges: entries.map(value => ({ node: { media: value } })),
    page_info: { has_next_page: more, end_cursor: cursor },
  } };
}

function fixture(options = {}) {
  const state = { calls: [], required: [], unsubscribed: 0 };
  const records = options.records || {};
  const environment = { getStore: () => ({ getSource: () => ({
    getRecordIDs: () => Object.keys(records), get: id => records[id],
  }) }) };
  const descriptor = { params: { id: "CURRENT_PAGE_DESCRIPTOR_ID", name: "PolarisProfileReelsTabContentQuery_connection" },
    fragment: { argumentDefinitions: [
      { kind: "LocalArgument", name: "data", defaultValue: { foo: "keep", page_size: 99, target_user_id: "wrong" } },
      { kind: "LocalArgument", name: "after", defaultValue: null },
      { kind: "LocalArgument", name: "renderFlag", defaultValue: true },
    ] } };
  const api = { apiGet: async (...args) => {
    state.calls.push({ type: "api", args });
    if (options.apiGet) return options.apiGet(...args);
    return args[0].includes("web_profile_info") ? { data: { user: profile } } : { data: { items: [media()] } };
  } };
  const relay = { fetchQuery: (env, query, variables, fetchOptions) => {
    state.calls.push({ type: "relay", env, query, variables, fetchOptions });
    if (options.fetchQuery) return options.fetchQuery(env, query, variables, fetchOptions, state);
    return { subscribe(observer) {
      const subscription = { unsubscribe() { state.unsubscribed++; } };
      observer.start?.(subscription);
      observer.next(options.response ?? connection());
      observer.complete();
      return subscription;
    } };
  } };
  const modules = {
    PolarisInstapi: api,
    PolarisRelayEnvironment: environment,
    CometRelay: relay,
    "PolarisProfileReelsTabContentQuery_connection.graphql": descriptor,
    ...options.modules,
  };
  const window = { location: { href: options.href || profileUrl }, require(name) {
    state.required.push(name);
    if (!Object.hasOwn(modules, name)) throw new Error("Not loaded");
    return modules[name];
  } };
  window.top = window;
  const document = { querySelectorAll: () => (options.scripts || []).map(value => ({ textContent: JSON.stringify(value) })) };
  const context = { window, document, URL, setTimeout: options.setTimeout || setTimeout, clearTimeout };
  return { context, state, descriptor, environment, api };
}

async function run(f, request) {
  f.context.request = request;
  const result = await vm.runInNewContext(`(${profileSource.toString()})(request)`, f.context);
  return JSON.parse(JSON.stringify(result));
}

test("serialized profile identification uses the current page client and exact username", async () => {
  const f = fixture();
  const result = await run(f, { action: "identify" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, profile);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.calls[0].args)), ["/api/v1/users/web_profile_info/", { query: { username: profile.username } }]);
});

test("profile identification accepts the nested Polaris response/body data envelope", async () => {
  const f = fixture({ apiGet: async () => ({ data: { data: { user: profile }, status: "ok" } }) });
  const result = await run(f, { action: "identify" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, profile);
});

test("identification reads an exact user record already in the Relay store without an HTTP request", async () => {
  const f = fixture({ records: {
    "XDTUserDict:777": { username: "someone_else", pk: "777" },
    [`XDTUserDict:${profile.id}`]: { username: profile.username },
  } });
  const result = await run(f, { action: "identify" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, profile);
  assert.equal(f.state.calls.length, 0);
});

test("embedded exact-profile JSON can identify a profile when its API module is not loaded", async () => {
  const f = fixture({ scripts: [{ data: { user: profile } }], modules: { PolarisInstapi: null } });
  assert.equal((await run(f, { action: "identify" })).profile.id, profile.id);
  assert.equal(f.state.calls.length, 0);
});

test("rejects foreign/credentialed/iframe and non-profile routes without network activity", async () => {
  for (const href of [
    "https://www.instagram.com/", "https://www.instagram.com/reel/ABC/", "https://www.instagram.com/accounts/login/",
    "https://instagram.com.evil.test/example.creator/", "http://www.instagram.com/example.creator/",
    "https://user:pass@www.instagram.com/example.creator/", "https://www.instagram.com:8443/example.creator/",
  ]) {
    const f = fixture({ href });
    assert.equal((await run(f, { action: "identify" })).error.code, "NOT_PROFILE", href);
    assert.equal(f.state.calls.length, 0);
  }
  const iframe = fixture();
  iframe.context.window.top = {};
  assert.equal((await run(iframe, { action: "identify" })).error.code, "NOT_PROFILE");
});

test("discovery uses the loaded descriptor/default variables and current first-party Relay environment", async () => {
  const f = fixture({ response: connection({ more: true, cursor: "NEXT_PAGE" }) });
  const result = await run(f, { action: "page", profile, cursor: "PREVIOUS_PAGE" });
  assert.equal(result.ok, true);
  assert.equal(result.page.hasMore, true);
  assert.equal(result.page.nextCursor, "NEXT_PAGE");
  assert.equal(result.page.items[0].mediaId, item.mediaId);
  assert.equal(result.page.items[0].username, "collaborating_creator", "a collaborative Reel is not excluded by author mismatch");
  const call = f.state.calls.find(value => value.type === "relay");
  assert.equal(call.query, f.descriptor);
  assert.equal(call.env, f.environment);
  assert.deepEqual(JSON.parse(JSON.stringify(call.variables)), {
    data: { foo: "keep", include_feed_video: true, page_size: 12, target_user_id: profile.id },
    after: "PREVIOUS_PAGE", renderFlag: true,
  });
  assert.equal(call.fetchOptions.fetchPolicy, "network-only");
  assert.equal(f.state.calls.filter(value => value.type === "api").length, 0);
});

test("derives missing shortcodes and deduplicates pinned IDs within a page", async () => {
  const f = fixture({ response: connection({ entries: [media({ code: undefined }), media({ code: undefined })] }) });
  const result = await run(f, { action: "page", profile });
  assert.equal(result.ok, true);
  assert.equal(result.page.items.length, 1);
  assert.equal(result.page.items[0].shortcode, item.shortcode);
});

test("explicit empty end-of-list is accepted, but absent or contradictory pagination is incomplete", async () => {
  const empty = await run(fixture({ response: connection({ entries: [] }) }), { action: "page", profile });
  assert.equal(empty.ok, true);
  assert.equal(empty.page.items.length, 0);
  assert.equal(empty.page.hasMore, false);
  for (const response of [
    {}, { xdt_api__v1__clips__user__connection_v2: { edges: [] } },
    connection({ more: true, cursor: null }),
    { xdt_api__v1__clips__user__connection_v2: { edges: [{}], page_info: { has_next_page: false } } },
    connection({ entries: [media({ code: "wrong" })] }),
  ]) {
    const result = await run(fixture({ response }), { action: "page", profile });
    assert.equal(result.ok, false);
    assert.ok(["SCHEMA_CHANGED", "PAGINATION_STALLED"].includes(result.error.code));
    assert.equal(result.error.stage, "discovery");
  }
  const repeated = await run(fixture({ response: connection({ more: true, cursor: "SAME" }) }), { action: "page", profile, cursor: "SAME" });
  assert.equal(repeated.error.code, "PAGINATION_STALLED");
});

test("module unavailability is reported explicitly rather than pretending the profile is empty", async () => {
  const f = fixture({ modules: { "PolarisProfileReelsTabContentQuery_connection.graphql": null } });
  const result = await run(f, { action: "page", profile });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ADAPTER_UNAVAILABLE");
  assert.match(result.error.message, /Reels tab/);
  assert.equal(f.state.calls.length, 0);
});

test("waits for the complete Relay query snapshot instead of treating an incremental payload as the final page", async () => {
  const f = fixture({ fetchQuery: () => ({ subscribe(observer) {
    const subscription = { unsubscribe() {} };
    observer.start?.(subscription);
    observer.next({});
    observer.next(connection({ more: true, cursor: "COMPLETE_CURSOR" }));
    observer.complete();
    return subscription;
  } }) });
  const result = await run(f, { action: "page", profile });
  assert.equal(result.ok, true);
  assert.equal(result.page.nextCursor, "COMPLETE_CURSOR");
});

test("navigation and changed profile identity are rejected before returning a page", async () => {
  const f = fixture({ fetchQuery: () => ({ subscribe(observer) {
    f.context.window.location.href = "https://www.instagram.com/another_profile/reels/";
    observer.next(connection()); observer.complete(); return { unsubscribe() {} };
  } }) });
  assert.equal((await run(f, { action: "page", profile })).error.code, "PROFILE_CHANGED");
  const changed = fixture({ records: { "XDTUserDict:999": { username: profile.username, pk: "999" } } });
  assert.equal((await run(changed, { action: "page", profile })).error.code, "PROFILE_CHANGED");
  const wrongProfile = fixture();
  assert.equal((await run(wrongProfile, { action: "page", profile: { id: "123", username: "other" } })).error.code, "PROFILE_CHANGED");
});

test("resolve works on the profile without individual Reel navigation and picks the largest trusted MP4", async () => {
  const f = fixture();
  const result = await run(f, { action: "resolve", profile, item });
  assert.equal(result.ok, true);
  assert.equal(result.media.mediaId, item.mediaId);
  assert.equal(result.media.shortcode, item.shortcode);
  assert.equal(result.media.url, videoUrl);
  assert.equal(result.media.width, 1080);
  assert.equal(result.media.pageUrl, `https://www.instagram.com/reel/${item.shortcode}/`);
  assert.equal(f.context.window.location.href, profileUrl);
  assert.equal(f.state.calls[0].args[0], `/api/v1/media/${item.mediaId}/info/`);
});

test("resolve validates both numeric ID and shortcode; wrong files never become downloadable", async () => {
  for (const record of [media({ pk: "123" }), media({ code: "OTHER" })]) {
    const f = fixture({ apiGet: async () => ({ data: { items: [record] } }) });
    assert.equal((await run(f, { action: "resolve", profile, item })).error.code, "MEDIA_MISMATCH");
  }
  const f = fixture();
  assert.equal((await run(f, { action: "resolve", profile, item: { ...item, shortcode: "WRONG" } })).error.code, "INVALID_MEDIA");
  assert.equal(f.state.calls.length, 0);
});

test("unavailable media is skipped distinctly from changed schema and foreign video addresses", async () => {
  const empty = fixture({ apiGet: async () => ({ data: { items: [] } }) });
  assert.equal((await run(empty, { action: "resolve", profile, item })).error.code, "MEDIA_UNAVAILABLE");
  const malformed = fixture({ apiGet: async () => ({ data: {} }) });
  assert.equal((await run(malformed, { action: "resolve", profile, item })).error.code, "SCHEMA_CHANGED");
  for (const url of ["https://evil.test/video.mp4", "blob:https://www.instagram.com/one", "https://scontent.cdninstagram.com/video.mpd"]) {
    const f = fixture({ apiGet: async () => ({ data: { items: [media({ video_versions: [{ url, width: 720, height: 1280 }] })] } }) });
    assert.equal((await run(f, { action: "resolve", profile, item })).error.code, "MEDIA_UNAVAILABLE");
  }
});

test("auth, challenge, rate limits and temporary network failures have typed recovery information", async () => {
  for (const [error, expected, retryable] of [
    [{ statusCode: 401 }, "LOGIN_REQUIRED", false],
    [{ message: "challenge_required" }, "CHECKPOINT_REQUIRED", false],
    [{ status: 429, retry_after: 10 }, "RATE_LIMITED", false],
    [{ status: 503 }, "NETWORK_ERROR", true],
  ]) {
    const f = fixture({ apiGet: async () => { throw error; } });
    const result = await run(f, { action: "resolve", profile, item });
    assert.equal(result.error.code, expected);
    assert.equal(result.error.retryable, retryable);
    if (expected === "RATE_LIMITED") assert.equal(result.error.retryAfterMs, 10000);
  }
});

test("stalled query is bounded and unsubscribed rather than left fetching forever", async () => {
  const f = fixture({ setTimeout: callback => setTimeout(callback, 5),
    fetchQuery: (env, query, variables, options, state) => ({ subscribe(observer) {
      const subscription = { unsubscribe() { state.unsubscribed++; } };
      observer.start?.(subscription);
      return subscription;
    } }),
  });
  const result = await run(f, { action: "page", profile });
  assert.equal(result.error.code, "LOOKUP_TIMEOUT");
  assert.equal(result.error.retryable, true);
  assert.equal(f.state.unsubscribed, 1);
});
