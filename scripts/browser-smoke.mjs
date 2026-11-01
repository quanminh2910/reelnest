// Exercises the real popup DOM in an isolated browser with mocked extension APIs.
// No Instagram requests are made, and no personal browser profile is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [
  process.env.REEL_SAVER_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch {}
}
if (!executable) throw new Error('Set REEL_SAVER_BROWSER to a Chromium browser executable.');

const profile = await mkdtemp(path.join(tmpdir(), 'reel-saver-smoke-'));
const fixtureScript = `(() => {
  const media = { shortcode: 'ABC123', pageUrl: 'https://www.instagram.com/reel/ABC123/',
    username: 'example_creator', width: 1080, height: 1920 };
  const fixture = window.__reelFixture = { mode: 'ready', state: 'in_progress', downloadCalls: 0 };
  const apis = {
    tabs: { query: async () => [{ id: 7 }] },
    runtime: { sendMessage: async (request) => {
      if (request.type === 'REEL_SAVER_INSPECT') {
        if (fixture.mode === 'error') return { ok: false,
          error: { code: 'NOT_REEL', message: 'Open a Reel on instagram.com, then click ReelNest.' } };
        return { ok: true, media };
      }
      if (request.type === 'REEL_SAVER_DOWNLOAD') {
        fixture.downloadCalls++;
        return { ok: true, media, download: { id: 42, state: fixture.state } };
      }
      return { ok: true, download: { id: 42, state: fixture.state,
        error: fixture.state === 'interrupted' ? 'The connection failed. Please retry.' : undefined } };
    } }
  };
  window.chrome = Object.assign(window.chrome || {}, apis);
})();`;

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const target = path.resolve(root, `.${pathname}`);
    if (!target.startsWith(root)) { res.writeHead(403).end(); return; }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const popupUrl = `http://127.0.0.1:${server.address().port}/src/popup/popup.html`;

let child;
let ws;
let browserLog = '';
try {
  child = spawn(executable, [
    '--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
    '--no-sandbox', '--disable-background-networking', '--disable-default-apps', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Browser did not start: ${browserLog.slice(-1500)}`)), 15_000);
    child.stderr.on('data', (data) => {
      browserLog += data.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(browserLog);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Browser exited (${code}): ${browserLog.slice(-1500)}`)); });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const pending = new Map();
  let nextId = 0;
  const exceptions = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.text);
    }
  });
  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page('Runtime.enable');
  await page('Page.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 372, height: 700, deviceScaleFactor: 1, mobile: false });
  await page('Page.addScriptToEvaluateOnNewDocument', { source: fixtureScript });
  const evaluate = async (expression) => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  async function waitFor(expression, description) {
    for (let tries = 0; tries < 60; tries++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}`);
  }
  await page('Page.navigate', { url: popupUrl });
  await waitFor(`document.querySelector('#button-label')?.textContent === 'Download MP4'`, 'popup ready');
  assert.equal(await evaluate('window.__reelFixture.downloadCalls'), 0);
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'popup must not overflow horizontally');
  assert.equal(await evaluate(`document.querySelector('#status').getAttribute('aria-live')`), 'polite');
  await evaluate(`document.querySelector('#download-button').click()`);
  await waitFor(`document.querySelector('#download-button').disabled && document.querySelector('#button-label').textContent.startsWith('Downloading')`, 'download in progress');
  assert.equal(await evaluate(`document.querySelector('#button-label').textContent === 'Downloaded'`), false);
  await evaluate(`window.__reelFixture.state = 'complete'`);
  await waitFor(`document.querySelector('#button-label').textContent === 'Downloaded'`, 'browser completion');
  console.log('PASS popup ready, no automatic download, in-progress state, complete-only success, layout, live status');

  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const metrics = await page('Page.getLayoutMetrics');
  const capture = await page('Page.captureScreenshot', { format: 'png', clip: {
    x: 0, y: 0, width: 372, height: Math.ceil(metrics.cssContentSize.height), scale: 1,
  } });
  await writeFile(path.join(artifacts, 'popup-preview.png'), Buffer.from(capture.data, 'base64'));

  await page('Page.navigate', { url: `${popupUrl}?retry` });
  await waitFor(`document.querySelector('#button-label')?.textContent === 'Download MP4'`, 'ready for interruption');
  await evaluate(`window.__reelFixture.state = 'interrupted'; document.querySelector('#download-button').click()`);
  await waitFor(`document.querySelector('#button-label').textContent === 'Retry'`, 'interrupted state');
  assert.equal(await evaluate(`document.querySelector('#download-button').disabled`), false);
  await evaluate(`window.__reelFixture.state = 'complete'; document.querySelector('#download-button').click()`);
  await waitFor(`document.querySelector('#button-label').textContent === 'Downloaded'`, 'retry completion');
  assert.equal(await evaluate('window.__reelFixture.downloadCalls'), 2);
  console.log('PASS interrupted download presents an enabled retry and retry can complete');

  await page('Page.addScriptToEvaluateOnNewDocument', { source: `window.__reelFixture.mode = 'error';` });
  await page('Page.navigate', { url: `${popupUrl}?invalid` });
  await waitFor(`document.querySelector('#button-label')?.textContent === 'Retry'`, 'invalid page feedback');
  assert.match(await evaluate(`document.querySelector('#status-message').textContent`), /Open a Reel/);
  assert.equal(await evaluate('window.__reelFixture.downloadCalls'), 0);
  assert.deepEqual(exceptions, [], 'popup should not throw browser exceptions');
  console.log('PASS invalid-page feedback; no uncaught page exceptions');
  console.log('Screenshot: reel-saver/artifacts/popup-preview.png');
  await send('Browser.close');
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (child?.exitCode === null) {
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (child.exitCode === null) child.kill();
  }
  await new Promise((resolve) => server.close(resolve));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('reel-saver-smoke-')) {
    await rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}
