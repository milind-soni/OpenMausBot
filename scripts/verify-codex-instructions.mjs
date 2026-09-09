// Optional native protocol smoke: requires a Codex binary, no credentials.
// Synthetic model responses verify request shape, not model quality or token cost.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
const root = mkdtempSync(join(tmpdir(), 'omb-native-instructions-'));
process.env.OMB_DATA_DIR = join(root, 'omb');
const { codexDeveloperInstructions, syncCodexInstructions } = await import('../server/drivers/codex-instructions.ts');
const captures = [];
const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req)
        raw += c;
    let body;
    try {
        body = JSON.parse(raw);
    }
    catch {
        body = { raw };
    }
    captures.push({ url: req.url, body });
    const item = { id: 'msg_' + captures.length, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture reply; remembered code ALPHA.', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
        { type: 'response.created', response: { id: 'resp_' + captures.length, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_' + captures.length, status: 'completed', output: [item] } }
    ])
        res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const home = join(root, 'home');
const cwd = join(root, 'cwd');
mkdirSync(home);
mkdirSync(cwd);
writeFileSync(join(home, 'config.toml'), `developer_instructions="NATIVE_RULE: Preserve configured instructions."\nmodel="gpt-5.6-sol"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
let child, seq = 0, pending, events, waiters;
async function start() {
    pending = new Map();
    events = [];
    waiters = [];
    child = spawn(process.env.PROBE_CODEX ?? 'codex', ['app-server'], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', c => writeFileSync(join(root, 'stderr.log'), c, { flag: 'a' }));
    createInterface({ input: child.stdout }).on('line', line => { let m; try {
        m = JSON.parse(line);
    }
    catch {
        return;
    } ; if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
    }
    else {
        events.push(m);
        for (const w of waiters)
            if (w.method === m.method)
                w.resolve(m);
    } });
    await rpc('initialize', { clientInfo: { name: 'omb-instruction-probe', version: '1' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
}
function rpc(method, params) { return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }); }
function event(method) { const found = events.find(m => m.method === method); return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ method, resolve })); }
async function stop() { child.kill('SIGTERM'); await once(child, 'exit'); }
const timeout = setTimeout(() => { child?.kill(); server.close(); console.error('probe timeout', root); process.exit(1); }, 60000);
let cursor;
try {
    for (const [index, instructions] of [...Array(5).fill('BOT_RULE_A: You are Testy. Always answer briefly.'), 'BOT_RULE_B: You are Renamed. Use new rules.', 'BOT_RULE_B: You are Renamed. Use new rules.', '', ''].entries()) {
        await start();
        const configured = await rpc('config/read', { cwd, includeLayers: false });
        const developerInstructions = codexDeveloperInstructions(configured.config, instructions);
        const method = cursor ? 'thread/resume' : 'thread/start';
        const t = await rpc(method, { ...(cursor ? { threadId: cursor } : { cwd, model: 'gpt-5.6-sol', ephemeral: false }), ...(process.env.PROBE_BEFORE ? {} : { developerInstructions }), approvalPolicy: 'never', sandbox: 'read-only' });
        cursor = t.thread.id;
        if (!process.env.PROBE_BEFORE)
            await syncCodexInstructions("native-probe", cursor, developerInstructions, index > 0, rpc);
        await rpc('turn/start', { threadId: cursor, input: [{ type: 'text', text: (process.env.PROBE_BEFORE ? instructions + '\n\n' : '') + (index === 0 ? 'Remember ALPHA.' : 'Continue ' + index) }] });
        const completed = await event('turn/completed');
        assert.equal(completed.params?.turn?.status, 'completed');
        console.log(JSON.stringify({ index, method, status: completed.params?.turn?.status, captures: captures.length }));
        if (index === 5 || index === 7) {
            events = [];
            await rpc('thread/compact/start', { threadId: cursor });
            const compacted = await event('turn/completed');
            console.log('compaction', JSON.stringify(compacted));
        }
        await stop();
    }
    const text = (index, role) => (captures[index].body.input ?? []).filter(item => item.role === role).flatMap(item => item.content ?? []).map(part => part.text ?? '').join('\n');
    for (let i = 0; i < captures.length; i++) {
        assert(text(i, 'developer').includes('NATIVE_RULE: Preserve configured instructions.'));
        assert(!text(i, 'user').includes('NATIVE_RULE'));
    }
    if (!process.env.PROBE_BEFORE) {
        for (let i = 0; i < captures.length; i++) {
            assert(!text(i, 'user').includes('BOT_RULE_'));
            assert(text(i, 'user').includes('Remember ALPHA.'));
        }
        for (let i = 0; i < 5; i++)
            assert.equal(text(i, 'developer').split('BOT_RULE_A').length - 1, 1);
        assert(text(5, 'developer').includes('BOT_RULE_B'));
        assert(text(5, 'developer').indexOf('BOT_RULE_B') > text(5, 'developer').indexOf('BOT_RULE_A'));
        assert(!text(7, 'developer').includes('BOT_RULE_A') && text(7, 'developer').includes('BOT_RULE_B'));
        assert(text(8, 'developer').includes('No OpenMausBot bot-specific instructions remain.'));
        assert(!text(10, 'developer').includes('BOT_RULE_'));
    }
    else {
        for (let i = 0; i < 5; i++)
            assert.equal(text(i, 'user').split('BOT_RULE_A').length - 1, i + 1);
    }
    console.log('Native instruction assertions passed.');
}
finally {
    clearTimeout(timeout);
    if (child && child.exitCode === null && child.signalCode === null) await stop();
    server.close();
    writeFileSync(join(root, 'captures.json'), JSON.stringify(captures, null, 2));
    console.log(root);
    for (const [index, c] of captures.entries()) {
        const input = c.body.input ?? [];
        const text = role => JSON.stringify(input.filter(x => x.role === role));
        const count = (s, marker) => s.split(marker).length - 1;
        console.log(JSON.stringify({ request: index + 1, userA: count(text('user'), 'BOT_RULE_A'), developerA: count(text('developer'), 'BOT_RULE_A'), userB: count(text('user'), 'BOT_RULE_B'), developerB: count(text('developer'), 'BOT_RULE_B') }));
    }
}
