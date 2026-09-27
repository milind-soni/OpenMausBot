// Owned HTTP stand-ins for the documented Orgo API and the real Daytona SDK.
// No mocks of SDK methods: contract drift reaches these fixtures as unknown routes.
import { createServer } from "node:http";
import type { HostedComputersConfig } from "../../shared/hosted-computers.ts";

export const HOSTED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
export const hostedFixtureConfig: HostedComputersConfig = {
  defaultProvider: "orgo",
  orgo: { enabled: true, workspaceId: "workspace-fixture", apiKey: "orgo-fixture-secret" },
  daytona: { enabled: true, snapshot: "desktop-fixture", apiKey: "daytona-fixture-secret" },
};
type Desktop = { id: string; name: string; state: string; labels: Record<string, string>; files: Map<string, string> };
export async function startFakeHostedComputers(onCode?: (machine: Desktop, command: string) => Promise<{ result: string; exitCode: number }>) {
  const machines: Desktop[] = [];
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const unknown: string[] = [];
  let base = "";
  let fail = false;
  const wire = (m: Desktop) => m.id.startsWith("orgo-")
    ? { id: m.id, name: m.name, workspace_id: "workspace-fixture", status: m.state }
    : { id: m.id, name: m.name, state: m.state, labels: m.labels, toolboxProxyUrl: `${base}/toolbox` };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, "http://fixture").pathname;
    calls.push({ method: req.method!, path, body });
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (fail) return json({ error: "orgo-fixture-secret daytona-fixture-secret" }, 500);
    const orgo = path.startsWith("/computers") || path.startsWith("/workspaces");
    const key = orgo ? hostedFixtureConfig.orgo!.apiKey : hostedFixtureConfig.daytona!.apiKey;
    if (req.headers.authorization !== `Bearer ${key}`) return json({ message: "Unauthorized" }, 401);
    if (path === "/workspaces/workspace-fixture") return json({ id: "workspace-fixture", desktops: machines.filter(m => m.id.startsWith("orgo-")).map(wire) });
    if (path === "/snapshots/desktop-fixture") return json({ id: "snapshot-fixture", name: "desktop-fixture", state: "active" });
    if ((path === "/computers" || path === "/sandbox") && req.method === "POST") {
      if (machines.some(m => m.name === body.name && m.id.startsWith(orgo ? "orgo-" : "daytona-"))) return json({ message: "Conflict" }, 409);
      const m: Desktop = { id: `${orgo ? "orgo" : "daytona"}-${machines.length + 1}`, name: body.name,
        state: orgo ? "running" : "started", labels: body.labels ?? {}, files: new Map() };
      machines.push(m); return json(wire(m), 201);
    }
    const match = path.match(/^\/(computers|sandbox|toolbox)\/([^/]+)(.*)$/);
    if (match) {
      const m = machines.find(m => m.id === match[2] || m.name === match[2]);
      if (!m) return json({ message: "Not found" }, 404);
      const action = match[3];
      if (!action && req.method === "GET") return json(wire(m));
      if (action === "/start" && req.method === "POST") { m.state = orgo ? "running" : "started"; return json(wire(m)); }
      if (action === "/stop" && req.method === "POST") { m.state = orgo ? "frozen" : "stopped"; return json(wire(m)); }
      if (action === "/computeruse/start") return json({ status: "started" });
      if (action === "/screenshot") return json({ success: true, image: HOSTED_PNG, mime_type: "image/png" });
      if (action === "/computeruse/screenshot") return json({ screenshot: HOSTED_PNG });
      if (action === "/bash" || action === "/process/execute") {
        const command = String(body.command);
        if (onCode && body.timeout === 620) return json(await onCode(m, command));
        const write = command.match(/printf %s (\S+) > (?:\/root\/)?([\w.-]+)/);
        const read = command.match(/cat (?:\/root\/)?([\w.-]+)/);
        let result = ""; let exitCode = 0;
        if (write) m.files.set(write[2]!, write[1]!);
        else if (read) { result = m.files.get(read[1]!) ?? "no such file"; exitCode = m.files.has(read[1]!) ? 0 : 1; }
        else if (command === "false") exitCode = 1;
        else result = "fixture command result";
        return json(orgo ? { success: true, output: result, exit_code: exitCode } : { result, exitCode });
      }
    }
    // Name lookups must distinguish an absent machine from a failed provider.
    if (/^\/sandbox\/[^/]+$/.test(path)) return json({ message: "Not found" }, 404);
    unknown.push(`${req.method} ${path}`);
    json({ message: `Unknown fixture endpoint: ${path}` }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: base, machines, calls, unknown, fail: (value: boolean) => { fail = value; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
