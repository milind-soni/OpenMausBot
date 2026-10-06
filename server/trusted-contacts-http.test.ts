import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { contactReplySchema } from "../shared/trusted-contacts.ts";
import { TrustedContacts } from "./trusted-contacts.ts";
import { createContactIngress, parseContactText, replyText, replyToContactText, TrustedPeers } from "./trusted-contacts-http.ts";

const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const start = Date.now() + 86400000; const end = start + 3600000;
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-contact-http-")); roots.push(root);
  const service = new TrustedContacts({ file: join(root, "contacts.json"), botExists: () => true });
  service.configure({ botId: "bot", source: "manual", slots: [{ start, end }], calendarIds: ["primary"] });
  const { contact, token } = service.createContact({ name: "Peer", botId: "bot" });
  service.grant(contact.id, { start, end, capabilities: ["availability", "propose"], expiresAt: end });
  const handler = createContactIngress(service);
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  servers.push(server); await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  return { service, root, token, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
it("enforces contact authentication and deduplicates requests over HTTP", async () => {
  const f = await fixture(); const url = `${f.base}/contacts/v1/requests`;
  const body = JSON.stringify({ id: "once", kind: "availability", start, end, durationMinutes: 30 });
  expect((await fetch(url, { method: "POST", body })).status).toBe(401);
  const send = () => fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body });
  const first = contactReplySchema.parse(await (await send()).json()); expect(first.status).toBe("completed");
  expect(await (await send()).json()).toEqual(first);
  const stranger = f.service.createContact({ name: "Other", botId: "bot" });
  expect((await fetch(`${url}/${first.id}`, { headers: { authorization: `Bearer ${stranger.token}` } })).status).toBe(404);
  expect(JSON.stringify(first)).not.toContain("contactId");
});
it("coordinates two independent instances and refreshes a pending proposal", async () => {
  const f = await fixture(); const local = await fixture();
  const peers = new TrustedPeers(join(local.root, "peers.json"));
  const peer = peers.add({ name: "Other Mausbot", endpoint: f.base, token: f.token });
  expect(JSON.stringify(peers.snapshot())).not.toContain(f.token);
  const sent = await peers.send(peer.id, { id: "coffee", kind: "proposal", subject: "Coffee", start, end });
  expect(sent.reply?.status).toBe("pending");
  await f.service.decide(sent.reply!.id, "approve");
  const refreshed = await peers.refresh(sent.id);
  expect(refreshed.reply?.status).toBe("completed");
  expect(new TrustedPeers(join(local.root, "peers.json")).snapshot().requests[0]?.reply?.status).toBe("completed");
});
it("parses explicit time zones and rejects ambiguous text without calling an agent", () => {
  const result = parseContactText("message-1", "free 2026-11-01T09:00:00+05:30 2026-11-01T10:00:00+05:30 30");
  expect(result.kind).toBe("availability"); expect(result.start).toBe(Date.parse("2026-11-01T03:30:00Z"));
  expect(() => parseContactText("message-2", "free tomorrow morning")).toThrow("free");
  expect(() => parseContactText("message-3", "free 2026-11-01T09:00:00 2026-11-01T10:00:00 30")).toThrow();
  expect(replyText({ id: "id", status: "completed", text: "Available", slots: [{ start, end }] })).toContain(new Date(start).toISOString());
});
it("refuses credential-bearing URLs and redirects without forwarding a secret", async () => {
  const f = await fixture(); const peers = new TrustedPeers(join(f.root, "peers.json"));
  expect(() => peers.add({ name: "bad", endpoint: "https://user:password@example.test", token: f.token })).toThrow();
  const redirect = createServer((_req, res) => { res.writeHead(302, { location: `${f.base}/contacts/v1/requests` }); res.end(); });
  servers.push(redirect); await new Promise<void>(ready => redirect.listen(0, "127.0.0.1", ready));
  const peer = peers.add({ name: "redirect", endpoint: `http://127.0.0.1:${(redirect.address() as AddressInfo).port}`, token: f.token });
  const result = await peers.send(peer.id, { id: "test", kind: "availability", start, end, durationMinutes: 30 });
  expect(result.status).toBe("uncertain"); expect(f.service.snapshot().requests).toHaveLength(0);
});
it("gives known messaging contacts safe help and refusals without exposing internal failures", async () => {
  const f = await fixture(); const contactId = f.service.authenticate(f.token);
  expect(await replyToContactText(f.service, contactId, "bad-text", "hello tomorrow")).toContain("Use: free");
  f.service.revoke(contactId);
  expect(await replyToContactText(f.service, contactId, "revoked", `free ${new Date(start).toISOString()} ${new Date(end).toISOString()} 30`)).toContain("No active grant");
});
