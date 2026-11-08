// Run with Node 26+ and its default test-file process isolation:
// HERMES_REPAIR_TEST_ROOT=/absolute/hermes/source node --test deploy/hermes/test_whatsapp_repair.mjs
// The root supplies installed code only. All credentials are freshly generated in mkdtemp.
// Based on the runtime regressions in WhiskeySockets/Baileys PR #2765, pinned at
// 042fe1f3ddacf63ac2288837fbc8a395556bbb6e; no helper-export or source-text assertions.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as module from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const REFS = ['repair-ref-1', 'repair-ref-2'];
const QR_LIFETIME = 1000;
const BROWSER = ['Hermes regression', 'Chrome', '1'];
const QR_PREFIX = 'https://wa.me/settings/linked_devices#';

// Only the network transport is substituted. The SDK WebSocketClient, socket
// stack, credential store, crypto, event buffer and binary ACK codec stay real.
// Never emit "open": that would start an unnecessary Noise server handshake.
const fakeTransportURL = `data:text/javascript,${encodeURIComponent(`
import { EventEmitter } from 'node:events';
export default class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = new Set();
    readyState = FakeWebSocket.OPEN;
    frames = [];
    constructor(url) {
        super();
        if (new URL(url).hostname !== 'pairing-regression.invalid') {
            throw new Error('Unexpected WebSocket destination in pairing regression');
        }
        FakeWebSocket.instances.add(this);
    }
    send(data, callback) {
        if (this.readyState !== FakeWebSocket.OPEN) {
            throw new Error('Writing to a closed regression transport');
        }
        this.frames.push(Buffer.from(data));
        callback?.();
    }
    close() {
        if (this.readyState !== FakeWebSocket.CLOSED) {
            this.readyState = FakeWebSocket.CLOSED;
            this.emit('close');
        }
    }
}
`)}`;

const pairDevice = () => ({
    tag: 'iq',
    attrs: { from: 's.whatsapp.net', type: 'set', id: 'repair-pair-device' },
    content: [{
        tag: 'pair-device',
        attrs: {},
        content: REFS.map(ref => ({ tag: 'ref', attrs: {}, content: Buffer.from(ref) })),
    }],
});

const refresh = (child, id = 'repair-refresh') => ({
    tag: 'notification',
    attrs: { from: 's.whatsapp.net', type: 'companion_reg_refresh', id },
    content: child ? [{ tag: child, attrs: {} }] : [],
});

function qrFields(qr) {
    assert.equal(typeof qr, 'string');
    assert.ok(qr.startsWith(QR_PREFIX), 'keep the linked-devices URL QR format');
    const fields = qr.slice(QR_PREFIX.length).split(',');
    assert.equal(fields.length, 5, 'QR must retain all five fields');
    return fields;
}

function expectedAck(node, extra = {}) {
    return {
        tag: 'ack',
        attrs: {
            id: node.attrs.id,
            to: node.attrs.from,
            class: node.tag,
            type: node.attrs.type,
            ...extra,
        },
        content: undefined,
    };
}

