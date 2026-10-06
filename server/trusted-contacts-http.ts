import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ContactError, type TrustedContacts } from "./trusted-contacts.ts";
import { json, readBody } from "./harness/http.ts";
import { writeFileAtomic } from "./atomic.ts";
import { contactReplySchema, contactRequestSchema, type ContactReply, type ContactRequestInput } from "../shared/trusted-contacts.ts";

export function contactErrorResponse(res: ServerResponse, error: unknown) {
  const bodyError = z.object({ status: z.union([z.literal(400), z.literal(413)]) }).safeParse(error);
  const status = error instanceof ContactError ? error.status : error instanceof z.ZodError ? 400 : bodyError.success ? bodyError.data.status : 500;
  json(res, status, { error: error instanceof ContactError ? error.message : status === 400 ? "Invalid contact request" : "Contact operation failed" });
}
export function createContactIngress(service: TrustedContacts) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/contacts/")) return false;
    res.setHeader("cache-control", "no-store");
    try {
      const token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      service.authenticate(token);
      if (req.method === "POST" && path === "/contacts/v1/requests") {
        json(res, 200, await service.receive(token, await readBody(req, 16000)));
      } else {
        const match = /^\/contacts\/v1\/requests\/([\w-]+)$/.exec(path);
        if (match && req.method === "GET") json(res, 200, service.result(token, match[1]!));
        else json(res, 404, { error: "Unknown contact endpoint" });
      }
    } catch (error) { contactErrorResponse(res, error); }
    return true;
  };
}
const help = "Use: free START END MINUTES, or meet START END SUBJECT. Use ISO dates with a timezone, for example 2026-11-01T09:00:00+05:30.";
const datePattern = z.string().datetime({ offset: true });
export function parseContactText(id: string, text: string): ContactRequestInput {
  const parts = text.trim().split(/\s+/); const [command, from, until, ...rest] = parts;
  if (!from || !until || !datePattern.safeParse(from).success || !datePattern.safeParse(until).success) throw new ContactError(help);
  const start = Date.parse(from); const end = Date.parse(until);
  const request = command?.toLowerCase() === "free" && rest.length === 1
    ? { id, kind: "availability", start, end, durationMinutes: Number(rest[0]) }
    : command?.toLowerCase() === "meet" ? { id, kind: "proposal", start, end, subject: rest.join(" ") } : null;
  const parsed = contactRequestSchema.safeParse(request);
  if (!parsed.success) throw new ContactError(help);
  return parsed.data;
}
export function replyText(reply: ContactReply): string {
  return [reply.text, ...(reply.slots ?? []).slice(0, 10).map(s => `${new Date(s.start).toISOString()} — ${new Date(s.end).toISOString()}`),
    ...(reply.status === "pending" ? [`Request: ${reply.id}. Send status ${reply.id} to check it.`] : [])].join("\n");
}
export async function receiveContactText(service: TrustedContacts, contactId: string, eventId: string, text: string): Promise<string> {
  const match = /^status ([\w-]+)$/i.exec(text.trim());
  const reply = match ? service.resultFor(contactId, match[1]!) : await service.receiveFrom(contactId, parseContactText(eventId, text));
  return replyText(reply);
}

/** Reply only with our own safe validation/refusal text; never relay provider
 * errors, stack traces or disk paths to a phone contact. */
export async function replyToContactText(service: TrustedContacts, contactId: string, eventId: string, text: string): Promise<string> {
  try { return await receiveContactText(service, contactId, eventId, text); }
  catch (error) {
    if (error instanceof ContactError) return error.message;
    if (error instanceof z.ZodError) return help;
    throw error; // Preserve uncertain processing as a failed delivery for local recovery.
  }
}

