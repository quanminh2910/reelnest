// Renders the actual content scripts against an intercepted Instagram-origin
// document, with local media/filesystem/runtime fixtures. No account or network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opfsFixture, cacheFailureFixture } from './browser-fs-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.REEL_SAVER_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch {}
}
if (!executable) throw new Error('Set REEL_SAVER_BROWSER to a Chromium executable.');
const writer = await readFile(path.join(root, 'src/content/folder-writer.js'), 'utf8');
const cache = await readFile(path.join(root, 'src/content/profile-cache.js'), 'utf8');
const panel = await readFile(path.join(root, 'src/content/profile-panel.js'), 'utf8');
const fixture = `(() => {
  const state = window.__fixture = { destination: 'downloads', browserState: 'in_progress',
    pickerCalls: 0, downloads: 0, resolves: 0, messages: [], failFetch: false,
    holdStatus: false, pendingStatuses: [] };
  const pageStyles = new CSSStyleSheet();
  pageStyles.replaceSync('body{font:16px system-ui;background:#fafafa;color:#222;margin:0}main{max-width:920px;margin:40px auto}header{padding:20px;border-bottom:1px solid #ddd}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:24px}.tile{height:240px;background:#eee;border-radius:8px}');
  document.adoptedStyleSheets = [pageStyles];
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let mediaNumber=0n;for(const letter of 'ABC123')mediaNumber=mediaNumber*64n+BigInt(alphabet.indexOf(letter));
  const media = { mediaId:mediaNumber.toString(),shortcode: 'ABC123', pageUrl: 'https://www.instagram.com/reel/ABC123/',
    ownerProfile:{id:'12345',username:'example_creator'},
    username: 'example_creator', width: 1080, height: 1920,
    url: 'https://scontent.cdninstagram.com/video/reel.mp4?fixture=local' };
  ${opfsFixture('window.__fixture', 'My Reels')}
  window.fetch = async () => {
    state.mediaTransfers=(state.mediaTransfers||0)+1;
    if (state.failFetch) throw new TypeError('Blocked by fixture CORS');
    const bytes = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4', ...(!state.unknownLength?{'Content-Length':String(bytes.length)}:{}) } });
  };
  window.chrome = Object.assign(window.chrome || {}, { runtime: {
    id: 'fixture-extension', getURL: p => 'chrome-extension://fixture-extension/' + p,
    onMessage: { addListener: listener => { state.messageListener = listener; } },
    sendMessage: async request => {
      state.messages.push(request);
      if (request.type === 'REEL_SAVER_SETTINGS_GET') return { ok: true, settings: { destination: state.destination } };
      if (request.type === 'REEL_SAVER_SETTINGS_SET') {
        state.destination = request.settings.destination;
        return { ok: true, settings: { destination: state.destination } };
      }
      if (request.type === 'REEL_SAVER_INSPECT') return location.pathname.startsWith('/reel/')
        ? { ok: true, media: { ...media, url: undefined } }
        : { ok: false, error: { code: 'NOT_REEL', message: 'Open a Reel to download it here.' } };
      if (request.type === 'REEL_SAVER_RESOLVE') { state.resolves++; return { ok: true, media, filename: 'example_creator_ABC123.mp4' }; }
      if (request.type === 'REEL_SAVER_DOWNLOAD') { state.downloads++; return { ok: true,
        media: { ...media, url: undefined }, download: { id: 41 + state.downloads, state: state.browserState } }; }
      if (request.type === 'REEL_SAVER_STATUS') {
        if (state.holdStatus) return new Promise(resolve => state.pendingStatuses.push({ id: request.downloadId, resolve }));
        return { ok: true, download: { id: request.downloadId, state: state.browserState } };
      }
      return { ok: false, error: { code: 'UNKNOWN', message: 'Unexpected fixture message' } };
    },
  } });
})();`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Profile fixture</title>
<style>body{font:16px system-ui;background:#fafafa;color:#222;margin:0}main{max-width:920px;margin:40px auto}header{padding:20px;border-bottom:1px solid #ddd}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:24px}.tile{height:240px;background:#eee;border-radius:8px}</style>
</head><body><main><header><h1>example_creator</h1><p>12 posts · 340 followers · 98 following</p></header><div class="grid"><div class="tile"></div><div class="tile"></div><div class="tile"></div></div></main>
<script>${fixture.replaceAll('</script', '<\\/script')}</script>
<script>${writer.replaceAll('</script', '<\\/script')}</script>
<script>${cache.replaceAll('</script', '<\\/script')}</script>
<script>${panel.replaceAll('</script', '<\\/script')}</script></body></html>`;

const profile = await mkdtemp(path.join(tmpdir(), 'reel-saver-profile-smoke-'));
let child;
let ws;
let browserLog = '';
try {
  child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
    '--no-sandbox', '--disable-background-networking', '--disable-default-apps', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Browser did not start: ${browserLog.slice(-1200)}`)), 15000);
    child.stderr.on('data', data => {
      browserLog += data.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(browserLog);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited ${code}: ${browserLog.slice(-1200)}`)); });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  const exceptions = [];
  let nextId = 0;
  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    } else if (message.method === 'Fetch.requestPaused') {
      const isFixture = message.params.resourceType === 'Document' && message.params.request.url.startsWith('https://www.instagram.com/');
      send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: isFixture ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Content-Security-Policy', value: "style-src 'none'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'" }],
        body: Buffer.from(isFixture ? html : '').toString('base64'),
      }, message.sessionId).catch(error => exceptions.push(error.message));
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params = {}) => send(method, params, sessionId);
  await page('Runtime.enable');
  await page('Page.enable');
  await page('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  async function waitFor(expression, description) {
    for (let tries = 0; tries < 80; tries++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}; exceptions: ${JSON.stringify(exceptions)}; page: ${await evaluate('document.body?.innerText.slice(0,200)')}`);
  }
  async function click(expression) {
    const position = await evaluate(`(() => {const element=${expression};element.scrollIntoView({block:'center'});const bounds=element.getBoundingClientRect();return {x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2};})()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
  }
  async function key(key, code, windowsVirtualKeyCode) {
    await page('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  }
  const rootFor = `document.querySelector('[data-reel-saver-panel]').shadowRoot`;
  const query = selector => `${rootFor}.querySelector(${JSON.stringify(selector)})`;
  const launcher = `document.querySelector('[data-reel-saver-launcher]')?.shadowRoot?.querySelector('button')`;
  async function selectDestination(value) {
    const index = ['downloads', 'ask', 'chosen'].indexOf(value);
    assert.ok(index >= 0);
    await click(query('[data-role=destination]'));
    await key('Home', 'Home', 36);
    for (let count = 0; count < index; count++) await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13);
  }
  await page('Page.navigate', { url: 'https://www.instagram.com/example_creator/' });
  await waitFor(`${launcher} && !${launcher}.hidden`, 'profile launcher');
  assert.equal(await evaluate(`document.querySelectorAll('[data-reel-saver-launcher]').length`), 1);
  await click(launcher);
  await waitFor(`${query('[data-role=dialog]')}?.open`, 'panel open');
  assert.equal(await evaluate(`getComputedStyle(${query('[data-role=dialog]')}).backgroundColor`), 'rgb(248, 251, 249)', 'panel styles survive restrictive Instagram-style CSP');
  assert.equal(await evaluate(`getComputedStyle(${query('[data-role=dialog]')}).borderRadius`), '18px');
  assert.ok(await evaluate(`${rootFor}.adoptedStyleSheets.length > 0`), 'uses constructed shadow stylesheets');
  await waitFor(`${query('[data-role=destination]')}?.value === 'downloads'`, 'default settings');
  assert.equal(await evaluate(`${query('[data-role=download]')}.disabled`), true, 'profile alone cannot start a Reel download');
  assert.equal(await evaluate('window.__fixture.downloads + window.__fixture.resolves'), 0);
  await evaluate(`for(let i=0;i<8;i++){const p=document.createElement('p');p.textContent='Mutation '+i;document.querySelector('main').append(p);}`);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await evaluate(`document.querySelectorAll('[data-reel-saver-launcher]').length`), 1, 'mutations do not duplicate launcher');
  await selectDestination('ask');
  await waitFor(`window.__fixture.destination === 'ask'`, 'Save As setting persists');
  await evaluate(`${query('[data-role=choose-folder]')}.click()`);
  assert.equal(await evaluate('window.__fixture.pickerCalls'), 0, 'synthesized folder-picker click is ignored');
  await click(query('[data-role=choose-folder]'));
  await waitFor(`window.__fixture.pickerCalls === 1 && ${query('[data-role=destination]')}.value === 'chosen'`, 'native folder choice');
  assert.match(await evaluate(`${query('[data-role=folder-name]')}.textContent`), /My Reels/);
  await evaluate(`history.pushState({},'', '/reel/ABC123/');window.dispatchEvent(new PopStateEvent('popstate'));`);
  await waitFor(`!${query('[data-role=download]')}.disabled`, 'Reel detected after SPA navigation');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-reel-saver-launcher]')).position`), 'fixed', 'floating launcher placement survives page CSP');
  await evaluate(`${query('[data-role=download]')}.click()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate('window.__fixture.downloads + window.__fixture.resolves'), 0, 'synthesized download click is ignored');
  await evaluate(`${query('[data-role=destination]')}.value='downloads';${query('[data-role=destination]')}.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert.equal(await evaluate(`${query('[data-role=destination]')}.value`), 'chosen', 'untrusted destination change is rejected');
  await evaluate(`${query('[data-role=destination]')}.value='downloads'`);
  await evaluate(cacheFailureFixture('window.__fixture'));
  await evaluate('window.__fixture.failCacheCommit=true;window.__fixture.unknownLength=true');
  await click(query('[data-role=download]'));
  await waitFor(`window.__fixture.listFiles().then(files=>files.filter(file=>file.path.endsWith('.mp4')).length === 1)`, 'native stream saved');
  assert.equal(await evaluate('window.__fixture.downloads'), 0, 'chosen-folder saves do not silently use browser downloads');
  const savedFiles=await evaluate("window.__fixture.listFiles().then(files=>files.filter(file=>file.path.endsWith('.mp4')))");
  assert.equal(savedFiles[0].size, 24);
  assert.equal(savedFiles[0].path, 'example_creator/example_creator_ABC123.mp4');
  await waitFor(`!${query('[data-role=history-retry]')}.hidden`,'saved single video retains metadata-only retry');
  assert.equal(await evaluate(`${query('[data-role=download]')}.disabled`),true,'a retained single save receipt blocks another physical download');
  const beforeSingleRetry={resolves:await evaluate('window.__fixture.resolves'),transfers:await evaluate('window.__fixture.mediaTransfers')};
  const singlePending=await evaluate("window.__fixture.readJson('example_creator/.reel-saver-cache.json')");
  assert.equal(Object.values(singlePending.pending)[0].expectedBytes,null);
  await evaluate('window.__fixture.failCacheCommit=false');
  await click(query('[data-role=history-retry]'));
  await waitFor(`${query('[data-role=history-retry]')}.hidden && !${query('[data-role=download]')}.disabled`,'single history retry records receipt without fetching');
  assert.equal(await evaluate('window.__fixture.resolves'),beforeSingleRetry.resolves);
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),beforeSingleRetry.transfers);
  const singleCache=await evaluate("window.__fixture.readJson('example_creator/.reel-saver-cache.json')");
  assert.equal(Object.keys(singleCache.saved).length,1);
  assert.deepEqual(singleCache.pending,{});
  await click(query('[data-role=download]'));
  await waitFor(`/Already downloaded/.test(${query('[data-role=status]')}.textContent)`,'single retry cache is usable by the next download');
  assert.equal(await evaluate('window.__fixture.resolves'),beforeSingleRetry.resolves);
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),beforeSingleRetry.transfers);
  assert.equal((await evaluate("window.__fixture.listFiles().then(files=>files.filter(file=>file.path.endsWith('.mp4')))" )).length,1);
  console.log('PASS unknown-size single save retries only its history commit and skips the next request without a duplicate transfer');
  console.log('PASS trusted controls, synthetic-event rejection, isolated destination, profile launcher, SPA Reel lookup, native stream writer');
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const capture = await page('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(artifacts, 'profile-panel-preview.png'), Buffer.from(capture.data, 'base64'));

  await selectDestination('downloads');
  await waitFor(`window.__fixture.destination === 'downloads'`, 'Downloads selection');
  await click(query('[data-role=download]'));
  await waitFor('window.__fixture.downloads === 1', 'browser download starts');
  assert.ok(!/saved|downloaded/i.test(await evaluate(`${query('[data-role=status]')}.textContent`)), 'not successful until complete');
  await evaluate(`window.__fixture.browserState='complete'`);
  await waitFor(`/saved|downloaded/i.test(${query('[data-role=status]')}.textContent)`, 'browser complete');

  await click(query('[data-role=choose-folder]'));
  await waitFor(`window.__fixture.pickerCalls === 2`, 'reselect folder');
  await evaluate(`window.__fixture.removeFile('example_creator/example_creator_ABC123.mp4').then(()=>{window.__fixture.failFetch=true;})`);
  await click(query('[data-role=download]'));
  await waitFor(`/could not|failed|Save As/i.test(${query('[data-role=status]')}.textContent)`, 'CORS error feedback');
  assert.equal(await evaluate('window.__fixture.downloads'), 1, 'native failure never silently downloads elsewhere');
  console.log('PASS browser completion state and explicit folder failure feedback');

  await selectDestination('downloads');
  await evaluate(`window.__fixture.browserState='in_progress';window.__fixture.holdStatus=true;`);
  await waitFor(`!${query('[data-role=download]')}.disabled`, 'ready for polling race');
  await click(query('[data-role=download]'));
  await waitFor('window.__fixture.pendingStatuses.length === 1', 'first pending status');
  await click(query('[data-role=close]'));
  await click(launcher);
  await waitFor('window.__fixture.pendingStatuses.length === 2', 'reopen creates second pending status');
  await evaluate(`(() => {const pending=window.__fixture.pendingStatuses.shift();pending.resolve({ok:true,download:{id:pending.id,state:'complete'}});})()`);
  await waitFor(`!${query('[data-role=download]')}.disabled`, 'old job completes');
  await click(query('[data-role=download]'));
  await waitFor('window.__fixture.downloads === 3', 'new browser job starts');
  await evaluate(`(() => {const pending=window.__fixture.pendingStatuses.shift();pending.resolve({ok:true,download:{id:pending.id,state:'complete'}});})()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate(`${query('[data-role=download]')}.disabled`), true, 'late old status must not finish a new download');
  assert.match(await evaluate(`${query('[data-role=status]')}.textContent`), /Saving with Chrome/);
  await waitFor('window.__fixture.pendingStatuses.length >= 1', 'new job status');
  await evaluate(`(() => {const pending=window.__fixture.pendingStatuses.shift();pending.resolve({ok:true,download:{id:pending.id,state:'complete'}});})()`);
  await waitFor(`!${query('[data-role=download]')}.disabled`, 'new job completes on its own status');
  console.log('PASS late status from a previous download cannot complete the next download');

  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`!${query('[data-role=dialog]')}.open`, 'Escape closes panel');
  await evaluate(`history.pushState({},'', '/accounts/login/');window.dispatchEvent(new PopStateEvent('popstate'));`);
  await waitFor(`!${launcher} || getComputedStyle(document.querySelector('[data-reel-saver-launcher]')).display === 'none'`, 'reserved routes hide launcher');
  assert.deepEqual(exceptions, [], 'no uncaught browser exceptions');
  console.log('PASS Escape handling, reserved-route cleanup, no uncaught exceptions');
  console.log('Screenshot: artifacts/profile-panel-preview.png');
  await send('Browser.close');
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (child?.exitCode === null) {
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (child.exitCode === null) child.kill();
  }
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('reel-saver-profile-smoke-')) {
    await rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}
