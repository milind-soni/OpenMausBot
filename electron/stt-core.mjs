import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
export const PROVIDERS = [
    { id: 'openrouter', name: 'OpenRouter', kind: 'audio', model: 'openai/whisper-large-v3', help: 'Sends audio to OpenRouter using your API key and OpenRouter credits.' },
    { id: 'windows-typing', name: 'Windows voice typing · Win+H', platforms: ['win32'], kind: 'system', help: 'Opens Windows’ own voice typing panel. Use its microphone to stop. Requires internet.' },
    { id: 'apple-speech', name: 'macOS speech recognition', platforms: ['darwin'], kind: 'native', help: 'Uses Apple’s speech recognition and the existing microphone controls.' },
    { id: 'whisper-local', name: 'Local Whisper', kind: 'audio', help: 'Offline transcription. Download a model once. Uses your CPU only when processing speech; fewer threads reduce peak load.' },
    { id: 'openai', name: 'OpenAI', kind: 'audio', model: 'gpt-4o-transcribe', help: 'Sends audio to OpenAI. Uses an API key and separate API billing, not your ChatGPT subscription.' },
    { id: 'groq', name: 'Groq', kind: 'audio', model: 'whisper-large-v3-turbo', help: 'Sends audio to Groq using your API key.' },
    { id: 'deepgram', name: 'Deepgram', kind: 'audio', model: 'nova-3', help: 'Sends audio to Deepgram using your API key. Automatic language detection is available.' },
    { id: 'azure', name: 'Azure Speech', kind: 'audio', help: 'Sends audio to your Azure Speech resource. Select the spoken language and enter the resource endpoint and key.' },
    { id: 'compatible', name: 'Custom OpenAI-compatible service', kind: 'audio', model: 'whisper-1', help: 'Connect a local server or cloud service that implements the audio/transcriptions API.' }
];
export function defaults(platform = process.platform) {
    return { version: 1, provider: platform === 'win32' ? 'windows-typing' : platform === 'darwin' ? 'apple-speech' : 'whisper-local', language: 'auto', profiles: {}, localModel: 'base', threads: 2, accelerate: false, executable: '' };
}
export function validateConfig(input, platform = process.platform) {
    const cfg = { ...defaults(platform), ...input };
    if (['windows-sapi', 'windows-speech'].includes(cfg.provider))
        cfg.provider = defaults(platform).provider;
    const p = PROVIDERS.find(p => p.id === cfg.provider);
    if (!p || p.platforms && !p.platforms.includes(platform))
        throw Error('This provider is not available on this system.');
    if (!/^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(cfg.language))
        throw Error('Choose a valid speech language.');
    if (!['base', 'small', 'turbo'].includes(cfg.localModel))
        throw Error('Unknown local model.');
    if (!Number.isInteger(cfg.threads) || cfg.threads < 1 || cfg.threads > 16)
        throw Error('CPU threads must be between 1 and 16.');
    cfg.accelerate = cfg.accelerate === true;
    cfg.executable = String(cfg.executable || '').slice(0, 4096);
    const profiles = {};
    for (const p of PROVIDERS.filter(p => p.model || p.id === 'azure')) {
        const v = cfg.profiles?.[p.id] || {};
        profiles[p.id] = { model: String(v.model || p.model || '').trim().slice(0, 160), endpoint: String(v.endpoint || '').trim().slice(0, 2048), key: String(v.key || '').trim().slice(0, 4096) };
        if (profiles[p.id].endpoint)
            validateEndpoint(profiles[p.id].endpoint);
        if (p.id === 'azure' && profiles[p.id].endpoint && !new URL(profiles[p.id].endpoint).hostname.endsWith('.cognitiveservices.azure.com') && !new URL(profiles[p.id].endpoint).hostname.endsWith('.stt.speech.microsoft.com'))
            throw Error('Use your Azure Speech resource endpoint.');
    }
    return { version: 1, provider: cfg.provider, language: cfg.language, profiles, localModel: cfg.localModel, threads: cfg.threads, accelerate: cfg.accelerate, executable: cfg.executable };
}
export function validateEndpoint(value) {
    let u;
    try {
        u = new URL(value);
    }
    catch {
        throw Error('Enter a valid service URL.');
    }
    if (u.username || u.password || u.hash || u.search)
        throw Error('The service URL cannot contain credentials, a query, or a fragment.');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
        throw Error('Use HTTPS, or HTTP for a local server.');
    return u;
}
export function publicConfig(cfg) {
    return { ...cfg, profiles: Object.fromEntries(Object.entries(cfg.profiles || {}).map(([k, v]) => [k, { model: v.model, endpoint: v.endpoint, hasKey: !!v.key }])) };
}
export function mergePublicConfig(current, input) {
    const merged = { ...current, ...input, profiles: { ...current.profiles } };
    for (const p of PROVIDERS) {
        if (input.profiles?.[p.id]) {
            const v = input.profiles[p.id];
            merged.profiles[p.id] = { ...current.profiles[p.id], ...v, key: v.clearKey ? '' : v.key || current.profiles[p.id]?.key || '' };
        }
    }
    return merged;
}
export function pcmToWav(raw) {
    const pcm = ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : Buffer.from(raw);
    if (pcm.length < 320 || pcm.length > 16000 * 2 * 35 || pcm.length % 2)
        throw Error('Invalid audio chunk.');
    const h = Buffer.alloc(44);
    h.write('RIFF');
    h.writeUInt32LE(pcm.length + 36, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(16000, 24);
    h.writeUInt32LE(32000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}
export async function transcribeCloud(cfg, raw, signal, fetchImpl = fetch) {
    const p = PROVIDERS.find(p => p.id === cfg.provider), profile = cfg.profiles[cfg.provider] || {};
    if (!profile.key && cfg.provider !== 'compatible')
        throw Error('Add an API key in Transcription settings.');
    const wav = pcmToWav(raw), lang = cfg.language === 'auto' ? null : cfg.language;
    let url, body, headers;
    if (cfg.provider === 'deepgram') {
        url = new URL('https://api.deepgram.com/v1/listen');
        url.searchParams.set('model', profile.model || p.model);
        url.searchParams.set('smart_format', 'true');
        url.searchParams.set(lang ? 'language' : 'detect_language', lang ? lang.split('-')[0] : 'true');
        body = wav;
        headers = { 'Authorization': `Token ${profile.key}`, 'Content-Type': 'audio/wav' };
    }
    else if (cfg.provider === 'azure') {
        if (!profile.endpoint)
            throw Error('Add your Azure Speech endpoint.');
        if (!lang)
            throw Error('Azure Speech needs an explicit language, such as de-DE or en-US.');
        url = validateEndpoint(profile.endpoint);
        url.pathname = url.hostname.endsWith('.cognitiveservices.azure.com') ? '/stt/speech/recognition/conversation/cognitiveservices/v1' : '/speech/recognition/conversation/cognitiveservices/v1';
        url.searchParams.set('language', lang);
        url.searchParams.set('format', 'simple');
        body = wav;
        headers = { 'Ocp-Apim-Subscription-Key': profile.key, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000' };
    }
    else {
        const base = cfg.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : cfg.provider === 'openai' ? 'https://api.openai.com/v1' : cfg.provider === 'groq' ? 'https://api.groq.com/openai/v1' : profile.endpoint;
        if (!base)
            throw Error('Add the transcription service URL.');
        url = validateEndpoint(base);
        url.pathname = url.pathname.replace(/\/$/, '').replace(/\/audio\/transcriptions$/, '') + '/audio/transcriptions';
        body = new FormData();
        body.set('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
        body.set('model', profile.model || p.model);
        body.set('response_format', 'json');
        if (lang)
            body.set('language', lang.split('-')[0]);
        headers = profile.key ? { Authorization: `Bearer ${profile.key}` } : {};
    }
    let response;
    try {
        response = await fetchImpl(url, { method: 'POST', headers, body, signal, redirect: 'error' });
    }
    catch {
        if (signal?.aborted)
            throw Error('Transcription canceled.');
        throw Error('Could not reach the transcription service. Check its address and your connection.');
    }
    if (!response.ok)
        throw Error(response.status === 401 || response.status === 403 ? 'The transcription service rejected the API key.' : response.status === 429 ? 'The transcription service is rate limited or has no remaining credit.' : `Transcription service returned HTTP ${response.status}.`);
    let result;
    try {
        result = await response.json();
    }
    catch {
        throw Error('The transcription service returned an invalid response.');
    }
    if (cfg.provider === 'azure' && result.RecognitionStatus && !['Success', 'NoMatch', 'InitialSilenceTimeout'].includes(result.RecognitionStatus))
        throw Error('Azure could not recognize this recording.');
    const text = cfg.provider === 'deepgram' ? result.results?.channels?.[0]?.alternatives?.[0]?.transcript : cfg.provider === 'azure' ? result.DisplayText ?? (['NoMatch', 'InitialSilenceTimeout'].includes(result.RecognitionStatus) ? '' : undefined) : result.text;
    if (typeof text !== 'string')
        throw Error('The transcription service returned no transcript field.');
    return text.trim();
}
export function runProcess(exe, args, { signal, timeout = 120000, maxOutput = 2e6, cwd } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(Error('Transcription canceled.'));
        const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd });
        let out = '', err = '', done = false, stopError = null;
        const finish = (error, result) => { if (done)
            return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (error)
            reject(error);
        else
            resolve(result); };
        const cancel = () => { stopError = Error('Transcription canceled.'); child.kill(); };
        const timer = setTimeout(() => { stopError = Error('Local transcription timed out. Try a smaller model.'); child.kill(); }, timeout);
        signal?.addEventListener('abort', cancel, { once: true });
        child.stdout.on('data', b => { out += b; if (out.length > maxOutput)
            cancel(); });
        child.stderr.on('data', b => { err = (err + b).slice(-4000); });
        child.on('error', () => finish(Error('The local speech engine could not start. Check its installation.')));
        child.on('close', code => finish(stopError || (code !== 0 ? Error(`The local speech engine exited (${code}).`) : null), { stdout: out, stderr: err }));
    });
}
export async function transcribeLocal(cfg, raw, { executable, modelPath, signal, tempRoot = os.tmpdir() }) {
    const dir = await fs.mkdtemp(path.join(tempRoot, 'openmaus-stt-'));
    try {
        const audio = path.join(dir, 'input.wav'), output = path.join(dir, 'result');
        await fs.writeFile(audio, pcmToWav(raw), { mode: 0o600 });
        const args = ['-m', modelPath, '-f', audio, '-l', cfg.language === 'auto' ? 'auto' : cfg.language.split('-')[0], '-t', String(cfg.threads), '-nt', '-otxt', '-of', output];
        if (!cfg.accelerate)
            args.push('-ng');
        await runProcess(executable, args, { signal, cwd: path.dirname(executable) });
        return (await fs.readFile(output + '.txt', 'utf8')).trim();
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
export function createRequestRegistry() {
    const sessions = new Map();
    return {
        begin(owner, cfg) { this.cancel(owner); const id = randomUUID(); sessions.set(owner, { id, cfg, controller: new AbortController(), busy: false }); return id; },
        get(owner, id) { const s = sessions.get(owner); if (!s || s.id !== id || s.controller.signal.aborted)
            throw Error('This transcription session has ended.'); return s; },
        cancel(owner, id) { const s = sessions.get(owner); if (s && (!id || s.id === id)) {
            s.controller.abort();
            sessions.delete(owner);
        } }
    };
}
