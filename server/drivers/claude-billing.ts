import type { ProviderSnapshot } from "../contracts.ts";

/** What a Claude instance's turns bill: `claude -p` runs on an ANTHROPIC_API_KEY in its environment ahead of any login,
 * billed per token (2.1.303), as it does on the CLI's own API-key sign-in. */
export function claudeBilling(env: NodeJS.ProcessEnv, account: ProviderSnapshot["account"]): Pick<ProviderSnapshot, "account" | "billing"> {
  return env.ANTHROPIC_API_KEY || account?.method === "api-key"
    ? { account: { ...account, method: "api-key" }, billing: "metered" }
    : { billing: "subscription" };
}

interface CallUsage {
  id?: string;
  usage: Record<string, number>;
}

const calls = new WeakMap<object, CallUsage>();
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** One model call's usage from its stream: `message_start` opens it, and each `message_delta` carries the running totals,
 * a field it leaves null keeping its start value (stream-json with --include-partial-messages, 2.1.303). The assistant
 * frames repeat the start's figures, so only the delta reports the call's whole output. */
export function claudeCallUsage(session: object, event: { type?: unknown; message?: { id?: unknown; usage?: unknown }; usage?: unknown }) {
  if (event.type === "message_start") {
    const usage = event.message?.usage && typeof event.message.usage === "object" ? event.message.usage as Record<string, unknown> : {};
    calls.set(session, { ...(typeof event.message?.id === "string" ? { id: event.message.id } : {}),
      usage: Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === "number")) as Record<string, number> });
    return null;
  }
  const call = calls.get(session);
  if (event.type !== "message_delta" || !call || !event.usage || typeof event.usage !== "object") return null;
  for (const [key, value] of Object.entries(event.usage)) if (typeof value === "number") call.usage[key] = value;
  const { input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: written, output_tokens: output } = call.usage;
  if (!count(fresh) && !count(read) && !count(written)) return null;
  return {
    type: "thread.token-usage.updated" as const, ...(call.id ? { itemId: call.id } : {}),
    input: count(fresh) + count(read), output: count(output), ...(typeof read === "number" ? { cachedInput: read } : {}),
    contextTokens: count(fresh) + count(read) + count(written),
  };
}
