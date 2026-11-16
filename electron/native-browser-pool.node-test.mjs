import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const { createNativeBrowserPool } = await import('./native-browser-pool.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let contentsSequence = 0;

class Contents extends EventEmitter {
  constructor(session, preferences) {
    super();
    this.session = session;
    this.preferences = preferences;
    this.url = '';
    this.commands = [];
    this.loads = [];
    this.targetId = `owned-fixture-page-${++contentsSequence}`;
    this.frameReady = new Promise(resolve => { this.resolveFrameReady = resolve; });
    this.debugger = new EventEmitter();
    this.debugger.attach = () => { this.attached = true; };
    this.debugger.isAttached = () => this.attached === true;
    this.debugger.detach = () => { this.attached = false; };
    this.debugger.sendCommand = async (method, params, sessionId) => {
      this.commands.push({ method, params, sessionId });
      if (method === 'Target.getTargetInfo') {
        assert.deepEqual(params, {}, 'owned identity query cannot select an external target');
        return this.identityInfo ?? { targetInfo: { targetId: this.targetId, type: 'page', title: this.getTitle(), url: this.getURL() } };
      }
      if (method === 'Page.getFrameTree' && this.waitForInitialDocument && !this.hasInitialDocument) await this.frameReady;
      if (method === 'Page.getFrameTree' && !this.dispatch) return { frameTree: { frame: { id: this.mainFrameId ?? this.targetId, url: this.url, loaderId: 'fixture-loader' } } };
      if (this.dispatch) return this.dispatch(method, params, sessionId);
      return { value: method };
    };
  }
  getURL() { return this.url; }
  getTitle() { return this.title ?? ''; }
  getLastWebPreferences() { return this.preferences; }
  isDestroyed() { return this.destroyed === true; }
  setWindowOpenHandler(handler) { this.popup = handler; }
  async loadURL(url) {
    this.loads.push(url); this.url = url; this.hasInitialDocument = true;
    this.resolveFrameReady(); this.emit('did-navigate', {}, url);
  }
  close() { this.destroyed = true; this.emit('destroyed'); }
}

function owner() {
  const result = new EventEmitter();
  result.views = new Set();
  result.contentView = {
    addChildView: view => result.views.add(view),
    removeChildView: view => result.views.delete(view),
  };
  result.getContentSize = () => [1200, 800];
  result.isDestroyed = () => result.destroyed === true;
  result.destroy = () => { result.destroyed = true; result.emit('closed'); };
  result.focus = () => { throw new Error('Must not focus an OS window'); };
  result.show = () => { throw new Error('Must not show an OS window'); };
  result.webContents = new Contents({}, {});
  return result;
}

function fixture(overrides = {}) {
  assert.equal(typeof createNativeBrowserPool, 'function', 'native pool factory is implemented');
  const main = owner();
  const views = [];
  const renderOwners = [];
  const sessions = new Map();
  const epochs = new Map();
  const messages = [];
  const inputs = [];
  const closes = [];
  let sequence = 0;
  const options = {
    product: 'Chrome/150.0.0.0',
    getOwner: () => main,
    createRenderOwner: () => { const value = owner(); renderOwners.push(value); return value; },
    sessionForProfile: async (id, openOptions) => {
      if (!sessions.has(id)) {
        const session = new EventEmitter();
        session.openOptions = openOptions;
        session.actions = [];
        session.cookies = { flushStore: async () => { session.actions.push('flush'); } };
        session.clearStorageData = async () => { session.actions.push('storage'); };
        session.clearAuthCache = async () => { session.actions.push('auth'); };
        session.clearCache = async () => { session.actions.push('cache'); };
        session.setPermissionRequestHandler = fn => { session.permissionRequest = fn; };
        session.setPermissionCheckHandler = fn => { session.permissionCheck = fn; };
        sessions.set(id, session);
      }
      return sessions.get(id);
    },
    createView: (preferences, existing) => {
      const view = {
        preferences,
        webContents: existing ?? new Contents(preferences.session, preferences),
        setVisible(visible) { this.visible = visible; },
        setBounds(bounds) { this.bounds = { ...bounds }; },
        getBounds() { return this.bounds ?? { x: 0, y: 0, width: 0, height: 0 }; },
      };
      views.push(view);
      return view;
    },
    onMessage: (profileId, text) => messages.push({ profileId, ...JSON.parse(text) }),
    onInput: (profileId, input) => { epochs.set(profileId, input.epoch); inputs.push({ profileId, ...input }); },
    onClose: (profileId, reason) => closes.push({ profileId, reason }),
    ...overrides,
  };
  const pool = createNativeBrowserPool(options);
  const f = { pool, options, main, views, renderOwners, sessions, epochs, messages, inputs, closes };
  f.open = async (profileId = 'profile-a', persistent = true, proxyPort) => {
    const result = await pool.open({ profileId, persistent, ...(proxyPort ? { proxyPort } : {}) });
    epochs.set(profileId, result.epoch);
    return result;
  };
  f.lease = input => { const epoch = pool.lease(input); epochs.set(input.profileId, epoch); return epoch; };
  f.rpc = async (profileId, method, params = {}, extra = {}) => {
    const id = ++sequence;
    const { sessionId, ...metadata } = extra;
    await pool.send({ profileId, epoch: epochs.get(profileId), actor: { kind: 'agent' }, ...metadata,
      message: JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) });
    return messages.find(message => message.profileId === profileId && message.id === id);
  };
  f.targets = async profileId => success(await f.rpc(profileId, 'Target.getTargets')).targetInfos;
  f.attach = async (profileId, targetId) => success(await f.rpc(profileId, 'Target.attachToTarget', { targetId, flatten: true })).sessionId;
  return f;
}

