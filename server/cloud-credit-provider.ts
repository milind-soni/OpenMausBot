// A Cloud home trial's Claude credit: OMB's own chat engine on the Admin's OpenAI-compatible relay, never Claude Code or
// Codex, since the platform's key never runs another product's agent. This machine holds only the relay's address and its
// token, in memory, reaching this one engine. It is never saved to config.json and the person's own engine always wins; a
// refusal is remembered under providers/, which never travels in a backup or a move.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { InstanceConfigMap, ModelCatalog, ProviderInstance, RuntimeEvent, TextGenerationOptions } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { ServiceCredential } from "./included-services.ts";
import { TRIAL_CREDIT_REFUSED, trialCreditEnds, trialCreditFailure, trialCreditRefusal, type TrialCreditEnd } from "./trial-credit.ts";

export const CLOUD_CREDIT_INSTANCE = "trial-credit";
export type CloudCreditStatus = "active" | "used_up" | "ended";
/** The chat engine reads its key from this, in its own environment only: never the workspace's OpenAI-compatible key. */
const CREDIT_KEY_ENV = "OPENMAUSBOT_TRIAL_CREDIT_KEY";
/** OpenAI-compatible model ids, OpenRouter's provider/model[:variant] among them; an id only ever goes in a request body. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const MAX_MODELS = 20;
/** The models it lists are asked for again this often while it cannot answer, at most. */
const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000] as const;
/** Listed for a credit refused before it ever listed a model, so it can say why; nothing is ever sent to it. */
const PLACEHOLDER: readonly CreditModel[] = [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }];

export interface CreditModel { id: string; label: string }

export function parseCreditModels(body: unknown): CreditModel[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const models: CreditModel[] = [];
  for (const row of data) {
    const id = row && typeof row === "object" ? (row as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !MODEL_ID.test(id) || models.some(model => model.id === id)) continue;
    const named = (row as { display_name?: unknown; name?: unknown }).display_name ?? (row as { name?: unknown }).name;
    models.push({ id, label: typeof named === "string" && named.trim() && named.length <= 80 ? named.trim() : id });
    if (models.length === MAX_MODELS) break;
  }
  return models;
}

/** The relay address is an OpenAI base URL with `/v1` (the Admin sends `…/api/cloud/services/ai/v1`); an empty `provider` keeps workspace routing off it. */
export function cloudCreditInstanceConfig(credential: ServiceCredential, models: readonly CreditModel[]): InstanceConfigMap {
  return {
    [CLOUD_CREDIT_INSTANCE]: {
      driver: "openai-compat", displayName: "Trial credit · Claude",
      config: { url: credential.api, apiKeyEnv: CREDIT_KEY_ENV, provider: "", model: models[0]!.id, managedModels: models.map(model => model.id) },
      environment: { [CREDIT_KEY_ENV]: credential.token },
    },
  };
}

interface Saved { token: string; models: CreditModel[]; refused?: TrialCreditEnd }

export interface CloudCreditOptions {
  registry: ProviderRegistry;
  dataDirectory: string;
  credential: ServiceCredential | null;
  fetch?: typeof fetch;
  onChange?: (ids: string[]) => void;
  /** The relay's first model, the credit's default, is another now: bots left on the old default follow it. */
  onDefault?: (from: string, to: string) => void;
  log?: (line: string) => void;
}

