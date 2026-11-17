import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DesktopBrowserClient } from "./desktop-bridge.ts";
const profileId = "a".repeat(64);
class Port extends EventEmitter {
    messages: Record<string, unknown>[] = [];
    postMessage(message: Record<string, unknown>) { this.messages.push(message); }
    receive(message: unknown) { this.emit("message", { data: message }); }
}
function fixture() {
    const port = new Port(), client = new DesktopBrowserClient(port);
    port.receive({ type: "openmausbot:native-browser-ready", protocol: 1, product: "Chrome/155.0.0.0" });
    return { port, client };
}
async function opened() {
    const f = fixture(), opening = f.client.open(profileId, { persistent: true, proxyPort: 17000 });
    const request = f.port.messages.at(-1)!;
    f.port.receive({ type: "openmausbot:native-browser-result", id: request.id, profileId, result: { epoch: 0, product: "Chrome/155.0.0.0" } });
    const transport = await opening;
    return { ...f, transport };
}
describe("desktop browser private transport", () => {
    it("requires the parent handshake before opening a native profile", async () => {
        const port = new Port(), client = new DesktopBrowserClient(port);
        await expect(client.open(profileId, { persistent: true, proxyPort: 17000 })).rejects.toThrow(/desktop/i);
        expect(port.messages).toHaveLength(0);
    });
    it("ignores a result from a different profile", async () => {
        const { port, client } = fixture();
        let resolved = false;
        const opening = client.open(profileId, { persistent: true, proxyPort: 17000 }).then(t => { resolved = true; return t; });
        const request = port.messages.at(-1)!;
        port.receive({ type: "openmausbot:native-browser-result", id: request.id, profileId: "b".repeat(64), result: { epoch: 0 } });
        await Promise.resolve();
        expect(resolved).toBe(false);
        port.receive({ type: "openmausbot:native-browser-result", id: request.id, profileId, result: { epoch: 0 } });
        await opening;
    });
    it("pins an operation's epoch rather than borrowing a later controller epoch", async () => {
        const { port, transport } = await opened();
        let resume!: () => void;
        const waiting = new Promise<void>(r => { resume = r; });
        const action = transport.withActor!({ kind: "agent" }, async () => { await waiting; transport.send('{"id":2,"method":"Runtime.evaluate"}'); });
        await Promise.resolve();
        port.receive({ type: "openmausbot:native-browser-input", profileId, epoch: 3 });
        resume();
        await action;
        expect(port.messages.at(-1)).toMatchObject({ type: "openmausbot:native-browser-cdp", profileId, epoch: 0, actor: { kind: "agent" } });
        await transport.withActor!({ kind: "viewer", viewerId: "person-a" }, async () => transport.send('{"id":3,"method":"Input.insertText"}'));
        expect(port.messages.at(-1)).toMatchObject({ epoch: 3, actor: { kind: "viewer", viewerId: "person-a" } });
    });
    it("does not deliver another profile's CDP events", async () => {
        const { port, transport } = await opened(), messages: string[] = [];
        transport.onMessage(m => messages.push(m));
        port.receive({ type: "openmausbot:native-browser-cdp-message", profileId: "b".repeat(64), message: '{"id":1}' });
        port.receive({ type: "openmausbot:native-browser-cdp-message", profileId, message: '{"id":2}' });
        expect(messages).toEqual(['{"id":2}']);
    });
    it("acknowledges physical takeover again for an already controlling person", async () => {
        const { port, client } = await opened();
        const first = client.setControl(profileId, "person-a", true);
        await Promise.resolve();
        let request = port.messages.at(-1)!;
        port.receive({ type: "openmausbot:native-browser-result", id: request.id, profileId, result: { epoch: 1 } });
        await first;
        const before = port.messages.length;
        port.receive({ type: "openmausbot:native-browser-input", profileId, epoch: 2 });
        const next = client.setControl(profileId, "person-a", true);
        await Promise.resolve();
        expect(port.messages.length).toBe(before + 1);
        request = port.messages.at(-1)!;
        expect(request).toMatchObject({ action: "lease", viewerId: "person-a", ready: true });
        port.receive({ type: "openmausbot:native-browser-result", id: request.id, profileId, result: { epoch: 3 } });
        await next;
    });
    it("closes the transport when its private parent disappears", async () => {
        const { port, client, transport } = await opened();
        let closed = false;
        transport.onClose(() => { closed = true; });
        port.emit("close");
        expect(closed).toBe(true);
        expect(client.available).toBe(false);
    });
});