function success(message) {
  assert.ok(message, 'CDP command produces a response');
  assert.equal(message.error, undefined, message.error?.message);
  return message.result;
}

function physical(contents, channel, input) {
  let prevented = false;
  contents.emit(channel === 'mouse' ? 'before-mouse-event' : 'before-input-event', { preventDefault: () => { prevented = true; } }, input);
  return prevented;
}

test('open waits for the injected session, is idempotent, and locks website preferences', async t => {
  const wait = deferred();
  const f = fixture();
  t.after(() => f.pool.destroy());
  const original = f.options.sessionForProfile;
  f.options.sessionForProfile = async (...args) => { await wait.promise; return original(...args); };
  const first = f.open('profile-a', true, 43210);
  const duplicate = f.open('profile-a', true, 43210);
  await tick();
  assert.equal(f.views.length, 0);
  wait.resolve();
  assert.deepEqual(await first, await duplicate);
  assert.equal(f.views.length, 1);
  assert.deepEqual(f.sessions.get('profile-a').openOptions, { persistent: true, proxyPort: 43210 });
  const preferences = f.views[0].preferences;
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.focusOnNavigation, false);
  assert.equal(preferences.preload, undefined);
  assert.deepEqual(f.views[0].webContents.loads, ['about:blank']);
});

test('browser facade lists and attaches only the addressed profile targets', async t => {
  const f = fixture(); t.after(() => f.pool.destroy());
  await f.open('profile-a'); await f.open('profile-b');
  const [a] = await f.targets('profile-a'); const [b] = await f.targets('profile-b');
  const otherCommands = f.views[1].webContents.commands.length;
  assert.notEqual(a.targetId, b.targetId);
  assert.equal((await f.rpc('profile-a', 'Target.attachToTarget', { targetId: b.targetId, flatten: true })).error.code, -32000);
  assert.equal((await f.rpc('profile-a', 'Target.getTargetInfo', { targetId: b.targetId })).error.code, -32000);
  const sessionId = await f.attach('profile-a', a.targetId);
  success(await f.rpc('profile-a', 'Runtime.evaluate', { expression: '2+3' }, { sessionId }));
  assert.equal(f.views[0].webContents.commands.at(-1).method, 'Runtime.evaluate');
  assert.equal(f.views[1].webContents.commands.length, otherCommands);
  assert.equal((await f.rpc('profile-b', 'Runtime.evaluate', {}, { sessionId })).error.code, -32000);
});

test('discovery and auto attach expose only owned pages and never enumerate Electron targets', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  success(await f.rpc('profile-a', 'Target.setDiscoverTargets', { discover: true }));
  success(await f.rpc('profile-a', 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
  assert.equal(f.messages.filter(message => message.method === 'Target.targetCreated').length, 1);
  const attached = f.messages.find(message => message.method === 'Target.attachedToTarget');
  assert.ok(attached.params.sessionId);
  assert.equal(attached.params.targetInfo.type, 'page');
  assert.equal(f.views[0].webContents.commands.some(command => command.method === 'Target.getTargets'), false);
  const created = success(await f.rpc('profile-a', 'Target.createTarget', { url: 'https://fixture.test/' }));
  assert.equal((await f.targets('profile-a')).length, 2);
  assert.equal(f.messages.filter(message => message.method === 'Target.attachedToTarget' && message.params.targetInfo.targetId === created.targetId).length, 1);
  assert.equal((await f.rpc('profile-a', 'Target.createBrowserContext')).error.code, -32601);
});

test('unacknowledged physical input is suppressed once, bumps epoch synchronously, and requires the same ready viewer', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); const opened = await f.open();
  const [target] = await f.targets('profile-a');
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a', visible: true, bounds: { x: 20, y: 30, width: 500, height: 400 } });
  const wc = f.views[0].webContents;
  assert.equal(physical(wc, 'mouse', { type: 'mouseDown', x: 5, y: 8, button: 'left' }), true);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].viewerId, 'viewer-a');
  assert.ok(f.inputs[0].epoch > opened.epoch);
  assert.equal(physical(wc, 'mouse', { type: 'mouseUp', x: 5, y: 8, button: 'left' }), true);
  assert.equal(f.inputs.length, 1);
  assert.equal((await f.rpc('profile-a', 'Target.getTargets', {}, { epoch: opened.epoch })).error.code, -32000);
  f.lease({ profileId: 'profile-a', viewerId: 'viewer-a', ready: true });
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'a', code: 'KeyA' }), false);
  assert.equal((await f.rpc('profile-a', 'Target.getTargets')).error.code, -32000);
  assert.equal((await f.rpc('profile-a', 'Target.getTargets', {}, { actor: { kind: 'viewer', viewerId: 'viewer-b' } })).error.code, -32000);
  success(await f.rpc('profile-a', 'Target.getTargets', {}, { actor: { kind: 'viewer', viewerId: 'viewer-a' } }));
  f.lease({ profileId: 'profile-a', viewerId: null, ready: false });
  success(await f.rpc('profile-a', 'Target.getTargets'));
});

