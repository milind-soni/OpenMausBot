import path from 'node:path';

const INPUT_TYPES = { mouseMoved: 'mouseMove', mousePressed: 'mouseDown', mouseReleased: 'mouseUp', mouseWheel: 'mouseWheel' };
const MODIFIERS = [['alt', 1], ['control', 2], ['meta', 4], ['shift', 8]];
const PAGE_DOMAINS = new Set(['Accessibility', 'Animation', 'Audits', 'Autofill', 'CacheStorage', 'CSS', 'Database', 'DOM',
  'DOMDebugger', 'DOMSnapshot', 'DOMStorage', 'Emulation', 'EventBreakpoints', 'Fetch', 'IndexedDB', 'Input', 'Inspector',
  'IO', 'LayerTree', 'Log', 'Media', 'Network', 'Overlay', 'Page', 'Performance', 'Preload', 'Runtime', 'Security',
  'ServiceWorker', 'WebAudio', 'WebAuthn', 'Debugger', 'Profiler', 'HeapProfiler']);
const PERMISSIONS = new Map([
  ['geolocation', 'geolocation'], ['notifications', 'notifications'], ['camera', 'videoCapture'],
  ['microphone', 'audioCapture'], ['clipboard-read', 'clipboard-read'], ['clipboard-write', 'clipboard-sanitized-write'],
  ['midi', 'midi'], ['persistent-storage', 'persistent-storage'], ['storage-access', 'storage-access'],
]);

function failure(message, code = -32000) { return Object.assign(new Error(message), { code }); }
function unsupported(method) { throw failure(`Native browser does not support ${method}`, -32601); }
function identifier(value, name) {
  if (typeof value !== 'string' || !value || value.length > 256 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw failure(`Invalid ${name}`, -32602);
  return value;
}
function listen(target, name, handler, cleanup) {
  target?.on?.(name, handler);
  cleanup.push(() => target?.removeListener?.(name, handler));
}
function discard(cleanup) { for (const remove of cleanup.splice(0)) { try { remove(); } catch {} } }
function neutral(message) {
  return message.method === 'Input.dispatchKeyEvent' && message.params?.type === 'keyUp' ||
    message.method === 'Input.dispatchMouseEvent' && message.params?.type === 'mouseReleased';
}
function expectedInput(method, params) {
  if (method === 'Input.dispatchKeyEvent' && (params.key || params.code)) {
    const type = params.type === 'rawKeyDown' ? 'keyDown' : params.type;
    if (['keyDown', 'keyUp', 'char'].includes(type)) return { channel: 'keyboard', type, key: params.key, code: params.code, modifiers: params.modifiers ?? 0 };
  }
  if (method === 'Input.dispatchMouseEvent' && INPUT_TYPES[params.type] && Number.isFinite(params.x) && Number.isFinite(params.y)) {
    return { channel: 'mouse', type: INPUT_TYPES[params.type], x: params.x, y: params.y, button: params.button ?? 'none', modifiers: params.modifiers ?? 0,
      ...(params.type === 'mouseWheel' ? { deltaX: params.deltaX ?? 0, deltaY: params.deltaY ?? 0 } : {}) };
  }
  return null;
}
function matches(expected, channel, input) {
  if (!input || expected.channel !== channel || expected.type !== input.type) return false;
  if (channel === 'keyboard') {
    if (expected.key && expected.key !== input.key || expected.code && expected.code !== input.code) return false;
  } else if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || Math.abs(expected.x - input.x) > 0.5 ||
      Math.abs(expected.y - input.y) > 0.5 || expected.button !== input.button) return false;
  if (expected.type === 'mouseWheel' && (expected.deltaX !== input.deltaX || expected.deltaY !== input.deltaY)) return false;
  return MODIFIERS.every(([name, bit]) => {
    const wanted = (expected.modifiers & bit) !== 0;
    return !(typeof input[name] === 'boolean' && input[name] !== wanted ||
      Array.isArray(input.modifiers) && input.modifiers.includes(name) !== wanted);
  });
}
function bounds(value, fallback = { x: 0, y: 0, width: 1280, height: 800 }) {
  const result = { ...fallback, ...value };
  if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(result[key])) || result.width < 0 || result.height < 0 ||
      result.width > 16384 || result.height > 16384) throw failure('Invalid native page bounds', -32602);
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(result[key])]));
}
function origin(value) {
  if (value === undefined) return '*';
  try { const result = new URL(value).origin; if (result !== 'null') return result; } catch {}
  throw failure('Invalid permission origin', -32602);
}
function filtered(info, filter) {
  if (!Array.isArray(filter)) return true;
  for (const entry of filter) if (!entry.type || entry.type === info.type) return entry.exclude !== true;
  return false;
}

