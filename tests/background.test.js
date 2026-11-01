import assert from 'node:assert/strict';
import { test } from 'node:test';

const REEL_URL = 'https://www.instagram.com/reel/ABC123/';
const EXTENSION_ID = 'reelsavertestextension';
const sender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/src/popup/popup.html`,
};
const profileSender = {
  id: EXTENSION_ID,
  tab: { id: 7, url: 'https://www.instagram.com/example_creator/' },
  frameId: 0,
  url: 'https://www.instagram.com/example_creator/',
};
const reelSender = { ...profileSender, url: REEL_URL };

function fixture() {
  const state = {
    tab: { id: 7, url: REEL_URL },
    session: {},
    local: {},
    downloads: [],
    calls: { extraction: 0, downloads: 0, downloadOptions: [] },
    media: {
      shortcode: 'ABC123',
      pageUrl: REEL_URL,
      username: 'example_creator',
      width: 720,
      height: 1280,
      url: 'https://scontent.cdninstagram.com/video/reel.mp4?token=example',
      thumbnailUrl: 'https://scontent.cdninstagram.com/image/poster.jpg',
      source: 'media-api',
    },
  };

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path = '') => `chrome-extension://${EXTENSION_ID}/${path}`,
      onMessage: { addListener() {} },
    },
    tabs: {
      async get() { return { ...state.tab }; },
      onRemoved: { addListener() {} },
    },
    scripting: {
      async executeScript() {
        state.calls.extraction += 1;
        if (state.injectionError) throw state.injectionError;
        const media = { ...state.media };
        if (state.navigateDuringExtraction) state.tab.url = state.navigateDuringExtraction;
        return [{ frameId: 0, result: { ok: true, media } }];
      },
    },
    downloads: {
      async download(options) {
        state.calls.downloads += 1;
        state.calls.downloadOptions.push({ ...options });
        if (state.downloadError) throw state.downloadError;
        const id = state.downloads.length + 1;
        state.downloads.push({
          id,
          url: options.url,
          finalUrl: options.url,
          filename: options.filename,
          byExtensionId: EXTENSION_ID,
          state: 'in_progress',
          exists: true,
        });
        return id;
      },
      async search(query) {
        const items = query.id === undefined
          ? state.downloads
          : state.downloads.filter((item) => item.id === query.id);
        return items.map((item) => ({ ...item }));
      },
      onChanged: { addListener() {} },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return { ...state.local };
          if (typeof keys === 'string') return { [keys]: state.local[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, state.local[key]]));
          return { ...keys, ...state.local };
        },
        async set(values) { Object.assign(state.local, structuredClone(values)); },
      },
      session: {
        async get(keys) {
          if (keys === null || keys === undefined) return { ...state.session };
          if (typeof keys === 'string') return { [keys]: state.session[keys] };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, state.session[key]]));
          }
          return { ...keys, ...state.session };
        },
        async set(values) { Object.assign(state.session, structuredClone(values)); },
        async remove(keys) {
          for (const key of typeof keys === 'string' ? [keys] : keys) delete state.session[key];
        },
      },
    },
  };
  return { state, chrome };
}

let importId = 0;
async function load(f) {
  globalThis.chrome = f.chrome;
  return import(`../src/background/background.js?background-test=${++importId}`);
}

function inspect(handleMessage) {
  return handleMessage({ type: 'REEL_SAVER_INSPECT', tabId: 7 }, sender);
}

function download(handleMessage, shortcode = 'ABC123') {
  return handleMessage({ type: 'REEL_SAVER_DOWNLOAD', tabId: 7, shortcode }, sender);
}

test('inspection extracts media without starting a download', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const result = await inspect(handleMessage);
  assert.equal(result.ok, true);
  assert.equal(result.media.shortcode, 'ABC123');
  assert.equal(f.state.calls.extraction, 1);
  assert.equal(f.state.calls.downloads, 0);
  assert.equal(result.media.url, undefined, 'signed media URL stays out of the popup response');
});

test('only the extension popup can request privileged operations', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const result = await handleMessage(
    { type: 'REEL_SAVER_DOWNLOAD', tabId: 7, shortcode: 'ABC123' },
    { id: 'another-extension', url: 'https://www.instagram.com/reel/ABC123/' },
  );
  assert.equal(result?.ok, false);
  assert.equal(f.state.calls.extraction, 0);
  assert.equal(f.state.calls.downloads, 0);
});

test('a non-Instagram tab is rejected before page injection', async () => {
  const f = fixture();
  f.state.tab.url = 'https://example.com/reel/ABC123/';
  const { handleMessage } = await load(f);
  const result = await inspect(handleMessage);
  assert.equal(result.ok, false);
  assert.equal(f.state.calls.extraction, 0);
});