test('a synthetic input ticket exempts one exact event, never the promise lifetime', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const wc = f.views[0].webContents; const wait = deferred();
  let syntheticPrevented;
  wc.dispatch = (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
      syntheticPrevented = physical(wc, 'mouse', { type: 'mouseMove', x: 10, y: 12, button: 'none' });
      return wait.promise;
    }
    return {};
  };
  const pending = f.rpc('profile-a', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 12, button: 'none' }, { sessionId });
  await tick();
  assert.equal(syntheticPrevented, false);
  assert.equal(f.inputs.length, 0);
  assert.equal(physical(wc, 'mouse', { type: 'mouseDown', x: 90, y: 12, button: 'left' }), true);
  assert.equal(f.inputs.length, 1);
  wait.resolve({ accepted: true });
  const response = await pending;
  assert.equal(response.error.code, -32000);
  assert.equal(f.messages.filter(message => message.id === response.id).length, 1);
});

test('takeover rejects outstanding results and releases held synthetic keys without replaying human input', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const wc = f.views[0].webContents;
  success(await f.rpc('profile-a', 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 }, { sessionId }));
  const wait = deferred();
  wc.dispatch = method => method === 'Runtime.evaluate' ? wait.promise : {};
  const pending = f.rpc('profile-a', 'Runtime.evaluate', { expression: 'slow()' }, { sessionId });
  await tick();
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'x', code: 'KeyX' }), true);
  await tick();
  assert.ok(wc.commands.some(command => command.method === 'Input.dispatchKeyEvent' && command.params.type === 'keyUp' && command.params.code === 'ShiftLeft'));
  assert.equal(wc.commands.some(command => command.params?.key === 'x'), false);
  wait.resolve({ result: { value: 'stale' } });
  assert.equal((await pending).error.code, -32000);
  success(await f.rpc('profile-a', 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' }, { sessionId, epoch: 0 }));
});

test('hidden automation retains a real render owner and layout restores the identical view without focusing', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  success(await f.rpc('profile-a', 'Runtime.evaluate', { expression: 'document.elementFromPoint(2,2)' }, { sessionId }));
  assert.equal(f.renderOwners.length, 1);
  assert.equal(f.renderOwners[0].views.has(f.views[0]), true);
  assert.equal(f.views[0].visible, true);
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a', visible: true, bounds: { x: 30, y: 40, width: 800, height: 600 } });
  assert.equal(f.main.views.has(f.views[0]), true);
  assert.equal(f.renderOwners[0].views.has(f.views[0]), false);
  assert.deepEqual(f.views[0].bounds, { x: 30, y: 40, width: 800, height: 600 });
});

test('native popups adopt the exact same-profile guest and preserve their opener target', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [opener] = await f.targets('profile-a');
  const parent = f.views[0].webContents;
  const decision = parent.popup({ url: 'https://fixture.test/popup', disposition: 'new-window' });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.overrideBrowserWindowOptions.show, false);
  const preferences = decision.overrideBrowserWindowOptions.webPreferences;
  const guest = new Contents(parent.session, preferences);
  const adopted = decision.createWindow({ webContents: guest });
  assert.equal(adopted, guest);
  assert.equal(f.views[1].webContents, guest);
  assert.deepEqual(guest.loads, []);
  await tick();
  const popup = (await f.targets('profile-a')).find(target => target.targetId !== opener.targetId);
  assert.equal(popup.openerId, opener.targetId);
  const foreign = new Contents({}, preferences);
  assert.throws(() => decision.createWindow({ webContents: foreign }), /session|profile/i);
});

test('page frame sessions stay virtual while owned iframe target identity is preserved', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const wc = f.views[0].webContents;
  wc.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'raw-frame', targetInfo: { targetId: 'raw-child', type: 'iframe', title: '', url: 'https://fixture.test/frame', attached: true }, waitingForDebugger: false });
  const event = f.messages.find(message => message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'iframe');
  assert.equal(event.sessionId, sessionId);
  assert.notEqual(event.params.sessionId, 'raw-frame');
  assert.equal(event.params.targetInfo.targetId, 'raw-child');
  success(await f.rpc('profile-a', 'Runtime.enable', {}, { sessionId: event.params.sessionId }));
  assert.equal(wc.commands.at(-1).sessionId, 'raw-frame');
  wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 17 } }, 'raw-frame');
  assert.equal(f.messages.at(-1).sessionId, event.params.sessionId);
  const before = wc.commands.length;
  assert.equal((await f.rpc('profile-a', 'Runtime.enable', {}, { sessionId: 'raw-frame' })).error.code, -32000);
  assert.equal(wc.commands.length, before);
  assert.equal((await f.rpc('profile-a', 'Target.getTargets', {}, { sessionId })).result.targetInfos.length, 1);
});

