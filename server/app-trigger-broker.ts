// The connected-apps service's app-event routes (cloudflare/composio-broker), called with this installation's token.
import { z } from "zod";

export interface BrokerAccess {
  url: string;
  token: string;
}

export class BrokerError extends Error {
  readonly status: number;
  readonly retryAfterS?: number;

  constructor(message: string, status: number, retryAfterS?: number) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
  }

  /** The service or the network failed; the same call can work later. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const triggerTypeSchema = z.object({
  slug: z.string(),
  toolkit: z.string(),
  name: z.string(),
  description: z.string().default(""),
  instructions: z.string().optional(),
  type: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type BrokerTriggerType = z.infer<typeof triggerTypeSchema>;

const typesSchema = z.object({
  toolkits: z.record(z.string(), z.object({ types: z.array(triggerTypeSchema).optional(), error: z.string().optional() })),
});

const dropSchema = z.object({ count: z.number(), lastAt: z.number() });
const bindingSchema = z.object({
  triggerId: z.string(),
  slug: z.string(),
  toolkit: z.string(),
  connectedAccountId: z.string(),
  enabled: z.boolean(),
  remote: z.object({ state: z.enum(["enabled", "disabled", "missing"]), config: z.record(z.string(), z.unknown()).optional() }).nullable(),
  dropped: z.record(z.string(), dropSchema).default({}),
});
const inventorySchema = z.object({
  triggers: z.array(bindingSchema),
  unbound: z.array(z.object({ triggerId: z.string(), enabled: z.boolean() })).nullable(),
  remoteError: z.string().optional(),
  limits: z.object({ plan: z.enum(["desktop", "cloud"]), eventsPerDay: z.number() }),
  usage: z.object({ eventsToday: z.number() }),
});
export type BrokerInventory = z.infer<typeof inventorySchema>;

const brokerEventSchema = z.object({
  seq: z.number(),
  id: z.string(),
  kind: z.enum(["message", "test", "trigger_disabled", "account_expired"]),
  triggerId: z.string().nullable(),
  receivedAt: z.number(),
  event: z.object({
    id: z.string().optional(),
    type: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
});
export type BrokerEvent = z.infer<typeof brokerEventSchema>;
const pollSchema = z.object({ events: z.array(z.unknown()), cursor: z.number() });

export interface AppTriggerBroker {
  triggerTypes(apps: string[]): Promise<Record<string, { types?: BrokerTriggerType[]; error?: string }>>;
  triggerType(slug: string): Promise<BrokerTriggerType | null>;
  create(input: { slug: string; connectedAccountId: string; config: Record<string, unknown> }): Promise<{ triggerId: string }>;
  setEnabled(triggerId: string, enabled: boolean): Promise<void>;
  remove(triggerId: string): Promise<void>;
  inventory(): Promise<BrokerInventory>;
  poll(input: { after: number; waitS: number; poller: string; signal?: AbortSignal }): Promise<{ events: BrokerEvent[]; cursor: number }>;
  testEvent(triggerId: string, data: Record<string, unknown>): Promise<void>;
}

async function errorText(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const body = JSON.parse(raw) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error.slice(0, 300);
  } catch {
  }
  return `The connected-apps service answered ${response.status}`;
}

/** `access` is read on every call: the desktop hands the token over after the server starts, and a Cloud registers late. */
export function brokerClient(access: () => BrokerAccess | null, fetchImpl: typeof fetch = (...args) => fetch(...args)): AppTriggerBroker {
  async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const current = access();
    if (!current) throw new BrokerError("The connected-apps service is not set up on this computer", 0);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${current.token}`);
    if (init.body) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetchImpl(`${current.url}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs ?? 30_000)]) : AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new BrokerError(error instanceof Error ? error.message : String(error), 0);
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new BrokerError(await errorText(response), response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    return response;
  }
  const json = async (response: Response) => response.json() as Promise<unknown>;
  return {
    async triggerTypes(apps) {
      const response = await call(`/v1/trigger-types?${new URLSearchParams({ toolkits: apps.join(",") })}`);
      return typesSchema.parse(await json(response)).toolkits;
    },
    async triggerType(slug) {
      try {
        return triggerTypeSchema.parse(await json(await call(`/v1/trigger-types/${encodeURIComponent(slug)}`)));
      } catch (error) {
        if (error instanceof BrokerError && error.status === 404) return null;
        throw error;
      }
    },
    async create(input) {
      const body = z.object({ triggerId: z.string().min(1) }).parse(await json(await call("/v1/triggers", { method: "POST", body: JSON.stringify(input) })));
      return { triggerId: body.triggerId };
    },
    async setEnabled(triggerId, enabled) {
      await (await call(`/v1/triggers/${encodeURIComponent(triggerId)}`, { method: "PATCH", body: JSON.stringify({ enabled }) })).body?.cancel();
    },
    async remove(triggerId) {
      await (await call(`/v1/triggers/${encodeURIComponent(triggerId)}`, { method: "DELETE" })).body?.cancel();
    },
    async inventory() {
      return inventorySchema.parse(await json(await call("/v1/triggers")));
    },
    async poll({ after, waitS, poller, signal }) {
      const query = new URLSearchParams({ after: String(after), wait: String(waitS), limit: "50" });
      const response = await call(`/v1/events?${query}`, { headers: { "x-omb-poller": poller }, signal, timeoutMs: (waitS + 15) * 1000 });
      const body = pollSchema.parse(await json(response));
      // One malformed row must not stall the queue: it is skipped, and the cursor still moves past it.
      const events = body.events.flatMap((event) => {
        const parsed = brokerEventSchema.safeParse(event);
        return parsed.success ? [parsed.data] : [];
      });
      return { events, cursor: body.cursor };
    },
    async testEvent(triggerId, data) {
      await (await call("/v1/events/test", { method: "POST", body: JSON.stringify({ triggerId, data }) })).body?.cancel();
    },
  };
}