test('a stale popup cannot download a different Reel', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const result = await download(handleMessage, 'OTHER_REEL');
  assert.equal(result.ok, false);
  assert.equal(f.state.calls.downloads, 0);
});

test('navigation during media lookup is rejected', async () => {
  const f = fixture();
  f.state.navigateDuringExtraction = 'https://www.instagram.com/reel/DIFFERENT/';
  const { handleMessage } = await load(f);
  const result = await download(handleMessage);
  assert.equal(result.ok, false);
  assert.equal(f.state.calls.downloads, 0);
});

test('untrusted media hosts and insecure media URLs are rejected', async (t) => {
  for (const url of [
    'https://cdninstagram.com.attacker.example/reel.mp4',
    'https://attacker.example/reel.mp4',
    'http://scontent.cdninstagram.com/reel.mp4',
    'blob:https://www.instagram.com/not-a-progressive-mp4',
    'javascript:alert(1)',
  ]) {
    await t.test(url, async () => {
      const f = fixture();
      f.state.media.url = url;
      const { handleMessage } = await load(f);
      const result = await download(handleMessage);
      assert.equal(result.ok, false);
      assert.equal(f.state.calls.downloads, 0);
    });
  }
});

test('injection failure produces an actionable error without a download', async () => {
  const f = fixture();
  f.state.injectionError = new Error('Cannot access contents of url');
  const { handleMessage } = await load(f);
  const result = await inspect(handleMessage);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
  assert.equal(f.state.calls.downloads, 0);
});

test('explicit download starts an MP4 browser download', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const result = await download(handleMessage);
  assert.equal(result.ok, true);
  assert.equal(result.download.state, 'in_progress');
  assert.equal(f.state.calls.downloads, 1);
  assert.match(f.state.downloads[0].filename, /\.mp4$/);
  assert.equal(f.state.downloads[0].url, f.state.media.url);
});

test('a second click reuses an in-progress download for the same Reel', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const first = await download(handleMessage);
  const second = await download(handleMessage);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.download.id, first.download.id);
  assert.equal(f.state.calls.downloads, 1);
});

test('returning to an in-progress Reel cannot expose cached media for another Reel', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const original = await download(handleMessage);
  f.state.tab.url = 'https://www.instagram.com/reel/REEL_B/';
  f.state.media.shortcode = 'REEL_B';
  f.state.media.pageUrl = f.state.tab.url;
  const other = await inspect(handleMessage);
  assert.equal(other.media.shortcode, 'REEL_B');
  f.state.tab.url = REEL_URL;
  const restored = await download(handleMessage);
  assert.equal(restored.ok, true);
  assert.equal(restored.download.id, original.download.id);
  assert.ok(!restored.media || restored.media.shortcode === 'ABC123');
  assert.equal(f.state.calls.downloads, 1);
});

test('concurrent download requests share one browser download', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const [first, second] = await Promise.all([
    download(handleMessage), download(handleMessage),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.download.id, second.download.id);
  assert.equal(f.state.calls.downloads, 1);
});

test('browser download rejection does not record a successful download', async () => {
  const f = fixture();
  f.state.downloadError = new Error('Download rejected');
  const { handleMessage } = await load(f);
  const result = await download(handleMessage);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DOWNLOAD_FAILED');
  assert.deepEqual(f.state.session, {});
});

test('an interrupted download can be retried', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  await download(handleMessage);
  f.state.downloads[0].state = 'interrupted';
  f.state.downloads[0].error = 'NETWORK_FAILED';
  const result = await download(handleMessage);
  assert.equal(result.ok, true);
  assert.equal(result.download.id, 2);
  assert.equal(f.state.calls.downloads, 2);
});

test('download status survives worker restart and uses actual browser completion', async () => {
  const f = fixture();
  const initial = await load(f);
  const first = await download(initial.handleMessage);
  f.state.downloads[0].state = 'complete';
  const restarted = await load(f);
  const inspected = await inspect(restarted.handleMessage);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.download.id, first.download.id);
  assert.equal(inspected.download.state, 'complete');
  const status = await restarted.handleMessage(
    { type: 'REEL_SAVER_STATUS', downloadId: first.download.id }, sender,
  );
  assert.equal(status.ok, true);
  assert.equal(status.download.state, 'complete');
  assert.equal(f.state.calls.downloads, 1);
});

test('status cannot expose another extension download', async () => {
  const f = fixture();
  f.state.downloads.push({ id: 500, byExtensionId: 'someone-else', state: 'complete' });
  const { handleMessage } = await load(f);
  const result = await handleMessage({ type: 'REEL_SAVER_STATUS', downloadId: 500 }, sender);
  assert.equal(result.ok, false);
});