test('Browser.close closes one profile and never destroys the main application owner', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open('profile-a'); await f.open('profile-b');
  success(await f.rpc('profile-a', 'Browser.close'));
  assert.equal(f.views[0].webContents.isDestroyed(), true);
  assert.equal(f.views[1].webContents.isDestroyed(), false);
  assert.equal(f.main.isDestroyed(), false);
  assert.equal(f.closes.length, 1);
  assert.equal(f.closes[0].profileId, 'profile-a');
  assert.deepEqual(f.sessions.get('profile-a').actions, ['flush']);
});

test('guest close and erase clear only their own Session and remove native listeners', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open('guest-a', false); await f.open('profile-b');
  const guest = f.views[0].webContents;
  await f.pool.close('guest-a');
  assert.deepEqual(f.sessions.get('guest-a').actions, ['flush', 'storage', 'auth', 'cache']);
  assert.equal(guest.listenerCount('before-input-event'), 0);
  assert.equal(guest.debugger.listenerCount('message'), 0);
  assert.deepEqual(f.sessions.get('profile-b').actions, []);
  await f.pool.erase('profile-b');
  assert.deepEqual(f.sessions.get('profile-b').actions, ['flush', 'storage', 'auth', 'cache']);
  assert.equal(f.sessions.get('profile-b').listenerCount('will-download'), 0);
});

test('virtual window resizing affects native page bounds without changing app window geometry', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a');
  const { windowId } = success(await f.rpc('profile-a', 'Browser.getWindowForTarget', { targetId: target.targetId }));
  success(await f.rpc('profile-a', 'Browser.setWindowBounds', { windowId, bounds: { width: 640, height: 480 } }));
  const { bounds } = success(await f.rpc('profile-a', 'Browser.getWindowBounds', { windowId }));
  assert.equal(bounds.width, 640); assert.equal(bounds.height, 480);
  assert.equal(f.views[0].bounds.width, 640);
  assert.equal((await f.rpc('profile-a', 'Browser.getWindowBounds', { windowId: 99999 })).error.code, -32000);
});

test('permissions use only owned session checks and unsupported browser methods fail explicitly', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open('profile-a'); await f.open('profile-b');
  success(await f.rpc('profile-a', 'Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'granted', origin: 'https://fixture.test' }));
  assert.equal(f.sessions.get('profile-a').permissionCheck(f.views[0].webContents, 'geolocation', 'https://fixture.test', {}), true);
  assert.equal(f.sessions.get('profile-b').permissionCheck(f.views[1].webContents, 'geolocation', 'https://fixture.test', {}), false);
  assert.equal(f.sessions.get('profile-a').permissionCheck(f.views[1].webContents, 'geolocation', 'https://fixture.test', {}), false);
  success(await f.rpc('profile-a', 'Browser.resetPermissions'));
  assert.equal(f.sessions.get('profile-a').permissionCheck(f.views[0].webContents, 'geolocation', 'https://fixture.test', {}), false);
  assert.equal((await f.rpc('profile-a', 'Browser.executeBrowserCommand')).error.code, -32601);
  assert.equal(f.views.every(view => view.webContents.commands.every(command => !command.method.startsWith('Browser.'))), true);
});

test('destroy closes only render owners created by this pool and invalidates reopen epochs', async () => {
  const f = fixture(); const opened = await f.open();
  await f.pool.close('profile-a'); const reopened = await f.open();
  assert.ok(reopened.epoch > opened.epoch);
  await f.pool.destroy();
  assert.equal(f.main.isDestroyed(), false);
  assert.equal(f.renderOwners.every(renderOwner => renderOwner.isDestroyed()), true);
  await assert.rejects(f.open(), /closed|destroy/i);
});

test('a foreign controller immediately hides the native layout and canInput never grants input by itself', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const wc = f.views[0].webContents;
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a', visible: true, canInput: true, bounds: { x: 0, y: 0, width: 600, height: 400 } });
  f.lease({ profileId: 'profile-a', viewerId: 'viewer-b', ready: true });
  assert.equal(f.main.views.has(f.views[0]), false);
  assert.equal(physical(wc, 'mouse', { type: 'mouseDown', x: 5, y: 8, button: 'left' }), true);
  f.lease({ profileId: 'profile-a', viewerId: 'viewer-a', ready: true });
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a', visible: true, canInput: false, bounds: { x: 0, y: 0, width: 600, height: 400 } });
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'a', code: 'KeyA' }), true);
});

