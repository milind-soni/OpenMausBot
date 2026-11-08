// A loopback stand-in for Sendblue's API: lines/state names the numbers a key owns, messages lists what a test pushed
// with the filters the poller uses, send-message records what was sent. Only the given keys are known; any other
// answers 401. A sender that has not texted the number first is refused, as a free shared line refuses it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSendblueSend { keyId: string; to: string; from: string; content: string }
export interface FakeSendblueAccount { secret: string; number: string }

export interface FakeSendblue {
  url: string;
  sent: FakeSendblueSend[];
  /** How many message lists each key asked for, and the last query it asked with. */
  polls: Map<string, { count: number; query?: URLSearchParams }>;
  /** A text from `from` to the number of the account with this key; `group` makes it a group message. */
  push(keyId: string, from: string, content: string, extra?: { group?: string; sentAt?: string }): string;
  /** Every send after this fails with Sendblue's words, until `failSends(false)`. */
  failSends(on: boolean): void;
  /** Every list after this fails with this HTTP status, until `failLists(undefined)`. */
  failLists(status: number | undefined): void;
  close(): Promise<void>;
}

export async function startFakeSendblue(accounts: Record<string, FakeSendblueAccount>): Promise<FakeSendblue> {
  const sent: FakeSendblueSend[] = [];
  const polls = new Map<string, { count: number; query?: URLSearchParams }>();
  const inbox: Array<Record<string, unknown> & { keyId: string; createdAt: number }> = [];
  const verified = new Set<string>();
  let sendsFail = false;
  let listStatus: number | undefined;
  let clock = Date.now();
  let counter = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const answer = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      const keyId = String(req.headers["sb-api-key-id"] ?? "");
      const account = accounts[keyId];
      if (!account || req.headers["sb-api-secret-key"] !== account.secret) return answer(401, { status: "ERROR", message: "Invalid credentials" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/v2/lines/state") {
        return answer(200, { status: "OK", data: [{ assignment: "assigned", sendblue_number: account.number, status: "ONLINE", worker_id: "w1" }], snapshot_at: new Date().toISOString() });
      }
      if (req.method === "GET" && url.pathname === "/api/v2/messages") {
        const entry = polls.get(keyId);
        polls.set(keyId, { count: (entry?.count ?? 0) + 1, query: url.searchParams });
        if (listStatus) return answer(listStatus, { status: "ERROR", message: "Slow down" });
        const q = url.searchParams;
        const since = q.get("created_at_gte") ? Date.parse(q.get("created_at_gte")!) : 0;
        const wantOutbound = q.get("is_outbound");
        const rows = inbox
          .filter((m) => m.keyId === keyId && m.createdAt >= since && (!q.get("sendblue_number") || m.sendblue_number === q.get("sendblue_number")) && (wantOutbound === null || String(m.is_outbound) === wantOutbound))
          .sort((a, b) => (q.get("order_direction") === "desc" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt))
          .slice(Number(q.get("offset") ?? 0), Number(q.get("offset") ?? 0) + Number(q.get("limit") ?? 100))
          .map(({ keyId: _key, createdAt: _at, ...message }) => message);
        return answer(200, { status: "OK", data: rows, pagination: { limit: Number(q.get("limit") ?? 100), offset: Number(q.get("offset") ?? 0), total: rows.length } });
      }
      if (req.method === "POST" && url.pathname === "/api/send-message") {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        if (sendsFail) return answer(400, { status: "DECLINED", error_reason: "The recipient is not a verified contact." });
        if (body.from_number !== account.number || typeof body.number !== "string" || typeof body.content !== "string" || body.content.length > 18996) return answer(400, { status: "ERROR", error_message: "Validation Error" });
        if (!verified.has(`${keyId}:${body.number}`)) return answer(400, { status: "DECLINED", error_reason: "Free plans can only message verified contacts. Have the contact text your Sendblue number first." });
        sent.push({ keyId, to: body.number, from: body.from_number, content: body.content });
        return answer(200, { status: "QUEUED", message_handle: `out-${sent.length}`, number: body.number, from_number: body.from_number, content: body.content });
      }
      return answer(404, { status: "ERROR", message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    polls,
    push(keyId, from, content, extra = {}) {
      const account = accounts[keyId]!;
      const handle = `in-${++counter}`;
      const createdAt = extra.sentAt ? Date.parse(extra.sentAt) : (clock = Math.max(clock + 1, Date.now()));
      verified.add(`${keyId}:${from}`);
      inbox.push({
        keyId, createdAt, message_handle: handle, content, number: from, from_number: from, to_number: account.number, sendblue_number: account.number,
        is_outbound: false, status: "RECEIVED", service: "iMessage", date_sent: new Date(createdAt).toISOString(), media_url: "", group_id: extra.group ?? "",
      });
      return handle;
    },
    failSends(on) { sendsFail = on; },
    failLists(status) { listStatus = status; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
