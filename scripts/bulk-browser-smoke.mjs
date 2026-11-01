// Bulk UI/browser integration using the real queue, panel, and writer.
// Runtime/profile responses are local fixtures; the selected OPFS folder is real.
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
const limits = await readFile(path.join(root, 'src/shared/download-limits.js'), 'utf8');
const queue = await readFile(path.join(root, 'src/content/bulk-queue.js'), 'utf8');
const bulkPanel = await readFile(path.join(root, 'src/content/bulk-panel.js'), 'utf8');
const panel = await readFile(path.join(root, 'src/content/profile-panel.js'), 'utf8');
const fixture = `(() => {
  const state = window.__fixture = { destination: 'downloads', mode: 'batches', batchSize: 35,
    total: 82, baseId: 100001, pageSize: 12, events: [], downloads: 0, resolves: 0, saved: 0, pickerCalls: 0,
    jobNumber: 0, nextId: 0, browserState: 'complete',
    failItem: null, failCount: 0, holdPage: false, heldPages: [], holdResolve: false, heldResolves: [],
    failRelease: false, releaseCalls: 0, failAck: 0, failNegativeAck: 0, failTransfers: 0,
    report: null, mp4Playable: false, completeOnCancel: false };
  const pageStyles = new CSSStyleSheet();
  pageStyles.replaceSync('body{font:16px system-ui;background:#fafafa;color:#222;margin:0}main{max-width:920px;margin:40px auto}header{padding:20px;border-bottom:1px solid #ddd}h1{font-size:24px}');
  document.adoptedStyleSheets=[pageStyles];
  const profile = { id:'12345',username:'example_creator' };
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const code=id=>{let value=BigInt(id),text='';do{text=alphabet[Number(value%64n)]+text;value/=64n;}while(value);return text;};
  const items = () => Array.from({length:state.total},(_,i)=>({mediaId:String(state.baseId+i),shortcode:code(state.baseId+i),username:profile.username}));
  ${opfsFixture('window.__fixture', 'My Reels')}
  state.videoReady=(async()=>{
    const types=['video/mp4;codecs=avc1.42001E','video/mp4'];
    const mimeType=types.find(type=>window.MediaRecorder?.isTypeSupported(type));
    if(!mimeType)throw new Error('This Chromium build cannot generate the playable MP4 fixture.');
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#1c523e';ctx.fillRect(0,0,32,32);
    const stream=canvas.captureStream(10);const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:32000});
    const chunks=[];recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    const complete=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=event=>reject(event.error);});
    recorder.start();await new Promise(resolve=>setTimeout(resolve,450));recorder.stop();await complete;
    for(const track of stream.getTracks())track.stop();
    const blob=new Blob(chunks,{type:'video/mp4'});const video=document.createElement('video');
    const objectUrl=URL.createObjectURL(blob);video.src=objectUrl;
    await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Generated MP4 did not load.'));});
    state.mp4Playable=video.videoWidth===32&&video.duration>0;URL.revokeObjectURL(objectUrl);
    if(!state.mp4Playable)throw new Error('Generated MP4 is not playable.');
    state.mp4=await blob.arrayBuffer();return state.mp4;
  })();
  window.fetch=async()=>{state.mediaTransfers=(state.mediaTransfers||0)+1;if(state.failTransfers>0){state.failTransfers--;throw new TypeError('Fixture video transfer failed');}const bytes=await state.videoReady;return new Response(bytes,{status:200,headers:{'Content-Type':'video/mp4',...(!state.unknownLength?{'Content-Length':String(bytes.byteLength)}:{})}});};
  const createObjectURL=URL.createObjectURL.bind(URL);
  URL.createObjectURL=blob=>{if(blob.type==='application/json')blob.text().then(text=>{state.report=JSON.parse(text);});return createObjectURL(blob);};
  const allDownloads=new Map();
  const downloadOwners=new Map();
  const nativePrepared=state.nativePrepared=new Map();
  const success = result=>({ok:true,...result});
  const mediaFor=item=>({mediaId:item.mediaId,shortcode:item.shortcode,pageUrl:'https://www.instagram.com/reel/'+item.shortcode+'/',username:profile.username,width:32,height:32,url:'https://scontent.cdninstagram.com/'+item.shortcode+'.mp4?secret=never_export'});
  window.chrome=Object.assign(window.chrome||{},{runtime:{id:'fixture-extension',getURL:p=>'chrome-extension://fixture-extension/'+p,
    onMessage:{addListener:listener=>{state.messageListener=listener;}},sendMessage:async request=>{
      const type=request.type;state.events.push({type,mediaId:request.item?.mediaId||request.mediaId,cursor:request.cursor,attemptId:request.attemptId,resultState:request.result?.state});
      if(type==='REEL_SAVER_SETTINGS_GET')return success({settings:{destination:state.destination}});
      if(type==='REEL_SAVER_SETTINGS_SET'){state.destination=request.settings.destination;return success({settings:{destination:state.destination}});}
      if(type==='REEL_SAVER_BULK_SETTINGS_GET')return success({settings:{mode:state.mode,batchSize:state.batchSize,maxNewVideos:state.maxNewVideos??null}});
      if(type==='REEL_SAVER_BULK_SETTINGS_SET'){Object.assign(state,request.settings);return success({settings:request.settings});}
      if(type==='REEL_SAVER_BULK_IDENTIFY')return success({profile:state.identifyProfile||profile});
      if(type==='REEL_SAVER_BULK_START'){state.jobNumber++;state.job={jobId:'fixture_job_'+state.jobNumber,profile,options:request.options};return success({job:state.job});}
      if(type==='REEL_SAVER_BULK_PAGE'){
        if(state.holdPage)await new Promise(resolve=>state.heldPages.push(resolve));
        const start=Number(request.cursor||0);const page=items().slice(start,start+state.pageSize);const after=start+page.length;
        return success({profile,page:{items:page,nextCursor:after<state.total?String(after):null,hasMore:after<state.total}});
      }
      if(type==='REEL_SAVER_BULK_RESOLVE'){
        const key=request.jobId+':'+request.item.mediaId;
        if(nativePrepared.has(key))return {ok:false,error:{code:'RECONCILIATION_REQUIRED',message:'The previous native result must be acknowledged before another lookup'}};
        state.resolves++;if(state.holdResolve)await new Promise(resolve=>state.heldResolves.push(resolve));
        if(state.failItem===request.item.mediaId&&state.failCount++===0)return {ok:false,error:{code:'NO_MP4',message:'No progressive MP4 was available.',stage:'resolve',retryable:false}};
        nativePrepared.set(key,request.attemptId);
        return success({media:mediaFor(request.item),filename:profile.username+'_'+request.item.shortcode+'.mp4'});
      }
      if(type==='REEL_SAVER_BULK_ITEM_RESULT'){
        if(request.result.state==='saved'&&state.failAck>0){state.failAck--;return {ok:false,error:{code:'STORAGE_FAILED',message:'Fixture result acknowledgement lost'}};}
        if(request.result.state!=='saved'&&state.failNegativeAck>0){state.failNegativeAck--;return {ok:false,error:{code:'STORAGE_FAILED',message:'Fixture failed result acknowledgement lost'}};}
        const key=request.jobId+':'+request.mediaId;
        if(!request.result.error?.cleanupFailed)nativePrepared.delete(key);
        if(request.result.state==='saved')state.saved++;return success({});
      }
      if(type==='REEL_SAVER_BULK_DOWNLOAD'){
        state.downloads++;
        if(state.failItem===request.item.mediaId&&state.failCount++===0)return {ok:false,error:{code:'SAVE_FAILED',message:'A fixture transfer failed.',stage:'download',retryable:false}};
        const download={id:++state.nextId,state:state.browserState,filename:profile.username+'_'+request.item.shortcode+'.mp4'};
        allDownloads.set(request.attemptId,download);downloadOwners.set(request.attemptId,{jobId:request.jobId,mediaId:request.item.mediaId});if(download.state==='complete')state.saved++;
        return success({download,filename:download.filename});
      }
      if(type==='REEL_SAVER_BULK_STATUS'){
        const download=allDownloads.get(request.attemptId);if(!download)return {ok:false,error:{code:'RECONCILE_REQUIRED',message:'Unknown fixture transfer'}};
        if(state.browserState==='complete'&&download.state!=='complete'){download.state='complete';state.saved++;}
        return success({download:{...download}});
      }
      if(type==='REEL_SAVER_BULK_CANCEL_ITEM'){const download=allDownloads.get(request.attemptId);if(download&&download.state!=='complete'){download.state=state.completeOnCancel?'complete':'interrupted';if(download.state==='complete')state.saved++;}return success({});}
      if(type==='REEL_SAVER_BULK_END'){
        state.releaseCalls++;if(state.failRelease)return {ok:false,error:{code:'NETWORK_FAILED',message:'Fixture release failed'}};
        if([...nativePrepared.keys()].some(key=>key.startsWith(request.jobId+':')))return {ok:false,error:{code:'RECONCILIATION_REQUIRED',message:'Fixture folder result remains unresolved'}};
        const savedResults=request.state==='stopped'?[...allDownloads].filter(([attemptId,download])=>downloadOwners.get(attemptId)?.jobId===request.jobId&&download.state==='complete').map(([attemptId,download])=>({...downloadOwners.get(attemptId),filename:download.filename,downloadId:download.id})):[];
        return success({savedResults});
      }
      if(type==='REEL_SAVER_BULK_REOPEN')return success({job:state.job});
      if(type==='REEL_SAVER_INSPECT')return {ok:false,error:{code:'NOT_REEL',message:'Open a Reel to download it here.'}};
      return {ok:false,error:{code:'UNKNOWN',message:'Unexpected fixture message '+type}};
    }}});
})();`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bulk fixture</title></head><body><main><header><h1>example_creator</h1><p>Profile bulk fixture</p></header></main>
<script>${fixture.replaceAll('</script','<\\/script')}</script><script>${writer.replaceAll('</script','<\\/script')}</script><script>${cache.replaceAll('</script','<\\/script')}</script><script>${limits.replaceAll('</script','<\\/script')}</script><script>${queue.replaceAll('</script','<\\/script')}</script><script>${bulkPanel.replaceAll('</script','<\\/script')}</script><script>${panel.replaceAll('</script','<\\/script')}</script></body></html>`;
const profile = await mkdtemp(path.join(tmpdir(), 'reel-saver-bulk-smoke-'));
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
          { name: 'Content-Security-Policy', value: "style-src 'none'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; media-src blob:" }],
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
  async function waitFor(expression, description, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const state = await evaluate(`(() => {const root=document.querySelector('[data-reel-saver-panel]')?.shadowRoot;return {status:root?.querySelector('[data-role=bulk-status]')?.textContent,counts:[...(root?.querySelectorAll('[data-count]')||[])].map(node=>[node.dataset.count,node.textContent]),events:window.__fixture?.events.slice(-8)};})()`);
    throw new Error(`Timed out: ${description}; exceptions: ${JSON.stringify(exceptions)}; state: ${JSON.stringify(state)}`);
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
  async function selectLimitMode(value) {
    await click(query('[data-role=bulk-limit-mode]'));
    await key(value==='custom'?'End':'Home',value==='custom'?'End':'Home',value==='custom'?35:36);
    await key('Enter','Enter',13);
  }
  async function enterLimit(value) {
    await click(query('[data-role=bulk-limit]'));
    await page('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await page('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await key('Backspace','Backspace',8);
    if(value)await page('Input.insertText',{text:value});
    await key('Tab','Tab',9);
  }
  await page('Page.navigate',{url:'https://www.instagram.com/example_creator/reels/'});
  await waitFor(`${launcher}`,'profile launcher');
  await click(launcher);
  await waitFor(`${query('[data-role=bulk-start]')} && !${query('[data-role=bulk-start]')}.disabled`,'bulk controls');
  await waitFor('window.__fixture.mp4Playable','playable MP4 fixture');
  assert.equal(await evaluate(`${query('[data-role=bulk-size]')}.value`),'35');
  assert.equal(await evaluate(`${query('[data-role=bulk-limit-mode]')}.value`),'unlimited');
  assert.equal(await evaluate('window.__fixture.jobNumber'),0,'opening panel never starts bulk automatically');
  await evaluate(`${query('[data-role=bulk-start]')}.click()`);
  assert.equal(await evaluate('window.__fixture.jobNumber'),0,'synthetic start ignored');
  await selectLimitMode('custom');
  assert.equal(await evaluate(`${query('[data-role=bulk-start]')}.disabled`),true,'empty custom limit blocks Start');
  for(const invalid of ['0','-1','1.5','1e2','50001','500000','1000000']){
    await enterLimit(invalid);
    assert.equal(await evaluate(`${query('[data-role=bulk-start]')}.disabled`),true,`invalid limit ${invalid} blocks Start`);
    assert.equal(await evaluate(`${query('[data-role=bulk-limit]')}.getAttribute('aria-invalid')`),'true');
    assert.equal(await evaluate('window.__fixture.jobNumber'),0,'invalid limits cannot start a job');
  }
  await selectLimitMode('unlimited');
  await waitFor(`${query('[data-role=bulk-start]')}.disabled===false && window.__fixture.maxNewVideos===null`,'unlimited preference restored');
  await click(query('[data-role=choose-folder]'));
  await waitFor(`${query('[data-role=destination]')}.value==='chosen'`,'folder selected');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.')`,'82-Reel native job',30000);
  const mp4Files = () => evaluate("window.__fixture.listFiles().then(files=>files.filter(file=>file.path.endsWith('.mp4')))");
  assert.equal((await mp4Files()).length,82);
  assert.equal(new Set((await mp4Files()).map(file=>file.path)).size,82);
  assert.ok((await mp4Files()).every(file=>file.path.startsWith('example_creator/')&&file.size>0));
  assert.equal(await evaluate('window.__fixture.downloads'),0,'folder job never redirects into Chrome downloads');
  const events=await evaluate('window.__fixture.events');
  const pageEvents=events.map((event,index)=>({...event,index})).filter(event=>event.type==='REEL_SAVER_BULK_PAGE');
  assert.deepEqual(pageEvents.map(event=>event.cursor),[null,'12','24','36','48','60','72']);
  assert.equal(events.slice(0,pageEvents[3].index).filter(event=>event.type==='REEL_SAVER_BULK_RESOLVE').length,35,'next batch discovery waits until first35saved');
  assert.equal(events.slice(0,pageEvents[6].index).filter(event=>event.type==='REEL_SAVER_BULK_RESOLVE').length,70,'next batch discovery waits until second35saved');
  await click(query('[data-role=bulk-report]'));
  await waitFor('window.__fixture.report','JSON report export');
  assert.equal(await evaluate('window.__fixture.report.counts.saved'),82);
  assert.equal(await evaluate("JSON.stringify(window.__fixture.report).includes('never_export')"),false,'report excludes signed media URLs');
  console.log('PASS real playable MP4 stream,82Reels in35/35/12 batches,page overflow,duplicate protection,trusted Start,localreport');
  const artifacts=path.join(root,'artifacts');await mkdir(artifacts,{recursive:true});
  const capture=await page('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(artifacts,'bulk-panel-preview.png'),Buffer.from(capture.data,'base64'));

  const importedReport=await evaluate(`(async()=>{
    const bytes=await window.__fixture.videoReady,root=await window.__fixture.rootReady;
    const filename='legacy_download (2).mp4',file=await root.getFileHandle(filename,{create:true}),stream=await file.createWritable();
    await stream.write(bytes);await stream.close();
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';let value=300001n,shortcode='';
    do{shortcode=alphabet[Number(value%64n)]+shortcode;value/=64n;}while(value);
    return{version:1,profile:{id:'12345',username:'example_creator'},items:[
      {mediaId:'300001',shortcode,state:'saved',filename,bytesWritten:bytes.byteLength},
      {mediaId:'300002',shortcode:'ignored',state:'canceled'}]};
  })()`);
  const importPath=path.join(profile,'legacy-report.json');
  await writeFile(importPath,JSON.stringify(importedReport));
  await page('DOM.enable');
  async function chooseReport(){
    const input=await page('Runtime.evaluate',{expression:query('[data-role=cache-import-file]'),returnByValue:false});
    assert.ok(input.result.objectId,'actual import input exists');
    await page('DOM.setFileInputFiles',{objectId:input.result.objectId,files:[importPath]});
  }
  const beforeImport=(await mp4Files()).length;
  await chooseReport();
  await waitFor(`!${query('[data-role=cache-import-summary]')}.hidden && !${query('[data-role=cache-import-commit]')}.disabled`,'actual report preview');
  assert.match(await evaluate(`${query('[data-role=cache-import-summary]')}.textContent`),/1 verified and ready \(1 to copy/);
  assert.equal((await mp4Files()).length,beforeImport,'preview does not copy any video');
  await evaluate(`${query('[data-role=cache-import-commit]')}.click()`);
  assert.equal((await mp4Files()).length,beforeImport,'synthetic import confirmation is ignored');
  await click(query('[data-role=cache-import-commit]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Import complete: 1 recorded, 1 copied.')`,'report import committed');
  const importedFiles=await mp4Files();
  assert.equal(importedFiles.length,beforeImport+1);
  assert.ok(importedFiles.some(file=>file.path==='legacy_download (2).mp4'),'original legacy video is retained');
  assert.ok(importedFiles.some(file=>file.path==='example_creator/legacy_download (2).mp4'),'legacy video copied into profile child');
  const importedCache=await evaluate("window.__fixture.readJson('example_creator/.reel-saver-cache.json')");
  assert.equal(Object.keys(importedCache.saved).length,83);
  assert.equal(importedCache.saved['300001'].origin,'report-import');
  assert.equal(importedCache.saved['300002'],undefined,'canceled report entries never become downloaded history');
  await chooseReport();
  await waitFor(`!${query('[data-role=cache-import-summary]')}.hidden`,'second report preview');
  assert.match(await evaluate(`${query('[data-role=cache-import-summary]')}.textContent`),/1 already recorded/);
  await click(query('[data-role=cache-import-cancel]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Import closed.')`,'import cancellation releases session');
  const resolvesBeforeImportedJob=await evaluate('window.__fixture.resolves');
  await evaluate('window.__fixture.total=1;window.__fixture.baseId=300001');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.') && Number(${query('[data-count=alreadyDownloaded]')}.textContent)===1`,'imported video skipped by subsequent job');
  assert.equal(await evaluate('window.__fixture.resolves'),resolvesBeforeImportedJob);
  assert.equal((await mp4Files()).length,importedFiles.length);
  await evaluate('window.__fixture.baseId=100001');
  console.log('PASS trusted report preview/confirm/cancel, verified root copy, retained original, ignored canceled entry, subsequent cache hit');

  await selectDestination('downloads');
  await click(query('[data-role=bulk-mode]'));
  await key('End','End',35);await key('Enter','Enter',13);
  await waitFor("window.__fixture.mode==='scan_all'",'scan-all setting');
  await evaluate('window.__fixture.total=3;window.__fixture.events=[]');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Download all 3 Reels'`,'scan-all ready');
  assert.equal(await evaluate('window.__fixture.downloads'),0,'scan-all requires explicit download after discovery');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.')`,'scan-all downloads');
  assert.equal(await evaluate('window.__fixture.downloads'),3);
  console.log('PASS scan-all review gate,explicitDownloadall,browser destination');

  await click(query('[data-role=bulk-mode]'));await key('Home','Home',36);await key('Enter','Enter',13);
  await waitFor("window.__fixture.mode==='batches'",'batch setting restored');
  await evaluate('window.__fixture.total=2;window.__fixture.browserState="in_progress";window.__fixture.events=[]');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-pause]')}.hidden===false`,'pause available');
  await click(query('[data-role=bulk-pause]'));
  await evaluate('window.__fixture.browserState="complete"');
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Resume'`,'pauses after current operation');
  const accepted=await evaluate('window.__fixture.downloads');
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(await evaluate('window.__fixture.downloads'),accepted,'paused queue schedules no additional file');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.')`,'resume completes');
  console.log('PASS pause finishes current operation,resume avoids repeatedsaveditems');

  await evaluate('window.__fixture.total=2;window.__fixture.failItem="100001";window.__fixture.failCount=0');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-retry]')}.hidden===false`,'retry failed action');
  const beforeRetry=await evaluate('window.__fixture.downloads');
  await click(query('[data-role=bulk-retry]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.')`,'retry failed completes');
  assert.equal(await evaluate('window.__fixture.downloads'),beforeRetry+1,'retry onlyfailed notsuccessful');
  console.log('PASS failed resultkept,Retryfailed retains successfulitems');

  await evaluate('window.__fixture.total=5;window.__fixture.failItem=null;window.__fixture.holdPage=true');
  await click(query('[data-role=bulk-start]'));
  await waitFor('window.__fixture.heldPages.length===1','held discoveryrequest');
  await click(query('[data-role=bulk-stop]'));
  await evaluate('window.__fixture.holdPage=false;window.__fixture.heldPages.splice(0).forEach(resolve=>resolve())');
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Stopped.')`,'stop discovery');
  const stoppedDownloads=await evaluate('window.__fixture.downloads');
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(await evaluate('window.__fixture.downloads'),stoppedDownloads,'late stopped discovery cannot schedule files');
  console.log('PASS stop,late discovery fencing,no furtherwrites');

  await evaluate('window.__fixture.total=0;window.__fixture.failRelease=true');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-stop]')}.textContent==='Release batch'`,'failed release recovery');
  assert.match(await evaluate(`${query('[data-role=bulk-status]')}.textContent`),/could not be released/);
  await evaluate('window.__fixture.failRelease=false');
  await click(query('[data-role=bulk-stop]'));
  await waitFor(`${query('[data-role=bulk-stop]')}.hidden && !${query('[data-role=bulk-start]')}.disabled`,'release retry unlocks next job');
  console.log('PASS failed lease release has explicit retry and cannot silently strand ownership');

  await click(query('[data-role=choose-folder]'));
  await evaluate('window.__fixture.total=1;window.__fixture.baseId=200001;window.__fixture.failAck=1');
  const beforeAck=(await mp4Files()).length;
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Resume'`,'saved file with lost acknowledgement pauses');
  assert.equal((await mp4Files()).length,beforeAck+1);
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.')`,'acknowledgement retry completes');
  assert.equal((await mp4Files()).length,beforeAck+1,'lost acknowledgement never writes a second video');
  console.log('PASS lost native result acknowledgement reconciles without duplicate file writes');

  await evaluate(cacheFailureFixture('window.__fixture'));
  await evaluate('window.__fixture.total=1;window.__fixture.baseId=400001;window.__fixture.unknownLength=true;window.__fixture.failCacheCommit=true');
  const beforeHistoryFailure={files:(await mp4Files()).length,resolves:await evaluate('window.__fixture.resolves'),transfers:await evaluate('window.__fixture.mediaTransfers')};
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Resume'`,'saved unknown-size video with failed history commit');
  assert.equal((await mp4Files()).length,beforeHistoryFailure.files+1);
  const pendingCache=await evaluate("window.__fixture.readJson('example_creator/.reel-saver-cache.json')");
  assert.equal(pendingCache.pending['400001'].expectedBytes,null,'failed commit retains unknown expected size');
  assert.equal(pendingCache.saved['400001'],undefined);
  await click(query('[data-role=bulk-stop]'));
  await waitFor(`${query('[data-role=bulk-stop]')}.textContent==='Record history and release' && !${query('[data-role=bulk-stop]')}.disabled`,'Stop retains the physical save receipt and cache session');
  assert.match(await evaluate(`${query('[data-role=bulk-status]')}.textContent`),/already saved|history.*recording/i);
  assert.equal((await mp4Files()).length,beforeHistoryFailure.files+1);
  await evaluate('window.__fixture.failCacheCommit=false');
  await click(query('[data-role=bulk-stop]'));
  await waitFor(`${query('[data-role=bulk-stop]')}.hidden && !${query('[data-role=bulk-start]')}.disabled`,'metadata receipt recorded and stopped batch released');
  const committedCache=await evaluate("window.__fixture.readJson('example_creator/.reel-saver-cache.json')");
  assert.ok(committedCache.saved['400001'].bytesWritten>0);
  assert.deepEqual(committedCache.pending,{});
  assert.equal(await evaluate('window.__fixture.resolves'),beforeHistoryFailure.resolves+1);
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),beforeHistoryFailure.transfers+1);
  assert.equal((await mp4Files()).length,beforeHistoryFailure.files+1);
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.') && Number(${query('[data-count=alreadyDownloaded]')}.textContent)===1`,'recovered history skips the unknown-size video on the next job');
  assert.equal(await evaluate('window.__fixture.resolves'),beforeHistoryFailure.resolves+1);
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),beforeHistoryFailure.transfers+1);
  assert.equal((await mp4Files()).length,beforeHistoryFailure.files+1);
  console.log('PASS unknown-size physical save keeps its receipt after Stop; history-only release and next-job skip write no duplicate video');

  await evaluate('window.__fixture.baseId=500001;window.__fixture.unknownLength=false;window.__fixture.failCacheOpen=true;window.__fixture.failRelease=true');
  const startsBeforeOpenFailure=await evaluate('window.__fixture.jobNumber');
  const resolvesBeforeOpenFailure=await evaluate('window.__fixture.resolves');
  const filesBeforeOpenFailure=(await mp4Files()).length;
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-stop]')}.textContent==='Release batch' && !${query('[data-role=bulk-stop]')}.hidden`,'successful START retained after cache open and END both fail');
  assert.equal(await evaluate('window.__fixture.jobNumber'),startsBeforeOpenFailure+1);
  assert.equal(await evaluate('window.__fixture.resolves'),resolvesBeforeOpenFailure);
  assert.equal((await mp4Files()).length,filesBeforeOpenFailure);
  await evaluate('window.__fixture.failCacheOpen=false;window.__fixture.failRelease=false');
  await click(query('[data-role=bulk-stop]'));
  await waitFor(`${query('[data-role=bulk-stop]')}.hidden && !${query('[data-role=bulk-start]')}.disabled`,'failed startup lease releases on retry');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.') && Number(${query('[data-count=saved]')}.textContent)===1`,'new native job works after failed cache startup recovery');
  assert.equal(await evaluate('window.__fixture.resolves'),resolvesBeforeOpenFailure+1);
  assert.equal((await mp4Files()).length,filesBeforeOpenFailure+1);
  console.log('PASS cache open failure after START plus END failure retains Release batch and allows a fresh job after release');

  await evaluate('window.__fixture.failCacheOpen=true;window.__fixture.failRelease=true');
  const startsBeforeImportFailure=await evaluate('window.__fixture.jobNumber');
  await chooseReport();
  await waitFor(`!${query('[data-role=cache-import-cancel]')}.hidden && !${query('[data-role=cache-import-cancel]')}.disabled && !${query('[data-role=cache-import-summary]')}.hidden`,'failed import startup retains its Cancel release action');
  assert.equal(await evaluate('window.__fixture.jobNumber'),startsBeforeImportFailure+1);
  assert.match(await evaluate(`${query('[data-role=cache-import-summary]')}.textContent`),/Cancel to release/);
  await click(query('[data-role=cache-import-cancel]'));
  assert.equal(await evaluate(`${query('[data-role=cache-import-cancel]')}.hidden`),false,'another END failure keeps import recovery available');
  await evaluate('window.__fixture.failCacheOpen=false;window.__fixture.failRelease=false');
  await click(query('[data-role=cache-import-cancel]'));
  await waitFor(`${query('[data-role=cache-import-cancel]')}.hidden && !${query('[data-role=bulk-start]')}.disabled`,'Cancel retry releases import context without an opened cache');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.') && Number(${query('[data-count=alreadyDownloaded]')}.textContent)===1`,'next job is usable after import startup release recovery');
  assert.equal(await evaluate('window.__fixture.resolves'),resolvesBeforeOpenFailure+1);
  assert.equal((await mp4Files()).length,filesBeforeOpenFailure+1);
  console.log('PASS failed import cache open plus END failure keeps Cancel available until the registered session releases');

  await waitFor(`${query('[data-role=cache-clear]')} && !${query('[data-role=cache-clear]')}.disabled`,'clear profile history is available for the selected library');
  await evaluate(`(async()=>{
    const root=await window.__fixture.rootReady,bytes=await window.__fixture.videoReady;
    const other=await ReelSaverProfileCache.openLibrary(root,{id:'67890',username:'other_creator'});
    try{
      const item={mediaId:'1',shortcode:'B'},filename='other_creator_B.mp4';
      await other.beginWrite(item,{filename,expectedBytes:bytes.byteLength});
      const file=await other.directoryHandle.getFileHandle(filename,{create:true}),stream=await file.createWritable();
      await stream.write(bytes);await stream.close();
      await other.commitSaved(item,{filename,bytesWritten:bytes.byteLength});
    }finally{other.close();}
  })()`);
  const primaryPath='example_creator/.reel-saver-cache.json';
  const backupPath='example_creator/.reel-saver-cache.backup.json';
  const readHistory=relative=>evaluate(`window.__fixture.readJson(${JSON.stringify(relative)})`);
  const primaryBeforeClear=await readHistory(primaryPath);
  const backupBeforeClear=await readHistory(backupPath);
  const otherPrimaryBeforeClear=await readHistory('other_creator/.reel-saver-cache.json');
  const otherBackupBeforeClear=await readHistory('other_creator/.reel-saver-cache.backup.json');
  const videosBeforeClear=await mp4Files();
  const jobsBeforeClear=await evaluate('window.__fixture.jobNumber');
  const releasesBeforeClear=await evaluate('window.__fixture.releaseCalls');
  const identifyCount=()=>evaluate("window.__fixture.events.filter(event=>event.type==='REEL_SAVER_BULK_IDENTIFY').length");
  const identifiesBeforeClear=await identifyCount();
  assert.ok(Object.keys(primaryBeforeClear.saved).length>0,'clear scenario starts with recorded downloads');
  assert.ok(Object.keys(backupBeforeClear.saved).length>0,'backup also starts with recorded history');
  await evaluate(`${query('[data-role=cache-clear]')}.click()`);
  assert.equal(await identifyCount(),identifiesBeforeClear,'synthetic clear preview never identifies or opens the library');
  assert.equal(await evaluate(`${query('[data-role=cache-clear-summary]')}.hidden`),true);
  assert.deepEqual(await readHistory(primaryPath),primaryBeforeClear);

  await click(query('[data-role=cache-clear]'));
  await waitFor(`!${query('[data-role=cache-clear-summary]')}.hidden && !${query('[data-role=cache-clear-confirm]')}.disabled`,'clear history confirmation preview');
  const clearPreview=await evaluate(`${query('[data-role=cache-clear-summary]')}.textContent`);
  assert.match(clearPreview,/@example_creator/);
  assert.match(clearPreview,/My Reels/);
  assert.match(clearPreview,new RegExp(String(Object.keys(primaryBeforeClear.saved).length)));
  assert.equal(await evaluate(`${query('[data-role=cache-clear]')}.disabled`),true,'a second clear cannot open over its own confirmation');
  assert.equal(await evaluate('window.__fixture.jobNumber'),jobsBeforeClear,'clear preview never starts a bulk job');
  assert.equal(await identifyCount(),identifiesBeforeClear+1);
  assert.deepEqual(await readHistory(primaryPath),primaryBeforeClear,'preview keeps primary history intact');
  assert.deepEqual(await readHistory(backupPath),backupBeforeClear,'preview keeps backup history intact');
  await evaluate(`${query('[data-role=cache-clear-confirm]')}.click()`);
  assert.equal(await identifyCount(),identifiesBeforeClear+1,'synthetic confirmation cannot clear metadata');
  assert.deepEqual(await readHistory(primaryPath),primaryBeforeClear);
  await evaluate(`${query('[data-role=cache-clear-cancel]')}.click()`);
  assert.equal(await evaluate(`${query('[data-role=cache-clear-confirm]')}.hidden`),false,'synthetic Cancel cannot discard a trusted confirmation');
  await click(query('[data-role=cache-clear-cancel]'));
  await waitFor(`${query('[data-role=cache-clear-summary]')}.hidden && !${query('[data-role=cache-clear]')}.disabled`,'Cancel closes history confirmation and releases its cache session');
  assert.deepEqual(await readHistory(primaryPath),primaryBeforeClear);
  assert.deepEqual(await readHistory(backupPath),backupBeforeClear);
  assert.deepEqual(await mp4Files(),videosBeforeClear,'preview and Cancel preserve all video paths and sizes');

  await click(query('[data-role=cache-clear]'));
  await waitFor(`!${query('[data-role=cache-clear-summary]')}.hidden`,'confirmation before source navigation');
  await evaluate("history.pushState({},'', '/other_creator/reels/');window.dispatchEvent(new PopStateEvent('popstate'));");
  await waitFor(`${query('[data-role=cache-clear-summary]')}.hidden && ${query('[data-role=cache-clear-confirm]')}.hidden`,'source navigation invalidates pending confirmation');
  assert.deepEqual(await readHistory(primaryPath),primaryBeforeClear,'navigation never confirms destructive metadata changes');
  await evaluate("history.pushState({},'', '/example_creator/reels/');window.dispatchEvent(new PopStateEvent('popstate'));");
  await waitFor(`!${query('[data-role=cache-clear]')}.disabled`,'clear available after returning to source profile');

  await click(query('[data-role=cache-clear]'));
  await waitFor(`!${query('[data-role=cache-clear-confirm]')}.disabled && !${query('[data-role=cache-clear-confirm]')}.hidden`,'confirmation before numeric identity changes');
  await evaluate("window.__fixture.identifyProfile={id:'54321',username:'example_creator'}");
  const identifiesBeforeRefusal=await identifyCount();
  await click(query('[data-role=cache-clear-confirm]'));
  await waitFor(`window.__fixture.events.filter(event=>event.type==='REEL_SAVER_BULK_IDENTIFY').length>${identifiesBeforeRefusal} && !${query('[data-role=cache-clear-confirm]')}.disabled`,'confirmation rechecks the numeric profile identity');
  assert.deepEqual(await readHistory(primaryPath),primaryBeforeClear,'same username with another numeric ID cannot clear this collection');
  assert.deepEqual(await readHistory(backupPath),backupBeforeClear);
  await evaluate('window.__fixture.identifyProfile=null');
  if(!await evaluate(`${query('[data-role=cache-clear-cancel]')}.hidden`))await click(query('[data-role=cache-clear-cancel]'));
  await waitFor(`!${query('[data-role=cache-clear]')}.disabled`,'identity refusal can release its confirmation');

  await click(query('[data-role=cache-clear]'));
  await waitFor(`!${query('[data-role=cache-clear-confirm]')}.hidden && !${query('[data-role=cache-clear-confirm]')}.disabled`,'final trusted clear confirmation');
  const identifiesBeforeCommit=await identifyCount();
  await click(query('[data-role=cache-clear-confirm]'));
  await waitFor(`(async()=>{const primary=await window.__fixture.readJson('${primaryPath}'),backup=await window.__fixture.readJson('${backupPath}');return Object.keys(primary.saved).length===0 && Object.keys(backup.saved).length===0 && !${query('[data-role=cache-clear]')}.disabled;})()`,'primary and backup history cleared together');
  assert.equal(await identifyCount(),identifiesBeforeCommit+1,'trusted confirmation verifies the profile again');
  assert.equal(await evaluate('window.__fixture.jobNumber'),jobsBeforeClear,'clearing history never starts or ends a bulk job');
  assert.equal(await evaluate('window.__fixture.releaseCalls'),releasesBeforeClear,'clear confirmation does not release a different worker job');
  const clearedPrimary=await readHistory(primaryPath),clearedBackup=await readHistory(backupPath);
  assert.equal(clearedPrimary.profile.id,'12345');
  assert.equal(clearedBackup.profile.id,'12345');
  assert.deepEqual(clearedPrimary.pending,{});
  assert.deepEqual(clearedBackup.pending,{});
  assert.deepEqual(await mp4Files(),videosBeforeClear,'confirmed clearing retains every MP4 name and byte size');
  assert.deepEqual(await readHistory('other_creator/.reel-saver-cache.json'),otherPrimaryBeforeClear,'another profile primary stays unchanged');
  assert.deepEqual(await readHistory('other_creator/.reel-saver-cache.backup.json'),otherBackupBeforeClear,'another profile backup stays unchanged');
  const indexAfterClear=await readHistory('.reel-saver-library.json');
  assert.equal(indexAfterClear.profiles['12345'].folderName,'example_creator');
  assert.equal(indexAfterClear.profiles['67890'].folderName,'other_creator');
  console.log('PASS trusted clear preview, Cancel, source/ID fences, both metadata copies reset, every video and unrelated profile retained');

  const originalOutput=primaryBeforeClear.saved['500001'].relativePath;
  const transfersBeforeRedownload=await evaluate('window.__fixture.mediaTransfers');
  const resolvesBeforeRedownload=await evaluate('window.__fixture.resolves');
  await evaluate('window.__fixture.total=1;window.__fixture.baseId=500001');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.') && Number(${query('[data-count=saved]')}.textContent)===1`,'cleared history permits a fresh download');
  const videosAfterRedownload=await mp4Files();
  const oldPaths=new Set(videosBeforeClear.map(file=>file.path));
  const newVideos=videosAfterRedownload.filter(file=>!oldPaths.has(file.path));
  assert.equal(newVideos.length,1,'redownload creates exactly one additional MP4');
  assert.equal(videosAfterRedownload.length,videosBeforeClear.length+1);
  assert.deepEqual(videosAfterRedownload.filter(file=>oldPaths.has(file.path)),videosBeforeClear,'redownload preserves every pre-existing file');
  assert.equal(newVideos[0].path,`example_creator/${originalOutput.slice(0,-4)} (1).mp4`,'redownload uses a unique suffix within the existing profile folder');
  assert.equal(await evaluate('window.__fixture.resolves'),resolvesBeforeRedownload+1);
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),transfersBeforeRedownload+1);
  const rerecorded=await readHistory(primaryPath);
  assert.deepEqual(Object.keys(rerecorded.saved),['500001']);
  assert.equal(rerecorded.saved['500001'].relativePath,newVideos[0].path.slice('example_creator/'.length));
  assert.deepEqual(await readHistory('other_creator/.reel-saver-cache.json'),otherPrimaryBeforeClear);
  console.log('PASS a post-clear job redownloads with a unique suffix and records only its fresh output');

  await evaluate('window.__fixture.baseId=700001;window.__fixture.holdPage=true');
  await click(query('[data-role=bulk-start]'));
  await waitFor('window.__fixture.heldPages.length===1','held job for clear-action exclusion');
  assert.equal(await evaluate(`${query('[data-role=cache-clear]')}.disabled`),true,'clear disabled while a job runs');
  await click(query('[data-role=bulk-pause]'));
  await evaluate('window.__fixture.holdPage=false;window.__fixture.heldPages.splice(0).forEach(resolve=>resolve())');
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Resume'`,'paused job for clear-action exclusion');
  assert.equal(await evaluate(`${query('[data-role=cache-clear]')}.disabled`),true,'clear stays disabled while a job is paused');
  await click(query('[data-role=bulk-stop]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Stopped.') && !${query('[data-role=cache-clear]')}.disabled`,'clear enabled after job releases');
  await chooseReport();
  await waitFor(`!${query('[data-role=cache-import-summary]')}.hidden && !${query('[data-role=cache-import-commit]')}.disabled`,'import preview for clear-action exclusion');
  assert.equal(await evaluate(`${query('[data-role=cache-clear]')}.disabled`),true,'clear disabled during report import');
  await click(query('[data-role=cache-import-cancel]'));
  await waitFor(`${query('[data-role=cache-import-cancel]')}.hidden && !${query('[data-role=cache-clear]')}.disabled`,'import Cancel releases clear action');
  console.log('PASS clear action is unavailable during active and paused jobs or report import');

  await selectLimitMode('custom');
  await enterLimit('2');
  await waitFor(`window.__fixture.maxNewVideos===2 && !${query('[data-role=bulk-start]')}.disabled`,'custom limit saved');
  assert.equal(await evaluate(`${query('[data-role=bulk-start]')}.textContent`),'Download up to 2 new Reels');
  const beforeLimitedNative={files:(await mp4Files()).length,transfers:await evaluate('window.__fixture.mediaTransfers'),resolves:await evaluate('window.__fixture.resolves')};
  await evaluate('window.__fixture.baseId=500001;window.__fixture.total=30;window.__fixture.events=[];window.__fixture.report=null');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'native cap reached and released');
  assert.equal(await evaluate('window.__fixture.job.options.maxNewVideos'),2,'worker receives the selected cap');
  assert.equal((await mp4Files()).length,beforeLimitedNative.files+2,'cached video does not consume native cap');
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),beforeLimitedNative.transfers+2);
  assert.equal(await evaluate('window.__fixture.resolves'),beforeLimitedNative.resolves+2);
  assert.equal(await evaluate(`${query('[data-count=saved]')}.textContent`),'2');
  assert.equal(await evaluate(`${query('[data-count=alreadyDownloaded]')}.textContent`),'1');
  assert.equal(await evaluate("window.__fixture.events.filter(event=>event.type==='REEL_SAVER_BULK_PAGE').length"),1,'small cap avoids unnecessary discovery pages');
  await click(query('[data-role=bulk-report]'));
  await waitFor('window.__fixture.report?.completionReason==="profile_limit_reached"','limited report exported');
  const limitedReport=await evaluate('window.__fixture.report');
  assert.equal(limitedReport.version,1);
  assert.equal(limitedReport.maxNewVideos,2);
  assert.equal(limitedReport.committedNewSaves,2);
  assert.equal(limitedReport.sourceExhausted,false,'limit is not full-profile completion');
  assert.ok(limitedReport.counts.deferred>0);
  assert.ok(limitedReport.items.filter(item=>item.state==='deferred').every(item=>item.reason==='profile_limit_reached'));
  console.log('PASS strict limit validation, saved preferences, native cap excludes cache hits, no extra discovery, compatible limited report');

  await selectDestination('downloads');
  await evaluate('window.__fixture.total=9;window.__fixture.browserState="in_progress";window.__fixture.events=[]');
  const downloadsBeforeLimitedPause=await evaluate('window.__fixture.downloads');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`window.__fixture.downloads===${downloadsBeforeLimitedPause+1}`,'limited browser transfer accepted');
  assert.equal(await evaluate(`${query('[data-role=bulk-limit-mode]')}.disabled`),true,'limit mode frozen while running');
  assert.equal(await evaluate(`${query('[data-role=bulk-limit]')}.disabled`),true,'limit frozen while running');
  await click(query('[data-role=bulk-pause]'));
  await evaluate('window.__fixture.browserState="complete"');
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Resume'`,'limited browser job paused');
  assert.equal(await evaluate(`${query('[data-role=bulk-limit]')}.disabled`),true,'limit remains frozen while paused');
  assert.equal(await evaluate(`${query('[data-count=saved]')}.textContent`),'1');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'limited browser Resume preserves allowance');
  assert.equal(await evaluate('window.__fixture.downloads'),downloadsBeforeLimitedPause+2,'Resume uses only remaining allowance');
  assert.equal(await evaluate(`${query('[data-count=saved]')}.textContent`),'2');
  console.log('PASS browser cap, frozen active/paused settings, Resume retains committed allowance');

  await click(query('[data-role=bulk-mode]'));await key('End','End',35);await key('Enter','Enter',13);
  await waitFor("window.__fixture.mode==='scan_all' && !document.querySelector('[data-reel-saver-panel]').shadowRoot.querySelector('[data-role=bulk-start]').disabled",'limited scan-all selected');
  await evaluate('window.__fixture.total=27;window.__fixture.events=[]');
  const downloadsBeforeLimitedScan=await evaluate('window.__fixture.downloads');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Download up to 2 new Reels' && ${query('[data-role=bulk-limit]')}.disabled`,'limited full scan ready for approval');
  assert.equal(await evaluate("window.__fixture.events.filter(event=>event.type==='REEL_SAVER_BULK_PAGE').length"),3,'scan-all still discovers the entire feed');
  assert.equal(await evaluate('window.__fixture.downloads'),downloadsBeforeLimitedScan,'scan-all still requires approval');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'limited scan-all saves only its allowance');
  assert.equal(await evaluate('window.__fixture.downloads'),downloadsBeforeLimitedScan+2);
  console.log('PASS scan-all discovers the full feed, presents the save cap, and needs explicit approval');

  await click(query('[data-role=bulk-mode]'));await key('Home','Home',36);await key('Enter','Enter',13);
  await waitFor(`window.__fixture.mode==='batches' && !${query('[data-role=bulk-start]')}.disabled`,'limited batch mode restored');
  await evaluate('window.__fixture.total=4;window.__fixture.failItem="500001";window.__fixture.failCount=0');
  const downloadsBeforeLimitedFailure=await evaluate('window.__fixture.downloads');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'failed item does not consume the cap');
  assert.equal(await evaluate('window.__fixture.downloads'),downloadsBeforeLimitedFailure+3,'one failed attempt plus two successful saves');
  assert.equal(await evaluate(`${query('[data-count=saved]')}.textContent`),'2');
  assert.equal(await evaluate(`${query('[data-count=failed]')}.textContent`),'1');
  assert.equal(await evaluate(`${query('[data-role=bulk-retry]')}.disabled`),true,'failed retries cannot exceed an exhausted cap');
  console.log('PASS failures do not consume allowance and Retry failed cannot exceed the finished cap');

  await evaluate('window.__fixture.total=3;window.__fixture.failItem=null;window.__fixture.browserState="in_progress";window.__fixture.completeOnCancel=true;window.__fixture.report=null');
  const downloadsBeforeStopRace=await evaluate('window.__fixture.downloads');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`window.__fixture.downloads===${downloadsBeforeStopRace+1}`,'browser transfer before Stop/completion race');
  await click(query('[data-role=bulk-stop]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Stopped. 1 saved') && !${query('[data-role=bulk-start]')}.disabled`,'Stop reconciles a browser file completed just before cancellation');
  assert.equal(await evaluate('window.__fixture.downloads'),downloadsBeforeStopRace+1,'Stop receipt reconciliation does not start another video');
  assert.equal(await evaluate(`${query('[data-count=saved]')}.textContent`),'1');
  await click(query('[data-role=bulk-report]'));
  await waitFor('window.__fixture.report?.completionReason==="user_stopped"','Stop race report exported');
  assert.equal(await evaluate('window.__fixture.report.committedNewSaves'),1,'physical completion is included in stopped run allowance');
  assert.equal(await evaluate('window.__fixture.report.counts.saved'),1);
  assert.equal(await evaluate('window.__fixture.report.items.filter(item=>item.state==="saved").length'),1);
  console.log('PASS Browser Downloads completion racing Stop is retained as a saved receipt with user_stopped reason');

  await click(query('[data-role=choose-folder]'));
  await evaluate('window.__fixture.total=1;window.__fixture.baseId=800001;window.__fixture.failTransfers=1;window.__fixture.failNegativeAck=1;window.__fixture.events=[]');
  const beforeNegativeAck={files:(await mp4Files()).length,resolves:await evaluate('window.__fixture.resolves'),transfers:await evaluate('window.__fixture.mediaTransfers')};
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Resume'`,'lost no-output acknowledgement pauses before another attempt');
  assert.equal((await mp4Files()).length,beforeNegativeAck.files);
  assert.equal(await evaluate('window.__fixture.nativePrepared.size'),1,'lost negative acknowledgement retains its prepared reservation');
  assert.equal(await evaluate('window.__fixture.resolves'),beforeNegativeAck.resolves+1);
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),beforeNegativeAck.transfers+1);
  const failedAttempt=await evaluate("window.__fixture.events.find(event=>event.type==='REEL_SAVER_BULK_ITEM_RESULT'&&event.resultState==='failed').attemptId");
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.') && !${query('[data-role=bulk-start]')}.disabled`,'Resume records failed old attempt before downloading again');
  assert.equal((await mp4Files()).length,beforeNegativeAck.files+1,'exactly one completed file is created after failed transfer acknowledgement recovery');
  assert.equal(await evaluate('window.__fixture.nativePrepared.size'),0);
  const recoveryEvents=await evaluate('window.__fixture.events');
  const oldAttemptAcks=recoveryEvents.filter(event=>event.type==='REEL_SAVER_BULK_ITEM_RESULT'&&event.attemptId===failedAttempt);
  assert.equal(oldAttemptAcks.length,2,'metadata retry acknowledges the original failed attempt');
  const secondLookup=recoveryEvents.map((event,index)=>({...event,index})).filter(event=>event.type==='REEL_SAVER_BULK_RESOLVE')[1];
  assert.ok(recoveryEvents.indexOf(oldAttemptAcks[1])<secondLookup.index,'negative acknowledgement settles before a new media lookup');
  console.log('PASS lost native failure acknowledgement retains its original attempt and Resume settles metadata before a fresh transfer');

  await evaluate('window.__fixture.baseId=800002;window.__fixture.holdResolve=true;window.__fixture.events=[]');
  const beforeHeldResolve={files:(await mp4Files()).length,transfers:await evaluate('window.__fixture.mediaTransfers')};
  await click(query('[data-role=bulk-start]'));
  await waitFor('window.__fixture.heldResolves.length===1','held native lookup before Stop');
  await click(query('[data-role=bulk-stop]'));
  await evaluate('window.__fixture.holdResolve=false;window.__fixture.heldResolves.splice(0).forEach(resolve=>resolve())');
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Stopped.') && !${query('[data-role=bulk-start]')}.disabled`,'Stop acknowledges a late prepared lookup without invoking the writer');
  assert.equal((await mp4Files()).length,beforeHeldResolve.files);
  assert.equal(await evaluate('window.__fixture.mediaTransfers'),beforeHeldResolve.transfers,'late lookup after Stop never transfers bytes');
  assert.equal(await evaluate('window.__fixture.nativePrepared.size'),0,'Stop releases the no-output prepared reservation');
  assert.equal(await evaluate("window.__fixture.events.filter(event=>event.type==='REEL_SAVER_BULK_ITEM_RESULT'&&event.resultState==='canceled').length"),1);
  console.log('PASS Stop during a held native lookup acknowledges its late prepared response and releases without writing');

  assert.deepEqual(exceptions,[],'no uncaught browser exceptions');
  console.log('Screenshot: artifacts/bulk-panel-preview.png');
  await send('Browser.close');

} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (child?.exitCode === null) {
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (child.exitCode === null) child.kill();
  }
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('reel-saver-bulk-smoke-')) {
    await rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}
