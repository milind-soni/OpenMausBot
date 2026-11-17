import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openMessageFile } from "../server/message-file.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createNativeBrowserCoordinator } from "./native-browser-main.mjs";
const folders = [];
afterEach(async () => { for (const path of folders.splice(0))
    await removeTempDir(path); });
const profileId = "a".repeat(64);
class Proc extends EventEmitter {
    postMessage(m) { this.emit("answer", m); }
}
async function fixture() {
    const userData = await mkdtemp(join(tmpdir(), "omb-native-main-"));
    folders.push(userData);
    const handlers = new Map(), protocols = new Map();
    const session = { protocol: { handle: async (name, handler) => { protocols.set(name, handler); }, unhandle: (name) => protocols.delete(name) }, setProxy: async () => undefined, clearStorageData: async () => undefined, clearCache: async () => undefined, clearAuthCache: async () => undefined, flushStorageData: () => undefined };
    const wc = Object.assign(new EventEmitter(), { send: () => undefined }), window = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => false });
    let poolOptions = {};
    let layouts = 0;
    const placements = [];
    const pool = { open: async (input) => { await poolOptions.sessionForProfile(input.profileId, input); return { epoch: 0 }; }, send: async () => undefined, lease: () => 1, layout: input => { layouts++; placements.push(input); }, close: async () => undefined, erase: async () => undefined, destroy: async () => undefined };
    const coordinator = createNativeBrowserCoordinator({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: () => undefined }, session: { fromPartition: () => session }, getOwner: () => window, isLocalOwner: (event) => event.sender === wc, userData, product: "Chrome/155.0.0.0", readFile: (path, roots) => openMessageFile(path, roots, 5 * 1024 * 1024), poolFactory: (options) => { poolOptions = options; return pool; } });
    const proc = new Proc();
    coordinator.attach(proc);
    const request = (action, body = {}) => new Promise(resolve => { const id = crypto.randomUUID(); const listener = (m) => { if (m.id === id) {
        proc.off("answer", listener);
        resolve(m);
    } }; proc.on("answer", listener); coordinator.receive(proc, { type: "openmausbot:native-browser-request", id, action, profileId, ...body }); });
    return { coordinator, proc, wc, userData, handlers, protocols, request, placements, poolOptions: () => poolOptions, layouts: () => layouts };
}
describe("native browser owner coordinator", () => {
    it("keeps the server's passive capability even when the renderer asks for input", async () => {
        const f = await fixture();
        await f.request("open", { persistent: true, proxyPort: 1234 });
        f.poolOptions().onMessage(profileId, JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { type: "page", targetId: "owned", url: "about:blank" } } }));
        const grant = await f.request("grant", { targetId: "owned", viewerId: "person", viewId: "passive", canOperate: false });
        expect(grant.error).toBeUndefined();
        f.handlers.get("native-browser:layout")({ sender: f.wc }, { token: grant.result.token, bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true, canInput: true, canTake: true });
        expect(f.placements.at(-1)).toMatchObject({ viewerId: "person", canTake: false, canInput: false });
        await f.coordinator.destroy();
    });
    it("refuses a server other than its private attached child", async () => {
        const f = await fixture();
        expect(f.coordinator.receive(new Proc(), { type: "openmausbot:native-browser-request", id: "x", action: "open", profileId, persistent: true, proxyPort: 1234 })).toBe(false);
        await f.coordinator.destroy();
    });
    it("refuses native layout without a scoped grant or from another page", async () => {
        const f = await fixture(), layout = f.handlers.get("native-browser:layout");
        expect(() => layout({ sender: {} }, { token: "made-up" })).toThrow(/local app/i);
        expect(() => layout({ sender: f.wc }, { token: "made-up" })).toThrow(/expired/i);
        expect(f.layouts()).toBe(0);
        await f.coordinator.destroy();
    });
    it("does not grant a foreign target under an existing native profile", async () => {
        const f = await fixture();
        await f.request("open", { persistent: true, proxyPort: 1234 });
        const result = await f.request("grant", { targetId: "foreign-owner-target", viewerId: "person", viewId: "view" });
        expect(result.error).toMatch(/invalid/i);
        await f.coordinator.destroy();
    });
    it("streams the authorized original HTML and relative assets but rejects paths outside it", async () => {
        const f = await fixture(), root = join(f.userData, "artifact"), outside = join(f.userData, "other.html");
        await mkdir(root);
        const path = join(root, "report.html"), source = "<main>" + "a".repeat(2 * 1024 * 1024) + "</main>";
        await writeFile(path, source);
        await writeFile(join(root, "style.css"), "main{color:red}");
        await writeFile(outside, "private unrelated");
        await f.request("open", { persistent: true, proxyPort: 1234 });
        const granted = await f.request("authorize-file", { path, roots: [root] });
        expect(granted.error).toBeUndefined();
        expect((granted.result).url).toBe(pathToFileURL(path).href);
        const protocol = f.protocols.get("file");
        const html = await protocol({ url: pathToFileURL(path).href });
        expect(html.status).toBe(200);
        expect(await html.text()).toBe(source);
        const css = await protocol({ url: pathToFileURL(join(root, "style.css")).href });
        expect(css.headers.get("content-type")).toBe("text/css");
        expect(await css.text()).toBe("main{color:red}");
        expect((await protocol({ url: pathToFileURL(outside).href })).status).toBe(403);
        await f.coordinator.destroy();
    });
});
