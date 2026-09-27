import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addedProviderConfigured, type AddedProvider, type HostedComputersConfig } from "../../shared/hosted-computers.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ComputerProviderError, createComputerProvider, type ComputerProvider, type Machine } from "./providers.ts";

type Record = { version: 1; provider: AddedProvider; name: string; id?: string };
type Factory = typeof createComputerProvider;
/** Workspace-local durable bindings. Raw provider ids and credentials never leave this service. */
export class HostedComputerManager {
  private readonly busy = new Map<string, Promise<unknown>>();
  private root: string;
  private scope: string;
  private config: () => HostedComputersConfig;
  private factory: Factory;
  constructor(root: string, scope: string, config: () => HostedComputersConfig, factory: Factory = createComputerProvider) {
    this.root = root; this.scope = scope; this.config = config; this.factory = factory;
  }
  private name(key: string): string {
    return `nation-${createHash("sha256").update(`${this.scope}\0${key}`).digest("hex").slice(0, 40)}`;
  }
  private file(provider: AddedProvider, key: string): string { return join(this.root, `${provider}-${this.name(key)}.json`); }
  private fence(provider: AddedProvider, key: string): string { return this.file(provider, key) + ".coding"; }
  private assertIdle(provider: AddedProvider, key: string): void {
    const path = this.fence(provider, key);
    if (!existsSync(path)) return;
    // An uncertain execution or server crash never releases a machine early.
    const expires = Number(readFileSync(path, "utf8"));
    if (!Number.isFinite(expires) || expires > Date.now()) throw new ComputerProviderError(409);
    rmSync(path);
  }
  private read(provider: AddedProvider, key: string): Record | null {
    const file = this.file(provider, key);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, "utf8")) as Record;
    if (data.version !== 1 || data.provider !== provider || data.name !== this.name(key) ||
      (data.id !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(data.id))) throw new ComputerProviderError(409);
    return data;
  }
  private save(provider: AddedProvider, key: string, record: Record): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file(provider, key), JSON.stringify(record), { mode: 0o600 });
  }
  configured(provider: AddedProvider): boolean { return addedProviderConfigured(this.config(), provider); }
  private async client(provider: AddedProvider): Promise<ComputerProvider> {
    if (!this.configured(provider)) throw new ComputerProviderError(409);
    return this.factory(provider, structuredClone(this.config()));
  }
  private async resolve(provider: AddedProvider, key: string, client: ComputerProvider): Promise<Machine | null> {
    const record = this.read(provider, key);
    // A vanished existing machine is an error; never silently replace a user's disk.
    if (record?.id) return client.get(record.id, record.name);
    const found = await client.find(this.name(key));
    if (found) this.save(provider, key, { version: 1, provider, name: found.name, id: found.id });
    return found;
  }
  private exclusive<T>(provider: AddedProvider, key: string, run: () => Promise<T>): Promise<T> {
    const lock = `${provider}:${key}`;
    if (this.busy.has(lock)) return Promise.reject(new ComputerProviderError(409));
    const promise = Promise.resolve().then(() => { this.assertIdle(provider, key); return run(); }).catch(error => { throw error instanceof ComputerProviderError ? error : new ComputerProviderError(); }).finally(() => { this.busy.delete(lock); });
    this.busy.set(lock, promise);
    return promise;
  }
  async status(provider: AddedProvider, key: string) {
    if (!this.configured(provider)) return { configured: false, state: null };
    try { const m = await this.resolve(provider, key, await this.client(provider)); return { configured: true, state: m?.state ?? null }; }
    catch { throw new ComputerProviderError(); }
  }
  start(provider: AddedProvider, key: string, create: boolean, authorized: () => boolean = () => true) {
    return this.exclusive(provider, key, async () => {
      const client = await this.client(provider);
      let m = await this.resolve(provider, key, client);
      if (!create) return m?.state === "running" ? { state: "running" } : null;
      if (!authorized()) throw new ComputerProviderError(403);
      if (!m) {
        // Record the deterministic request name before making a chargeable request.
        this.save(provider, key, { version: 1, provider, name: this.name(key) });
        m = await client.create(this.name(key));
        this.save(provider, key, { version: 1, provider, name: m.name, id: m.id });
      }
      if (!authorized()) throw new ComputerProviderError(403);
      m = await client.start(m);
      if (m.state !== "running") throw new ComputerProviderError(409);
      return { state: m.state };
    });
  }
  stop(provider: AddedProvider, key: string) {
    return this.exclusive(provider, key, async () => {
      const client = await this.client(provider);
      const m = await this.resolve(provider, key, client);
      if (m) await client.stop(m);
      return { ok: true };
    });
  }
  private async running(provider: AddedProvider, key: string) {
    const client = await this.client(provider);
    const m = await this.resolve(provider, key, client);
    if (!m || m.state !== "running") throw new ComputerProviderError(409);
    return { client, m };
  }
  async screenshot(provider: AddedProvider, key: string) {
    try { const { client, m } = await this.running(provider, key); return await client.screenshot(m); }
    catch { throw new ComputerProviderError(); }
  }
  execute(provider: AddedProvider, key: string, command: string, authorized: () => boolean = () => true) {
    if (!command.trim() || command.length > 4000) return Promise.reject(new ComputerProviderError(400));
    return this.exclusive(provider, key, async () => {
      const { client, m } = await this.running(provider, key);
      // Resolving a remote machine can outlive the turn which requested it.
      if (!authorized()) throw new ComputerProviderError(403);
      return client.execute(m, command);
    });
  }
  code(provider: AddedProvider, key: string, command: string, authorized: () => boolean, expires: number) {
    if (command.length > 64_000) return Promise.reject(new ComputerProviderError(400));
    return this.exclusive(provider, key, async () => {
      const { client, m } = await this.running(provider, key);
      if (!authorized() || !client.code) throw new ComputerProviderError(403);
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      writeFileAtomic(this.fence(provider, key), String(expires + 60_000), { mode: 0o600 });
      const result = await client.code(m, command);
      // Only a receipt from our supervisor confirms that its process group
      // ended; provider timeouts retain the durable fence until its deadline.
      try {
        const receipt = JSON.parse(result.stdout.trim());
        if (result.exitCode === 0 && ["completed", "failed", "cancelled"].includes(receipt.status)) rmSync(this.fence(provider, key), { force: true });
      } catch { /* uncertain: fenced */ }
      return result;
    });
  }
}