export class CloudCreditProvider {
  private refused: TrialCreditEnd | null = null;
  private models: CreditModel[] = [];
  private loaded = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;
  private readonly options: CloudCreditOptions;
  private readonly fetcher: typeof fetch;
  constructor(options: CloudCreditOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  /** The credit's engine id, on this Cloud home: also a selection left on it after the token went. */
  owns(instanceId: string): boolean { return instanceId === CLOUD_CREDIT_INSTANCE; }
  status(): CloudCreditStatus { return this.refused ?? "active"; }
  /** A credit is there and not used up or ended. */
  lasts(): boolean { return this.options.credential !== null && this.refused === null; }

  async start(): Promise<void> {
    if (!this.options.credential) return;
    const saved = this.saved();
    if (saved) {
      this.refused = saved.refused ?? null;
      this.models = saved.models.length ? saved.models : [...PLACEHOLDER];
      await this.load();
      if (!this.refused) this.schedule(0);
      return;
    }
    await this.ask();
  }

  close(): void { this.closed = true; clearTimeout(this.timer); }

  private async ask(): Promise<void> {
    const credential = this.options.credential;
    if (!credential || this.closed) return;
    try {
      const response = await this.fetcher(`${credential.api}/models`, {
        headers: { authorization: `Bearer ${credential.token}`, accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text().catch(() => "");
      const body = (() => { try { return JSON.parse(text) as unknown; } catch { return null; } })();
      const refused = response.ok ? null : trialCreditRefusal(response.status, text);
      if (refused && trialCreditEnds(refused)) { await this.refuse(refused); return; }
      const models = response.ok ? parseCreditModels(body) : [];
      if (!models.length) throw new Error(`the relay answered ${response.status} with no model`);
      this.attempt = 0;
      const changed = models.map(model => model.id).join() !== this.models.map(model => model.id).join() || !this.loaded;
      const before = this.models[0]?.id;
      this.models = models;
      this.save();
      if (changed) await this.load();
      if (before && before !== models[0]!.id) this.options.onDefault?.(before, models[0]!.id);
    } catch (error) {
      // Names only: never the token or what the relay sent.
      if (this.loaded) return;
      this.options.log?.(`[trial credit] could not list its models yet (${error instanceof Error ? error.name : "error"}); trying again`);
      this.schedule(RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!);
    }
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => { void this.ask(); }, delay);
    this.timer.unref?.();
  }

  private async refuse(reason: TrialCreditEnd): Promise<void> {
    if (this.refused === reason) return;
    this.refused = reason;
    clearTimeout(this.timer);
    this.save();
    // Kept listed, so Engines and My Cloud's sign-in say why.
    if (!this.models.length) this.models = [...PLACEHOLDER];
    if (this.loaded) this.options.onChange?.([CLOUD_CREDIT_INSTANCE]); else await this.load();
  }

  private async load(): Promise<void> {
    const credential = this.options.credential;
    if (!credential || !this.models.length || this.closed) return;
    const catalog: ModelCatalog = { default: this.models[0]!.id, options: this.models.map(model => ({ id: model.id, label: model.label })) };
    await this.options.registry.load(cloudCreditInstanceConfig(credential, this.models), instance => this.decorate(instance, catalog));
    this.loaded = true;
    this.options.onChange?.([CLOUD_CREDIT_INSTANCE]);
  }

  private plain(event: RuntimeEvent): RuntimeEvent {
    if (event.type !== "runtime.error") return event;
    const refused = trialCreditFailure(event.message);
    return refused ? { ...event, message: TRIAL_CREDIT_REFUSED[refused], ...(refused === "paused" ? {} : { setup: true }), trialCredit: refused } : event;
  }

  private decorate(instance: ProviderInstance, models: ModelCatalog): ProviderInstance {
    instance.adapter.onEvent(event => {
      const refused = event.type === "runtime.error" ? trialCreditFailure(event.message) : null;
      if (refused && trialCreditEnds(refused)) void this.refuse(refused);
    });
    const blocked = () => this.refused ? new Error(TRIAL_CREDIT_REFUSED[this.refused]) : null;
    return {
      ...instance, models,
      refreshModels: async () => {},
      installRuntime: undefined, startAuthentication: undefined, getAuthentication: undefined, completeAuthentication: undefined,
      cancelAuthentication: undefined, signOut: undefined,
      snapshot: async () => {
        if (this.refused) return { state: "unavailable", reason: TRIAL_CREDIT_REFUSED[this.refused] };
        const snapshot = await instance.snapshot();
        return { ...snapshot, authenticated: snapshot.state === "available", billing: "metered", account: undefined };
      },
      adapter: {
        ...instance.adapter,
        onEvent: listener => instance.adapter.onEvent(event => listener(this.plain(event))),
        sendTurn: async input => {
          const refused = blocked();
          if (refused) throw refused;
          return instance.adapter.sendTurn(input);
        },
      },
      // Background calls (a title, a summary) spend the credit too, and stop with it.
      ...(instance.generateText ? {
        generateText: async (prompt: string, options?: TextGenerationOptions) => {
          const refused = blocked();
          if (refused) throw refused;
          try {
            return await instance.generateText!(prompt, options);
          } catch (error) {
            const reason = trialCreditFailure(error instanceof Error ? error.message : "");
            if (!reason) throw error;
            if (trialCreditEnds(reason)) void this.refuse(reason);
            throw new Error(TRIAL_CREDIT_REFUSED[reason]);
          }
        },
      } : {}),
    };
  }

  /** Its own folder, owned by this server and never a link into a personal one. */
  storage(): string {
    let directory = this.options.dataDirectory;
    for (const part of ["providers", "trial-credit"]) {
      directory = join(directory, part);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Trial credit storage must be an owned directory.");
    }
    return directory;
  }

  /** Kept for this token only: another token is another credit. */
  private tokenKey(): string {
    return createHash("sha256").update(this.options.credential!.token).digest("hex").slice(0, 32);
  }

  private saved(): Saved | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.options.dataDirectory, "providers", "trial-credit", "state.json"), "utf8")) as Partial<Saved>;
      if (raw?.token !== this.tokenKey()) return null;
      const models = parseCreditModels({ data: (raw.models ?? []).map(model => ({ id: model?.id, display_name: model?.label })) });
      const refused = raw.refused === "used_up" || raw.refused === "ended" ? raw.refused : undefined;
      return models.length || refused ? { token: raw.token, models, ...(refused ? { refused } : {}) } : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      writeFileAtomic(join(this.storage(), "state.json"), JSON.stringify({ token: this.tokenKey(), models: this.models, ...(this.refused ? { refused: this.refused } : {}) }), { mode: 0o600 });
    } catch (error) {
      this.options.log?.(`[trial credit] could not save its state (${error instanceof Error ? error.name : "error"})`);
    }
  }
}