test('a layout for a different person cannot reattach a held profile and switching profiles leaves one main native view', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open('profile-a'); await f.open('profile-b');
  const [a] = await f.targets('profile-a'); const [b] = await f.targets('profile-b');
  const value = { viewerId: 'viewer-a', visible: true, canInput: true, bounds: { x: 0, y: 0, width: 600, height: 400 } };
  f.lease({ profileId: 'profile-a', viewerId: 'viewer-b', ready: true });
  f.pool.layout({ profileId: 'profile-a', targetId: a.targetId, ...value });
  assert.equal(f.main.views.size, 0);
  f.lease({ profileId: 'profile-a', viewerId: null, ready: false });
  f.pool.layout({ profileId: 'profile-a', targetId: a.targetId, ...value });
  f.pool.layout({ profileId: 'profile-b', targetId: b.targetId, ...value });
  assert.equal(f.main.views.size, 1);
  assert.equal(f.main.views.has(f.views[1]), true);
});

test('session reuse cannot alias a different profile or the application session', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  f.options.sessionForProfile = async () => f.sessions.get('profile-a');
  await assert.rejects(f.open('profile-b'), /separate|owned|profile/i);
  f.options.sessionForProfile = async () => f.main.webContents.session;
  await assert.rejects(f.open('profile-c'), /separate|owned|profile/i);
  assert.equal(f.views[0].webContents.isDestroyed(), false);
  assert.deepEqual(f.sessions.get('profile-a').actions, []);
});

test('a profile close while opening waits for its session without creating a website view', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); const wait = deferred();
  const original = f.options.sessionForProfile;
  f.options.sessionForProfile = async (...args) => { await wait.promise; return original(...args); };
  const opening = f.open('profile-a');
  const rejected = assert.rejects(opening, /closed/i);
  const closing = f.pool.close('profile-a');
  wait.resolve(); await rejected; await closing;
  assert.equal(f.views.length, 0);
  assert.deepEqual(f.sessions.get('profile-a').actions, ['flush']);
});

test('second identical hardware input cannot consume an already-used synthetic ticket', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const wc = f.views[0].webContents; const wait = deferred();
  wc.dispatch = (method, params) => method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' ? wait.promise : {};
  const pending = f.rpc('profile-a', 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA' }, { sessionId });
  await tick();
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'a', code: 'KeyA' }), false);
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'a', code: 'KeyA' }), true);
  wait.resolve({}); assert.equal((await pending).error.code, -32000);
});

test('unknown raw debugger frame events are discarded and native detach removes virtual child access', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const wc = f.views[0].webContents;
  const before = f.messages.length;
  wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log' }, 'unowned-frame');
  assert.equal(f.messages.length, before);
  wc.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'raw-frame', targetInfo: { targetId: 'raw-child', type: 'iframe', title: '', url: '', attached: true } });
  const child = f.messages.at(-1).params.sessionId;
  wc.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'raw-frame', targetId: 'raw-child' });
  assert.equal((await f.rpc('profile-a', 'Runtime.enable', {}, { sessionId: child })).error.code, -32000);
  success(await f.rpc('profile-a', 'Runtime.enable', {}, { sessionId }));
});

test('root cookie commands use the addressed Session and reject external browser context ids', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open('profile-a'); await f.open('profile-b');
  const writes = [];
  const session = f.sessions.get('profile-a');
  session.cookies.get = async () => [{ name: 'fixture', value: 'one', domain: '.fixture.test', path: '/', secure: true, httpOnly: true, session: false, expirationDate: 2000000000, sameSite: 'lax' }];
  session.cookies.set = async value => writes.push(value);
  const { cookies } = success(await f.rpc('profile-a', 'Storage.getCookies'));
  assert.equal(cookies[0].name, 'fixture'); assert.equal(cookies[0].expires, 2000000000); assert.equal(cookies[0].sameSite, 'Lax');
  success(await f.rpc('profile-a', 'Storage.setCookies', { cookies: [{ name: 'fixture', value: 'two', domain: '.fixture.test', path: '/page', secure: true, sameSite: 'None' }] }));
  assert.deepEqual(writes, [{ url: 'https://fixture.test/page', name: 'fixture', value: 'two', domain: '.fixture.test', path: '/page', secure: true, sameSite: 'no_restriction' }]);
  assert.equal((await f.rpc('profile-b', 'Storage.getCookies', { browserContextId: 'foreign' })).error.code, -32000);
  assert.deepEqual(f.sessions.get('profile-b').actions, []);
});

test('scoped downloads emit CDP events, cancel by own guid, and cannot target another profile download', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open('profile-a'); await f.open('profile-b');
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const wc = f.views[0].webContents;
  wc.dispatch = () => ({ frameTree: { frame: { id: 'cdp-frame-a', url: 'https://fixture.test/' } } });
  success(await f.rpc('profile-a', 'Page.getFrameTree', {}, { sessionId }));
  const downloadPath = process.platform === 'win32' ? 'D:\\fixture-downloads' : '/fixture-downloads';
  success(await f.rpc('profile-a', 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath, eventsEnabled: true }));
  const item = new EventEmitter();
  item.getGUID = () => 'fixture-guid'; item.getFilename = () => 'sample.txt'; item.getURL = () => 'https://fixture.test/sample.txt';
  item.setSavePath = value => { item.path = value; }; item.getSavePath = () => item.path;
  item.getTotalBytes = () => 20; item.getReceivedBytes = () => 20;
  item.cancel = () => { item.canceled = true; };
  let prevented = false;
  f.sessions.get('profile-a').emit('will-download', { preventDefault: () => { prevented = true; } }, item, wc);
  assert.equal(prevented, false);
  assert.ok(item.path.endsWith('fixture-guid'));
  const began = f.messages.find(message => message.method === 'Browser.downloadWillBegin');
  assert.equal(began.params.frameId, 'cdp-frame-a');
  assert.equal((await f.rpc('profile-b', 'Browser.cancelDownload', { guid: 'fixture-guid' })).error.code, -32000);
  success(await f.rpc('profile-a', 'Browser.cancelDownload', { guid: 'fixture-guid' }));
  assert.equal(item.canceled, true);
  item.emit('done', {}, 'completed');
  const done = f.messages.find(message => message.method === 'Browser.downloadProgress' && message.params.state === 'completed');
  assert.equal(done.params.receivedBytes, 20);
  assert.equal(item.listenerCount('updated'), 0);
});

