// A stand-in workspace server for server/workspace-host.test.ts: the three
// routes the host relies on, plus probes that report what arrived. Its
// state file ($HOME/fake-state.json) lets a test make it busy, keep it awake
// or slow to exit, since only the host's own environment list reaches it.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const port = Number(process.env.OMB_PORT);
const key = process.env.NATION_WORKSPACE_KEY ?? "";
let minted = 0;
let token = "";

const state = (): { busy?: boolean; keepAlive?: boolean; slowExitMs?: number } => {
  try { return JSON.parse(readFileSync(join(process.env.HOME ?? "", "fake-state.json"), "utf8")); } catch { return {}; }
};

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const send = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://fake");
  if (url.pathname === "/api/health") return send(200, { app: "nation-team-chat", pid: process.pid });
  if (url.pathname.startsWith("/api/workspace-host/")) {
    if (req.headers["x-nation-workspace-key"] !== key) return send(403, { error: "forbidden" });
    if (url.pathname === "/api/workspace-host/session") {
      minted++;
      token = `omb_sess_fake_${minted}`;
      return send(200, { token, received: JSON.parse(raw || "{}") });
    }
    return send(200, { busy: state().busy === true, keepAlive: state().keepAlive === true });
  }
  if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
  if (url.pathname === "/api/echo") {
    return send(200, { headers: req.headers, body: raw, minted, env: {
      dataDir: process.env.NATION_DATA_DIR, owner: process.env.NATION_PRODUCT_OWNER, watcher: process.env.NATION_CREDIT_WATCHER,
    } }, { "set-cookie": ["nation_device=11111111-2222-4333-8444-555555555555; Path=/", "omb_session_1=stolen; Path=/"] });
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write("data: ping\n\n"), 20);
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (url.pathname === "/api/revoke") {
    token = "";
    return send(200, { ok: true });
  }
  if (url.pathname === "/api/exit") {
    send(200, { ok: true });
    setTimeout(() => process.exit(1), 10);
    return;
  }
  send(404, { error: "not found" });
});
server.listen(port, "127.0.0.1");
// A real workspace takes a moment to put its computers to sleep as it stops.
process.on("SIGTERM", () => setTimeout(() => process.exit(0), state().slowExitMs ?? 0));
