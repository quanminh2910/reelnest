// Development helper: attach to the already enabled local Chrome debug bridge.
// Uses stdin/stdout for commands and never opens another server or browser.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const marker = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
const [port, socketPath] = (await readFile(marker, 'utf8')).trim().split(/\r?\n/);
if (!/^\d+$/.test(port) || !socketPath?.startsWith('/devtools/browser/')) throw new Error('Invalid local Chrome debugging marker.');
const ws = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
const input = createInterface({ input: process.stdin });
const pending = new Map();
const events = [];
let sequence = 0;
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!message.id) {
    if (message.method === 'Runtime.executionContextCreated') {
      const { id, name, origin, auxData } = message.params.context;
      events.push({ method: message.method, sessionId: message.sessionId, context: { id, name, origin, auxData } });
    } else if (message.method === 'Network.loadingFailed') {
      const { requestId, type, errorText, canceled, blockedReason, corsErrorStatus } = message.params;
      events.push({ method: message.method, sessionId: message.sessionId, requestId, type, errorText, canceled, blockedReason, corsErrorStatus });
    }
    if (events.length > 100) events.shift();
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
output({ state: 'connecting', message: 'Waiting for Chrome to allow the local debugging connection.' });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome debugging permission or connection timed out.')), 120000);
  ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome debugging connection failed.')); }, { once: true });
});
const version = await send('Browser.getVersion');
const { targetInfos } = await send('Target.getTargets');
const instagramTabs = targetInfos.filter(target => {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return url.protocol === 'https:' && ['www.instagram.com', 'instagram.com'].includes(url.hostname);
  } catch { return false; }
});
output({ state: 'connected', pid: process.pid, browser: version.product, instagramTabs: instagramTabs.map(({ targetId }) => ({ targetId })) });
for await (const line of input) {
  try {
    const request = JSON.parse(line);
    if (request.method === 'disconnect') break;
    if (request.method === 'helper.events') {
      output({ id: request.id, events: events.splice(0) });
      continue;
    }
    const result = await send(request.method, request.params, request.sessionId);
    output({ id: request.id, result });
  } catch (error) { output({ error: error.message }); }
}
ws.close();
input.close();
setTimeout(() => process.exit(0), 250);
