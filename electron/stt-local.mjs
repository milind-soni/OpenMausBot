import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runProcess } from './stt-core.mjs';
export const MODELS = [
    { id: 'base', name: 'Base · 148 MB', file: 'ggml-base.bin', size: 147951465, sha: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
    { id: 'small', name: 'Small · 488 MB', file: 'ggml-small.bin', size: 487601967, sha: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
    { id: 'turbo', name: 'Large v3 Turbo · 574 MB', file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195, sha: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' }
];
export async function downloadVerified(url, target, { size, sha, progress = () => { } }) {
    const part = target + '.' + randomUUID() + '.part';
    await fs.mkdir(path.dirname(target), { recursive: true });
    const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!response.ok || !response.body)
        throw Error(`Download failed (HTTP ${response.status}).`);
    const hash = createHash('sha256');
    let received = 0;
    const handle = await fs.open(part, 'wx', 0o600);
    try {
        for await (const chunk of response.body) {
            received += chunk.length;
            if (received > size)
                throw Error('Downloaded file exceeded its expected size.');
            hash.update(chunk);
            await handle.writeFile(chunk);
            progress(received / size);
        }
        if (received !== size || hash.digest('hex') !== sha)
            throw Error('Downloaded file failed its integrity check.');
        await handle.close();
        await fs.rename(part, target);
    }
    catch (e) {
        await handle.close().catch(() => { });
        await fs.rm(part, { force: true });
        throw e;
    }
}
async function findBinary(dir, name) {
    if (!existsSync(dir))
        return null;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === name)
            return full;
        if (entry.isDirectory()) {
            const f = await findBinary(full, name);
            if (f)
                return f;
        }
    }
    return null;
}
export function createLocalModels(root, { platform = process.platform, arch = process.arch } = {}) {
    let installing = false, progress = null;
    const modelPath = id => path.join(root, 'models', MODELS.find(m => m.id === id)?.file || 'unknown');
    async function executable(cfg) {
        if (cfg.executable && existsSync(cfg.executable))
            return cfg.executable;
        const bundled = await findBinary(path.join(root, 'runtime'), platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
        if (bundled)
            return bundled;
        for (const p of ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli'])
            if (platform !== 'win32' && existsSync(p))
                return p;
        return null;
    }
    async function state(cfg) {
        const exe = await executable(cfg);
        return { models: await Promise.all(MODELS.map(async (m) => ({ ...m, installed: (await fs.stat(modelPath(m.id)).catch(() => null))?.size === m.size }))), runtimeReady: !!exe, executable: exe || '', installing, progress, canDownloadRuntime: ['win32', 'linux'].includes(platform) && ['x64', 'arm64'].includes(arch) };
    }
    async function install(id, cfg) {
        if (installing)
            throw Error('A local model download is already running.');
        const model = MODELS.find(m => m.id === id);
        if (!model)
            throw Error('Unknown local model.');
        installing = true;
        progress = { label: 'Preparing download', percent: 0 };
        try {
            if (!(await executable(cfg))) {
                const name = platform === 'win32' ? (arch === 'x64' ? 'whisper-bin-x64.zip' : 'whisper-bin-win-cpu-arm64.zip') : `whisper-bin-ubuntu-${arch}.tar.gz`;
                const assets = JSON.parse(await fs.readFile(new URL('./runtime-assets.json', import.meta.url), 'utf8'));
                const asset = assets.find(a => a.name === name);
                if (!['win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || !asset)
                    throw Error('Choose an installed whisper-cli executable first. On macOS, install whisper-cpp with Homebrew.');
                const archive = path.join(root, name), runtime = path.join(root, 'runtime');
                await downloadVerified(asset.browser_download_url, archive, { size: asset.size, sha: asset.digest.slice(7), progress: p => progress = { label: 'Speech engine', percent: Math.round(p * 100) } });
                await fs.mkdir(runtime, { recursive: true });
                // Only hash-verified upstream archives are extracted into this dedicated directory.
                if (platform === 'win32')
                    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${runtime.replace(/'/g, "''")}' -Force`]);
                else
                    await runProcess('tar', ['-xzf', archive, '-C', runtime]);
                await fs.rm(archive, { force: true });
                if (!(await executable(cfg)))
                    throw Error('The downloaded engine did not contain whisper-cli.');
            }
            if ((await fs.stat(modelPath(id)).catch(() => null))?.size !== model.size) {
                await downloadVerified('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + model.file, modelPath(id), { size: model.size, sha: model.sha, progress: p => progress = { label: model.name, percent: Math.round(p * 100) } });
            }
            progress = null;
            return await state(cfg);
        }
        finally {
            installing = false;
        }
    }
    return { state, install, executable, modelPath };
}
