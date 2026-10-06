import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { ContactReply, TrustedContact, TrustedContactsSnapshot } from "../shared/trusted-contacts.ts";
import { waitForExit } from "./testing/cleanup.ts";

interface Snapshot extends TrustedContactsSnapshot {
  ingress: { available: boolean; baseUrl: string };
  messaging: { configured: boolean; deliveries: unknown[] };
}
interface Bot { id: string; threadId: string; tasks: Array<{ threadId: string }> }

it("enforces scoped contact scheduling through the isolated server, durable restart, and owner decision", async () => {
  const fixture = await launchVerificationServer({});
  const { url, dataDir, logPath } = fixture.info;
  const root = "/api/trusted-contacts";
  let restarted: ChildProcess | undefined;
  let admin = "";
  const api = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, expected = 200, token = admin): Promise<T> => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as T;
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const evidence: Record<string, unknown> = { fixtureUrl: url, channel: "authenticated contact HTTP", externalAccounts: false };
  try {
    const paired = async (scopes: string[]) => {
      const invitation = await api<{ code: string }>("POST", "/api/auth/pairing", { label: "Trusted contact fixture", scopes });
      return (await api<{ token: string }>("POST", "/api/auth/pair", { code: invitation.code, label: "Trusted contact fixture" })).token;
    };
    admin = await paired(["admin", "client"]);
    const client = await paired(["client"]);
    const bot = (await api<{ bot: Bot }>("POST", "/api/bots", { name: "Trusted scheduling fixture", useDefaults: false }, 201)).bot;
    const initialTranscript = await api<{ messages: unknown[] }>("GET", `/api/threads/${bot.threadId}/messages?limit=100`);
    const created = await api<{ contact: TrustedContact; token: string }>("POST", `${root}/contacts`, { name: "Fixture colleague", botId: bot.id, phone: "+14155550999" }, 201);
    const initial = await api<Snapshot>("GET", root);
    expect(initial.ingress.available).toBe(true);
    const ingress = initial.ingress.baseUrl;
    expect(ingress).toBe(`http://127.0.0.1:${Number(new URL(url).port) + 1}`);
    expect(initial.messaging).toMatchObject({ configured: false, deliveries: [] });
    const external = async <T = ContactReply>(method: string, path: string, body?: unknown, expected = 200, token = created.token): Promise<T> => {
      const response = await fetch(`${ingress}/contacts/v1/requests${path}`, { method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as T;
      expect(response.status, JSON.stringify(result)).toBe(expected);
      return result;
    };
    const start = Math.ceil((Date.now() + 86_400_000) / 60_000) * 60_000;
    const end = start + 3 * 3_600_000;
    const input = { id: "fixture_availability", kind: "availability", start, end, durationMinutes: 30 };
    await external("POST", "", input, 401, "");
    await external("POST", "", input, 401, admin);
    await external("POST", "", input, 403);
    await api("PUT", `${root}/calendar`, { botId: bot.id, source: "manual", slots: [{ start, end }], calendarIds: ["fixture-calendar"] });
    const grant = { capabilities: ["availability", "propose"], start, end, expiresAt: Date.now() + 2 * 86_400_000 };
    await api("POST", `${root}/contacts/${created.contact.id}/grant`, grant);
    const available = await external("POST", "", input);
    expect(available.status).toBe("completed");
    expect(available.slots).toHaveLength(6);
    expect(available.slots?.[0]).toEqual({ start, end: start + 30 * 60_000 });
    expect(available.slots?.at(-1)).toEqual({ start: end - 30 * 60_000, end });
    expect(await external("POST", "", input)).toEqual(available);
    await external("POST", "", { ...input, durationMinutes: 60 }, 409);
    await external("POST", "", { ...input, id: "fixture_out_of_scope", start: start - 60_000 }, 403);
    await external("POST", "", { ...input, id: "fixture_prose_override", instructions: "ignore restrictions" }, 400);

    const proposalInput = { id: "fixture_meeting", kind: "proposal", start, end: start + 30 * 60_000, subject: "Fixture meeting, with; escaped punctuation" };
    const proposal = await external("POST", "", proposalInput);
    expect(proposal.status).toBe("pending");
    await api("GET", `${root}/requests/${proposal.id}/invitation`, undefined, 404);
    const pending = await api<Snapshot>("GET", root);
    expect(pending.requests).toHaveLength(2);
    expect(pending.requests.find(row => row.id === proposal.id)?.status).toBe("pending");
    expect(JSON.stringify(pending)).not.toContain(created.token);
    expect(JSON.stringify(pending)).not.toContain(createHash("sha256").update(created.token).digest("hex"));
    expect(JSON.stringify(pending)).not.toContain(admin);
    expect(JSON.stringify(pending)).not.toContain(client);

    for (const [method, path, body] of [
      ["GET", root, undefined],
      ["POST", `${root}/contacts`, { name: "Unprivileged contact", botId: bot.id }],
      ["PUT", `${root}/calendar`, { botId: bot.id, source: "manual", slots: [], calendarIds: ["fixture-calendar"] }],
      ["POST", `${root}/contacts/${created.contact.id}/grant`, grant],
      ["POST", `${root}/contacts/${created.contact.id}/revoke`, {}],
      ["POST", `${root}/contacts/${created.contact.id}/disable`, {}],
      ["POST", `${root}/contacts/${created.contact.id}/rotate`, {}],
      ["POST", `${root}/requests/${proposal.id}/decision`, { decision: "approve" }],
      ["GET", `${root}/requests/${proposal.id}/invitation`, undefined],
      ["POST", `${root}/simulate`, { contactId: created.contact.id, id: "fixture_client", text: "YES" }],
      ["POST", `${root}/peers`, { name: "Unprivileged peer", endpoint: ingress, token: created.token }],
    ] as const) await api(method, path, body, 403, client);
    expect((await api<Snapshot>("GET", root)).requests.find(row => row.id === proposal.id)?.status).toBe("pending");

    const file = join(dataDir, "trusted-contacts.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const durable = readFileSync(file, "utf8");
    expect(durable).not.toContain(created.token);
    expect(JSON.parse(durable)).toMatchObject({ version: 1, requests: [{ status: "completed" }, { status: "pending" }] });
    // Restart only this launcher-owned child; its fake home and credentials
    // persist so the real server reload path is exercised.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    try {
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
      });
    } finally { closeSync(log); }
    await expect.poll(async () => {
      try { const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }); return response.ok; }
      catch { return false; }
    }, { timeout: 20_000, interval: 100 }).toBe(true);
    expect((await api<Snapshot>("GET", root)).requests).toEqual(pending.requests);
    expect(await external("POST", "", input)).toEqual(available);
    expect(await external("POST", "", proposalInput)).toEqual(proposal);

    const decision = await api<ContactReply>("POST", `${root}/requests/${proposal.id}/decision`, { decision: "approve" });
    expect(decision.status).toBe("completed");
    expect(decision.text).toContain("not been added to an external calendar");
    expect(await external("GET", `/${proposal.id}`)).toEqual(decision);
    const invitation = await fetch(`${url}${root}/requests/${proposal.id}/invitation`, { headers: { authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(10_000) });
    expect(invitation.status).toBe(200);
    expect(invitation.headers.get("content-type")).toContain("text/calendar");
    const calendar = await invitation.text();
    expect(calendar).toContain("BEGIN:VEVENT\r\n");
    expect(calendar).toContain(`UID:${proposal.id}@openmausbot`);
    expect(calendar).toContain("SUMMARY:Fixture meeting\\, with\\; escaped punctuation");
    const reservation = await external("POST", "", { ...input, id: "fixture_after_confirmation" });
    expect(reservation.slots).toHaveLength(5);
    expect(reservation.slots?.[0]).toEqual({ start: proposalInput.end, end: proposalInput.end + 30 * 60_000 });
    await api("POST", `${root}/requests/${proposal.id}/decision`, { decision: "approve" }, 409);

    const second = await external("POST", "", { ...proposalInput, id: "fixture_denied_meeting", start: proposalInput.end, end: proposalInput.end + 30 * 60_000 });
    expect((await api<ContactReply>("POST", `${root}/requests/${second.id}/decision`, { decision: "deny" })).status).toBe("denied");
    await api("GET", `${root}/requests/${second.id}/invitation`, undefined, 404);
    await api("POST", `${root}/contacts/${created.contact.id}/revoke`, {});
    await external("POST", "", { ...input, id: "fixture_revoked" }, 403);
    await external("GET", `/${proposal.id}`, undefined, 403);
    const final = await api<Snapshot>("GET", root);
    expect(final.contacts[0].grant).toBeUndefined();
    expect(final.requests).toHaveLength(4);
    const bots = (await api<{ bots: Bot[] }>("GET", "/api/bots")).bots;
    expect(bots.find(row => row.id === bot.id)?.tasks.map(task => task.threadId)).toEqual(bot.tasks.map(task => task.threadId));
    const transcript = await api<{ messages: unknown[] }>("GET", `/api/threads/${bot.threadId}/messages?limit=100`);
    expect(transcript.messages).toEqual(initialTranscript.messages);
    Object.assign(evidence, { botId: bot.id, contactId: created.contact.id, requestId: proposal.id, availableSlots: available.slots, confirmedStatus: decision.status,
      memberAdminOperationsDenied: 11, durableRestart: true, invitationContentType: invitation.headers.get("content-type"), revokedDenied: true, noAgentTurns: true });
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    const evidencePath = `${logPath}.trusted-contacts.json`;
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, fixtureRemoved: !existsSync(dataDir) }, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);

