// Typed values out of text or images, mirroring server/decider: never throws, every failure is { ok: false, reason }.
// Whose key: the person's own Workers AI token (Clairic, with Clef for yes/no and choices), else Cloud's included relay
// (only for requests it accepts), else the OpenRouter LLM fallback, else nothing. Jev does not extract. One switch for
// both helper models: decider.enabled.
import type { AppConfig } from "../config.ts";
import { helpersOn, includedAccount, openrouterAccount, sharedOpenRouterKey, workersAiAccount, type HelperAccount } from "../decider/accounts.ts";
import type { DeciderFailure } from "../decider/types.ts";
import { EXTRACT_KEY_CHECK, extractRequestProblem, relayAcceptsExtract } from "./contract.ts";
import { extractWithOpenRouter, extractWithRelay, OPENROUTER_EXTRACT_MODEL } from "./remote.ts";
import type { ExtractBackendRequest, ExtractBackendResult, ExtractInput, ExtractOptions, ExtractResult, ExtractSeam, FieldSchema } from "./types.ts";
import { extractWithWorkersAi } from "./workers-ai.ts";

export type { ExtractInput, ExtractResult, ExtractSeam, FieldSchema } from "./types.ts";

export const DEFAULT_EXTRACT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;

/** In order: own Workers AI, Cloud's included relay (only for requests it accepts), OpenRouter, nothing. */
export function extractorAccount(cfg: AppConfig, request?: { seam: ExtractSeam; fields: FieldSchema; input: ExtractInput }): HelperAccount | null {
  const candidates = [workersAiAccount(cfg), includedAccount(), openrouterAccount(cfg)];
  return candidates.find((account): account is HelperAccount =>
    Boolean(account) && !(account!.included && request && !relayAcceptsExtract(request.seam, request.fields, request.input))) ?? null;
}

export function extractorReady(cfg: AppConfig): boolean {
  return helpersOn(cfg, extractorAccount(cfg));
}

/** Settings: which backend reads, never a key. */
export function describeExtractor(cfg: AppConfig): { provider?: HelperAccount["provider"]; included?: true; ready: boolean } {
  const account = extractorAccount(cfg);
  return { ...(account ? { provider: account.provider } : {}), ...(account?.included ? { included: true as const } : {}), ready: helpersOn(cfg, account) };
}

/** The OpenRouter model extraction uses: the decider's own when it is a chat model, else a default one. */
function openrouterModel(cfg: AppConfig): string {
  const own = cfg.decider?.openrouterModel?.trim();
  return own && cfg.decider?.openrouterApi === "chat" ? own : OPENROUTER_EXTRACT_MODEL;
}

const today = (timeZone?: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

export interface ExtractorDeps {
  config(): AppConfig;
  fetch?: typeof fetch;
  now?: () => number;
  timeZone?: () => string | undefined;
}

export interface Extractor {
  extract(seam: ExtractSeam, fields: FieldSchema, input: ExtractInput, options?: ExtractOptions): Promise<ExtractResult>;
  /** One tiny extraction, whatever the switch says: the Settings Test button. */
  testKey(options?: ExtractOptions): Promise<ExtractResult>;
}

export function createExtractor(deps: ExtractorDeps): Extractor {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());

  async function call(account: HelperAccount, cfg: AppConfig, seam: ExtractSeam, fields: FieldSchema, input: ExtractInput, options: ExtractOptions): Promise<ExtractResult> {
    const provider = account.provider;
    if (options.signal?.aborted) return { ok: false, provider, reason: "cancelled" };
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ExtractBackendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
    });
    const request: ExtractBackendRequest = {
      key: account.token, baseUrl: account.api, ...(account.accountId ? { accountId: account.accountId } : {}),
      ...(provider === "openrouter" ? { model: openrouterModel(cfg) } : {}),
      seam, fields, input, referenceDate: today(deps.timeZone?.()), signal: controller.signal, fetch: fetchImpl,
    };
    const backend = provider === "workersai" ? extractWithWorkersAi : provider === "openrouter" ? extractWithOpenRouter : extractWithRelay;
    const started = now();
    let outcome: ExtractBackendResult;
    try {
      outcome = await Promise.race([Promise.resolve().then(() => backend(request)).catch((): ExtractBackendResult => ({ ok: false, reason: "malformed" })), timedOut]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    if (!outcome.ok) {
      const reason: DeciderFailure = outcome.reason !== "timeout" && options.signal?.aborted ? "cancelled" : outcome.reason;
      return { ok: false, provider, reason, ...(outcome.status ? { status: outcome.status } : {}), latencyMs };
    }
    return { ok: true, provider, values: outcome.values, ...(outcome.model ? { model: outcome.model } : {}), latencyMs };
  }

  return {
    async extract(seam, fields, input, options = {}) {
      try {
        if (extractRequestProblem(fields, input) !== null) return { ok: false, reason: "misconfigured" };
        const cfg = deps.config();
        if (cfg.decider?.provider === "off") return { ok: false, reason: "disabled" };
        const any = extractorAccount(cfg);
        if (!any) return { ok: false, reason: cfg.decider?.enabled === true ? "no_key" : "disabled" };
        if (!helpersOn(cfg, any)) return { ok: false, reason: "disabled" };
        if (seam === "inboxTriage" && cfg.decider?.jobs?.inboxTriage === false) return { ok: false, reason: "job_off" };
        const account = extractorAccount(cfg, { seam, fields, input });
        // Through the included token, only the exact requests the relay takes.
        if (!account) return { ok: false, reason: any.included ? "misconfigured" : "no_key" };
        return await call(account, cfg, seam, fields, input, options);
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
    async testKey(options = {}) {
      try {
        const cfg = deps.config();
        const account = extractorAccount(cfg, { seam: "keyCheck", ...EXTRACT_KEY_CHECK });
        if (!account) return { ok: false, reason: "no_key" };
        return await call(account, cfg, "keyCheck", EXTRACT_KEY_CHECK.fields, EXTRACT_KEY_CHECK.input, { timeoutMs: 10_000, ...options });
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
  };
}

/** Settings' "Decision and extraction" page: which of the person's own keys are on file and who reads, never a key.
 * The Cloudflare account ID is not a secret, so it is shown back. */
export function describeHelpers(cfg: AppConfig) {
  const accountId = cfg.decider?.workersAiAccountId?.trim();
  return {
    own: { jev: Boolean(cfg.decider?.key?.trim()), workersAi: Boolean(cfg.decider?.workersAiToken?.trim()), openrouter: Boolean(cfg.decider?.openrouterKey?.trim()) },
    ...(sharedOpenRouterKey(cfg) ? { sharedKey: true as const } : {}),
    ...(accountId ? { workersAiAccountId: accountId } : {}),
    extraction: describeExtractor(cfg),
  };
}
