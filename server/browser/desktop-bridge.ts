import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { BrowserActor, CdpTransport } from "./cdp/transport.ts";
export interface DesktopBrowserPort {
    postMessage(message: unknown): void;
    on(event: "message" | "close", listener: (event: unknown) => void): unknown;
}
interface Pending {
    profileId: string;
    resolve(result: Record<string, unknown>): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}
interface NativeProfile {
    epoch: number;
    transport: NativeTransport;
    control: {
        owner: string | null;
        ready: boolean;
    };
    controlWork: Promise<void>;
    selectedTargetId?: string;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const PROFILE = /^[a-f0-9]{64}$/;
const MAX_CDP_BYTES = 16 * 1024 * 1024;
class NativeTransport implements CdpTransport {
    readonly #actors = new AsyncLocalStorage<{
        actor: BrowserActor;
        epoch: number;
    }>();
    readonly #messages = new Set<(message: string) => void>();
    readonly #closes = new Set<(reason: string) => void>();
    readonly #client: DesktopBrowserClient;
    readonly profileId: string;
    closed = false;
    constructor(client: DesktopBrowserClient, profileId: string) { this.#client = client; this.profileId = profileId; }
    send(message: string): void {
        if (this.closed)
            throw new Error("The native browser connection is closed.");
        if (message.length > MAX_CDP_BYTES)
            throw new Error("The native browser message is too large.");
        const scope = this.#actors.getStore();
        this.#client.send({ type: "openmausbot:native-browser-cdp", profileId: this.profileId, epoch: scope?.epoch ?? this.#client.epoch(this.profileId), actor: scope?.actor ?? { kind: "system" }, message });
    }
    onMessage(listener: (message: string) => void) { this.#messages.add(listener); }
    onClose(listener: (reason: string) => void) { if (this.closed)
        listener("The native browser connection closed.");
    else
        this.#closes.add(listener); }
    receive(message: string) { if (!this.closed)
        for (const listener of this.#messages)
            listener(message); }
    ended(reason: string) { if (this.closed)
        return; this.closed = true; for (const listener of this.#closes)
        listener(reason); this.#messages.clear(); this.#closes.clear(); }
    close() { if (this.closed)
        return; this.ended("Closed by the driver."); void this.#client.request("close", this.profileId).catch(() => undefined); }
    async withActor<T>(actor: BrowserActor, work: () => Promise<T>): Promise<T> {
        await this.#client.controlSettled(this.profileId);
        return this.#actors.run({ actor, epoch: this.#client.epoch(this.profileId) }, work);
    }
}
/** Only Electron's current utility-process parent can grant this transport. */
export class DesktopBrowserClient {
    readonly #port: DesktopBrowserPort | undefined;
    readonly #pending = new Map<string, Pending>();
    readonly #profiles = new Map<string, NativeProfile>();
    readonly #opening = new Map<string, Promise<CdpTransport>>();
    #available = false;
    #product = "";
    constructor(port?: DesktopBrowserPort) {
        this.#port = port;
        port?.on("message", event => { const data = object(event); this.receive(data?.data ?? event); });
        port?.on("close", () => this.#closed("The desktop browser parent disconnected."));
    }
    get available() { return this.#available; }
    get product() { return this.#product; }
    receive(value: unknown): boolean {
        const m = object(value);
        if (!m || typeof m.type !== "string" || !m.type.startsWith("openmausbot:native-browser-"))
            return false;
        if (m.type === "openmausbot:native-browser-ready") {
            if (m.protocol === 1 && typeof m.product === "string" && /^Chrome\/[\d.]+$/.test(m.product)) {
                this.#available = true;
                this.#product = m.product;
            }
            return true;
        }
        if (m.type === "openmausbot:native-browser-unavailable") {
            this.#closed("Native browser unavailable.");
            return true;
        }
        if (typeof m.profileId !== "string" || !PROFILE.test(m.profileId))
            return true;
        const profile = this.#profiles.get(m.profileId);
        if (m.type === "openmausbot:native-browser-result") {
            const id = typeof m.id === "string" ? m.id : "", pending = this.#pending.get(id);
            if (!pending || pending.profileId !== m.profileId)
                return true;
            this.#pending.delete(id);
            clearTimeout(pending.timer);
            if (typeof m.error === "string")
                pending.reject(new Error(m.error));
            else
                pending.resolve(object(m.result) ?? {});
        }
        else if (m.type === "openmausbot:native-browser-cdp-message" && typeof m.message === "string" && m.message.length <= MAX_CDP_BYTES) {
            profile?.transport.receive(m.message);
        }
        else if (m.type === "openmausbot:native-browser-input" && Number.isSafeInteger(m.epoch) && Number(m.epoch) >= 0) {
            if (profile) {
                profile.epoch = Math.max(profile.epoch, Number(m.epoch));
                profile.control = { ...profile.control, ready: false };
            }
        }
        else if (m.type === "openmausbot:native-browser-closed") {
            profile?.transport.ended("The native profile browser closed.");
            this.#profiles.delete(m.profileId);
        }
        return true;
    }
    send(message: unknown) { if (!this.#available || !this.#port)
        throw new Error("The native browser requires the local desktop app."); this.#port.postMessage(message); }
    request(action: string, profileId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        if (!PROFILE.test(profileId))
            return Promise.reject(new Error("Invalid native browser profile."));
        if (!this.#available)
            return Promise.reject(new Error("The native browser requires the local desktop app."));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("The native browser did not answer. Check its state before repeating the action.")); }, 30000);
            timer.unref?.();
            this.#pending.set(id, { profileId, resolve, reject, timer });
            try {
                this.send({ type: "openmausbot:native-browser-request", id, action, profileId, ...body });
            }
            catch (error) {
                this.#pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }
    open(profileId: string, options: {
        persistent: boolean;
        proxyPort: number;
        fresh?: boolean;
    }): Promise<CdpTransport> {
        const found = this.#profiles.get(profileId);
        if (found && !found.transport.closed)
            return Promise.resolve(found.transport);
        const pending = this.#opening.get(profileId);
        if (pending)
            return pending;
        if (!Number.isInteger(options.proxyPort) || options.proxyPort < 1 || options.proxyPort > 65535)
            return Promise.reject(new Error("Native browser requires its network gate."));
        const opening = this.request("open", profileId, options).then(result => {
            const transport = new NativeTransport(this, profileId);
            this.#profiles.set(profileId, { epoch: Number(result.epoch) || 0, transport, control: { owner: null, ready: false }, controlWork: Promise.resolve(), ...(typeof result.selectedTargetId === "string" ? { selectedTargetId: result.selectedTargetId } : {}) });
            return transport;
        }).finally(() => this.#opening.delete(profileId));
        this.#opening.set(profileId, opening);
        return opening;
    }
    epoch(profileId: string) { return this.#profiles.get(profileId)?.epoch ?? 0; }
    selectedTarget(profileId: string) { return this.#profiles.get(profileId)?.selectedTargetId; }
    controlSettled(profileId: string) { return this.#profiles.get(profileId)?.controlWork ?? Promise.resolve(); }
    setControl(profileId: string, owner: string | null, ready: boolean): Promise<void> {
        const p = this.#profiles.get(profileId);
        if (!p)
            return Promise.resolve();
        if (p.control.owner === owner && p.control.ready === ready)
            return p.controlWork;
        p.control = { owner, ready };
        const work = async () => { const answer = await this.request("lease", profileId, { viewerId: owner, ready }); if (Number.isSafeInteger(answer.epoch))
            p.epoch = Math.max(p.epoch, Number(answer.epoch)); };
        p.controlWork = p.controlWork.then(work, work);
        return p.controlWork;
    }
    #closed(reason: string) {
        this.#available = false;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this.#pending.clear();
        for (const profile of this.#profiles.values())
            profile.transport.ended(reason);
        this.#profiles.clear();
    }
}
export const desktopBrowser = new DesktopBrowserClient((process as NodeJS.Process & {
    parentPort?: DesktopBrowserPort;
}).parentPort);