const endpointSchema = z.string().max(2000).transform(value => value.replace(/\/+$/, "")).refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" &&
      (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname));
  } catch { return false; }
}, "Use an HTTPS origin, or loopback HTTP for local testing");
const peerInput = z.object({ name: z.string().trim().min(1).max(80), endpoint: endpointSchema, token: z.string().regex(/^[\w-]{43}$/) }).strict();
const peerSchema = peerInput.extend({ id: z.string().uuid() });
const outboundSchema = z.object({
  id: z.string().uuid(), peerId: z.string().uuid(), input: contactRequestSchema,
  status: z.enum(["sending", "replied", "uncertain"]), reply: contactReplySchema.optional(), error: z.string().optional(),
});
const peerState = z.object({ version: z.literal(1), peers: z.array(peerSchema).max(100), requests: z.array(outboundSchema).max(1000) });
type PeerState = z.infer<typeof peerState>;
export type PeerRequest = z.infer<typeof outboundSchema>;
export class TrustedPeers {
  private state: PeerState;
  private inFlight = new Set<string>();
  private file: string;
  constructor(file: string) {
    this.file = file;
    this.state = existsSync(file) ? peerState.parse(JSON.parse(readFileSync(file, "utf8"))) : { version: 1, peers: [], requests: [] };
    if (this.state.requests.some(r => r.status === "sending")) {
      const next = structuredClone(this.state);
      for (const r of next.requests) if (r.status === "sending") { r.status = "uncertain"; r.error = "Delivery was interrupted. Check the other Mausbot before sending again."; }
      this.save(next);
    }
  }
  private save(state: PeerState) { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); writeFileAtomic(this.file, JSON.stringify(state), { mode: 0o600 }); this.state = state; }
  snapshot() { return structuredClone({ peers: this.state.peers.map(({ token: _token, ...peer }) => peer), requests: this.state.requests }); }
  add(value: unknown) {
    const peer = { ...peerInput.parse(value), id: randomUUID() };
    if (this.state.peers.length >= 100) throw new ContactError("Peer limit reached", 409);
    const next = structuredClone(this.state); next.peers.push(peer); this.save(next);
    const { token: _token, ...publicPeer } = peer; return publicPeer;
  }
  remove(id: string) { const next = structuredClone(this.state); next.peers = next.peers.filter(p => p.id !== id); this.save(next); }
  async send(peerId: string, value: unknown): Promise<PeerRequest> {
    const input = contactRequestSchema.parse(value);
    if (!this.state.peers.some(p => p.id === peerId)) throw new ContactError("Unknown peer", 404);
    const old = this.state.requests.find(r => r.peerId === peerId && r.input.id === input.id);
    if (old) {
      if (JSON.stringify(input) !== JSON.stringify(old.input)) throw new ContactError("Request ID already has different content", 409);
      return structuredClone(old);
    }
    if (this.state.requests.length >= 1000) throw new ContactError("Peer request history is full", 429);
    const row: PeerRequest = { id: randomUUID(), peerId, input, status: "sending" };
    const next = structuredClone(this.state); next.requests.push(row); this.save(next);
    return this.deliver(row, false);
  }
  async refresh(id: string): Promise<PeerRequest> {
    const row = this.state.requests.find(r => r.id === id);
    if (!row?.reply) throw new ContactError("No remote request ID is available to refresh", 409);
    if (row.reply.status !== "pending") return structuredClone(row);
    return this.deliver(row, true);
  }
  private async deliver(row: PeerRequest, refresh: boolean): Promise<PeerRequest> {
    if (this.inFlight.has(row.id)) throw new ContactError("Request is already in progress", 409);
    const peer = this.state.peers.find(p => p.id === row.peerId);
    if (!peer) throw new ContactError("Unknown peer", 404);
    this.inFlight.add(row.id);
    let reply: ContactReply | undefined; let error: string | undefined;
    try {
      const response = await fetch(`${peer.endpoint}/contacts/v1/requests${refresh ? `/${row.reply!.id}` : ""}`, {
        method: refresh ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${peer.token}`, "content-type": "application/json" },
        ...(refresh ? {} : { body: JSON.stringify(row.input) }),
      });
      if (!response.ok) throw new Error(`Remote Mausbot returned HTTP ${response.status}`);
      const reader = response.body?.getReader(); if (!reader) throw new Error("Empty remote response");
      let body = ""; let bytes = 0; const decoder = new TextDecoder();
      try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 32000) throw new Error("Oversized remote response"); body += decoder.decode(item.value, { stream: true }); } body += decoder.decode(); } finally { await reader.cancel(); }
      reply = contactReplySchema.parse(JSON.parse(body));
      if (refresh && reply.id !== row.reply!.id) throw new Error("Remote request identity changed");
      if (reply.slots?.some(s => s.start < row.input.start || s.end > row.input.end)) throw new Error("Remote availability exceeds requested dates");
      if (!this.state.peers.some(p => p.id === peer.id)) throw new Error("Peer was removed while the request was running");
    } catch { reply = undefined; error = "Remote delivery could not be verified. Check the other Mausbot before sending again."; }
    finally { this.inFlight.delete(row.id); }
    const next = structuredClone(this.state); const record = next.requests.find(r => r.id === row.id)!;
    record.status = reply ? "replied" : "uncertain"; if (reply) record.reply = reply; if (error) record.error = error; else delete record.error;
    this.save(next); return structuredClone(record);
  }
}