test('page sessions cannot invoke process-global debugger domains or foreign context storage', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const initialCommands = f.views[0].webContents.commands.length;
  for (const method of ['SystemInfo.getInfo', 'Tracing.start', 'Memory.getDOMCounters', 'Input.setIgnoreInputEvents']) {
    assert.equal((await f.rpc('profile-a', method, {}, { sessionId })).error?.code, -32601);
  }
  assert.equal((await f.rpc('profile-a', 'Network.getCookies', { browserContextId: 'foreign' }, { sessionId })).error.code, -32000);
  assert.equal(f.views[0].webContents.commands.length, initialCommands);
});

test('a wheel dispatch ticket does not suppress a physical wheel with different deltas', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const wc = f.views[0].webContents; const wait = deferred();
  wc.dispatch = () => wait.promise;
  const pending = f.rpc('profile-a', 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 10, y: 12, deltaX: 0, deltaY: 20 }, { sessionId });
  await tick();
  assert.equal(physical(wc, 'mouse', { type: 'mouseWheel', x: 10, y: 12, button: 'none', deltaX: 0, deltaY: -20 }), true);
  wait.resolve({}); assert.equal((await pending).error.code, -32000);
});

test('owned native identity remains coherent through real driver metadata, isolated worlds, and same-document navigation', async t => {
  const { CdpBrowser } = await import('../server/browser/cdp/browser.ts');
  const f = fixture(); t.after(() => f.pool.destroy());
  const original = f.options.createView;
  f.options.createView = (...args) => {
    const view = original(...args); const wc = view.webContents;
    wc.targetId = 'OWNED-PAGE-MAIN';
    wc.dispatch = (method, params) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'OWNED-PAGE-MAIN', url: wc.url, loaderId: 'fixture-loader' } } };
      if (method === 'Page.createIsolatedWorld') {
        assert.equal(params.frameId, 'OWNED-PAGE-MAIN');
        return { executionContextId: 41 };
      }
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'complete' } };
      if (method === 'Page.navigate') {
        wc.url = params.url;
        wc.debugger.emit('message', {}, 'Page.navigatedWithinDocument', { frameId: 'OWNED-PAGE-MAIN', url: params.url });
        return {};
      }
      return {};
    };
    return view;
  };
  await f.open();
  const [metadata] = await f.targets('profile-a');
  assert.equal(metadata.targetId, 'OWNED-PAGE-MAIN');
  assert.deepEqual(f.views[0].webContents.commands.filter(command => command.method === 'Target.getTargetInfo').map(command => command.params), [{}]);
  let receive;
  const onMessage = f.options.onMessage;
  f.options.onMessage = (profileId, text) => { onMessage(profileId, text); receive?.(text); };
  const transport = {
    send: message => { void f.pool.send({ profileId: 'profile-a', epoch: f.epochs.get('profile-a'), actor: { kind: 'agent' }, message }); },
    onMessage: handler => { receive = handler; },
    onClose() {}, close() {},
  };
  const browser = await CdpBrowser.connect(transport, { viewport: null, permissions: false, timeoutMs: 500 });
  const page = await browser.waitForPage(candidate => candidate.targetId === 'OWNED-PAGE-MAIN', 500);
  await page.ready;
  assert.equal(page.frames.mainFrameId, 'OWNED-PAGE-MAIN');
  assert.equal(page.frames.main.id, 'OWNED-PAGE-MAIN');
  const result = await page.navigate('https://fixture.test/#section', { timeoutMs: 500 });
  assert.equal(result.url, 'https://fixture.test/#section');
  assert.ok(f.views[0].webContents.commands.some(command => command.method === 'Page.createIsolatedWorld' && command.params.frameId === 'OWNED-PAGE-MAIN'));
  browser.connection.close();
});

test('a mismatched owned page target and main frame is rejected before discovery', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); const original = f.options.createView;
  f.options.createView = (...args) => {
    const view = original(...args); view.webContents.mainFrameId = 'OTHER-FRAME'; return view;
  };
  await assert.rejects(f.open(), /identity|frame/i);
  assert.equal(f.messages.some(message => message.method === 'Target.targetCreated' || message.method === 'Target.attachedToTarget'), false);
  assert.equal(f.views[0].webContents.isDestroyed(), true);
});