/** A profile-scoped CDP endpoint over owned sandboxed native website views. */
export function createNativeBrowserPool(options) {
  for (const name of ['createView', 'sessionForProfile', 'getOwner', 'createRenderOwner']) {
    if (typeof options?.[name] !== 'function') throw failure(`Native browser requires ${name}`);
  }
  const profiles = new Map();
  const knownSessions = new Map();
  const sessionOwners = new WeakMap();
  const epochs = new Map();
  const renderOwners = new Set();
  const maxProfiles = options.maxProfiles ?? 16;
  const maxTargets = options.maxTargets ?? 64;
  const maxTargetsPerProfile = options.maxTargetsPerProfile ?? 16;
  let targetSequence = 0;
  let sessionSequence = 0;
  let windowSequence = 0;
  let destroyed = false;
  let destroyPromise;
  let visibleTab = null;

  function alive() { if (destroyed) throw failure('Native browser pool is closed'); }
  function emit(profile, message) { try { options.onMessage?.(profile.id, JSON.stringify(message)); } catch {} }
  function notifyInput(profile, tab) {
    try { options.onInput?.(profile.id, { viewerId: tab.layout?.viewerId ?? profile.lease.viewerId, targetId: tab.id, epoch: profile.epoch }); } catch {}
  }
  function record(id) {
    identifier(id, 'profileId');
    const profile = profiles.get(id);
    if (!profile || profile.closed || profile.phase !== 'ready') throw failure('Native browser profile is not open');
    return profile;
  }
  function advance(profile, reason) {
    profile.epoch += 1;
    epochs.set(profile.id, profile.epoch);
    for (const token of profile.pending) if (token.actor.kind !== 'system') token.cancel(failure(reason));
    for (const tab of profile.targets.values()) {
      tab.tickets.clear();
      releaseHeld(tab);
    }
  }
  function authorize(profile, epoch, actor, message) {
    if (profile.closed) throw failure('Native browser profile is closed');
    if (actor.kind === 'system') return;
    if (neutral(message) && actor.kind === 'agent') return;
    if (epoch !== profile.epoch) throw failure('Native browser ownership epoch changed');
    if (actor.kind === 'agent') {
      if (profile.humanPending || profile.lease.viewerId !== null) throw failure('A person holds native browser control');
    } else if (actor.kind === 'viewer') {
      if (!profile.lease.ready || profile.lease.viewerId !== actor.viewerId) throw failure('Native browser viewer is not the acknowledged controller');
    } else throw failure('Invalid native browser actor', -32602);
  }
  function preferences(profile) {
    return { session: profile.session, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, focusOnNavigation: false };
  }
  function targetInfo(tab) {
    return { targetId: tab.id, type: 'page', title: tab.wc.getTitle?.() ?? '', url: tab.wc.getURL?.() || tab.url || 'about:blank',
      attached: tab.aliases.size > 0, canAccessOpener: !!tab.openerId, ...(tab.openerId ? { openerId: tab.openerId } : {}) };
  }
  function target(profile, id) {
    const tab = profile.targets.get(id);
    if (!tab?.identified || tab.wc.isDestroyed?.()) throw failure('Target does not belong to this native profile');
    return tab;
  }
  function publicTargets(profile) { return [...profile.targets.values()].filter(tab => tab.identified); }
  function checkCapacity(profile) {
    if (profile.targets.size >= maxTargetsPerProfile || [...profiles.values()].reduce((sum, item) => sum + item.targets.size, 0) >= maxTargets) {
      throw failure('Native browser target limit reached');
    }
  }
  function renderOwner(profile) {
    if (profile.renderOwner && !profile.renderOwner.isDestroyed?.()) return profile.renderOwner;
    const owner = options.createRenderOwner();
    if (!owner?.contentView || owner === options.getOwner() || owner.isDestroyed?.()) throw failure('A separate hidden render owner is required');
    profile.renderOwner = owner;
    renderOwners.add(owner);
    return owner;
  }
  function move(tab, owner, nextBounds) {
    if (tab.owner !== owner) {
      tab.owner?.contentView.removeChildView(tab.view);
      try { owner.contentView.addChildView(tab.view); }
      catch (error) { try { tab.owner?.contentView.addChildView(tab.view); } catch {} throw error; }
      tab.owner = owner;
    }
    tab.view.setBounds(nextBounds);
    tab.view.setVisible(true);
  }
  function prepareSurface(tab) {
    if (visibleTab === tab && tab.layout?.visible && !tab.owner?.isDestroyed?.()) return;
    // Electron 43 needs a rendering owner for native DOM hit testing, even when its window is show:false.
    move(tab, renderOwner(tab.profile), { ...tab.automationBounds, x: 0, y: 0 });
  }
  function showLayout(tab) {
    const owner = options.getOwner();
    if (!owner?.contentView || owner.isDestroyed?.()) throw failure('Native browser main owner is unavailable');
    const value = bounds(tab.layout.bounds);
    const [width, height] = owner.getContentSize?.() ?? [value.x + value.width, value.y + value.height];
    const x = Math.max(0, Math.min(width, value.x));
    const y = Math.max(0, Math.min(height, value.y));
    const clipped = { x, y, width: Math.max(0, Math.min(width, value.x + value.width) - x), height: Math.max(0, Math.min(height, value.y + value.height) - y) };
    move(tab, owner, clipped);
    tab.view.setVisible(clipped.width > 0 && clipped.height > 0);
  }
  function physicalInput(tab, channel, event, input) {
    const profile = tab.profile;
    if (profile.closed) { event.preventDefault(); return; }
    for (const ticket of tab.tickets) {
      if (ticket.expires < Date.now() || !ticket.neutral && ticket.epoch !== profile.epoch) { tab.tickets.delete(ticket); continue; }
      if (matches(ticket.expected, channel, input)) { tab.tickets.delete(ticket); return; }
    }
    if (channel === 'keyboard' && input?.type === 'keyDown' && (input.key === 'Escape' || input.code === 'Escape') &&
        (input.shift === true || input.modifiers?.includes('shift'))) {
      event.preventDefault();
      try { options.onFocusAddress?.(profile.id, { targetId: tab.id, viewerId: tab.layout?.viewerId ?? profile.lease.viewerId }); } catch {}
      return;
    }
    if (tab.layout?.canTake === false) { event.preventDefault(); return; }
    if (visibleTab === tab && tab.layout?.visible && tab.layout.canInput !== false && profile.lease.ready &&
        profile.lease.viewerId !== null && profile.lease.viewerId === tab.layout.viewerId) {
      try { options.onActivity?.(profile.id, { targetId: tab.id, viewerId: tab.layout.viewerId }); } catch {}
      return;
    }
    event.preventDefault();
    if (profile.humanPending) return;
    profile.humanPending = true;
    profile.lease = { viewerId: tab.layout?.viewerId ?? profile.lease.viewerId, ready: false };
    advance(profile, 'A person took over native browser control');
    notifyInput(profile, tab);
  }
  function attachDebugger(tab) {
    if (tab.wc.debugger.isAttached?.()) return;
    tab.wc.debugger.attach('1.3');
  }
  function alias(tab, rawSessionId, parentSessionId) {
    const sessionId = `native-session-${++sessionSequence}`;
    const entry = { id: sessionId, tab, rawSessionId, parentSessionId };
    tab.profile.sessions.set(sessionId, entry);
    if (rawSessionId) tab.rawSessions.set(rawSessionId, entry);
    else tab.aliases.add(sessionId);
    return entry;
  }
  function attachTarget(tab) {
    attachDebugger(tab);
    const entry = alias(tab);
    emit(tab.profile, { method: 'Target.attachedToTarget', params: { sessionId: entry.id, targetInfo: targetInfo(tab), waitingForDebugger: false } });
    return entry.id;
  }
  function detachSession(profile, id, announce = true) {
    const entry = profile.sessions.get(id);
    if (!entry) throw failure('Session does not belong to this native profile');
    for (const child of profile.sessions.values()) if (child.parentSessionId === id) detachSession(profile, child.id, announce);
    profile.sessions.delete(id);
    entry.tab.aliases.delete(id);
    if (entry.rawSessionId) entry.tab.rawSessions.delete(entry.rawSessionId);
    if (announce) emit(profile, { method: 'Target.detachedFromTarget', params: { sessionId: id, targetId: entry.targetId ?? entry.tab.id } });
    return entry;
  }
  function childInfo(tab, info) {
    let result = tab.childTargets.get(info.targetId);
    if (!result) { result = { ...info }; tab.childTargets.set(info.targetId, result); }
    else Object.assign(result, info);
    return result;
  }
  function debuggerEvent(tab, method, params = {}, rawSessionId) {
    const profile = tab.profile;
    if (profile.closed || !profile.targets.has(tab.id)) return;
    const entry = rawSessionId ? tab.rawSessions.get(rawSessionId) : null;
    if (rawSessionId && !entry) return;
    const recipients = entry ? [entry.id] : [...tab.aliases];
    if (!recipients.length) return;
    if (method === 'Target.attachedToTarget') {
      if (typeof params.sessionId !== 'string' || !params.targetInfo || !['iframe', 'worker', 'shared_worker', 'service_worker'].includes(params.targetInfo.type)) return;
      const child = tab.rawSessions.get(params.sessionId) ?? alias(tab, params.sessionId, recipients[0]);
      child.targetId = params.targetInfo.targetId;
      emit(profile, { method, params: { ...params, sessionId: child.id, targetInfo: childInfo(tab, params.targetInfo) }, sessionId: recipients[0] });
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const child = tab.rawSessions.get(params.sessionId);
      if (!child) return;
      const info = params.targetId && tab.childTargets.get(params.targetId);
      emit(profile, { method, params: { ...params, sessionId: child.id, ...(info ? { targetId: info.targetId } : {}) }, sessionId: recipients[0] });
      detachSession(profile, child.id, false);
      return;
    }
    if (method.startsWith('Target.')) {
      const rawInfo = params.targetInfo;
      const known = rawInfo ? tab.childTargets.get(rawInfo.targetId) : tab.childTargets.get(params.targetId);
      if (!known) return;
      params = rawInfo ? { ...params, targetInfo: childInfo(tab, rawInfo) } : { ...params, targetId: known.targetId };
    }
    if (method.startsWith('Browser.')) return;
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) tab.mainFrameId = params.frame.id;
    for (const sessionId of recipients) emit(profile, { method, params, sessionId });
  }
  function updateTarget(tab) {
    if (tab.identified && tab.profile.discover && tab.profile.targets.has(tab.id)) emit(tab.profile, { method: 'Target.targetInfoChanged', params: { targetInfo: targetInfo(tab) } });
  }
  function removeTarget(tab, closeContents) {
    const profile = tab.profile;
    if (!profile.targets.delete(tab.id)) return;
    for (const token of profile.pending) if (token.tab === tab) token.cancel(failure('Native browser target closed'));
    for (const id of tab.aliases) if (profile.sessions.has(id)) detachSession(profile, id);
    for (const entry of profile.sessions.values()) if (entry.tab === tab) detachSession(profile, entry.id);
    tab.tickets.clear(); tab.heldKeys.clear(); tab.heldMouse.clear();
    discard(tab.cleanup);
    try { tab.wc.setWindowOpenHandler?.(() => ({ action: 'deny' })); } catch {}
    try { tab.view.setVisible(false); tab.owner?.contentView.removeChildView(tab.view); } catch {}
    if (visibleTab === tab) visibleTab = null;
    try { if (tab.wc.debugger.isAttached?.()) tab.wc.debugger.detach(); } catch {}
    try { if (closeContents && !tab.wc.isDestroyed?.()) tab.wc.close({ waitForBeforeUnload: false }); } catch {}
    if (tab.identified && profile.discover) emit(profile, { method: 'Target.targetDestroyed', params: { targetId: tab.id } });
  }
  function assertInitializingTarget(tab) {
    if (tab.profile.closed || tab.profile.targets.get(tab.id) !== tab || tab.wc.isDestroyed?.()) throw failure('Native target closed before identity resolved');
  }
  async function identifyTarget(tab, existing) {
    // Electron 43's new webContents has no frame until its first document loads; native popup guests initialize themselves.
    if (!existing) await tab.wc.loadURL('about:blank');
    assertInitializingTarget(tab);
    attachDebugger(tab);
    const { targetInfo: info } = await tab.wc.debugger.sendCommand('Target.getTargetInfo', {});
    assertInitializingTarget(tab);
    const { frameTree } = await tab.wc.debugger.sendCommand('Page.getFrameTree', {});
    if (info?.type !== 'page' || !info.targetId || info.targetId !== frameTree?.frame?.id) throw failure('Owned native page target and main-frame identity do not match');
    identifier(info.targetId, 'owned targetId');
    const profile = tab.profile;
    assertInitializingTarget(tab);
    if ([...profiles.values()].some(owner => [...owner.targets.values()].some(existing => existing !== tab && existing.identified && existing.id === info.targetId))) {
      throw failure('Native target identity is already owned by another view');
    }
    profile.targets.delete(tab.id);
    tab.id = info.targetId; tab.mainFrameId = frameTree.frame.id; tab.identified = true;
    profile.targets.set(tab.id, tab);
    if (profile.discover && filtered(targetInfo(tab), profile.discoverFilter)) emit(profile, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(tab) } });
    if (profile.autoAttach && filtered(targetInfo(tab), profile.autoAttachFilter)) attachTarget(tab);
  }
  function makeTarget(profile, url, existing, openerId) {
    if (profile.closed) throw failure('Native browser profile is closed');
    checkCapacity(profile);
    const prefs = existing?.getLastWebPreferences?.();
    if (existing && (existing.session !== profile.session || existing.isDestroyed?.())) throw failure('Popup session does not match this native profile');
    if (existing && (!prefs || prefs.nodeIntegration !== false || prefs.contextIsolation !== true || prefs.sandbox !== true || prefs.webSecurity === false || prefs.preload)) {
      throw failure('Popup native view has unsafe website preferences');
    }
    const view = options.createView(preferences(profile), existing);
    const wc = view?.webContents;
    if (!wc || wc.session !== profile.session || existing && wc !== existing || wc === options.getOwner()?.webContents) {
      try { if (wc && wc !== existing && wc !== options.getOwner()?.webContents) wc.close({ waitForBeforeUnload: false }); } catch {}
      throw failure('Native view did not adopt the owned profile session and exact popup guest');
    }
    const tab = { id: `pending-native-target-${++targetSequence}`, identified: false, windowId: ++windowSequence, profile, view, wc, url, openerId,
      owner: null, layout: null, automationBounds: bounds(), aliases: new Set(), rawSessions: new Map(), childTargets: new Map(),
      tickets: new Set(), heldKeys: new Map(), heldMouse: new Map(), cleanup: [] };
    profile.targets.set(tab.id, tab);
    try {
      view.setVisible(false);
      prepareSurface(tab);
      const on = (name, fn) => listen(wc, name, fn, tab.cleanup);
      on('before-input-event', (event, input) => physicalInput(tab, 'keyboard', event, input));
      on('before-mouse-event', (event, input) => physicalInput(tab, 'mouse', event, input));
      on('will-attach-webview', event => event.preventDefault());
      on('destroyed', () => removeTarget(tab, false));
      on('render-process-gone', () => {
        advance(profile, 'Native browser renderer exited');
        emit(profile, { method: 'Target.targetCrashed', params: { targetId: tab.id, status: 'crashed', errorCode: -1 } });
      });
      for (const name of ['did-navigate', 'did-navigate-in-page', 'page-title-updated']) on(name, () => updateTarget(tab));
      listen(wc.debugger, 'message', (_event, method, params, rawSessionId) => debuggerEvent(tab, method, params, rawSessionId), tab.cleanup);
      listen(wc.debugger, 'detach', (_event, reason) => {
        for (const id of tab.aliases) if (profile.sessions.has(id)) detachSession(profile, id);
        for (const token of profile.pending) if (token.tab === tab) token.cancel(failure(`Native debugger detached: ${reason || 'closed'}`));
      }, tab.cleanup);
      wc.setWindowOpenHandler?.(details => {
        try {
          if (profile.closed || !profile.targets.has(tab.id)) return { action: 'deny' };
          checkCapacity(profile);
          return { action: 'allow', outlivesOpener: true,
            overrideBrowserWindowOptions: { show: false, webPreferences: preferences(profile) },
            createWindow: nativeOptions => {
              const guest = nativeOptions?.webContents;
              if (!guest && details.postBody) throw failure('A popup form submission requires its original native guest');
              const popup = makeTarget(profile, details.url || 'about:blank', guest, tab.id);
              if (!guest) void popup.identityPromise.then(() => popup.wc.loadURL(details.url || 'about:blank', details.referrer ? { httpReferrer: details.referrer } : undefined)).catch(() => {});
              return popup.wc;
            } };
        } catch { return { action: 'deny' }; }
      });
      tab.identityPromise = identifyTarget(tab, existing);
      void tab.identityPromise.catch(() => removeTarget(tab, true));
      return tab;
    } catch (error) { removeTarget(tab, true); throw error; }
  }
  async function invoke(tab, method, params, rawSessionId, isNeutral = false) {
    attachDebugger(tab);
    const expected = expectedInput(method, params);
    if (expected && tab.tickets.size >= 64) throw failure('Too many native input dispatches');
    // Electron 43 exposes no synthetic bit: one exact event may consume each dispatch ticket.
    const ticket = expected ? { expected, epoch: tab.profile.epoch, neutral: isNeutral, expires: Date.now() + 1000 } : null;
    if (ticket) tab.tickets.add(ticket);
    if (!isNeutral) {
      if (method === 'Input.dispatchKeyEvent') {
        const key = params.code || params.key;
        if (['keyDown', 'rawKeyDown'].includes(params.type) && key) tab.heldKeys.set(key, { ...params, rawSessionId });
        if (params.type === 'keyUp') tab.heldKeys.delete(key);
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mousePressed') tab.heldMouse.set(params.button ?? 'left', { ...params, rawSessionId });
        if (params.type === 'mouseReleased') tab.heldMouse.delete(params.button ?? 'left');
      }
    }
    try {
      const result = await tab.wc.debugger.sendCommand(method, params, rawSessionId);
      if (method === 'Page.getFrameTree' && !rawSessionId && result?.frameTree?.frame?.id) tab.mainFrameId = result.frameTree.frame.id;
      return result;
    }
    finally { if (ticket) tab.tickets.delete(ticket); }
  }
  function releaseHeld(tab) {
    const keys = [...tab.heldKeys.values()]; const mouse = [...tab.heldMouse.values()];
    tab.heldKeys.clear(); tab.heldMouse.clear();
    for (const { rawSessionId, ...params } of keys) void invoke(tab, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp', modifiers: 0 }, rawSessionId, true).catch(() => {});
    for (const { rawSessionId, ...params } of mouse) void invoke(tab, 'Input.dispatchMouseEvent', { ...params, type: 'mouseReleased', buttons: 0, modifiers: 0 }, rawSessionId, true).catch(() => {});
  }
  function installSession(profile) {
    const session = profile.session;
    const owns = wc => [...profile.targets.values()].some(tab => tab.wc === wc);
    const allowed = (wc, permission, requestingOrigin, details = {}) => {
      if (!owns(wc) || profile.closed) return false;
      let names = permission === 'media' ? (details.mediaTypes ?? []).map(type => type === 'video' ? 'videoCapture' : 'audioCapture') : [permission];
      if (!names.length) return false;
      let location;
      try { location = origin(requestingOrigin || details.requestingUrl || wc.getURL?.()); } catch { return false; }
      return names.every(name => profile.permissions.get(`${location}:${name}`) === 'granted' ||
        !profile.permissions.has(`${location}:${name}`) && profile.permissions.get(`*:${name}`) === 'granted');
    };
    session.setPermissionCheckHandler?.(allowed);
    session.setPermissionRequestHandler?.((wc, permission, answer, details) => answer(allowed(wc, permission, details?.requestingUrl, details)));
    profile.cleanup.push(() => session.setPermissionCheckHandler?.(null), () => session.setPermissionRequestHandler?.(null));
    listen(session, 'will-download', (event, item, wc) => {
      if (!owns(wc) || profile.closed || !['allow', 'allowAndName'].includes(profile.downloadBehavior.behavior)) { event.preventDefault(); return; }
      const tab = [...profile.targets.values()].find(entry => entry.wc === wc);
      const guid = String(item.getGUID?.() || `native-download-${++targetSequence}`);
      const name = path.basename(String(item.getFilename?.() || 'download')).replace(/[<>:"/\\|?*]|\p{Cc}/gu, '_');
      item.setSavePath(path.join(profile.downloadBehavior.downloadPath, profile.downloadBehavior.behavior === 'allowAndName' ? guid : name));
      profile.downloads.set(guid, item);
      const removers = [];
      const progress = state => {
        if (!profile.downloadBehavior.eventsEnabled) return;
        emit(profile, { method: 'Browser.downloadProgress', params: { guid, state, totalBytes: item.getTotalBytes?.() ?? 0, receivedBytes: item.getReceivedBytes?.() ?? 0,
          ...(state === 'completed' ? { filePath: item.getSavePath?.() } : {}) } });
      };
      listen(item, 'updated', () => progress('inProgress'), removers);
      listen(item, 'done', (_event, state) => {
        progress(state === 'completed' ? 'completed' : 'canceled');
        profile.downloads.delete(guid); profile.downloadCleanup.delete(guid); discard(removers);
      }, removers);
      profile.downloadCleanup.set(guid, removers);
      if (profile.downloadBehavior.eventsEnabled) emit(profile, { method: 'Browser.downloadWillBegin', params: {
        guid, url: item.getURL?.() ?? '', suggestedFilename: name, frameId: String(tab.mainFrameId ?? wc.mainFrame?.frameToken ?? tab.id), targetId: tab.id } });
    }, profile.cleanup);
  }
  async function open({ profileId, persistent, proxyPort }) {
    alive(); identifier(profileId, 'profileId');
    if (typeof persistent !== 'boolean' || proxyPort !== undefined && (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)) throw failure('Invalid native profile options', -32602);
    const existing = profiles.get(profileId);
    if (existing) {
      if (existing.closed || existing.persistent !== persistent || existing.proxyPort !== proxyPort) throw failure('Native profile is closing or has different open options');
      await existing.openPromise;
      return { profileId, product: options.product, epoch: existing.epoch };
    }
    if (profiles.size >= maxProfiles) throw failure('Native browser profile limit reached');
    const profile = { id: profileId, persistent, proxyPort, epoch: (epochs.get(profileId) ?? 0) + 1, phase: 'opening', closed: false,
      targets: new Map(), sessions: new Map(), pending: new Set(), cleanup: [], permissions: new Map(), downloads: new Map(), downloadCleanup: new Map(),
      downloadBehavior: { behavior: 'deny' }, lease: { viewerId: null, ready: false }, humanPending: false, discover: false, autoAttach: false };
    profiles.set(profileId, profile); epochs.set(profileId, profile.epoch);
    profile.sessionPromise = Promise.resolve().then(() => options.sessionForProfile(profileId, { persistent, ...(proxyPort === undefined ? {} : { proxyPort }) }));
    profile.openPromise = (async () => {
      const session = await profile.sessionPromise;
      if (!session || session === options.getOwner()?.webContents?.session || sessionOwners.has(session) && sessionOwners.get(session) !== profileId) {
        throw failure('Native browser requires a separate, profile-owned Session');
      }
      profile.session = session; sessionOwners.set(session, profileId); knownSessions.set(profileId, { session, persistent });
      if (profile.closed || destroyed) throw failure('Native profile closed while opening');
      installSession(profile);
      const tab = makeTarget(profile, 'about:blank');
      await tab.identityPromise;
      if (profile.closed || destroyed) throw failure('Native profile closed while opening');
      profile.phase = 'ready';
      return { profileId, product: options.product, epoch: profile.epoch };
    })();
    try { return await profile.openPromise; }
    catch (error) { if (!profile.closePromise) await closeRecord(profile, 'open-failed', false); throw error; }
  }
  function lease({ profileId, viewerId, ready }) {
    alive(); const profile = record(profileId);
    if (viewerId !== null) identifier(viewerId, 'viewerId');
    if (typeof ready !== 'boolean' || ready && viewerId === null) throw failure('Invalid native viewer lease', -32602);
    if (profile.lease.viewerId === viewerId && profile.lease.ready === ready && !profile.humanPending) return profile.epoch;
    profile.lease = { viewerId, ready }; profile.humanPending = false;
    if (visibleTab?.profile === profile && viewerId !== null && visibleTab.layout?.viewerId !== viewerId) {
      const previous = visibleTab; visibleTab = null;
      previous.layout = { ...previous.layout, visible: false };
      prepareSurface(previous);
    }
    advance(profile, 'Native browser controller changed');
    return profile.epoch;
  }
  function layout({ profileId, targetId, viewerId, bounds: value, visible, canInput, canTake }) {
    alive(); const profile = record(profileId); const tab = target(profile, targetId);
    identifier(viewerId, 'viewerId'); const nextBounds = bounds(value);
    if (typeof visible !== 'boolean' || canInput !== undefined && typeof canInput !== 'boolean' ||
        canTake !== undefined && typeof canTake !== 'boolean') throw failure('Invalid native layout', -32602);
    if (!visible && tab.layout && tab.layout.viewerId !== viewerId) return;
    const permitted = profile.lease.viewerId === null || profile.lease.viewerId === viewerId;
    tab.layout = { viewerId, bounds: nextBounds, visible: visible && permitted, canInput: canInput !== false, canTake: canTake !== false };
    if (tab.layout.visible) {
      const previous = visibleTab; visibleTab = tab;
      if (previous && previous !== tab) prepareSurface(previous);
      showLayout(tab);
    } else if (visibleTab === tab) { visibleTab = null; prepareSurface(tab); }
  }
  function activate(tab) {
    const previous = visibleTab;
    if (previous && previous.profile === tab.profile && previous !== tab) {
      tab.layout = { ...previous.layout, bounds: { ...previous.layout.bounds } };
      previous.layout = { ...previous.layout, visible: false };
      visibleTab = tab; prepareSurface(previous); showLayout(tab);
    }
    return {};
  }
  function permission(profile, params, reset = false) {
    if (params.browserContextId) throw failure('Browser context does not belong to this native profile');
    if (reset) { profile.permissions.clear(); return {}; }
    const location = origin(params.origin);
    const name = PERMISSIONS.get(params.permission?.name);
    if (!name || params.permission?.sysex) unsupported('Browser.setPermission permission');
    if (!['granted', 'denied', 'prompt'].includes(params.setting)) throw failure('Invalid permission setting', -32602);
    profile.permissions.set(`${location}:${name}`, params.setting);
    return {};
  }
  async function browserCommand(profile, method, params) {
    if (params.browserContextId) throw failure('Browser context does not belong to this native profile');
    switch (method) {
      case 'Browser.getVersion': return { protocolVersion: '1.3', product: options.product, revision: '', userAgent: [...profile.targets.values()][0]?.wc.getUserAgent?.() ?? options.product, jsVersion: process.versions.v8 };
      case 'Browser.getWindowForTarget': {
        const tab = target(profile, params.targetId); return { windowId: tab.windowId, bounds: { ...tab.view.getBounds?.() ?? tab.automationBounds, windowState: 'normal' } };
      }
      case 'Browser.getWindowBounds': case 'Browser.setWindowBounds': {
        const tab = [...profile.targets.values()].find(entry => entry.windowId === params.windowId);
        if (!tab) throw failure('Window does not belong to this native profile');
        if (method === 'Browser.getWindowBounds') return { bounds: { ...tab.view.getBounds?.() ?? tab.automationBounds, windowState: 'normal' } };
        if (params.bounds?.windowState && params.bounds.windowState !== 'normal') unsupported('Browser.setWindowBounds windowState');
        tab.automationBounds = bounds(params.bounds, tab.automationBounds);
        if (visibleTab === tab) showLayout(tab); else prepareSurface(tab);
        return {};
      }
      case 'Browser.setPermission': return permission(profile, params);
      case 'Browser.resetPermissions': return permission(profile, params, true);
      case 'Browser.grantPermissions': {
        if (!Array.isArray(params.permissions)) throw failure('Invalid permissions', -32602);
        const names = params.permissions.map(name => PERMISSIONS.has(name) ? name : [...PERMISSIONS].find(([, value]) => value === name)?.[0]);
        if (names.some(name => !name)) unsupported(method);
        for (const name of names) permission(profile, { permission: { name }, setting: 'granted', origin: params.origin });
        return {};
      }
      case 'Browser.setDownloadBehavior': {
        if (!['deny', 'default', 'allow', 'allowAndName'].includes(params.behavior)) unsupported(method);
        if (['allow', 'allowAndName'].includes(params.behavior) && (typeof params.downloadPath !== 'string' || !path.isAbsolute(params.downloadPath))) throw failure('An authorized absolute download path is required', -32602);
        profile.downloadBehavior = { behavior: params.behavior, downloadPath: params.downloadPath, eventsEnabled: params.eventsEnabled === true };
        return {};
      }
      case 'Browser.cancelDownload': {
        const item = profile.downloads.get(params.guid); if (!item) throw failure('Download does not belong to this native profile');
        item.cancel(); return {};
      }
      default: unsupported(method);
    }
  }
  async function targetCommand(profile, message, entry, token) {
    const { method, params = {} } = message;
    switch (method) {
      case 'Target.getTargets': return { targetInfos: publicTargets(profile).map(targetInfo).filter(info => filtered(info, params.filter)) };
      case 'Target.getTargetInfo': return { targetInfo: targetInfo(params.targetId ? target(profile, params.targetId) : entry?.tab ?? publicTargets(profile)[0] ?? target(profile, '')) };
      case 'Target.setDiscoverTargets':
        if (entry) unsupported(method);
        profile.discover = params.discover === true; profile.discoverFilter = params.filter;
        if (profile.discover) for (const tab of publicTargets(profile)) if (filtered(targetInfo(tab), params.filter)) emit(profile, { method: 'Target.targetCreated', params: { targetInfo: targetInfo(tab) } });
        return {};
      case 'Target.setAutoAttach':
        if (params.flatten === false) unsupported('Target.setAutoAttach non-flattened sessions');
        if (entry) return invoke(entry.tab, method, params, entry.rawSessionId);
        profile.autoAttach = params.autoAttach === true; profile.autoAttachFilter = params.filter;
        if (profile.autoAttach) for (const tab of publicTargets(profile)) if (!tab.aliases.size && filtered(targetInfo(tab), params.filter)) attachTarget(tab);
        return {};
      case 'Target.createTarget': {
        if (params.browserContextId || params.forTab || params.newWindow) unsupported(method);
        authorize(profile, token.epoch, token.actor, message);
        const tab = makeTarget(profile, typeof params.url === 'string' ? params.url : 'about:blank');
        token.createdTab = tab;
        try {
          await tab.identityPromise;
          if (token.cancelled) throw failure('Native target creation was cancelled');
          authorize(profile, token.epoch, token.actor, message);
          if (tab.url !== 'about:blank') await tab.wc.loadURL(tab.url);
        }
        catch (error) { removeTarget(tab, true); throw error; }
        return { targetId: tab.id };
      }
      case 'Target.attachToTarget':
        if (params.flatten === false) unsupported('Target.attachToTarget non-flattened sessions');
        return { sessionId: attachTarget(target(profile, params.targetId)) };
      case 'Target.detachFromTarget': {
        const attached = profile.sessions.get(params.sessionId);
        if (!attached) throw failure('Session does not belong to this native profile');
        if (attached.rawSessionId) await invoke(attached.tab, method, { sessionId: attached.rawSessionId }, attached.parentSessionId ? profile.sessions.get(attached.parentSessionId)?.rawSessionId : undefined);
        if (profile.sessions.has(params.sessionId)) detachSession(profile, params.sessionId);
        return {};
      }
      case 'Target.closeTarget': removeTarget(target(profile, params.targetId), true); return { success: true };
      case 'Target.activateTarget': return activate(target(profile, params.targetId));
      default: unsupported(method);
    }
  }
  async function storageCommand(profile, method, params) {
    if (params.browserContextId) throw failure('Browser context does not belong to this native profile');
    const session = profile.session;
    switch (method) {
      case 'Storage.getCookies': {
        if (typeof session.cookies?.get !== 'function') unsupported(method);
        const cookies = await session.cookies.get({});
        return { cookies: cookies.map(cookie => ({
          name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
          expires: cookie.expirationDate ?? -1, size: Buffer.byteLength(cookie.name + cookie.value),
          httpOnly: cookie.httpOnly === true, secure: cookie.secure === true, session: cookie.session === true,
          sameSite: { no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[cookie.sameSite] ?? 'None', priority: 'Medium',
          sourceScheme: cookie.secure ? 'Secure' : 'NonSecure', sourcePort: cookie.secure ? 443 : 80,
        })) };
      }
      case 'Storage.setCookies': {
        if (typeof session.cookies?.set !== 'function') unsupported(method);
        if (!Array.isArray(params.cookies)) throw failure('Invalid cookies', -32602);
        const cookies = params.cookies.map(cookie => {
          if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') throw failure('Invalid cookie', -32602);
          if (cookie.partitionKey !== undefined) unsupported('Storage.setCookies partitioned cookie');
          const url = cookie.url ?? `${cookie.secure ? 'https' : 'http'}://${String(cookie.domain ?? '').replace(/^\./, '')}${cookie.path || '/'}`;
          let parsed;
          try { parsed = new URL(url); } catch { throw failure('Invalid cookie URL', -32602); }
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw failure('Invalid cookie URL', -32602);
          const result = { url, name: cookie.name, value: cookie.value };
          for (const name of ['domain', 'path', 'secure', 'httpOnly']) if (cookie[name] !== undefined) result[name] = cookie[name];
          if (cookie.expires !== undefined && cookie.expires !== -1) result.expirationDate = cookie.expires;
          if (cookie.sameSite !== undefined) {
            result.sameSite = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }[cookie.sameSite];
            if (!result.sameSite) throw failure('Invalid cookie sameSite', -32602);
          }
          return result;
        });
        for (const cookie of cookies) await session.cookies.set(cookie);
        return {};
      }
      case 'Storage.clearCookies':
        if (typeof session.clearStorageData !== 'function') unsupported(method);
        await session.clearStorageData({ storages: ['cookies'] }); return {};
      case 'Storage.clearDataForOrigin': {
        if (typeof session.clearStorageData !== 'function') unsupported(method);
        const location = origin(params.origin);
        if (location === '*') throw failure('A storage origin is required', -32602);
        if (typeof params.storageTypes !== 'string') throw failure('Invalid storage types', -32602);
        const types = params.storageTypes.split(',').map(value => value.trim());
        const mapping = { cookies: 'cookies', file_systems: 'filesystem', indexeddb: 'indexdb', local_storage: 'localstorage',
          websql: 'websql', service_workers: 'serviceworkers', cache_storage: 'cachestorage', shader_cache: 'shadercache' };
        if (!types.includes('all') && types.some(type => !mapping[type])) unsupported(method);
        await session.clearStorageData({ origin: location, ...(types.includes('all') ? {} : { storages: types.map(type => mapping[type]) }) });
        return {};
      }
      default: unsupported(method);
    }
  }
  async function dispatch(profile, message, token) {
    const entry = message.sessionId ? profile.sessions.get(message.sessionId) : null;
    if (message.sessionId && !entry) throw failure('Session does not belong to this native profile');
    if (entry) token.tab = entry.tab;
    if (message.method.startsWith('Browser.')) return browserCommand(profile, message.method, message.params ?? {});
    if (message.method.startsWith('Target.')) return targetCommand(profile, message, entry, token);
    if (message.method.startsWith('Storage.')) return storageCommand(profile, message.method, message.params ?? {});
    if (!entry) unsupported(message.method);
    if (message.params?.browserContextId) throw failure('Browser context does not belong to this native profile');
    if (!PAGE_DOMAINS.has(message.method.split('.')[0]) || message.method === 'Input.setIgnoreInputEvents') unsupported(message.method);
    if (message.method === 'Page.bringToFront') return activate(entry.tab);
    if (message.method === 'Page.setDownloadBehavior') return browserCommand(profile, 'Browser.setDownloadBehavior', message.params ?? {});
    prepareSurface(entry.tab);
    return invoke(entry.tab, message.method, message.params ?? {}, entry.rawSessionId, neutral(message));
  }
  async function send(input) {
    let message;
    let profile;
    let token;
    let settled = false;
    const reply = body => {
      if (settled) return;
      settled = true;
      const envelope = { id: message?.id ?? null, ...(message?.sessionId ? { sessionId: message.sessionId } : {}), ...body };
      emit(profile ?? { id: input.profileId }, envelope);
    };
    try {
      try { message = JSON.parse(input.message); } catch { throw failure('Invalid CDP JSON', -32700); }
      if (!message || !Number.isInteger(message.id) || typeof message.method !== 'string' || message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) throw failure('Invalid CDP command', -32600);
      alive(); profile = record(input.profileId);
      const actor = input.actor ?? { kind: 'agent' };
      if (actor.kind === 'viewer') identifier(actor.viewerId, 'viewerId');
      authorize(profile, input.epoch, actor, message);
      if (message.method === 'Browser.close') {
        reply({ result: {} }); await closeRecord(profile, 'browser-close'); return;
      }
      let cancel;
      const cancellation = new Promise((_resolve, reject) => { cancel = reject; });
      token = { actor, epoch: input.epoch, cancelled: false, cancel: error => {
        if (token.cancelled) return;
        token.cancelled = true;
        cancel(error);
        if (token.createdTab) removeTarget(token.createdTab, true);
      } };
      profile.pending.add(token);
      const result = await Promise.race([dispatch(profile, message, token), cancellation]);
      authorize(profile, input.epoch, actor, message);
      reply({ result: result ?? {} });
    } catch (error) {
      if (token?.createdTab) removeTarget(token.createdTab, true);
      reply({ error: { code: Number.isInteger(error.code) ? error.code : -32000, message: String(error.message || error) } });
    } finally { if (token) profile.pending.delete(token); }
  }
  async function clearSession(session) {
    const outcomes = await Promise.allSettled(['clearStorageData', 'clearAuthCache', 'clearCache'].map(name => Promise.resolve().then(() => session[name]?.())));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
  function closeRecord(profile, reason, notify = true) {
    if (profile.closePromise) return profile.closePromise;
    profile.closed = true; profile.phase = 'closing';
    advance(profile, 'Native browser profile closed');
    for (const tab of profile.targets.values()) removeTarget(tab, true);
    profile.closePromise = (async () => {
      try {
        await profile.sessionPromise.catch(() => {});
        discard(profile.cleanup);
        for (const item of profile.downloads.values()) { try { item.cancel(); } catch {} }
        for (const cleanup of profile.downloadCleanup.values()) discard(cleanup);
        profile.downloads.clear(); profile.downloadCleanup.clear();
        if (profile.session) {
          await profile.session.cookies?.flushStore?.();
          if (!profile.persistent) await clearSession(profile.session);
        }
      } finally {
        if (profiles.get(profile.id) === profile) profiles.delete(profile.id);
        if (profile.renderOwner) {
          try { if (!profile.renderOwner.isDestroyed?.()) profile.renderOwner.destroy(); } catch {}
          renderOwners.delete(profile.renderOwner);
        }
        if (notify) { try { options.onClose?.(profile.id, reason); } catch {} }
      }
    })();
    return profile.closePromise;
  }
  async function close(profileId) {
    identifier(profileId, 'profileId');
    const profile = profiles.get(profileId);
    if (profile) await closeRecord(profile, 'closed');
  }
  async function erase(profileId) {
    identifier(profileId, 'profileId');
    const profile = profiles.get(profileId);
    if (profile) await closeRecord(profile, 'erased');
    const known = knownSessions.get(profileId);
    if (known && (!profile || profile.persistent)) await clearSession(known.session);
  }
  function destroy() {
    if (destroyPromise) return destroyPromise;
    destroyed = true;
    destroyPromise = (async () => {
      const outcomes = await Promise.allSettled([...profiles.values()].map(profile => closeRecord(profile, 'pool-destroyed')));
      for (const owner of renderOwners) { try { if (owner !== options.getOwner() && !owner.isDestroyed?.()) owner.destroy(); } catch {} }
      renderOwners.clear();
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return destroyPromise;
  }
  return { open, send, lease, layout, close, erase, destroy };
}
