// Actual queue controls, child runner and folder history in an isolated browser.
// The coordinator/source are fixtures; no personal Chrome profile or account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opfsFixture } from './browser-fs-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.REEL_SAVER_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set REEL_SAVER_BROWSER to a Chromium executable.');
const files = ['src/shared/download-limits.js', 'src/shared/profile-queue-config.js', 'src/content/folder-writer.js',
  'src/content/profile-cache.js', 'src/content/bulk-queue.js', 'src/content/bulk-panel.js',
  'src/content/profile-job-runner.js', 'src/content/profile-queue-panel.js', 'src/content/profile-panel.js'];
const scripts = await Promise.all(files.map(file => readFile(path.join(root, file), 'utf8')));
const fixture = `(() => {
  const state=window.__queueFixture={draft:null,run:null,jobs:{},browserFiles:{},requests:[],sources:[],writes:0,browserWrites:0,pickerCalls:0,held:false,holdTransfer:true};
  ${opfsFixture('window.__queueFixture', 'Queue library')}
  const code=id=>{const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';let n=BigInt(id),v='';do{v=chars[Number(n%64n)]+v;n/=64n;}while(n);return v;};
  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  let serial=0;
  const ok=value=>({ok:true,...value});
  const failure=message=>({ok:false,error:{code:'FIXTURE',message}});
  const current=()=>{state.run.updatedAt=Date.now();return clone(state.run);};
  const entry=()=>state.run.entries[state.run.currentIndex];
  const finish=()=>{state.run.currentIndex++;if(state.run.currentIndex>=state.run.entries.length||state.run.draft.totalLimit!=null&&state.run.committedNewSaves>=state.run.draft.totalLimit){state.run.state='completed';state.run.completionReason=state.run.draft.totalLimit!=null&&state.run.committedNewSaves>=state.run.draft.totalLimit?'queue_limit_reached':'feed_exhausted';}};
  window.fetch=async()=>{
    state.writes++;
    if(state.holdTransfer){state.held=true;await new Promise(resolve=>state.releaseTransfer=resolve);state.holdTransfer=false;state.held=false;}
    const bytes=new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
    return new Response(bytes,{headers:{'Content-Type':'video/mp4','Content-Length':String(bytes.length)}});
  };
  window.chrome=Object.assign(window.chrome||{},{runtime:{id:'fixture-extension',getURL:p=>'chrome-extension://fixture-extension/'+p,
    onMessage:{addListener(listener){state.listener=listener;}},sendMessage:async message=>{
      state.requests.push(clone(message));
      if(message.type==='REEL_SAVER_SETTINGS_GET')return ok({settings:{destination:'downloads'}});
      if(message.type==='REEL_SAVER_SETTINGS_SET')return ok({settings:message.settings});
      if(message.type==='REEL_SAVER_INSPECT')return{ok:false,error:{code:'NOT_REEL',message:'Open a Reel to download it here.'}};
      if(message.type==='REEL_SAVER_BULK_SETTINGS_GET')return ok({settings:{mode:'batches',batchSize:35,maxNewVideos:null}});
      const action=message.type.replace('REEL_SAVER_QUEUE_','');
      if(action==='DRAFT_GET')return ok({draft:state.draft||undefined});
      if(action==='DRAFT_SET'){state.draft=clone(message.draft);return ok({draft:state.draft});}
      if(action==='LATEST')return ok({run:clone(state.run)});
      if(action==='START'){
        state.draft=clone(message.draft);state.run={id:'fixture-run-'+(++serial),state:'running',currentIndex:0,committedNewSaves:0,draft:clone(message.draft),options:message.options,
          entries:message.draft.entries.map(row=>({...clone(row),state:'pending',effectiveLimit:row.limitMode==='custom'?row.maxNewVideos:row.limitMode==='unlimited'?null:message.draft.defaultLimit,committedNewSaves:0,counts:{alreadyDownloaded:0,failed:0}}))};
        return ok({run:current()});
      }
      if(action==='ENTRY_START'){
        const row=entry();state.sources.push(row.username);const numeric=row.username==='creator_a'?'12345':row.username==='creator_b'?'67890':'99999';
        row.state='running';row.profile={id:numeric,username:row.username};
        const budget=Math.min(row.effectiveLimit??Infinity,state.run.draft.totalLimit==null?Infinity:state.run.draft.totalLimit-state.run.committedNewSaves);
        const job={jobId:'fixture-child-'+(++serial),profile:row.profile,options:{mode:'batches',batchSize:state.run.draft.batchSize,maxNewVideos:Number.isFinite(budget)?budget:null,destination:state.run.options.destination,skipExisting:state.run.options.skipExisting}};
        state.jobs[job.jobId]={job,entryId:row.id,operations:{}};return ok({run:current(),job});
      }
      if(action==='PROGRESS'){
        const row=state.run.entries.find(value=>value.id===message.entryId);row.counts=clone(message.snapshot.counts);
        row.committedNewSaves=message.snapshot.counts.saved;
        state.run.committedNewSaves=state.run.entries.reduce((n,value)=>n+value.committedNewSaves,0);return ok({run:current()});
      }
      if(action==='ENTRY_FINISH'){entry().state=message.summary.state;entry().completionReason=message.summary.completionReason;finish();return ok({run:current()});}
      if(action==='PAUSE'){state.run.state='paused';return ok({run:current()});}
      if(action==='RESUME'){state.run.state='running';return ok({run:current()});}
      if(action==='SKIP'){entry().state='skipped';finish();if(state.run.state!=='completed')state.run.state='running';return ok({run:current()});}
      if(action==='STOP'){state.run.state='stopped';return ok({run:current()});}
      if(action==='SHOW_SOURCE')return ok({});
      if(action==='REPORT')return ok({report:{version:1,type:'reelnest_queue',run:clone(state.run)}});
      const bulk=message.type.replace('REEL_SAVER_BULK_',''),registered=state.jobs[message.jobId];
      if(!registered)return failure('Unknown fixture message '+message.type);
      const job=registered.job;
      const media=message.item||{mediaId:message.mediaId||'1',shortcode:code(message.mediaId||'1')};
      const basename=job.profile.username+'_'+media.shortcode+'.mp4';
      if(bulk==='PAGE'){
        const first=job.profile.id==='12345'?100001:200001;
        return ok({page:{items:Array.from({length:4},(_,i)=>({mediaId:String(first+i),shortcode:code(first+i)})),hasMore:false,nextCursor:null}});
      }
      if(bulk==='RESOLVE')return ok({media:{...media,username:job.profile.username,url:'https://scontent.cdninstagram.com/'+media.shortcode+'.mp4',width:32,height:32},filename:basename});
      if(bulk==='ITEM_RESULT')return ok({});
      if(bulk==='CHECK_EXISTING')return ok({result:state.browserFiles[job.profile.id+':'+media.mediaId]||null});
      if(bulk==='DOWNLOAD'){
        state.browserWrites++;const id=state.browserWrites;state.browserFiles[job.profile.id+':'+media.mediaId]={cacheHit:true,filename:basename,bytesWritten:24,downloadId:id};
        return ok({download:{id,state:'complete',filename:basename,bytesWritten:24}});
      }
      if(bulk==='END')return ok({committedNewSaves:0,savedResults:[]});
      if(bulk==='CANCEL_ITEM')return ok({canceled:true});
      return failure('Unexpected fixture bulk action '+bulk);
    }}});
})();`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Queue fixture</title></head><body><main><header><h1>control_profile</h1></header></main>
<script>${fixture.replaceAll('</script', '<\\/script')}</script>${scripts.map(source => `<script>${source.replaceAll('</script', '<\\/script')}</script>`).join('')}</body></html>`;
const temporary = await mkdtemp(path.join(tmpdir(), 'reelnest-profile-queue-ui-'));
let child, ws;
const pending = new Map();
try {
  child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--disable-background-networking',
    '--disable-default-apps', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--remote-debugging-port=0', `--user-data-dir=${temporary}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('Browser did not start.')), 15000);
    child.stderr.on('data', data => { log += data.toString(); const match = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', reject);
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const errors = [];
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Fetch.requestPaused') {
      const good = message.params.resourceType === 'Document' && message.params.request.url.startsWith('https://www.instagram.com/');
      send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: good ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(good ? html : '').toString('base64') }, message.sessionId).catch(error => errors.push(error.message));
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params = {}) => send(method, params, sessionId);
  await page('Runtime.enable'); await page('Page.enable'); await page('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await page('Emulation.setDeviceMetricsOverride', { width: 1250, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => { const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const shadow = "document.querySelector('[data-reel-saver-panel]').shadowRoot";
  const query = selector => `${shadow}.querySelector(${JSON.stringify(selector)})`;
  const role = name => query(`[data-role=${name}]`);
  async function wait(expression, title) { for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Timed out: ${title}. ${JSON.stringify(errors)} ${await evaluate(`${role('queue-status')}?.textContent`)}`); }
  async function click(expression) {
    const position = await evaluate(`(()=>{const n=${expression};n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
  }
  async function key(key, code, virtual) { await page('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual }); await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual }); }
  async function select(expression, index) { await click(expression); await key('Home', 'Home', 36); for (let i = 0; i < index; i++) await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13); }
  async function fill(expression, text) { await evaluate(`(()=>{const n=${expression};n.focus();n.select()})()`); await page('Input.insertText', { text }); await key('Tab', 'Tab', 9); }

  await page('Page.navigate', { url: 'https://www.instagram.com/control_profile/reels/' });
  await wait("document.querySelector('[data-reel-saver-launcher]')?.shadowRoot.querySelector('button')", 'launcher');
  await click("document.querySelector('[data-reel-saver-launcher]').shadowRoot.querySelector('button')");
  await wait(`${role('profile-queue-view')} && !${role('destination')}.disabled`, 'loaded controls');
  await click(role('profile-queue-view'));
  await fill(role('queue-input'), '@creator_a\nhttps://www.instagram.com/creator_b/reels/\n@creator_c\nhttps://example.com/invalid');
  await click(role('queue-add'));
  await wait(`${role('queue-draft')}.children.length===3`, 'valid profiles retained');
  assert.match(await evaluate(`${role('queue-input-errors')}.textContent`), /Line 4/);
  await select(role('queue-default-limit-mode'), 1);
  assert.equal(await evaluate(`${role('queue-start')}.disabled`), true, 'empty custom limit blocks starting');
  await fill(role('queue-default-limit'), '2');
  await select(query('[data-role=queue-draft] li:nth-child(2) select'), 1);
  await fill(query('[data-role=queue-draft] li:nth-child(2) input'), '1');
  await select(role('queue-total-limit-mode'), 1); await fill(role('queue-total-limit'), '3');
  await click(role('choose-folder'));
  await wait(`${role('destination')}.value==='chosen'`, 'one chosen root');
  await evaluate(`${role('queue-start')}.click()`);
  assert.equal(await evaluate('window.__queueFixture.run'), null, 'synthetic queue Start is ignored');
  await click(role('queue-start'));
  await wait('window.__queueFixture.held', 'first transfer held');
  assert.equal(await evaluate(`${role('destination')}.disabled`), true, 'destination frozen during queue');
  await click(role('queue-pause'));
  await evaluate('window.__queueFixture.releaseTransfer()');
  await wait(`${role('queue-status')}.textContent.includes('Paused') || ${role('queue-status')}.textContent.includes('paused')`, 'queue pauses');
  assert.deepEqual(await evaluate('window.__queueFixture.sources'), ['creator_a']);
  await click(role('queue-resume'));
  await wait(`!${role('queue-start')}.hidden`, 'native queue complete');
  assert.deepEqual(await evaluate('window.__queueFixture.sources'), ['creator_a', 'creator_b']);
  assert.equal(await evaluate('window.__queueFixture.run.committedNewSaves'), 3);
  assert.equal(await evaluate('window.__queueFixture.pickerCalls'), 1);
  const nativeFiles = await evaluate('window.__queueFixture.listFiles()');
  assert.equal(nativeFiles.filter(file => /\.mp4$/.test(file.path)).length, 3);
  assert.equal(nativeFiles.filter(file => file.path.startsWith('creator_a/') && /\.mp4$/.test(file.path)).length, 2);
  assert.equal(nativeFiles.filter(file => file.path.startsWith('creator_b/') && /\.mp4$/.test(file.path)).length, 1);
  assert.equal(nativeFiles.some(file => file.path.startsWith('creator_c/')), false);
  console.log('PASS actual queue controls and native runner: one picker, separate profile folders, per-profile overrides, total cap, pause/resume and no third profile');

  await select(role('destination'), 0);
  await click(role('queue-start'));
  await wait(`!${role('queue-start')}.hidden`, 'browser queue complete');
  assert.equal(await evaluate('window.__queueFixture.browserWrites'), 3);
  assert.equal(await evaluate('window.__queueFixture.run.committedNewSaves'), 3);
  assert.equal(await evaluate('window.__queueFixture.pickerCalls'), 1);
  assert.equal(await evaluate(`${role('queue-results')}.children.length`), 3);
  console.log('PASS Browser Downloads queue uses the same caps and serial runner without another folder selection');
  assert.deepEqual(errors, []);
  console.log('PASS trusted start, invalid-input feedback, shared destination locking and latest result rendering without uncaught errors');
} finally {
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Fixture closed.')); }
  pending.clear();
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (child && child.exitCode == null) { child.kill(); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]); }
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('reelnest-profile-queue-ui-')) throw new Error('Refusing unexpected temporary profile cleanup.');
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
