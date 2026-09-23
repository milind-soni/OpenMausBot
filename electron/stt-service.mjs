import path from 'node:path';
import { app, safeStorage, dialog, BrowserWindow } from 'electron';
import { PROVIDERS, publicConfig, transcribeCloud, transcribeLocal, createRequestRegistry } from './stt-core.mjs';
import { createSttSettings } from './stt-settings.mjs';
import { createLocalModels } from './stt-local.mjs';
export function registerStt({ ipcMain, localOnly }) {
    const root = path.join(app.getPath('userData'), 'transcription');
    const settings = createSttSettings(root, safeStorage), load = settings.load;
    const local = createLocalModels(root), registry = createRequestRegistry();
    async function state() { const cfg = await load(); return { config: publicConfig(cfg), providers: PROVIDERS.filter(p => !p.platforms || p.platforms.includes(process.platform)), local: await local.state(cfg) }; }
    const handle = (name, fn) => ipcMain.handle(name, localOnly(name, fn));
    handle('stt:settings', () => state());
    handle('stt:save', async (_e, input) => { await settings.save(input); return state(); });
    handle('stt:install', async (_e, request) => {
        const cfg = await load();
        return local.install(request.id, { ...cfg, executable: typeof request.executable === 'string' ? request.executable : cfg.executable });
    });
    handle('stt:pick-engine', async (event) => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: 'Select whisper-cli', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Speech engine', extensions: ['exe'] }] } : {}) });
        return result.canceled ? null : result.filePaths[0];
    });
    const watched = new WeakSet();
    handle('stt:begin', async (event) => {
        const cfg = structuredClone(await load()), provider = PROVIDERS.find(p => p.id === cfg.provider);
        if (cfg.provider === 'whisper-local') {
            const status = await local.state(cfg);
            if (!status.runtimeReady || !status.models.find(m => m.id === cfg.localModel)?.installed)
                throw Error('Download the selected model in Transcription settings first.');
        }
        else if (provider.kind === 'audio') {
            const profile = cfg.profiles[cfg.provider];
            if (!profile?.key && cfg.provider !== 'compatible')
                throw Error('Add an API key in Transcription settings first.');
            if (['azure', 'compatible'].includes(cfg.provider) && !profile?.endpoint)
                throw Error('Add the service endpoint in Transcription settings first.');
            if (cfg.provider === 'azure' && cfg.language === 'auto')
                throw Error('Choose the spoken language for Azure Speech.');
        }
        if (!watched.has(event.sender)) {
            watched.add(event.sender);
            const owner = event.sender.id;
            event.sender.once('destroyed', () => registry.cancel(owner));
        }
        return { id: registry.begin(event.sender.id, cfg), provider: provider.id, kind: provider.kind, language: cfg.language };
    });
    handle('stt:cancel', (event, id) => registry.cancel(event.sender.id, id));
    handle('stt:transcribe', async (event, { id, pcm }) => {
        const s = registry.get(event.sender.id, id);
        if (s.busy)
            throw Error('A speech segment is still processing.');
        if (!(pcm instanceof ArrayBuffer) && !ArrayBuffer.isView(pcm))
            throw Error('Invalid audio.');
        s.busy = true;
        const deadline = AbortSignal.timeout(120000), signal = AbortSignal.any([s.controller.signal, deadline]);
        try {
            const text = s.cfg.provider === 'whisper-local' ? await transcribeLocal(s.cfg, pcm, { executable: await local.executable(s.cfg), modelPath: local.modelPath(s.cfg.localModel), signal }) : await transcribeCloud(s.cfg, pcm, signal);
            registry.get(event.sender.id, id);
            return { text };
        }
        finally {
            s.busy = false;
        }
    });
    return { load };
}