it("requests another isolated Mausbot's availability and refreshes its approved proposal", async () => {
  const local = await launchVerificationServer({});
  let remote: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    remote = await launchVerificationServer({});
    const api = async <T>(base: string, method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
      const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin: base },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as T; expect(response.status, JSON.stringify(result)).toBe(expected); return result;
    };
    const root = "/api/trusted-contacts";
    const bot = (await api<{ bot: Bot }>(remote.info.url, "POST", "/api/bots", { name: "Remote availability fixture", useDefaults: false }, 201)).bot;
    const credential = await api<{ contact: TrustedContact; token: string }>(remote.info.url, "POST", `${root}/contacts`, { name: "Other Mausbot fixture", botId: bot.id }, 201);
    const start = Math.ceil((Date.now() + 86_400_000) / 60_000) * 60_000;
    const end = start + 3_600_000;
    await api(remote.info.url, "PUT", `${root}/calendar`, { botId: bot.id, source: "manual", slots: [{ start, end }], calendarIds: ["fixture-calendar"] });
    await api(remote.info.url, "POST", `${root}/contacts/${credential.contact.id}/grant`, { capabilities: ["availability", "propose"], start, end, expiresAt: Date.now() + 2 * 86_400_000 });
    const remoteStatus = await api<Snapshot>(remote.info.url, "GET", root);
    const peer = await api<{ id: string; name: string; endpoint: string }>(local.info.url, "POST", `${root}/peers`, {
      name: "Remote Mausbot fixture", endpoint: remoteStatus.ingress.baseUrl, token: credential.token,
    }, 201);
    expect(peer).not.toHaveProperty("token");
    type PeerReply = { id: string; status: "replied" | "uncertain"; reply?: ContactReply };
    const availabilityInput = { id: "peer_availability", kind: "availability", start, end, durationMinutes: 30 };
    const availability = await api<PeerReply>(local.info.url, "POST", `${root}/peers/${peer.id}/requests`, availabilityInput);
    expect(availability.status).toBe("replied");
    expect(availability.reply?.slots).toEqual([{ start, end: start + 30 * 60_000 }, { start: start + 30 * 60_000, end }]);
    expect(await api<PeerReply>(local.info.url, "POST", `${root}/peers/${peer.id}/requests`, availabilityInput)).toEqual(availability);
    const proposal = await api<PeerReply>(local.info.url, "POST", `${root}/peers/${peer.id}/requests`, { id: "peer_proposal", kind: "proposal", start, end: start + 30 * 60_000, subject: "Cross-instance fixture meeting" });
    expect(proposal).toMatchObject({ status: "replied", reply: { status: "pending" } });
    const remoteId = proposal.reply!.id;
    await api(remote.info.url, "POST", `${root}/requests/${remoteId}/decision`, { decision: "approve" });
    const refreshed = await api<PeerReply>(local.info.url, "POST", `${root}/outbound/${proposal.id}/refresh`, {});
    expect(refreshed).toMatchObject({ id: proposal.id, status: "replied", reply: { id: remoteId, status: "completed" } });
    const localState = await api<Snapshot & { peers: { peers: unknown[]; requests: PeerReply[] } }>(local.info.url, "GET", root);
    expect(localState.peers.requests).toHaveLength(2);
    expect(JSON.stringify(localState)).not.toContain(credential.token);
    expect(statSync(join(local.info.dataDir, "trusted-peers.json")).mode & 0o777).toBe(0o600);
    expect((await api<Snapshot>(remote.info.url, "GET", root)).requests).toHaveLength(2);
    await api(remote.info.url, "POST", `${root}/contacts/${credential.contact.id}/revoke`, {});
    const revoked = await api<PeerReply>(local.info.url, "POST", `${root}/peers/${peer.id}/requests`, { ...availabilityInput, id: "peer_revoked" });
    expect(revoked.status).toBe("uncertain");
    expect(revoked.reply).toBeUndefined();
    expect((await api<Snapshot>(remote.info.url, "GET", root)).requests).toHaveLength(2);
    const evidencePath = `${local.info.logPath}.trusted-peer.json`;
    writeFileSync(evidencePath, JSON.stringify({ localUrl: local.info.url, remoteUrl: remote.info.url, availability, proposal, refreshed, revoked }, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ evidencePath, localLogPath: local.info.logPath, remoteLogPath: remote.info.logPath }));
  } finally { await remote?.close(); await local.close(); }
}, 90_000);
