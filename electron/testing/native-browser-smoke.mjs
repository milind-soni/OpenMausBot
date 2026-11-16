import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as tcpServer, connect } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, WebContentsView, ipcMain, session, utilityProcess } from 'electron';
import { createNativeBrowserCoordinator } from '../native-browser-main.mjs';

const output = process.env.OMB_NATIVE_SMOKE_OUTPUT;
if (!output || !process.env.OMB_NATIVE_SMOKE_HOME) throw Error('Use a disposable native-browser smoke home.');
app.setPath('userData', process.env.OMB_NATIVE_SMOKE_HOME);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.whenReady().then(async () => {
const connections = new Set();
const paths = new Set();
const sockets = new Set();
const html = `<!doctype html><title>Native fixture</title><form onsubmit="event.preventDefault();document.querySelector('output').textContent='Hello '+document.querySelector('input').value"><label>Name <input id="name"></label><button id="go">Go</button></form><output></output><button id="popup" onclick="window.open('/popup')">Popup</button><iframe src="http://child.fixture.test/child"></iframe><script>window.popupMessage='';addEventListener('message',e=>window.popupMessage=e.data);</script>`;
const http = createServer((req, res) => {
  paths.add(req.url);
  res.setHeader('content-type', req.url === '/worker' ? 'text/javascript' : 'text/html');
  if (req.url === '/popup') res.end('<script>opener.postMessage("popup preserved","*")</script>Popup');
  else if (req.url === '/child') res.end('<title>Child</title><button>Child button</button>');
  else if (req.url === '/redirect') { res.writeHead(302, { location: '/form' }); res.end(); }
  else if (req.url === '/worker') res.end('postMessage("worker preserved")');
  else res.end(html);
});
http.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
http.listen(0, '127.0.0.1'); await once(http, 'listening');
const socks = tcpServer(socket => {
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  let buffer = Buffer.alloc(0), phase = 0;
  const data = chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (phase === 0) {
      if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
      assert.equal(buffer[0], 5); buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 0])); phase = 1;
    }
    if (phase !== 1 || buffer.length < 5) return;
    const length = buffer[3] === 3 ? buffer[4] : 0;
    if (!length) { socket.destroy(); return; }
    if (buffer.length < 7 + length) return;
    const host = buffer.subarray(5, 5 + length).toString();
    if (!['fixture.test', 'child.fixture.test'].includes(host)) { socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
    connections.add(host); const rest = buffer.subarray(7 + length); phase = 2; socket.removeListener('data', data);
    const upstream = connect(http.address().port, '127.0.0.1', () => {
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (rest.length) upstream.write(rest); socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
  };
  socket.on('data', data); socket.on('error', () => {});
});
socks.listen(0, '127.0.0.1'); await once(socks, 'listening');
const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
await owner.loadURL('data:text/html,<title>Privileged fixture owner</title>');
const files = await import('../../dist-server/message-file.js');
const coordinator = createNativeBrowserCoordinator({ ipcMain, session, WebContentsView, BrowserWindow, getOwner: () => owner, isLocalOwner: event => event.sender === owner.webContents, userData: app.getPath('userData'), product: `Chrome/${process.versions.chrome}`, readFile: (path, roots) => files.openMessageFile(path, roots, files.MESSAGE_FILE_DOWNLOAD_MAX_BYTES) });
const home = app.getPath('userData');
const worker = utilityProcess.fork(process.env.OMB_NATIVE_SMOKE_WORKER ?? fileURLToPath(new URL('./native-browser-worker.mjs', import.meta.url)), [], { env: {
  ...process.env, HOME: home, USERPROFILE: home, OMB_DATA_DIR: join(home, 'data'),
  CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), OMB_DISABLE_MODEL_MANIFEST_FETCH: '1',
  OMB_NATIVE_SMOKE_PROXY: String(socks.address().port),
}, stdio: 'pipe', serviceName: 'OMB isolated native browser smoke' });
worker.stdout?.on('data', data => process.stdout.write(data)); worker.stderr?.on('data', data => process.stderr.write(data));
let completed = false;
const finish = async result => {
  if (completed) return; completed = true; clearTimeout(timeout);
  await coordinator.destroy(); worker.kill(); owner.destroy(); for (const socket of sockets) socket.destroy(); socks.close(); http.close();
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify({ ...result, electron: process.versions.electron, chromium: process.versions.chrome, connections: [...connections], paths: [...paths] }, null, 2)); app.exit(result.pass ? 0 : 1);
};
worker.on('message', message => {
  if (message?.type === 'native-smoke-ready') coordinator.attach(worker);
  else if (message?.type === 'native-smoke-done') {
    const pass = message.pass && connections.has('fixture.test') && connections.has('child.fixture.test');
    void finish({ ...message, pass });
  } else coordinator.receive(worker, message);
});
worker.on('exit', code => { if (!completed) void finish({ pass: false, error: `Utility process exited: ${code}` }); });
const timeout = setTimeout(() => void finish({ pass: false, error: 'Native smoke timed out.' }), 120_000);
}).catch(error => {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ pass: false, error: error.stack ?? String(error) }, null, 2));
  app.exit(1);
});
