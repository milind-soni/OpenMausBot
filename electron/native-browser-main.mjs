import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createNativeBrowserPool } from './native-browser-pool.mjs';
const PROFILE = /^[a-f0-9]{64}$/;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
export function createNativeBrowserCoordinator(options) {
    const { ipcMain, session, getOwner, isLocalOwner, userData, readFile, product } = options;
    let current = null;
    const profiles = new Map(), sessions = new Map(), grants = new Map();
    const internal = new Map();
    let nextInternal = 0;
    const watched = new WeakSet();
    const snapshots = join(userData, 'native-browser-tabs');
    const send = (proc, message) => { try {
        proc?.postMessage(message);
    }
    catch { } };
    const notify = (profileId, message) => send(profiles.get(profileId)?.proc, { profileId, ...message });
    const snapshotFile = profileId => join(snapshots, profileId + '.json');
    function saveTabs(p) {
        if (!p.persistent)
            return;
        const tabs = [...p.tabs.values()].filter(t => /^https?:\/\//i.test(t.url)).slice(0, 8).map(t => { const url = new URL(t.url); url.username = ''; url.password = ''; return { url: url.href.slice(0, 8192), selected: t.targetId === p.selected }; });
        mkdirSync(snapshots, { recursive: true, mode: 0o700 });
        const dest = snapshotFile(p.id), tmp = dest + '.pending';
        writeFileSync(tmp, JSON.stringify({ version: 1, tabs }), { mode: 0o600 });
        renameSync(tmp, dest);
    }
    function remember(profileId, text) {
        const p = profiles.get(profileId);
        if (!p)
            return;
        let m;
        try {
            m = JSON.parse(text);
        }
        catch {
            return;
        }
        if (typeof m.id === 'number') {
            const local = internal.get(profileId + ':' + m.id);
            if (local) {
                internal.delete(profileId + ':' + m.id);
                clearTimeout(local.timer);
                if (m.error)
                    local.reject(Error(m.error.message));
                else
                    local.resolve(m.result ?? {});
                return;
            }
            const selected = p.selecting.get(m.id);
            if (selected) {
                p.selecting.delete(m.id);
                if (!m.error)
                    p.selected = selected;
            }
        }
        if (m.method === 'Target.targetDestroyed')
            p.tabs.delete(m.params?.targetId);
        const info = m.params?.targetInfo;
        if (info?.type === 'page' && id(info.targetId) && typeof info.url === 'string') {
            p.tabs.set(info.targetId, { targetId: info.targetId, url: info.url });
            if (m.method === 'Target.attachedToTarget') {
                p.sessionTargets.set(m.params.sessionId, info.targetId);
                p.selected = info.targetId;
            }
        }
    }
    function command(profileId, method, params = {}) {
        const id = --nextInternal;
        return new Promise((resolve, reject) => { const timer = setTimeout(() => { internal.delete(profileId + ':' + id); reject(Error('Native browser restore timed out.')); }, 15000); timer.unref?.(); internal.set(profileId + ':' + id, { resolve, reject, timer }); void pool.send({ profileId, actor: { kind: 'system' }, message: JSON.stringify({ id, method, params }) }); });
    }
    async function sessionForProfile(profileId, settings = { persistent: true }) {
        let ses = sessions.get(profileId);
        if (!ses) {
            ses = session.fromPartition((settings.persistent ? 'persist:' : '') + 'omb-native-' + profileId);
            sessions.set(profileId, ses);
            await ses.protocol.handle('file', async (request) => {
                const p = profiles.get(profileId);
                if (!p || p.proc !== current)
                    return new Response('Unavailable', { status: 403 });
                try {
                    fileURLToPath(request.url);
                }
                catch {
                    return new Response('Invalid file', { status: 400 });
                }
                for (const root of p.fileRoots) {
                    try {
                        const file = await readFile(request.url, [root]);
                        const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[extname(file.path).toLowerCase()] ?? file.mime;
                        return new Response(Readable.toWeb(file.handle.createReadStream({ autoClose: true })), { headers: { 'content-type': mime, 'content-length': String(file.bytes), 'x-content-type-options': 'nosniff' } });
                    }
                    catch { }
                }
                return new Response('This file was not opened from the conversation.', { status: 403 });
            });
        }
        if (settings.proxyPort !== undefined) {
            const port = settings.proxyPort;
            if (!Number.isInteger(port) || port < 1 || port > 65535)
                throw Error('Native browser network gate is unavailable.');
            await ses.setProxy({ proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
        }
        return ses;
    }
    const pool = (options.poolFactory ?? createNativeBrowserPool)({
        createView: (preferences, existing) => {
            const view = new options.WebContentsView({ webPreferences: preferences, ...existing ? { webContents: existing } : {} });
            view.webContents.setWebRTCIPHandlingPolicy?.('disable_non_proxied_udp');
            return view;
        }, sessionForProfile, getOwner, product,
        createRenderOwner: () => new options.BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }),
        onMessage: (profileId, message) => { remember(profileId, message); notify(profileId, { type: 'openmausbot:native-browser-cdp-message', message }); },
        onClose: (profileId) => { notify(profileId, { type: 'openmausbot:native-browser-closed' }); for (const [token, g] of grants)
            if (g.profileId === profileId)
                grants.delete(token); },
        onInput: (profileId, input) => {
            notify(profileId, { type: 'openmausbot:native-browser-input', epoch: input.epoch });
            for (const [token, g] of grants)
                if (g.profileId === profileId && g.targetId === input.targetId && g.viewerId === input.viewerId) {
                    const w = getOwner();
                    if (w && !w.isDestroyed())
                        w.webContents.send('native-browser:take', { token });
                }
        },
        onActivity: (profileId, input) => {
            for (const [token, g] of grants)
                if (g.visible && g.profileId === profileId && g.targetId === input.targetId && g.viewerId === input.viewerId) {
                    const w = getOwner();
                    if (w && !w.isDestroyed())
                        w.webContents.send('native-browser:activity', { token });
                }
        },
        onFocusAddress: (profileId, input) => {
            for (const [token, g] of grants)
                if (g.profileId === profileId && g.targetId === input.targetId && g.viewerId === input.viewerId) {
                    const w = getOwner();
                    if (w && !w.isDestroyed())
                        w.webContents.send('native-browser:focus-address', { token });
                }
        },
    });
    async function closeProfile(profileId) {
        const p = profiles.get(profileId);
        if (!p)
            return;
        if (p.closing)
            return p.closing;
        saveTabs(p);
        p.closing = pool.close(profileId).finally(() => { if (profiles.get(profileId) === p)
            profiles.delete(profileId); const ses = sessions.get(profileId); ses?.protocol.unhandle('file'); sessions.delete(profileId); });
        return p.closing;
    }
    async function request(proc, m) {
        let result;
        const profileId = m.profileId;
        if (m.action === 'open') {
            if (typeof m.persistent !== 'boolean' || !Number.isInteger(m.proxyPort))
                throw Error('Invalid native browser opening.');
            const existing = profiles.get(profileId);
            if (existing && existing.proc !== proc)
                throw Error('Native profile belongs to another server.');
            const p = existing ?? { id: profileId, proc, persistent: m.persistent, tabs: new Map(), sessionTargets: new Map(), selecting: new Map(), selected: null, fileRoots: new Set(), closing: null };
            profiles.set(profileId, p);
            result = await pool.open({ profileId, persistent: m.persistent, proxyPort: m.proxyPort });
            if (!existing && m.persistent && !m.fresh && existsSync(snapshotFile(profileId))) {
                try {
                    const stored = JSON.parse(readFileSync(snapshotFile(profileId), 'utf8'));
                    if (stored.version === 1 && Array.isArray(stored.tabs)) {
                        const tabs = stored.tabs.slice(0, 8).filter(tab => typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url));
                        if (tabs.length) {
                            const before = await command(profileId, 'Target.getTargets');
                            for (const old of before.targetInfos ?? [])
                                await command(profileId, 'Target.closeTarget', { targetId: old.targetId });
                        }
                        for (const tab of tabs) {
                            const created = await command(profileId, 'Target.createTarget', { url: tab.url });
                            if (tab.selected)
                                result.selectedTargetId = created.targetId;
                        }
                    }
                }
                catch { }
            }
        }
        else if (m.action === 'close') {
            const p = profiles.get(profileId);
            if (p && p.proc !== proc)
                throw Error('Native profile belongs to another server.');
            await closeProfile(profileId);
            result = {};
        }
        else if (m.action === 'ungrant') {
            const g = grants.get(m.token);
            if (g && g.proc === proc && g.profileId === profileId) {
                if (g.visible)
                    pool.layout({ ...g, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
                grants.delete(m.token);
            }
            result = {};
        }
        else if (m.action === 'erase') {
            const p = profiles.get(profileId);
            if (p && p.proc !== proc)
                throw Error('Native profile belongs to another server.');
            if (p)
                await closeProfile(profileId);
            const ses = await sessionForProfile(profileId, { persistent: true });
            await ses.clearStorageData();
            await ses.clearAuthCache();
            await ses.clearCache();
            ses.flushStorageData();
            ses.protocol.unhandle('file');
            sessions.delete(profileId);
            if (existsSync(snapshotFile(profileId)))
                unlinkSync(snapshotFile(profileId));
            result = {};
        }
        else {
            const p = profiles.get(profileId);
            if (!p || p.proc !== proc)
                throw Error('Native profile belongs to another server.');
            if (m.action === 'lease') {
                result = { epoch: pool.lease({ profileId, viewerId: m.viewerId, ready: m.ready === true }) };
            }
            else if (m.action === 'grant') {
                if (!id(m.targetId) || !p.tabs.has(m.targetId) || !id(m.viewerId) || !id(m.viewId) || typeof m.canOperate !== 'boolean')
                    throw Error('Invalid native browser view.');
                const token = randomUUID();
                grants.set(token, { proc, profileId, targetId: m.targetId, viewerId: m.viewerId, viewId: m.viewId, canOperate: m.canOperate, visible: false });
                result = { token };
            }
            else if (m.action === 'authorize-file') {
                if (typeof m.path !== 'string' || !Array.isArray(m.roots))
                    throw Error('Invalid native artifact.');
                const file = await readFile(m.path, m.roots);
                try {
                    if (file.mime.split(';', 1)[0] !== 'text/html')
                        throw Error('Only HTML opens as a native artifact.');
                    p.fileRoots.add(dirname(file.path));
                    result = { url: pathToFileURL(file.path).href };
                }
                finally {
                    await file.handle.close();
                }
            }
            else
                throw Error('Unsupported native browser operation.');
        }
        send(proc, { type: 'openmausbot:native-browser-result', id: m.id, profileId, result });
    }
    function receive(proc, value) {
        const m = record(value);
        if (proc !== current || !m || typeof m.type !== 'string' || !m.type.startsWith('openmausbot:native-browser-'))
            return false;
        if (typeof m.profileId !== 'string' || !PROFILE.test(m.profileId))
            return true;
        if (m.type === 'openmausbot:native-browser-request' && id(m.id))
            void request(proc, m).catch(error => send(proc, { type: 'openmausbot:native-browser-result', id: m.id, profileId: m.profileId, error: String(error?.message ?? error) }));
        else if (m.type === 'openmausbot:native-browser-cdp') {
            const p = profiles.get(m.profileId);
            if (!p || p.proc !== proc)
                return true;
            let command;
            try {
                command = JSON.parse(m.message);
            }
            catch {
                return true;
            }
            if (command.method === 'Browser.close' && !command.sessionId) {
                void closeProfile(m.profileId);
                return true;
            }
            if (command.method === 'Page.bringToFront' && p.sessionTargets.has(command.sessionId))
                p.selecting.set(command.id, p.sessionTargets.get(command.sessionId));
            void pool.send(m);
        }
        return true;
    }
    function hide() { for (const g of grants.values())
        if (g.visible) {
            pool.layout({ ...g, bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
            g.visible = false;
        } }
    function owner(event) { const w = getOwner(); if (!w || w.isDestroyed() || event.sender !== w.webContents || !isLocalOwner(event))
        throw Error('Native browser layout belongs to the local app window.'); if (!watched.has(w)) {
        watched.add(w);
        w.webContents.on('did-start-navigation', (_event, _url, inPlace, isMain) => { if (isMain && !inPlace)
            hide(); });
        w.once('closed', hide);
    } }
    ipcMain.handle('native-browser:layout', (event, input) => {
        owner(event);
        const g = grants.get(input?.token);
        if (!g || g.proc !== current)
            throw Error('This native browser view has expired.');
        pool.layout({ ...g, bounds: input.bounds, visible: input.visible === true, canTake: g.canOperate, canInput: g.canOperate && input.canInput === true });
        g.visible = input.visible === true;
        const p = profiles.get(g.profileId);
        if (g.visible && p)
            p.selected = g.targetId;
    });
    return { receive, get available() { return current !== null; },
        attach(proc) { current = proc; send(proc, { type: 'openmausbot:native-browser-ready', protocol: 1, product }); },
        reject(proc) { if (current === proc)
            current = null; for (const p of profiles.values())
            if (p.proc === proc)
                void closeProfile(p.id); },
        hide,
        async destroy() { current = null; await Promise.all([...profiles.keys()].map(closeProfile)); await pool.destroy(); ipcMain.removeHandler('native-browser:layout'); },
    };
}