test('installed Baileys companion registration repair', { concurrency: false, timeout: 60000 }, async suite => {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 26, 'Node.js 26+ is required');
    assert.equal(typeof module.registerHooks, 'function', 'synchronous ESM hooks are required');
    const root = process.env.HERMES_REPAIR_TEST_ROOT;
    assert.ok(root && isAbsolute(root), 'set HERMES_REPAIR_TEST_ROOT to an absolute installed Hermes source root');
    const sdk = join(root, 'scripts', 'whatsapp-bridge', 'node_modules', '@whiskeysockets', 'baileys');
    const sdkImport = relative => import(pathToFileURL(join(sdk, relative)).href);

    // Fail closed if a changed SDK tries a second network route. This is restored
    // by the test context; no real socket connection is permitted, even on failure.
    suite.mock.method(net.Socket.prototype, 'connect', () => {
        throw new Error('Network connection forbidden in WhatsApp repair regression');
    });
    const hooks = module.registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === 'ws') {
                return { url: fakeTransportURL, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        },
    });
    suite.after(() => hooks.deregister());

    const { default: FakeWebSocket } = await import(fakeTransportURL);
    const { DEFAULT_CONNECTION_CONFIG, DEF_CALLBACK_PREFIX, NOISE_WA_HEADER } = await sdkImport('lib/Defaults/index.js');
    const { default: makeWASocket } = await sdkImport('lib/Socket/index.js');
    const { decodeBinaryNode } = await sdkImport('lib/WABinary/index.js');
    const { useMultiFileAuthState } = await sdkImport('lib/Utils/use-multi-file-auth-state.js');

    // Same CB:* fan-out as socket.js/onMessageReceived, injected at the decoded
    // transport boundary (a real Noise handshake needs a server certificate).
    // Invoke the registered listeners in EventEmitter order and await their
    // results, rather than waiting forever for an event absent in broken rc13.
    async function deliver(ws, node) {
        const child = Array.isArray(node.content) ? node.content[0]?.tag : '';
        const prefix = `${DEF_CALLBACK_PREFIX}${node.tag}`;
        const events = [];
        for (const [key, value] of Object.entries(node.attrs)) {
            events.push(`${prefix},${key}:${value},${child}`, `${prefix},${key}:${value}`, `${prefix},${key}`);
        }
        events.push(`${prefix},,${child}`, prefix);
        const pending = [];
        for (const event of events) {
            for (const listener of ws.rawListeners(event)) {
                try {
                    pending.push(Promise.resolve(listener.call(ws, node)));
                } catch (error) {
                    pending.push(Promise.reject(error));
                }
            }
        }
        const settled = await Promise.allSettled(pending);
        const failures = settled.filter(result => result.status === 'rejected');
        if (failures.length) {
            throw new AggregateError(failures.map(result => result.reason), 'SDK stanza handler failed');
        }
    }

    async function readFrame(frame) {
        const start = frame.subarray(0, NOISE_WA_HEADER.length).equals(NOISE_WA_HEADER) ? NOISE_WA_HEADER.length : 0;
        assert.ok(frame.length >= start + 3, 'complete Noise length prefix');
        const length = frame.readUIntBE(start, 3);
        assert.equal(frame.length, start + 3 + length, 'complete outbound binary stanza');
        // Pre-handshake encodeFrame writes clear binary nodes; decode them with
        // the installed SDK, not an echoing fake sendNode/buildAckStanza.
        return decodeBinaryNode(frame.subarray(start + 3));
    }

    async function withSocket(t, run) {
        const authDir = await mkdtemp(join(tmpdir(), 'hermes-whatsapp-repair-'));
        let sock;
        let persisted = Promise.resolve();
        let closed;
        let timersEnabled = false;
        try {
            t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
            timersEnabled = true;
            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            assert.equal(state.creds.me, undefined);
            assert.equal(state.creds.registered, false);
            const logger = DEFAULT_CONNECTION_CONFIG.logger.child({ test: 'whatsapp-repair' });
            logger.level = 'silent';
            sock = makeWASocket({
                ...DEFAULT_CONNECTION_CONFIG,
                auth: state,
                logger,
                browser: BROWSER,
                qrTimeout: QR_LIFETIME,
                waWebSocketUrl: 'wss://pairing-regression.invalid/ws',
            });
            const transports = [...FakeWebSocket.instances];
            assert.equal(transports.length, 1, 'exactly one fake WebSocket per SDK socket');
            const transport = transports[0];
            const qrs = [];
            const updates = [];
            const connections = [];
            closed = new Promise(resolve => {
                sock.ev.on('connection.update', update => {
                    connections.push(update);
                    if (update.qr) qrs.push(update.qr);
                    if (update.connection === 'close') resolve();
                });
            });
            sock.ev.on('creds.update', update => {
                updates.push(structuredClone(update));
                persisted = persisted.then(() => saveCreds());
                // The assertion/cleanup awaits this promise; don't leak an
                // unhandled rejection while the event emitter cannot await it.
                void persisted.catch(() => {});
            });
            await nextTurn(); // settle the SDK's startup process.nextTick
            await run({
                sock, creds: state.creds, qrs, updates, connections,
                deliver: node => deliver(sock.ws, node),
                sent: () => Promise.all(transport.frames.map(readFrame)),
                reload: async () => {
                    await persisted;
                    return (await useMultiFileAuthState(authDir)).state.creds;
                },
                advance: async milliseconds => {
                    t.mock.timers.tick(milliseconds);
                    await nextTurn();
                },
            });
        } finally {
            try {
                if (sock) {
                    await sock.end(new Error('pairing regression finished'));
                    // A QR-expiry callback can already have started async end().
                    // Wait for its end handlers too, before restoring the clock.
                    if (closed) await closed;
                }
                await persisted;
            } finally {
                for (const transport of FakeWebSocket.instances) {
                    transport.close();
                    transport.removeAllListeners();
                }
                FakeWebSocket.instances.clear();
                if (timersEnabled) t.mock.timers.reset();
                await rm(authDir, { recursive: true, force: true });
            }
        }
    }

    for (const child of ['companion_reg_refresh', 'pair-device-rotate-qr']) {
        await suite.test(`${child}: rotates only the secret, persists it, reuses the ref and retains its deadline`, async t => {
            await withSocket(t, async h => {
                await h.deliver(pairDevice());
                assert.equal(h.qrs.length, 1);
                const original = structuredClone(h.creds);
                const originalQR = qrFields(h.qrs[0]);
                assert.deepEqual(originalQR, [
                    REFS[0],
                    Buffer.from(h.creds.noiseKey.public).toString('base64'),
                    Buffer.from(h.creds.signedIdentityKey.public).toString('base64'),
                    original.advSecretKey,
                    '1',
                ]);
                await h.advance(400);
                const secrets = new Set([original.advSecretKey]);
                for (let index = 0; index < 3; index++) {
                    const node = refresh(child, `repair-refresh-${index}`);
                    await h.deliver(node);
                    const secret = h.creds.advSecretKey;
                    assert.ok(!secrets.has(secret), 'each retirement must mint a fresh adv secret');
                    secrets.add(secret);
                    const bytes = Buffer.from(secret, 'base64');
                    assert.equal(bytes.length, 32, 'use a real 32-byte secret');
                    assert.equal(bytes.toString('base64'), secret, 'canonical base64 encoding');
                    assert.deepEqual(structuredClone(h.creds), { ...original, advSecretKey: secret });
                    assert.equal(h.updates.length, index + 1);
                    assert.deepEqual(h.updates[index], { advSecretKey: secret });
                    assert.equal(h.qrs.length, index + 2);
                    assert.deepEqual(qrFields(h.qrs.at(-1)), [...originalQR.slice(0, 3), secret, originalQR[4]]);
                    // JSON persistence omits initAuthCreds' optional undefined fields.
                    const expectedSaved = Object.fromEntries(
                        Object.entries({ ...original, advSecretKey: secret }).filter(([, value]) => value !== undefined),
                    );
                    assert.deepEqual(structuredClone(await h.reload()), expectedSaved);
                    const acks = (await h.sent()).filter(sent => sent.tag === 'ack' && sent.attrs.id === node.attrs.id);
                    assert.deepEqual(acks, [expectedAck(node)], 'generic handler sends exactly one pre-login ACK');
                }
                await h.advance(599);
                assert.equal(h.qrs.length, 4, 'current ref remains until its original deadline');
                await h.advance(1);
                assert.equal(h.qrs.length, 5, 'refresh must not extend the original QR timer');
                assert.deepEqual(qrFields(h.qrs.at(-1)), [REFS[1], ...originalQR.slice(1, 3), h.creds.advSecretKey, '1']);
                assert.ok(h.sock.ws.isOpen, 'refresh must not consume the next allotted ref');
                await h.advance(QR_LIFETIME - 1);
                assert.ok(h.sock.ws.isOpen);
                await h.advance(1);
                assert.equal(h.sock.ws.isClosed, true, 'the original two-ref budget expires on schedule');
                assert.equal(h.qrs.length, 5);
                const terminal = h.connections.find(update => update.connection === 'close');
                assert.equal(terminal.lastDisconnect.error.output.statusCode, 408);
            });
        });
    }

    await suite.test('malformed refreshes preserve credentials and QR while still receiving one ACK', async t => {
        await withSocket(t, async h => {
            await h.deliver(pairDevice());
            const before = structuredClone(h.creds);
            for (const [index, child] of [undefined, 'unrelated-child'].entries()) {
                const node = refresh(child, `malformed-${index}`);
                await h.deliver(node);
                assert.deepEqual(structuredClone(h.creds), before);
                assert.deepEqual(h.updates, []);
                assert.equal(h.qrs.length, 1);
                assert.deepEqual((await h.sent()).filter(sent => sent.tag === 'ack' && sent.attrs.id === node.attrs.id), [expectedAck(node)]);
            }
        });
    });

    await suite.test('creds.me protects pending identity even when registered is false', async t => {
        await withSocket(t, async h => {
            await h.deliver(pairDevice());
            // Simulate identity appearing after QR display, before registration
            // completes. Never invoke account login or requestPairingCode.
            h.creds.me = { id: '15550000000:1@s.whatsapp.net', name: 'regression' };
            h.creds.registered = false;
            const before = structuredClone(h.creds);
            for (const child of ['companion_reg_refresh', 'pair-device-rotate-qr']) {
                const node = refresh(child, `identity-${child}`);
                await h.deliver(node);
                assert.deepEqual(structuredClone(h.creds), before);
                assert.deepEqual(h.updates, []);
                assert.equal(h.qrs.length, 1);
                assert.deepEqual((await h.sent()).filter(sent => sent.tag === 'ack' && sent.attrs.id === node.attrs.id), [expectedAck(node)]);
            }
        });
    });

    await suite.test('refresh before QR display persists a secret used by the first QR', async t => {
        await withSocket(t, async h => {
            const before = h.creds.advSecretKey;
            await h.deliver(refresh('companion_reg_refresh'));
            assert.notEqual(h.creds.advSecretKey, before);
            assert.equal(h.qrs.length, 0, 'do not invent a reference before pair-device');
            assert.equal((await h.reload()).advSecretKey, h.creds.advSecretKey);
            await h.deliver(pairDevice());
            assert.equal(h.qrs.length, 1);
            assert.equal(qrFields(h.qrs[0])[3], h.creds.advSecretKey);
        });
    });

    await suite.test('public ACK API permits pre-login notifications but rejects messages without identity', async t => {
        await withSocket(t, async h => {
            const node = refresh('companion_reg_refresh');
            await h.sock.sendMessageAck(node);
            assert.deepEqual(await h.sent(), [expectedAck(node)]);
            const message = {
                tag: 'message',
                attrs: { from: '15550000001@s.whatsapp.net', id: 'repair-message', type: 'text' },
            };
            await assert.rejects(h.sock.sendMessageAck(message), { isBoom: true });
            assert.deepEqual(await h.sent(), [expectedAck(node)], 'rejected ACK must write no frame');
            h.creds.me = { id: '15550000000:1@s.whatsapp.net' };
            await h.sock.sendMessageAck(message);
            assert.deepEqual(await h.sent(), [expectedAck(node), expectedAck(message, { from: h.creds.me.id })]);
        });
    });
});
