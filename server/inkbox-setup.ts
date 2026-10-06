import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { InkboxResource, InkboxSecretStore, InkboxSetupInput, InkboxSetupSnapshot } from "../shared/inkbox-setup.ts";
import type { InkboxChannel, InkboxConfig } from "./inkbox-channel.ts";
import { InkboxProvider, InkboxSetupError } from "./inkbox-provider.ts";
import { openInkboxTunnel, type InkboxTunnel, type InkboxTunnelOptions } from "./inkbox-tunnel.ts";

const inputSchema = z.object({ apiKey: z.string().trim().min(1).max(4096).refine(v => !/[\r\n]/.test(v)),
  botId: z.string().uuid(), ownerPhone: z.string().regex(/^\+[1-9]\d{6,14}$/) }).strict();
const documentSchema = inputSchema.extend({ version: z.literal(1), enabled: z.boolean(), pending: z.boolean(),
  stage: z.enum(["initial", "identity", "scoped", "subscribed", "ready"]),
  identityId: z.string().uuid().optional(), handle: z.string().regex(/^[a-z0-9-]{3,63}$/).optional(),
  signingSecret: z.string().min(1).max(4096).optional(), subscriptionId: z.string().uuid().optional(),
  broadEvents: z.boolean().optional(),
  pairing: z.object({ number: z.string().regex(/^\+[1-9]\d{6,14}$/), connectText: z.string().max(100), smsLink: z.string().max(300) }).optional(),
}).strict();
type Document = z.infer<typeof documentSchema>;
type Channel = Pick<InkboxChannel, "handle" | "close" | "status" | "idle">;
interface Options {
  directory: string; port: number; secrets: InkboxSecretStore; botExists(id: string): boolean;
  makeChannel(config: InkboxConfig, file: string, active: () => boolean): Channel;
  fetch?: typeof fetch; tunnel?: (options: InkboxTunnelOptions) => Promise<InkboxTunnel>;
}
const interrupted = () => new InkboxSetupError("Setup was interrupted before its result could be saved. Check the identity in Inkbox, then disconnect and set up a new connection.", 409);
/** Owns desktop setup and lifetime. Private durable state never becomes an API response. */
export class InkboxSetup {
  private document: Document | null = null;
  private loaded: Promise<void> | null = null;
  private storageError = false;
  private phase: InkboxSetupSnapshot["phase"] = "disconnected";
  private error?: string;
  private generation = 0;
  private resources: InkboxResource[] = [];
  private eventSubscriptionError?: string;
  private toolBinding: string | null = null;
  private abort?: AbortController;
  private operation: Promise<void> | null = null;
  private stopping = false;
  private channel: Channel | null = null;
  private connection: InkboxTunnel | null = null;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  get hasConfiguration() { return this.document !== null || this.storageError; }
  /** Private host accessor. Never include this credential or binding in snapshots. */
  toolConnection(botId: string): { identityId: string; apiKey: string; binding: string } | null {
    const doc = this.document;
    if (!doc?.enabled || doc.pending || doc.stage !== "ready" || !doc.identityId || doc.botId !== botId ||
      this.stopping || this.error || !this.connection?.isConnected || !this.toolBinding) return null;
    return { identityId: doc.identityId, apiKey: doc.apiKey, binding: this.toolBinding };
  }
  snapshot(): InkboxSetupSnapshot {
    const doc = this.document;
    const deliveries = this.channel?.status().deliveries ?? [];
    let phase = this.phase;
    if (this.connection && !this.error && doc?.enabled) {
      phase = !this.connection.isConnected ? "connecting" : deliveries.some(d => d.sender === doc.ownerPhone && d.status !== "recorded") ? "connected" : "awaiting_phone";
    }
    return { available: this.options.secrets.available, phase, ...(this.channel ? { approvalMode: this.channel.status().approvalMode ?? "ask" } : {}), resources: this.resources.map(r => ({ ...r })), capabilitiesAvailable: !!doc && !!this.toolConnection(doc.botId),
      ...(doc ? { botId: doc.botId, ownerPhone: doc.ownerPhone, ...(doc.handle ? { identityHandle: doc.handle } : {}), ...(doc.pairing ? { pairing: { ...doc.pairing } } : {}) } : {}),
      ...(this.eventSubscriptionError ? { eventSubscriptionError: this.eventSubscriptionError } : {}),
      ...(this.error ? { error: this.error } : {}), canReconnect: !!doc && !doc.pending && !this.operation && !this.stopping,
      deliveries: deliveries.map(d => ({ id: d.id, sender: d.sender, channel: d.channel, status: d.status, ...(d.text !== undefined ? {text:d.text} : {}), ...(d.receivedAt !== undefined ? {receivedAt:d.receivedAt} : {}),
        ...(d.reference ? {reference:{...d.reference}} : {}), ...(d.previewState ? {previewState:d.previewState} : {}), ...(d.previewNotice ? {previewNotice:d.previewNotice} : {}),
        ...(d.reply ? { reply: d.reply } : {}), ...(d.error ? { error: d.error } : {}) })) };
  }
  private async load() {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.options.secrets.available) return;
      try {
        const value = await this.options.secrets.read();
        if (value !== null) {
          const parsed = documentSchema.safeParse(value);
          if (!parsed.success) throw new Error();
          this.document = parsed.data;
        }
      } catch { this.storageError = true; this.fail(new InkboxSetupError("Could not read secure iMessage settings. Restart the desktop app before trying again.", 503)); }
    })();
    await this.loaded;
  }
  private fail(error: unknown) {
    this.phase = "error";
    this.error = error instanceof InkboxSetupError ? error.message : "Could not finish iMessage setup. Check your connection and try again.";
    return new InkboxSetupError(this.error, error instanceof InkboxSetupError ? error.status : 503);
  }
  private assertCurrent(generation: number) {
    if (generation !== this.generation || this.stopping) throw new InkboxSetupError("Setup was stopped.", 409);
  }
  private async save(doc: Document, generation: number) {
    this.assertCurrent(generation);
    try { await this.options.secrets.write(doc); }
    catch { throw new InkboxSetupError("Could not save secure iMessage settings. Check desktop credential storage before trying again.", 503); }
    // Keep the last durable result even if a disconnect arrived while writing.
    this.document = doc;
    this.assertCurrent(generation);
  }
  private async run(work: (generation: number, signal: AbortSignal) => Promise<void>, preflight?: () => void) {
    await this.load();
    if (!this.options.secrets.available || this.storageError) throw new InkboxSetupError("Secure iMessage setup is available only in the local desktop app.", 503);
    if (this.operation || this.stopping) throw new InkboxSetupError("Another iMessage operation is still finishing.", 409);
    preflight?.();
    const generation = ++this.generation; this.abort = new AbortController(); this.error = undefined;
    const promise = (async () => {
      try { await work(generation, this.abort!.signal); }
      catch (error) { if (generation === this.generation) { await this.stopRuntime(); throw this.fail(error); } throw error; }
    })();
    this.operation = promise;
    try { await promise; } finally { if (this.operation === promise) this.operation = null; }
  }
  async prepareRestore() { await this.load(); }
  async restore() {
    const generation = this.generation;
    await this.load();
    if (generation !== this.generation || this.stopping || this.operation || !this.document?.enabled || this.storageError) return;
    try { await this.reconnect(); } catch { /* Snapshot carries safe startup error; desktop startup continues. */ }
  }
  async setup(value: InkboxSetupInput) {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new InkboxSetupError("Enter an Inkbox API key, choose a bot, and enter your phone number with its country code.");
    if (!this.options.botExists(parsed.data.botId)) throw new InkboxSetupError("Choose an existing bot.");
    return this.run(async (generation, signal) => {
      this.phase = "setting_up";
      await this.stopRuntime();
      let doc: Document = { ...parsed.data, version: 1, enabled: true, pending: false, stage: "initial" };
      await this.save(doc, generation);
      doc = await this.provision(doc, generation, signal);
      await this.activate(doc, generation, signal);
    }, () => {
      if (this.document?.enabled) throw new InkboxSetupError("Disconnect the current iMessage setup first.", 409);
    });
  }
  private async provision(start: Document, generation: number, signal: AbortSignal): Promise<Document> {
    let doc = start;
    let provider = new InkboxProvider(doc.apiKey, this.options.fetch, signal);
    if (doc.stage === "initial") {
      const key = await provider.inspectKey(); this.assertCurrent(generation);
      if (key.scoped_identity_id) {
        const identity = await provider.ownIdentity(key.scoped_identity_id); this.assertCurrent(generation);
        if (identity.signing_key_configured) throw new InkboxSetupError("This identity already has a signing key. Use an admin key to create a separate Mausbot identity.", 409);
        doc = { ...doc, identityId: identity.id, handle: identity.agent_handle, stage: "scoped" }; await this.save(doc, generation);
      } else {
        doc = { ...doc, handle: `maus-${randomUUID().replaceAll("-", "")}`, pending: true }; await this.save(doc, generation);
        const identity = await provider.createIdentity(doc.handle!);
        doc = { ...doc, identityId: identity.id, stage: "identity", pending: false }; await this.save(doc, generation);
      }
    }
    if (!doc.identityId || !doc.handle) throw interrupted();
    const identityId = doc.identityId, handle = doc.handle;
    if (doc.stage === "identity") {
      const identity = await provider.getIdentity(handle); this.assertCurrent(generation);
      if (identity.id !== doc.identityId || identity.signing_key_configured) throw interrupted();
      doc = { ...doc, pending: true }; await this.save(doc, generation);
      const apiKey = await provider.mintKey(identityId);
      doc = { ...doc, apiKey, stage: "scoped", pending: false }; await this.save(doc, generation);
      provider = new InkboxProvider(apiKey, this.options.fetch, signal);
    }
    if (doc.stage === "scoped") {
      const key = await provider.inspectKey(); this.assertCurrent(generation);
      if (key.scoped_identity_id !== doc.identityId) throw new InkboxSetupError("The key does not belong to this iMessage identity.");
      const identity = await provider.getIdentity(handle); this.assertCurrent(generation);
      if (identity.id !== doc.identityId || identity.signing_key_configured) throw new InkboxSetupError("This identity already has a signing key. Disconnect and use an admin key to create a separate Mausbot identity.", 409);
      if (!identity.imessage_enabled) {
        doc = { ...doc, pending: true }; await this.save(doc, generation);
        await provider.enableIdentity(handle);
        doc = { ...doc, pending: false }; await this.save(doc, generation);
      }
      doc = { ...doc, pending: true }; await this.save(doc, generation);
      const subscription = await provider.subscribe(identityId, handle);
      doc = { ...doc, broadEvents: true, subscriptionId: subscription.id, signingSecret: subscription.signingSecret, stage: "subscribed", pending: false }; await this.save(doc, generation);
    }
    if (doc.stage === "subscribed") {
      const pairing = await provider.router(identityId, handle);
      doc = { ...doc, pairing, stage: "ready" }; await this.save(doc, generation);
    }
    return doc;
  }
  async reconnect() {
    return this.run(async (generation, signal) => {
      let doc = this.document;
      if (!doc) throw new InkboxSetupError("Set up iMessage first.");
      if (doc.pending) throw interrupted();
      await this.stopRuntime();
      doc = { ...doc, enabled: true }; await this.save(doc, generation);
      doc = await this.provision(doc, generation, signal);
      await this.activate(doc, generation, signal);
    });
  }
  private async activate(doc: Document, generation: number, signal: AbortSignal) {
    if (!doc.identityId || !doc.handle || !doc.signingSecret || !doc.pairing || !this.options.botExists(doc.botId)) throw new InkboxSetupError("The saved connection is incomplete or its bot was removed. Disconnect and set up iMessage again.");
    this.phase = "connecting";
    const provider = new InkboxProvider(doc.apiKey, this.options.fetch, signal);
    const key = await provider.inspectKey(); this.assertCurrent(generation);
    if (key.scoped_identity_id !== doc.identityId) throw new InkboxSetupError("The saved key does not belong to this iMessage identity.");
    const identity = await provider.getIdentity(doc.handle); this.assertCurrent(generation);
    if (identity.id !== doc.identityId || !identity.imessage_enabled) throw new InkboxSetupError("The saved iMessage identity is no longer available.");
    this.eventSubscriptionError = undefined;
    if (!doc.broadEvents && doc.subscriptionId) {
      try {
        await provider.extendSubscription(doc.subscriptionId, doc.identityId, doc.handle);
        doc = { ...doc, broadEvents: true }; await this.save(doc, generation);
      } catch { this.eventSubscriptionError = "Additional event subscriptions could not be verified. Existing iMessage setup is preserved; reconnect to retry discovery."; }
    }
    try { this.resources = await provider.resources(doc.handle!, doc.identityId!); }
    catch { this.resources = [{channel: "email", status: "error", reason: "Channel resources could not be verified. Reconnect to refresh."}]; }
    this.assertCurrent(generation);
    const binding = createHash("sha256").update(JSON.stringify([doc.identityId, doc.botId, doc.ownerPhone])).digest("hex");
    const directory = join(this.options.directory, "inkbox", binding);
    const active = () => generation === this.generation && !this.stopping && this.document?.enabled === true;
    this.channel = this.options.makeChannel({ apiKey: doc.apiKey, signingSecret: doc.signingSecret!, identityId: doc.identityId!, botId: doc.botId, ownerPhone: doc.ownerPhone, ...(identity.mailbox ? {mailboxId:identity.mailbox.id,emailAddress:identity.mailbox.email_address} : {}), ...(identity.phone_number ? {phoneNumberId:identity.phone_number.id,phoneNumber:identity.phone_number.number} : {}) }, join(directory, "deliveries.json"), active);
    const connection = await (this.options.tunnel ?? openInkboxTunnel)({ apiKey: doc.apiKey, handle: doc.handle!, identityId: doc.identityId!, stateDir: join(directory, "tunnel"), port: this.options.port, active, fetch: this.options.fetch });
    if (!active()) { await connection.close(); this.assertCurrent(generation); }
    this.connection = connection;
    this.toolBinding = randomUUID();
    void connection.wait().then(() => {
      if (active() && this.connection === connection) { this.channel?.close(); this.connection = null; this.fail(new InkboxSetupError("The iMessage connection stopped. Click Reconnect.", 503)); }
    }, () => {
      if (active() && this.connection === connection) { this.channel?.close(); this.connection = null; this.fail(new InkboxSetupError("The iMessage connection was lost. Click Reconnect.", 503)); }
    });
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (this.channel && !this.error && this.document?.enabled && !this.stopping) return this.channel.handle(req, res);
    if (this.hasConfiguration && req.url?.split("?")[0] === "/inkbox") { res.writeHead(503); res.end(); return true; }
    return false;
  }
  private async stopRuntime() {
    this.toolBinding = null;
    const channel = this.channel; this.channel = null;
    channel?.close();
    const connection = this.connection; this.connection = null;
    if (connection) await connection.close().catch(() => {});
    await channel?.idle();
  }
  async disconnect() {
    if (this.stopping) throw new InkboxSetupError("The connection is already stopping.", 409);
    this.stopping = true; ++this.generation; this.abort?.abort();
    try {
      await this.stopRuntime(); await this.operation?.catch(() => {}); await this.load();
      if (this.document) {
        const doc = { ...this.document, enabled: false };
        try { await this.options.secrets.write(doc); this.document = doc; }
        catch { throw new InkboxSetupError("The connection stopped, but its pause could not be saved securely. Keep the app closed until credential storage is working.", 503); }
      }
      this.phase = "disconnected"; this.error = undefined;
    } catch (error) { throw this.fail(error); }
    finally { this.stopping = false; }
  }
  async close() {
    this.stopping = true; ++this.generation; this.abort?.abort();
    await this.stopRuntime(); await this.operation?.catch(() => {});
  }
}
