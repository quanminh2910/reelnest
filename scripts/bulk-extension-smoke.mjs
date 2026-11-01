// Actual unpacked extension smoke: Chrome runtime/storage/scripting are real.
// Instagram and CDN responses are local fixtures; the selected OPFS folder is real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opfsFixture } from './browser-fs-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.REEL_SAVER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch {}
}
if (!executable) throw new Error('Set REEL_SAVER_BROWSER to a Chromium executable.');
const mainFixture = `(() => {
 const profile=location.pathname.startsWith('/second_creator/')?{id:'67890',username:'second_creator'}:{id:'12345',username:'example_creator'};
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const code=id=>{let n=BigInt(id),s='';do{s=alphabet[Number(n%64n)]+s;n/=64n;}while(n);return s;};
 const ids=Array.from({length:profile.id==='12345'?36:2},(_,i)=>String(100001+i));
 const media=id=>({pk:id,code:code(id),media_type:2,user:{pk:profile.id,username:profile.username},
  video_versions:[{url:'https://scontent.cdninstagram.com/'+code(id)+'.mp4?secret=local_fixture',width:32,height:32}]});
 const graphId='graphql-profile-'+profile.id,provider='__relay_internal__pv__PolarisShortDramaEnabledrelayprovider';
 window.__pageFixture={pages:[],counts:[],graphIds:[],info:[],providers:0,readerCalls:0};
 const environment={getStore:()=>({getSource:()=>({getRecordIDs:()=>['XDTUserDict:'+profile.id],get:()=>({...profile,pk:profile.id,id:graphId})})})};
 const argument=name=>({kind:'Variable',name,variableName:name});
 const definitions=['after','data','first','id',provider].map(name=>({kind:'LocalArgument',name,defaultValue:null}));
 // Field names/types and the sibling connection handle match the operation
 // captured from the user's signed-in Instagram tab on 2026-10-31.
 const connection={kind:'LinkedField',name:'clips_connection',alias:null,concreteType:'XDTUserProfileClipsConnection',plural:false,
  args:[argument('after'),argument('data'),argument('first')],selections:[]};
 const node={kind:'LinkedField',name:'fetch__XDTUserDict',alias:null,concreteType:'XDTUserDict',plural:false,args:[argument('id')],
  selections:[connection,{kind:'LinkedHandle',name:'clips_connection',handle:'connection',
   key:'PolarisProfileReelsTabContentQuery_clips_connection',filters:['data'],args:connection.args},{kind:'ScalarField',name:'id'}]};
 const descriptor={params:{id:'CURRENT_FIRST_PARTY_QUERY',name:'PolarisProfileReelsTabContentQuery_connection',operationKind:'query',
  providedVariables:{[provider]:{get(){window.__pageFixture.providers++;return true;}}}},
  fragment:{kind:'Fragment',name:'ProfileReelsReader',type:'Query',argumentDefinitions:definitions,selections:[{...node,selections:[{kind:'ScalarField',name:'id'},
   {kind:'FragmentSpread',name:'PolarisProfileReelsTabContentQuery'}]}]},
  operation:{argumentDefinitions:definitions,selections:[node]}};
 environment.execute=({operation})=>({subscribe(observer){
    const variables=operation.request.variables;
    if(variables.first!==12||variables.id!==graphId||variables.data.target_user_id!==profile.id)throw new Error('Profile query arguments were not supplied');
    window.__pageFixture.counts.push(variables.first);window.__pageFixture.graphIds.push(variables.id);
    window.__pageFixture.pages.push(variables.after||null);const offset=Number(variables.after||0),values=ids.slice(offset,offset+12),after=offset+values.length;
    const subscription={unsubscribe(){}};observer.start?.(subscription);
    observer.next({data:{fetch__XDTUserDict:{id:graphId,clips_connection:{edges:values.map(id=>({node:{media:media(id)}})),
      page_info:{has_next_page:after<ids.length,end_cursor:after<ids.length?String(after):null}}}}});
    observer.complete();return subscription;}});
 const modules={PolarisRelayEnvironment:environment,
  'PolarisProfileReelsTabContentQuery_connection.graphql':descriptor,
  PolarisInstapi:{apiGet:async(path)=>{window.__pageFixture.info.push(path);const id=path.match(/media\\/([0-9]+)\\//)?.[1];
    return id?{data:{items:[media(id)]}}:{data:{user:profile}};}},
  // Like the live page, the public client exposes fetchQuery but no factory.
  CometRelay:{fetchQuery(env,query,variables){
    window.__pageFixture.readerCalls++;
    if(query.params!==descriptor.params||query.operation!==descriptor.operation||query.fragment===descriptor.fragment)throw new Error('Only the reader may change');
    if(query.fragment.selections[0].selections.some(field=>field.kind==='FragmentSpread'))throw new Error('Masked reader cannot expose the connection');
    const runtimeVariables=Object.fromEntries(query.operation.argumentDefinitions.map(def=>[def.name,variables[def.name]??def.defaultValue]));
    for(const [name,implementation]of Object.entries(query.params.providedVariables))runtimeVariables[name]=implementation.get();
    const operation={request:{node:query,variables:runtimeVariables,cacheConfig:{force:true}}};
    return{subscribe(observer){return env.execute({operation}).subscribe({start:value=>observer.start?.(value),
      next:response=>observer.next(response.data),error:error=>observer.error(error),complete:()=>observer.complete()});}};}}};
 window.require=name=>{if(!Object.hasOwn(modules,name))throw new Error('Module not loaded: '+name);return modules[name];};
})();`;
const isolatedFixture = `(() => {
 const state=window.__isolatedFixture={pickerCalls:0,playable:false,mediaTransfers:0};
 ${opfsFixture('window.__isolatedFixture', 'Installed extension fixture')}
 state.videoReady=(async()=>{
  const mimeType=['video/mp4;codecs=avc1.42001E','video/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType)throw new Error('No MP4 encoder available.');
  const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const ctx=canvas.getContext('2d');ctx.fillStyle='#1c523e';ctx.fillRect(0,0,32,32);
  const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType}),chunks=[];
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
  const done=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=event=>reject(event.error);});
  recorder.start();await new Promise(resolve=>setTimeout(resolve,450));recorder.stop();await done;stream.getTracks().forEach(track=>track.stop());
  const blob=new Blob(chunks,{type:'video/mp4'}),url=URL.createObjectURL(blob),video=document.createElement('video');video.src=url;
  await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Generated video cannot load.'));});
  state.playable=video.videoWidth===32&&video.duration>0;URL.revokeObjectURL(url);state.bytes=await blob.arrayBuffer();return state.bytes;
 })();
 window.fetch=async(address,options)=>{
  state.mediaTransfers++;
  if(options?.referrerPolicy!=='strict-origin-when-cross-origin'||options?.redirect!=='error'||options?.credentials!=='omit')throw new TypeError('Fixture CDN rejects the no-referrer redirect');
  const bytes=await state.videoReady;return new Response(bytes,{headers:{'Content-Type':'video/mp4','Content-Length':String(bytes.byteLength)}});};
})();`;
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Installed extension profile fixture</title></head><body><main><header><h1>example_creator</h1></header></main><script>${mainFixture.replaceAll('</script','<\\/script')}</script></body></html>`;
const profile = await mkdtemp(path.join(tmpdir(), 'reel-saver-bulk-extension-'));
let child;
let ws;
let browserLog = '';
try {
  child = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu',
    '--no-sandbox', '--disable-background-networking', '--disable-default-apps', '--disable-sync',
    '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${root}`, `--load-extension=${root}`,
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
  const executionContexts = [];
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
    } else if (message.method === 'Runtime.executionContextCreated') {
      executionContexts.push(message.params.context);
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
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(profile,'downloads')});
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params = {}) => send(method, params, sessionId);
  await page('Runtime.enable');
  await page('Page.enable');
  await page('Fetch.enable', { patterns: [{ urlPattern: 'https://www.instagram.com/*', resourceType: 'Document', requestStage: 'Request' }] });
  await page('Emulation.setDeviceMetricsOverride', { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  async function waitFor(expression, description) {
    for (let tries = 0; tries < 200; tries++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${description}; exceptions: ${JSON.stringify(exceptions)}; page: ${await evaluate("document.querySelector('[data-reel-saver-panel]')?.shadowRoot?.textContent.slice(-2200) || document.body?.innerText.slice(0,200)")}`);
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
  async function setLimit(value) {
    await click(query('[data-role=bulk-limit-mode]'));
    await key('Home', 'Home', 36);
    if (value !== null) await key('ArrowDown', 'ArrowDown', 40);
    await key('Enter', 'Enter', 13);
    if (value !== null) {
      await click(query('[data-role=bulk-limit]'));
      await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await page('Input.insertText', { text: String(value) });
      await key('Tab', 'Tab', 9);
    }
    await waitFor(`!${query('[data-role=bulk-start]')}.disabled`, 'limit settings committed');
  }
  await page('Page.navigate',{url:'https://www.instagram.com/example_creator/reels/'});
  await waitFor(`${launcher}`,'actual extension profile launcher');
  let workerSession;
  let extensionId;
  // The content launcher can appear before the new extension worker finishes
  // starting. Wait for that target instead of assuming synchronous startup.
  for(let attempt=0;attempt<80&&!workerSession;attempt++){
    const targets=await send('Target.getTargets');
    for(const target of targets.targetInfos.filter(t=>t.type==='service_worker'&&t.url.endsWith('/src/background/background.js'))){
      const attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});
      const response=await send('Runtime.evaluate',{expression:'chrome.runtime.getManifest().name',returnByValue:true},attached.sessionId);
      if(response.result?.value==='ReelNest'){workerSession=attached.sessionId;extensionId=new URL(target.url).host;break;}
    }
    if(!workerSession)await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(workerSession,'actual ReelNest service worker loaded');
  const contentContext=()=>executionContexts.filter(context=>context.auxData?.type==='isolated'&&
    (context.origin==='chrome-extension://'+extensionId||context.name.includes(extensionId))).at(-1);
  let content=contentContext();
  assert.ok(content,'actual extension isolated content world found: '+JSON.stringify(executionContexts.map(c=>({id:c.id,name:c.name,origin:c.origin,type:c.auxData?.type}))));
  async function isolated(expression){const result=await page('Runtime.evaluate',{expression,contextId:content.id,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
  await isolated(isolatedFixture);
  await isolated('window.__isolatedFixture.videoReady');
  assert.equal(await isolated('window.__isolatedFixture.playable'),true);
  assert.equal(await evaluate('typeof window.ReelSaverFolderWriter'),'undefined','page cannot access isolated folder capability');
  await click(launcher);
  await waitFor(`${query('[data-role=bulk-start]')} && !${query('[data-role=bulk-start]')}.disabled`,'actual bulk settings from worker');
  await click(query('[data-role=choose-folder]'));
  await waitFor(`${query('[data-role=destination]')}.value==='chosen'`,'isolated native folder');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.')`,'actual36Reel worker/source/queue/native job');
  const mp4Files=()=>isolated("window.__isolatedFixture.listFiles().then(files=>files.filter(file=>file.path.endsWith('.mp4')))");
  const firstFiles=await mp4Files();
  assert.equal(firstFiles.length,36);
  assert.equal(new Set(firstFiles.map(file=>file.path)).size,36);
  assert.ok(firstFiles.every(file=>file.path.startsWith('example_creator/')&&file.size>0));
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),36);
  const firstCache=await isolated("window.__isolatedFixture.readJson('example_creator/.reel-saver-cache.json')");
  assert.equal(Object.keys(firstCache.saved).length,36);
  assert.deepEqual(firstCache.pending,{});
  assert.equal(firstCache.profile.id,'12345');
  assert.ok(!JSON.stringify(firstCache).includes('secret='),'persistent cache contains no signed media URLs');
  assert.deepEqual(await evaluate('window.__pageFixture.pages'),[null,'12','24']);
  assert.deepEqual(await evaluate('window.__pageFixture.counts'),[12,12,12],'serialized source fills first for each page');
  assert.deepEqual(await evaluate('window.__pageFixture.graphIds'),['graphql-profile-12345','graphql-profile-12345','graphql-profile-12345'],'exact GraphQL profile ID supplied');
  assert.equal(await evaluate('window.__pageFixture.providers'),3,'runtime evaluates providers once per page');
  assert.equal(await evaluate('window.__pageFixture.readerCalls'),3,'public fetchQuery used with an unmasked reader for every page');
  const journalResponse=await send('Runtime.evaluate',{expression:`(async()=>{const all=await chrome.storage.session.get(null);const active=all['reel-saver:bulk-active'];return{active,operations:Object.entries(all).filter(([key])=>key.includes(':operation:')).map(([key,value])=>value)};})()`,returnByValue:true,awaitPromise:true},workerSession);
  if(journalResponse.exceptionDetails)throw new Error(journalResponse.exceptionDetails.text);
  const journal=journalResponse.result.value;
  assert.equal(journal.active.active,false,'END released actual worker lease');
  assert.equal(journal.active.exhausted,true,'worker confirmed discovery exhaustion');
  assert.equal(journal.operations.length,36);
  assert.equal(journal.operations.filter(item=>item.state==='saved').length,36,'all actual journal operations saved');
  assert.ok(journal.operations.every(item=>!JSON.stringify(item).includes('secret=')),'signed media URL not persisted');
  assert.equal(await isolated('chrome.runtime.id'),extensionId,'runtime was not mocked');
  console.log('PASS actual installed extension: profile client -> scripting MAIN -> worker membership -> queue -> isolated writer -> actual session journal');
  console.log('PASS 36 unique playable MP4 transfers into an actual OPFS profile folder and 36 committed cache entries');
  const mediaInfoCount=()=>evaluate("window.__pageFixture.info.filter(path=>/media\\//.test(path)).length");
  const firstInfo=await mediaInfoCount();
  assert.equal(firstInfo,36);
  async function startAndCheck(saved,already,description){
    await click(query('[data-role=bulk-start]'));
    await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Completed.') && Number(${query('[data-count=saved]')}.textContent)===${saved} && Number(${query('[data-count=alreadyDownloaded]')}.textContent)===${already} && !${query('[data-role=bulk-start]')}.disabled`,description);
  }
  await startAndCheck(0,36,'all-cached second job');
  assert.equal(await mediaInfoCount(),firstInfo,'verified cached Reels never resolve signed media again');
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),36,'second job makes no MP4 requests');
  assert.deepEqual(await mp4Files(),firstFiles,'second job does not create or resize a video');
  console.log('PASS a new job verifies all 36 cache hits with zero new media resolution or video writes');

  await isolated(`window.__isolatedFixture.removeFile(${JSON.stringify(firstFiles[0].path)})`);
  await startAndCheck(1,35,'deleted video restored');
  assert.equal(await mediaInfoCount(),firstInfo+1,'only the missing video is resolved');
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),37);
  assert.deepEqual(await mp4Files(),firstFiles,'missing video reuses the available original filename');
  console.log('PASS deleting one saved video causes exactly one replacement download');

  async function reconnectFixture(description){
    await waitFor(`${launcher} && ${query('[data-role=dialog]')} && !${query('[data-role=dialog]')}.open`,description);
    content=contentContext();
    assert.ok(content,'new document has an isolated extension context');
    await isolated(isolatedFixture);
    await isolated('window.__isolatedFixture.videoReady');
    await click(launcher);
    await waitFor(`${query('[data-role=bulk-start]')} && !${query('[data-role=bulk-start]')}.disabled`,'new document bulk controls');
    await click(query('[data-role=choose-folder]'));
    await waitFor(`${query('[data-role=destination]')}.value==='chosen'`,'reselected persistent OPFS root');
  }
  await page('Page.reload');
  await reconnectFixture('reloaded extension launcher');
  await startAndCheck(0,36,'persistent cache after reload and root reselection');
  assert.equal(await mediaInfoCount(),0);
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),0);
  assert.deepEqual(await mp4Files(),firstFiles);
  console.log('PASS reload and parent-folder reselection preserve profile history and prevent repeated downloads');

  await page('Page.navigate',{url:'https://www.instagram.com/second_creator/reels/'});
  await reconnectFixture('second profile launcher');
  await startAndCheck(2,0,'second profile isolated library folder');
  const bothProfiles=await mp4Files();
  assert.equal(bothProfiles.filter(file=>file.path.startsWith('example_creator/')).length,36);
  assert.equal(bothProfiles.filter(file=>file.path.startsWith('second_creator/')).length,2);
  const secondCache=await isolated("window.__isolatedFixture.readJson('second_creator/.reel-saver-cache.json')");
  assert.equal(secondCache.profile.id,'67890');
  assert.equal(Object.keys(secondCache.saved).length,2);
  const index=await isolated("window.__isolatedFixture.readJson('.reel-saver-library.json')");
  assert.equal(index.profiles['12345'].folderName,'example_creator');
  assert.equal(index.profiles['67890'].folderName,'second_creator');
  console.log('PASS one selected library root isolates two profile folders and their persistent histories');

  // Exercise the limit through the real installed content/worker protocol. A
  // deliberate copy counts as new even though the profile already has history.
  await page('Page.navigate',{url:'https://www.instagram.com/example_creator/reels/'});
  await reconnectFixture('limited profile launcher');
  await setLimit(1);
  await click(query('[data-role=skip-existing]'));
  assert.equal(await evaluate(`${query('[data-role=skip-existing]')}.checked`),false);
  await isolated(`(() => {const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{
    if(blob.type==='application/json')blob.text().then(text=>{window.__isolatedFixture.report=JSON.parse(text);});return create(blob);};})()`);
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'one-save limit and lease release');
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),1);
  assert.equal(await mediaInfoCount(),1,'only the permitted Reel is resolved');
  assert.deepEqual(await evaluate('window.__pageFixture.pages'),[null],'cap one does not fetch a second discovery page');
  assert.equal((await mp4Files()).length,39,'one additional uniquely named copy is kept');
  await click(query('[data-role=bulk-report]'));
  for(let attempt=0;attempt<40&&!await isolated('!!window.__isolatedFixture.report');attempt++)await new Promise(resolve=>setTimeout(resolve,25));
  const limitedReport=await isolated('window.__isolatedFixture.report');
  assert.equal(limitedReport.version,1);
  assert.equal(limitedReport.maxNewVideos,1);
  assert.equal(limitedReport.committedNewSaves,1);
  assert.equal(limitedReport.completionReason,'profile_limit_reached');
  assert.equal(limitedReport.sourceExhausted,false);
  assert.equal(limitedReport.counts.saved,1);
  assert.equal(limitedReport.counts.deferred,11);
  assert.equal(limitedReport.items.filter(item=>item.state==='deferred'&&item.reason==='profile_limit_reached').length,11);
  assert.equal(limitedReport.items.some(item=>JSON.stringify(item).includes('secret=')),false);
  console.log('PASS installed single-profile cap: one committed copy, no extra page/media request, compatible report and deferred overflow');

  // Missing files remain eligible; cached pages must not consume the allowance.
  await click(query('[data-role=skip-existing]'));
  const historyAfterCopy=await isolated("window.__isolatedFixture.readJson('example_creator/.reel-saver-cache.json')");
  const missing=Object.values(historyAfterCopy.saved).slice(-2).map(entry=>'example_creator/'+entry.relativePath);
  for(const filename of missing)await isolated(`window.__isolatedFixture.removeFile(${JSON.stringify(filename)})`);
  await evaluate('window.__pageFixture.pages=[];window.__pageFixture.info=[]');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'cached pages followed by one missing save');
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),2,'cache hits do not consume the new-save allowance');
  assert.equal(await mediaInfoCount(),1);
  assert.equal(Number(await evaluate(`${query('[data-count=saved]')}.textContent`)),1);
  assert.ok(Number(await evaluate(`${query('[data-count=alreadyDownloaded]')}.textContent`))>0);
  console.log('PASS installed limited run scans cached entries and saves a missing video without exceeding its allowance');

  await page('Page.reload');
  await reconnectFixture('persisted limit after reload');
  assert.equal(await evaluate(`${query('[data-role=bulk-limit-mode]')}.value`),'custom');
  assert.equal(await evaluate(`${query('[data-role=bulk-limit]')}.value`),'1');

  // Lose a negative writer acknowledgement once. The worker's prepared quota
  // must be settled with the original attempt before another attempt starts.
  await isolated(`(() => {
    const state=window.__isolatedFixture,send=chrome.runtime.sendMessage.bind(chrome.runtime),fetchVideo=window.fetch;
    state.failedAcknowledgements=0;state.failedTransfers=0;
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='REEL_SAVER_BULK_ITEM_RESULT'&&message.result?.state==='failed'&&!state.failedAcknowledgements++)throw new Error('Fixture lost failed-save acknowledgement');
      return send(message);
    };
    window.fetch=async(...args)=>{if(!state.failedTransfers++)throw new TypeError('Fixture video transfer failed before writing');return fetchVideo(...args);};
  })()`);
  const filesBeforeFailure=await mp4Files();
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-start]')}.textContent==='Resume' && !${query('[data-role=bulk-start]')}.disabled`,'lost negative acknowledgement pauses safely');
  assert.deepEqual(await mp4Files(),filesBeforeFailure,'failed transfer creates no additional file');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'original negative receipt settles before retry');
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),1,'only the successful retry writes a video');
  assert.equal((await mp4Files()).length,filesBeforeFailure.length+1);
  assert.equal(Number(await evaluate(`${query('[data-count=saved]')}.textContent`)),1);
  console.log('PASS real worker reservation survives a lost failure acknowledgement and Resume settles it before one successful retry');

  // Stop while MAIN-world media lookup is pending, before a native file writer
  // starts. The eventual prepared response must receive a no-output receipt.
  await click(query('[data-role=skip-existing]'));
  await evaluate(`(() => {const api=require('PolarisInstapi'),get=api.apiGet;api.apiGet=async address=>{
    if(/media\\//.test(address))await new Promise(resolve=>{window.__pageFixture.releaseResolve=resolve;});return get(address);};})()`);
  await click(query('[data-role=bulk-start]'));
  await waitFor(`typeof window.__pageFixture.releaseResolve==='function'`,'held native resolution');
  await click(query('[data-role=bulk-stop]'));
  await evaluate('window.__pageFixture.releaseResolve()');
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Stopped.') && !${query('[data-role=bulk-start]')}.disabled && ${query('[data-role=bulk-stop]')}.hidden`,'Stop acknowledges no-output prepared response and releases ownership');
  assert.equal(await isolated('window.__isolatedFixture.mediaTransfers'),1,'Stop during lookup never starts another file transfer');
  assert.equal(Number(await evaluate(`${query('[data-count=saved]')}.textContent`)),0);
  console.log('PASS installed Stop during native lookup records no output and releases the reserved allowance');
  await setLimit(null);
  assert.equal(await evaluate(`${query('[data-role=bulk-limit-mode]')}.value`),'unlimited');
  console.log('PASS custom limit persists as a preference and can return to Unlimited');

  // Keep real runtime/storage/scripting and use synthetic Chrome download
  // records for the browser destination. No external network or user folder.
  await page('Page.reload');
  await reconnectFixture('browser history regression profile');
  await selectDestination('downloads');
  const workerEval=async expression=>{
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},workerSession);
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  };
  await workerEval(`(() => {
    const records=globalThis.__browserHistoryFixture=[];
    chrome.downloads.download=async options=>{
      const id=records.length+1000;
      records.push({id,byExtensionId:chrome.runtime.id,filename:'C:/Fixture Downloads/'+options.filename,
        url:options.url,finalUrl:options.url,state:'complete',mime:'video/mp4',exists:true,
        fileSize:2048,totalBytes:2048,bytesReceived:2048,startTime:new Date().toISOString()});
      return id;
    };
    chrome.downloads.search=async query=>{
      const matches=records.filter(item=>(query.id==null||item.id===query.id)&&
        (!query.state||item.state===query.state)&&(query.exists===undefined||item.exists===query.exists)&&
        (!query.filenameRegex||new RegExp(query.filenameRegex).test(item.filename)));
      return structuredClone(matches.slice().reverse().slice(0,query.limit||matches.length));
    };
  })()`);
  await setLimit(25);
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'first 25 browser saves');
  assert.equal(await workerEval('globalThis.__browserHistoryFixture.length'),25);
  assert.equal(Number(await evaluate(`${query('[data-count=saved]')}.textContent`)),25);
  const firstBrowserFiles=await workerEval('globalThis.__browserHistoryFixture.map(item=>item.filename)');
  await setLimit(10);
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'next 10 browser saves after 25 history hits');
  assert.equal(await workerEval('globalThis.__browserHistoryFixture.length'),35);
  assert.equal(Number(await evaluate(`${query('[data-count=saved]')}.textContent`)),10);
  assert.equal(Number(await evaluate(`${query('[data-count=alreadyDownloaded]')}.textContent`)),25);
  const nextBrowserFiles=await workerEval('globalThis.__browserHistoryFixture.slice(25).map(item=>item.filename)');
  assert.equal(nextBrowserFiles.some(filename=>firstBrowserFiles.includes(filename)),false,'second run downloads 10 different Reels');
  console.log('PASS installed browser-destination regression: 25 saved, then 25 history hits and 10 distinct new Reels');

  await page('Page.reload');
  await reconnectFixture('browser history after tab reload');
  await selectDestination('downloads');
  await setLimit(1);
  await workerEval('globalThis.__browserHistoryFixture[0].exists=false');
  await click(query('[data-role=bulk-start]'));
  await waitFor(`${query('[data-role=bulk-status]')}.textContent.startsWith('Limit reached') && !${query('[data-role=bulk-start]')}.disabled`,'missing browser file remains eligible after reload');
  assert.equal(await workerEval('globalThis.__browserHistoryFixture.length'),36);
  assert.equal(await workerEval('globalThis.__browserHistoryFixture.at(-1).filename'),firstBrowserFiles[0]);
  assert.equal(Number(await evaluate(`${query('[data-count=saved]')}.textContent`)),1);
  console.log('PASS browser history survives a new job/tab document and Chrome-reported missing files can download again');
  const artifacts=path.join(root,'artifacts');await mkdir(artifacts,{recursive:true});
  const capture=await page('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(artifacts,'bulk-extension-preview.png'),Buffer.from(capture.data,'base64'));
  assert.deepEqual(exceptions,[],'no unhandled page exceptions');
  await send('Browser.close');

} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (child?.exitCode === null) {
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (child.exitCode === null) child.kill();
  }
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('reel-saver-bulk-extension-')) {
    await rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}