test('Instagram top-frame content scripts can inspect their own Reel without an arbitrary tab ID', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const result = await handleMessage({ type: 'REEL_SAVER_INSPECT' }, reelSender);
  assert.equal(result.ok, true);
  assert.equal(result.media.shortcode, 'ABC123');
  assert.equal(result.media.url, undefined);
  assert.equal(f.state.calls.extraction, 1);
});

test('content scripts cannot read or download another tab', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  for (const type of ['REEL_SAVER_INSPECT', 'REEL_SAVER_DOWNLOAD', 'REEL_SAVER_RESOLVE']) {
    const result = await handleMessage({ type, tabId: 999, shortcode: 'ABC123' }, reelSender);
    assert.equal(result.ok, false, type);
  }
  assert.equal(f.state.calls.extraction, 0);
  assert.equal(f.state.calls.downloads, 0);
});

test('profile controls reject iframe, foreign, and lookalike content senders', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  for (const invalidSender of [
    { ...profileSender, frameId: 1 },
    { ...profileSender, url: 'https://instagram.com.attacker.test/example_creator/' },
    { ...profileSender, url: 'http://www.instagram.com/example_creator/' },
    { ...profileSender, url: 'https://user:pass@www.instagram.com/example_creator/' },
    { ...profileSender, url: 'https://www.instagram.com:8443/example_creator/' },
    { ...profileSender, id: 'other-extension' },
    { ...profileSender, tab: undefined },
  ]) {
    const result = await handleMessage({ type: 'REEL_SAVER_SETTINGS_GET' }, invalidSender);
    assert.equal(result?.ok, false, invalidSender.url);
  }
});

test('save-location preference persists and controls browser Save As', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const initial = await handleMessage({ type: 'REEL_SAVER_SETTINGS_GET' }, profileSender);
  assert.deepEqual(initial, { ok: true, settings: { destination: 'downloads' } });
  const saved = await handleMessage({
    type: 'REEL_SAVER_SETTINGS_SET', settings: { destination: 'ask' },
  }, profileSender);
  assert.deepEqual(saved, { ok: true, settings: { destination: 'ask' } });
  const started = await download(handleMessage);
  assert.equal(started.ok, true);
  assert.equal(f.state.calls.downloadOptions.at(-1).saveAs, true);
  const restarted = await load(f);
  const restored = await restarted.handleMessage({ type: 'REEL_SAVER_SETTINGS_GET' }, profileSender);
  assert.equal(restored.settings.destination, 'ask');
});

test('default destination retains the working noninteractive browser download', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  await download(handleMessage);
  assert.equal(f.state.calls.downloadOptions[0].saveAs, false);
});

test('invalid destination preferences are rejected rather than persisted', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  for (const destination of ['chosen', '/outside/Downloads', 'https://attacker.test', null, 3]) {
    const result = await handleMessage({
      type: 'REEL_SAVER_SETTINGS_SET', settings: { destination },
    }, profileSender);
    assert.equal(result.ok, false, String(destination));
  }
  assert.deepEqual(f.state.local, {});
});

test('native-folder resolution returns validated media only to the originating content script', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const result = await handleMessage({ type: 'REEL_SAVER_RESOLVE', shortcode: 'ABC123' }, reelSender);
  assert.equal(result.ok, true);
  assert.equal(result.media.url, f.state.media.url);
  assert.equal(result.filename, 'example_creator_ABC123.mp4');
  assert.equal(f.state.calls.downloads, 0, 'resolving media does not start a browser download');
  const popupAttempt = await handleMessage({
    type: 'REEL_SAVER_RESOLVE', shortcode: 'ABC123', tabId: 7,
  }, sender);
  assert.equal(popupAttempt.ok, false, 'popup never receives the privileged native-folder URL');
});

test('native-folder resolution rejects page changes and untrusted media URLs', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const stale = await handleMessage({ type: 'REEL_SAVER_RESOLVE', shortcode: 'WRONG' }, reelSender);
  assert.equal(stale.ok, false);
  f.state.media.url = 'https://cdninstagram.com.attacker.test/reel.mp4';
  const foreign = await handleMessage({ type: 'REEL_SAVER_RESOLVE', shortcode: 'ABC123' }, reelSender);
  assert.equal(foreign.ok, false);
  assert.equal(f.state.calls.downloads, 0);
});

test('content download status is limited to its own tab record', async () => {
  const f = fixture();
  const { handleMessage } = await load(f);
  const started = await download(handleMessage);
  const sameTab = await handleMessage({
    type: 'REEL_SAVER_STATUS', downloadId: started.download.id,
  }, reelSender);
  assert.equal(sameTab.ok, true);
  const anotherTab = await handleMessage({
    type: 'REEL_SAVER_STATUS', downloadId: started.download.id,
  }, { ...reelSender, tab: { id: 8, url: REEL_URL } });
  assert.equal(anotherTab.ok, false);
});
