// Local Chrome/CDP screenshot helper; Node 22+ provides the WebSocket client.
// Usage: node scripts/browser_capture.mjs URL OUTPUT.png [WAIT_EXPRESSION] [EVALUATE_EXPRESSION]
// WAIT_EXPRESSION defaults to window.baselineReviewReady === true.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [url, output, waitExpression = 'window.baselineReviewReady === true',
  evaluateExpression = '({title: document.title, ready: window.baselineReviewReady})'] = process.argv.slice(2);
if (!url || !output) {
  console.error('Usage: node scripts/browser_capture.mjs URL OUTPUT.png [WAIT_EXPRESSION] [EVALUATE_EXPRESSION]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(root, '.tmp');
const screenshot = resolve(output);
await mkdir(scratch, {recursive: true});
await mkdir(dirname(screenshot), {recursive: true});
const profile = await mkdtemp(`${scratch}/chrome-capture-`);
const logPath = `${profile}/chrome.log`;
const log = createWriteStream(logPath);
const browser = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update',
  '--no-proxy-server',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0', 'about:blank',
], {stdio: ['ignore', 'ignore', 'pipe']});
browser.stderr.pipe(log);
let socket;
try {
  const endpoint = await new Promise((done, fail) => {
    let startupLog = '';
    const timer = setTimeout(() => fail(new Error(`Chrome startup timeout; see ${logPath}`)), 15000);
    browser.once('error', error => {clearTimeout(timer); fail(error);});
    browser.once('exit', code => {clearTimeout(timer); fail(new Error(`Chrome exited ${code}; see ${logPath}`));});
    browser.stderr.on('data', chunk => {
      startupLog += chunk.toString();
      const match = startupLog.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {clearTimeout(timer); done(match[1]);}
    });
  });
  const base = new URL(endpoint);
  const pages = await fetch(`http://${base.host}/json/list`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, {once: true});
    socket.addEventListener('error', fail, {once: true});
  });
  let nextId = 0;
  const pending = new Map();
  const pageErrors = [];
  socket.addEventListener('message', event => {
    const payload = JSON.parse(event.data);
    if (payload.method === 'Runtime.exceptionThrown') pageErrors.push(payload.params.exceptionDetails);
    if (!pending.has(payload.id)) return;
    const {done, fail, timer} = pending.get(payload.id);
    pending.delete(payload.id);
    clearTimeout(timer);
    if (payload.error) fail(new Error(JSON.stringify(payload.error)));
    else done(payload.result);
  });
  const call = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId;
    const timer = setTimeout(() => {pending.delete(id); fail(new Error(`CDP timeout: ${method}`));}, 30000);
    pending.set(id, {done, fail, timer});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  const navigation = await call('Page.navigate', {url});
  if (navigation.errorText) throw new Error(navigation.errorText);
  const deadline = Date.now() + 60000;
  while (!(await evaluate(`Boolean(${waitExpression})`))) {
    if (Date.now() >= deadline) throw new Error(`Page readiness timed out: ${waitExpression}`);
    await new Promise(done => setTimeout(done, 200));
  }
  const result = await evaluate(evaluateExpression);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const capture = await call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
  console.log(JSON.stringify({url, screenshot, result, pageErrors, logPath}, null, 2));
  await call('Browser.close');
} catch (error) {
  console.error(JSON.stringify({error: error.message, logPath}));
  process.exitCode = 1;
} finally {
  if (socket) socket.close();
  if (browser.exitCode === null) browser.kill('SIGTERM');
  log.end();
}
