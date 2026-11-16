import { z } from "zod";

/** The Grok Bot link's wire: the connected-apps service (cloudflare/composio-broker) holds the public address and relays
 * each tool call over one socket to the desktop app, which is the only author of every answer. */

/** 32 random bytes, base64url. Security: it never leaves the desktop except as the header that attaches its socket. */
export type LinkSecret = string & { readonly __brand: "LinkSecret" };
/** What the public address carries. Security: derived one way, so the address cannot attach as the desktop. */
export type LinkKey = string & { readonly __brand: "LinkKey" };

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const isLinkSecret = (value: unknown): value is LinkSecret => typeof value === "string" && KEY_SHAPE.test(value);

/** base64url(SHA-256("grok-link:" + secret)). */
export async function linkKey(secret: LinkSecret): Promise<LinkKey> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`grok-link:${secret}`)));
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") as LinkKey;
}

/** POST <service>/mcp/move/<LinkKey>: the address pasted into Grok Bot. */
export const GROK_LINK_PATH_PREFIX = "/mcp/move/";
export const GROK_LINK_MCP_PATH = /^\/mcp\/move\/([A-Za-z0-9_-]{43})$/;
/** GET with Upgrade attaches the desktop's socket; DELETE turns the link off. Both carry GROK_LINK_SECRET_HEADER. */
export const GROK_LINK_ATTACH_PATH = "/v1/grok-link";
export const GROK_LINK_SECRET_HEADER = "x-omb-link-secret";
/** A send_export document at the importer's 4 MB cap inside a JSON-RPC envelope. */
export const GROK_LINK_BODY_MAX = 4 * 1024 * 1024 + 64 * 1024;
/** Every frame the desktop sends, an answer among them. */
export const GROK_LINK_ANSWER_MAX = 256 * 1024;
/** Calls one link runs at a time, on the service and on the desktop. */
export const GROK_LINK_IN_FLIGHT = 8;
/** Close code: another desktop attached with the same secret. The one closed must not reconnect by itself. */
export const GROK_LINK_REPLACED = 4001;
/** Text frames the service answers without waking: the desktop's keepalive. */
export const GROK_LINK_PING = "ping";
export const GROK_LINK_PONG = "pong";

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.literal(true).optional(),
});
export type LinkToolResult = z.infer<typeof toolResultSchema>;

const manifestSchema = z.object({
  /** MCP protocol versions the desktop speaks, preferred first. */
  versions: z.array(z.string()).min(1),
  /** The `initialize` result; the service fills in the protocol version it picked. */
  initialize: z.record(z.string(), z.unknown()),
  /** The `tools/list` result. */
  tools: z.record(z.string(), z.unknown()),
  /** The `tools/call` result while no desktop is attached. */
  offline: toolResultSchema,
  /** The `tools/call` result when the desktop took the call and did not answer in time. */
  late: toolResultSchema,
});
/** Everything the service says without the desktop, written by the desktop on every attach. */
export type LinkManifest = z.infer<typeof manifestSchema>;

/** `message` is the caller's JSON-RPC request, as sent. */
export type ToDesktop = { t: "call"; id: string; message: unknown };
export const toDesktopSchema = z.object({ t: z.literal("call"), id: z.string().min(1).max(64), message: z.unknown() });

const callId = z.string().min(1).max(64);
export const fromDesktopSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), manifest: manifestSchema }),
  /** Receipt, sent at once: tells a sleeping computer from a slow tool. */
  z.object({ t: z.literal("got"), id: callId }),
  /** The HTTP answer to the call: `body` is JSON, and no body is an empty reply. */
  z.object({ t: z.literal("answer"), id: callId, status: z.number().int().min(200).max(599), body: z.unknown().optional() }),
]);
export type FromDesktop = z.infer<typeof fromDesktopSchema>;