test('a popup returns its exact guest synchronously and publishes only after its owned identity resolves', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const [opener] = await f.targets('profile-a');
  success(await f.rpc('profile-a', 'Target.setDiscoverTargets', { discover: true }));
  const parent = f.views[0].webContents;
  const decision = parent.popup({ url: 'https://fixture.test/popup', disposition: 'new-window' });
  const guest = new Contents(parent.session, decision.overrideBrowserWindowOptions.webPreferences);
  guest.targetId = 'OWNED-POPUP'; const identity = deferred(); guest.identityInfo = identity.promise;
  assert.equal(decision.createWindow({ webContents: guest }), guest);
  assert.equal((await f.targets('profile-a')).length, 1);
  assert.equal(f.messages.some(message => message.method === 'Target.targetCreated' && message.params.targetInfo.openerId === opener.targetId), false);
  identity.resolve({ targetInfo: { targetId: 'OWNED-POPUP', type: 'page', title: '', url: 'https://fixture.test/popup' } });
  await tick();
  const popup = (await f.targets('profile-a')).find(info => info.openerId === opener.targetId);
  assert.equal(popup.targetId, 'OWNED-POPUP');
  assert.equal(f.messages.filter(message => message.method === 'Target.targetCreated' && message.params.targetInfo.targetId === 'OWNED-POPUP').length, 1);
});

test('physical Shift+Escape returns to the existing address chain without takeover while matching synthetic input does not', async t => {
  const focused = [];
  const f = fixture({ onFocusAddress: (profileId, info) => focused.push({ profileId, ...info }) });
  t.after(() => f.pool.destroy()); const opened = await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a', visible: true, bounds: { x: 0, y: 0, width: 600, height: 400 } });
  const wc = f.views[0].webContents;
  wc.dispatch = (method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
      assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'Escape', code: 'Escape', shift: true }), false);
    }
    return {};
  };
  success(await f.rpc('profile-a', 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', modifiers: 8 }, { sessionId }));
  assert.deepEqual(focused, []);
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'Escape', code: 'Escape', shift: true }), true);
  assert.deepEqual(focused, [{ profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a' }]);
  assert.deepEqual(f.inputs, []);
  assert.equal((await f.open()).epoch, opened.epoch);
});

test('new native contents load their initial blank document before waiting for frame identity', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); const original = f.options.createView;
  f.options.createView = (...args) => {
    const view = original(...args); view.webContents.waitForInitialDocument = true; return view;
  };
  const opening = f.open(); void opening.catch(() => {});
  await tick();
  assert.deepEqual(f.views[0].webContents.loads, ['about:blank']);
  await opening;
  const [page] = await f.targets('profile-a');
  assert.equal(page.targetId, f.views[0].webContents.targetId);
  const created = success(await f.rpc('profile-a', 'Target.createTarget', { url: 'https://fixture.test/new' }));
  assert.equal(created.targetId, f.views[1].webContents.targetId);
  assert.deepEqual(f.views[1].webContents.loads, ['about:blank', 'https://fixture.test/new']);
});

test('an adopted popup waits for its own initial navigation without loading a blank or replacing its guest', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  const parent = f.views[0].webContents;
  const decision = parent.popup({ url: 'https://fixture.test/popup', disposition: 'new-window' });
  const guest = new Contents(parent.session, decision.overrideBrowserWindowOptions.webPreferences);
  guest.waitForInitialDocument = true;
  assert.equal(decision.createWindow({ webContents: guest }), guest);
  await tick();
  assert.deepEqual(guest.loads, []);
  assert.equal((await f.targets('profile-a')).length, 1);
  guest.url = 'https://fixture.test/popup'; guest.hasInitialDocument = true; guest.resolveFrameReady();
  await tick();
  const popup = (await f.targets('profile-a')).find(info => info.targetId === guest.targetId);
  assert.ok(popup);
  assert.equal(popup.url, 'https://fixture.test/popup');
  assert.equal(f.views[1].webContents, guest);
  assert.deepEqual(guest.loads, []);
});

test('takeover during a new target identity query cancels and closes that target before its requested navigation', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); await f.open();
  success(await f.rpc('profile-a', 'Target.setDiscoverTargets', { discover: true }));
  const identity = deferred(); const original = f.options.createView;
  f.options.createView = (...args) => {
    const view = original(...args); view.webContents.identityInfo = identity.promise; return view;
  };
  const pending = f.rpc('profile-a', 'Target.createTarget', { url: 'https://fixture.test/must-not-open' });
  await tick(); const created = f.views[1].webContents;
  assert.deepEqual(created.loads, ['about:blank']);
  assert.equal(physical(f.views[0].webContents, 'mouse', { type: 'mouseDown', x: 1, y: 2, button: 'left' }), true);
  assert.equal((await pending).error.code, -32000);
  identity.resolve({ targetInfo: { targetId: created.targetId, type: 'page', title: '', url: 'about:blank' } });
  await tick();
  assert.deepEqual(created.loads, ['about:blank']);
  assert.equal(created.isDestroyed(), true);
  const { targetInfos } = success(await f.rpc('profile-a', 'Target.getTargets', {}, { actor: { kind: 'system' } }));
  assert.equal(targetInfos.length, 1);
  assert.equal(f.messages.some(message => message.method === 'Target.targetCreated' && message.params.targetInfo.targetId === created.targetId), false);
});

