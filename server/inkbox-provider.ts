import { z } from "zod";
import type { InkboxResource } from "../shared/inkbox-setup.ts";

const key = z.string().min(1).max(4096).refine(value => !/[\r\n]/.test(value));
const handleSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).refine(value => !value.includes("--"));
export const INKBOX_RECEIVED_EVENTS = ["imessage.received", "text.received", "message.received", "call.ended", "slack.dm_received", "slack.group_dm_received", "slack.channel_message_received", "slack.mention_received", "slack.thread_reply_received", "a2a.task.created", "a2a.task.message", "a2a.task.canceled", "a2a.sent_task.updated"] as const;
export const INKBOX_TUNNEL_ZONE = "inkboxwire.com";
const tunnelSummarySchema = z.object({
  id: z.string().uuid(), tunnel_name: handleSchema, agent_identity_id: z.string().uuid(),
  public_host: z.string(), tls_mode: z.literal("edge"), status: z.literal("active"), zone: z.literal(INKBOX_TUNNEL_ZONE),
});
const tunnelSchema = tunnelSummarySchema.extend({ currently_connected: z.boolean().nullable().optional() });
export type InkboxTunnelMetadata = z.infer<typeof tunnelSchema>;
const identitySchema = z.object({
  id: z.string().uuid(), agent_handle: handleSchema, status: z.literal("active"),
  imessage_enabled: z.boolean(), signing_key_configured: z.boolean(),
  tunnel: tunnelSummarySchema,
  mailbox: z.object({ id: z.string().uuid(), email_address: z.string().email().max(320), agent_identity_id: z.string().uuid() }).nullish(),
  phone_number: z.object({ id: z.string().uuid(), number: z.string().regex(/^\+[1-9]\d{6,14}$/), agent_identity_id: z.string().uuid(), status: z.string(), sms_status: z.string().nullable().optional() }).nullish(),
});
export type InkboxIdentity = z.infer<typeof identitySchema>;
export class InkboxSetupError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InkboxSetupError("Inkbox returned an unreadable response. Try again later.", 502);
  return parsed.data;
}
export function inkboxPublicUrl(handle: string): string {
  return `https://${validated(handleSchema, handle)}.inkboxwire.com`;
}
/** Fixed endpoints, bounded reads and app-owned errors: provider data is never an instruction. */
export class InkboxProvider {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly signal?: AbortSignal;
  constructor(apiKey: string, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
    this.apiKey = validated(key, apiKey); this.fetcher = fetcher; this.signal = signal;
  }
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`https://inkbox.ai/api/v1${path}`, { method, redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(this.signal ? [this.signal] : [])]),
        headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new InkboxSetupError("Could not reach Inkbox. Check your connection and try again.", 502); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new InkboxSetupError("Inkbox rejected this key or its permissions. Check the key in Inkbox.", 400);
      if (response.status === 402) throw new InkboxSetupError("Your Inkbox account has reached its plan limit. Check your account in Inkbox.", 400);
      if (response.status === 409) throw new InkboxSetupError("Inkbox reports a setup conflict. Check the identity in Inkbox before trying again.", 409);
      throw new InkboxSetupError("Inkbox could not finish this step. Try again later.", 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new InkboxSetupError("Inkbox returned an empty response.", 502);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
        if (size > 256 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(chunk.value); }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw new InkboxSetupError("Inkbox returned an unreadable response. Try again later.", 502); }
  }
  async inspectKey() { return validated(z.object({ status: z.literal("active"), scoped_identity_id: z.string().uuid().nullable() }), await this.request("/api-keys/self")); }
  private identity(value: unknown, handle?: string): InkboxIdentity {
    const identity = validated(identitySchema, value);
    if ((identity.mailbox && identity.mailbox.agent_identity_id !== identity.id) || (identity.phone_number && identity.phone_number.agent_identity_id !== identity.id)) throw new InkboxSetupError("Inkbox returned a different resource identity.", 502);
    if (handle && identity.agent_handle !== handle) throw new InkboxSetupError("Inkbox returned a different identity.", 502);
    if (inkboxPublicUrl(identity.agent_handle) !== `https://${identity.tunnel.public_host}`) throw new InkboxSetupError("Inkbox returned an unexpected connection address.", 502);
    if (identity.tunnel.tunnel_name !== identity.agent_handle || identity.tunnel.agent_identity_id !== identity.id) throw new InkboxSetupError("Inkbox returned a different tunnel identity.", 502);
    return identity;
  }
  async createIdentity(handle: string): Promise<InkboxIdentity> {
    validated(handleSchema, handle);
    return this.identity(await this.request("/identities", "POST", { agent_handle: handle, display_name: "Mausbot", imessage_enabled: true }), handle);
  }
  async ownIdentity(id: string): Promise<InkboxIdentity> {
    const entries = await this.request("/identities");
    if (!Array.isArray(entries) || entries.length !== 1) throw new InkboxSetupError("The key must identify one Inkbox identity.", 400);
    const identity = this.identity(entries[0]);
    if (identity.id !== id) throw new InkboxSetupError("The key does not match this Inkbox identity.", 400);
    await this.getTunnel(identity.tunnel.id, identity.id, identity.agent_handle);
    return identity;
  }
  async getIdentity(handle: string): Promise<InkboxIdentity> {
    validated(handleSchema, handle);
    const identity = this.identity(await this.request(`/identities/${handle}`), handle);
    await this.getTunnel(identity.tunnel.id, identity.id, handle);
    return identity;
  }
  async enableIdentity(handle: string): Promise<InkboxIdentity> {
    validated(handleSchema, handle);
    const identity = this.identity(await this.request(`/identities/${handle}`, "PATCH", { imessage_enabled: true }), handle);
    await this.getTunnel(identity.tunnel.id, identity.id, handle);
    return identity;
  }
  /** Identity payloads contain durable summaries only. Read live ownership
   * immediately before connecting; missing state never means disconnected. */
  async getTunnel(id: string, identityId: string, handle: string): Promise<InkboxTunnelMetadata> {
    validated(z.string().uuid(), id); validated(z.string().uuid(), identityId); validated(handleSchema, handle);
    const tunnel = validated(tunnelSchema, await this.request(`/tunnels/${id}`));
    if (tunnel.id !== id || tunnel.agent_identity_id !== identityId || tunnel.tunnel_name !== handle || `https://${tunnel.public_host}` !== inkboxPublicUrl(handle)) {
      throw new InkboxSetupError("Inkbox returned a different tunnel identity or address.", 502);
    }
    if (tunnel.currently_connected !== false) throw new InkboxSetupError("This Inkbox identity may already be connected elsewhere. Close that connection or use an admin key to create a separate Mausbot identity.", 409);
    return tunnel;
  }
  async mintKey(identityId: string): Promise<string> {
    const result = validated(z.object({ api_key: key, record: z.object({ status: z.literal("active"), scoped_identity_id: z.literal(identityId) }) }),
      await this.request("/api-keys", "POST", { label: "Mausbot iMessage", scoped_identity_id: identityId }));
    return result.api_key;
  }
  async subscribe(identityId: string, handle: string): Promise<{ id: string; signingSecret: string }> {
    const url = `${inkboxPublicUrl(handle)}/inkbox`;
    const result = validated(z.object({ id: z.string().uuid(), agent_identity_id: z.literal(identityId), url: z.literal(url),
      event_types: z.array(z.string()).refine(events => INKBOX_RECEIVED_EVENTS.every(event => events.includes(event))), signing_key: key.nullish() }),
    await this.request("/webhooks/subscriptions", "POST", { agent_identity_id: identityId, url, event_types: [...INKBOX_RECEIVED_EVENTS] }));
    if (!result.signing_key) throw new InkboxSetupError("This identity already has a signing key. Use an admin API key to create a separate Mausbot identity; existing connections were not reset.", 409);
    return { id: result.id, signingSecret: result.signing_key };
  }
  async extendSubscription(subscriptionId: string, identityId: string, handle: string): Promise<void> {
    validated(z.string().uuid(), subscriptionId); validated(z.string().uuid(), identityId); validated(handleSchema, handle);
    const schema = z.object({ id: z.literal(subscriptionId), agent_identity_id: z.literal(identityId), url: z.literal(`${inkboxPublicUrl(handle)}/inkbox`), status: z.literal("active"), event_types: z.array(z.string().min(1).max(100)).max(100) });
    const path = `/webhooks/subscriptions/${subscriptionId}?scope=identity`;
    const current = validated(schema, await this.request(path));
    if (INKBOX_RECEIVED_EVENTS.every(event => current.event_types.includes(event))) return;
    const eventTypes = [...new Set([...current.event_types, ...INKBOX_RECEIVED_EVENTS])];
    const updated = validated(schema, await this.request(path, "PATCH", { event_types: eventTypes }));
    if (!eventTypes.every(event => updated.event_types.includes(event))) throw new InkboxSetupError("Inkbox did not confirm the event subscription.", 502);
  }
  /** Read channel inventory without requiring a disconnected tunnel or provisioning resources. */
  async resources(handle: string, identityId: string): Promise<InkboxResource[]> {
    validated(handleSchema, handle); validated(z.string().uuid(), identityId);
    const identity = validated(z.object({ id: z.literal(identityId), agent_handle: z.literal(handle), imessage_enabled: z.boolean(),
      mailbox: z.object({ id: z.string().uuid(), email_address: z.string().email().max(320), agent_identity_id: z.literal(identityId) }).nullish(),
      phone_number: z.object({ id: z.string().uuid(), number: z.string().regex(/^\+[1-9]\d{6,14}$/), agent_identity_id: z.literal(identityId), status: z.string(), sms_status: z.string().nullable().optional() }).nullish(),
      imessage_number: z.object({ number: z.string().regex(/^\+[1-9]\d{6,14}$/) }).nullish(),
    }), await this.request(`/identities/${handle}`));
    const results = await Promise.allSettled([
      this.request(`/slack/connections?identity_id=${encodeURIComponent(identityId)}`).then(value => validated(z.object({ connections: z.array(z.object({ id: z.string().uuid(), identity_id: z.literal(identityId), workspace_name: z.string().max(200), status: z.enum(["connected", "disconnected", "reauthorization_required"]) })) }), value)),
      this.request(`/identities/${handle}/a2a/settings`).then(value => validated(z.object({ enabled: z.boolean() }), value)),
    ]);
    const [slack, a2a] = results;
    const phone = identity.phone_number;
    return [
      { channel: "email", status: identity.mailbox ? "ready" : "error", ...(identity.mailbox ? { address: identity.mailbox.email_address } : {}), reason: identity.mailbox ? "Mailbox available to bot tools. Email senders cannot approve owner actions." : "Mailbox details could not be verified." },
      { channel: "imessage", status: identity.imessage_enabled ? "ready" : "needs_setup", ...(identity.imessage_number ? { address: identity.imessage_number.number } : {}), reason: identity.imessage_enabled ? "Enabled. Connect your phone using the pairing instructions." : "Enable iMessage in Inkbox." },
      { channel: "sms", status: phone?.status === "active" && phone.sms_status === "ready" ? "ready" : "needs_setup", ...(phone ? { address: phone.number } : {}), reason: !phone ? "No phone number attached. Provision one in Inkbox to use SMS/MMS." : phone.sms_status === "ready" ? "SMS owner chat is available. MMS is recorded for bot tools; recipient consent and carrier limits apply." : "The phone number is not ready to send SMS/MMS." },
      { channel: "calls", status: phone?.status === "active" ? "ready" : "needs_setup", ...(phone ? { address: phone.number } : {}), reason: phone?.status === "active" ? "Calling tools are available. Configure hosted voice in Inkbox before answering calls." : "Calling may use a voice-enabled iMessage line; check phone readiness with bot tools." },
      { channel: "slack", status: slack.status === "rejected" ? "error" : slack.value.connections.some(c => c.status === "connected") ? "ready" : "needs_setup", reason: slack.status === "rejected" ? "Slack connection status could not be checked." : slack.value.connections.some(c => c.status === "connected") ? "Workspace connected. Messages are available to bot tools; owner commands are not enabled." : "Install or reconnect the identity’s Slack app in Inkbox." },
      { channel: "a2a", status: a2a.status === "rejected" ? "error" : a2a.value.enabled ? "ready" : "needs_setup", reason: a2a.status === "rejected" ? "Agent communication status could not be checked." : a2a.value.enabled ? "Agent communication is enabled. Incoming tasks do not grant owner authority." : "Enable agent communication in Inkbox." },
      { channel: "whatsapp", status: "unavailable", reason: "Inkbox does not document a native WhatsApp channel." },
    ];
  }
  async router(identityId: string, handle: string) {
    const result = validated(z.object({ number: z.string().regex(/^\+[1-9]\d{6,14}$/), connect_command: z.literal(`connect @${handle}`) }),
      await this.request(`/imessage/triage-number?agent_identity_id=${encodeURIComponent(identityId)}`));
    return { number: result.number, connectText: result.connect_command, smsLink: `sms:${result.number}?&body=${encodeURIComponent(result.connect_command)}` };
  }
}