test('activity reports only accepted unmatched native input for the acknowledged visible viewer', async t => {
  const activity = [];
  const f = fixture({ onActivity: (profileId, input) => activity.push({ profileId, ...input }) });
  t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  const layout = { profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a', visible: true, canInput: true, bounds: { x: 0, y: 0, width: 600, height: 400 } };
  f.pool.layout(layout); const wc = f.views[0].webContents;
  assert.equal(physical(wc, 'mouse', { type: 'mouseDown', x: 10, y: 20, button: 'left' }), true);
  assert.deepEqual(activity, []);
  f.lease({ profileId: 'profile-a', viewerId: 'viewer-a', ready: true });
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'private-text', code: 'KeyA' }), false);
  assert.deepEqual(activity, [{ profileId: 'profile-a', targetId: target.targetId, viewerId: 'viewer-a' }]);
  wc.dispatch = () => { assert.equal(physical(wc, 'mouse', { type: 'mouseMove', x: 10, y: 20, button: 'none' }), false); return {}; };
  success(await f.rpc('profile-a', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }, { sessionId, actor: { kind: 'viewer', viewerId: 'viewer-a' } }));
  assert.equal(activity.length, 1);
  wc.dispatch = null;
  f.pool.layout({ ...layout, canInput: false });
  assert.equal(physical(wc, 'mouse', { type: 'mouseDown', x: 10, y: 20, button: 'left' }), true);
  assert.equal(activity.length, 1);
  f.lease({ profileId: 'profile-a', viewerId: 'viewer-b', ready: true });
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'b', code: 'KeyB' }), true);
  assert.equal(activity.length, 1);
});

test('a passive viewer consumes physical input without canceling outstanding agent work or changing its epoch', async t => {
  const activity = [];
  const f = fixture({ onActivity: (profileId, input) => activity.push({ profileId, ...input }) });
  t.after(() => f.pool.destroy()); const opened = await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'passive-viewer', visible: true, canInput: false, canTake: false, bounds: { x: 0, y: 0, width: 600, height: 400 } });
  const waiting = deferred(); const wc = f.views[0].webContents;
  wc.dispatch = method => method === 'Runtime.evaluate' ? waiting.promise : {};
  const pending = f.rpc('profile-a', 'Runtime.evaluate', { expression: 'slowFixture()' }, { sessionId });
  await tick();
  assert.equal(physical(wc, 'mouse', { type: 'mouseDown', x: 10, y: 20, button: 'left' }), true);
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'a', code: 'KeyA' }), true);
  const epoch = (await f.open()).epoch;
  waiting.resolve({ fixtureComplete: true });
  const response = await pending;
  assert.equal(epoch, opened.epoch);
  assert.deepEqual(success(response), { fixtureComplete: true });
  assert.deepEqual(f.inputs, []);
  assert.deepEqual(activity, []);
});

test('canTake restricts physical activity even with an acknowledged lease while matching synthetic input remains permitted', async t => {
  const activity = [];
  const f = fixture({ onActivity: (profileId, input) => activity.push({ profileId, ...input }) });
  t.after(() => f.pool.destroy()); await f.open();
  const [target] = await f.targets('profile-a'); const sessionId = await f.attach('profile-a', target.targetId);
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'passive-viewer', visible: true, canInput: true, canTake: false, bounds: { x: 0, y: 0, width: 600, height: 400 } });
  const epoch = f.lease({ profileId: 'profile-a', viewerId: 'passive-viewer', ready: true });
  const wc = f.views[0].webContents;
  assert.equal(physical(wc, 'keyboard', { type: 'keyDown', key: 'a', code: 'KeyA' }), true);
  assert.deepEqual(activity, []);
  assert.deepEqual(f.inputs, []);
  assert.equal((await f.open()).epoch, epoch);
  wc.dispatch = (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') assert.equal(physical(wc, 'mouse', { type: 'mouseMove', x: 10, y: 20, button: 'none' }), false);
    return {};
  };
  success(await f.rpc('profile-a', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }, { sessionId, actor: { kind: 'viewer', viewerId: 'passive-viewer' } }));
  assert.deepEqual(activity, []);
});

test('an interactive viewer with no input lease can still request control through its first physical event', async t => {
  const f = fixture(); t.after(() => f.pool.destroy()); const opened = await f.open();
  const [target] = await f.targets('profile-a');
  f.pool.layout({ profileId: 'profile-a', targetId: target.targetId, viewerId: 'interactive-viewer', visible: true, canInput: false, canTake: true, bounds: { x: 0, y: 0, width: 600, height: 400 } });
  assert.equal(physical(f.views[0].webContents, 'mouse', { type: 'mouseDown', x: 10, y: 20, button: 'left' }), true);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].viewerId, 'interactive-viewer');
  assert.ok(f.inputs[0].epoch > opened.epoch);
});
