// A stand-in for agent-browser's loopback command relay: `POST /api/command` on 127.0.0.1 and the session's
// `.stream` file where the daemon writes it. Tests set its page and read back every command.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeGeometry {
  url: string; title: string; vw: number; vh: number; dpr: number; sx: number; sy: number;
  focus: null | { role: string; name: string; editable: boolean; valueLength: number; secret: boolean; rect: { x: number; y: number; w: number; h: number }; frame?: "same" | "cross" | null };
  unmasked: number;
}

export class FakeRelay {
  readonly dir: string;
  readonly session: string;
  server!: Server;
  port = 0;
  readonly commands: Array<Record<string, unknown>> = [];
  connected = true;
  sessionName: string;
  /** The daemon's process id, as `session_info` reports it: this test's own, so it is alive. */
  daemonPid = process.pid;
  console: Array<{ type: string; text: string }> = [];
  errors: Array<{ text: string; url: null; line: number | null; column: number | null }> = [];
  requests: Array<Record<string, unknown>> = [];
  geometry: FakeGeometry = { url: "https://app.example.com/signup", title: "Sign up", vw: 1280, vh: 720, dpr: 1, sx: 0, sy: 0, focus: null, unmasked: 0 };
  boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  /** Bytes a screenshot writes; null fails the capture. */
  picture: Buffer | null = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  typed: string[] = [];
  /** Commands that never answer (the daemon busy behind something). */
  hang = new Set<string>();
  /** Answer `launched: true` on the next command that would relaunch. */
  launchNext = false;
  /** Runs before each command is answered: a test's hook into the timeline. */
  onCommand?: (command: Record<string, unknown>) => void | Promise<void>;

  constructor(session = "bot-test") {
    this.session = session;
    this.sessionName = session;
    this.dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    mkdirSync(join(this.dir, "s"), { recursive: true });
  }

  get env(): Record<string, string> { return { AGENT_BROWSER_SESSION: this.session, AGENT_BROWSER_SOCKET_DIR: join(this.dir, "s"), HOME: this.dir }; }
  get target() { return { session: this.session, binaryPath: join(this.dir, "agent-browser"), env: this.env }; }
  get spec() { return { command: join(this.dir, "agent-browser"), args: ["mcp"], env: { AGENT_BROWSER_SESSION: this.session, AGENT_BROWSER_SOCKET_DIR: join(this.dir, "s") } }; }

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const origin = req.headers.origin;
      if (req.url !== "/api/command" || req.method !== "POST" || origin !== `http://127.0.0.1:${this.port}`) {
        res.writeHead(403); res.end(); return;
      }
      const command = JSON.parse(raw) as Record<string, unknown>;
      this.commands.push(command);
      await this.onCommand?.(command);
      if (this.hang.has(String(command.action))) return;
      const reply = (data: Record<string, unknown> | null, error?: string) => {
        const launched = this.launchNext && !["stream_status", "session_info"].includes(String(command.action));
        if (launched) this.launchNext = false;
        res.writeHead(error ? 502 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(error ? { success: false, error } : { success: true, data: { ...data, lifecycle: { launched, relaunchedBrowser: false, reused: !launched } } }));
      };
      switch (command.action) {
        case "stream_status": return reply({ enabled: true, port: this.port, connected: this.connected, screencasting: false });
        case "session_info": return reply({ session: this.sessionName, backgroundPid: this.daemonPid, browserLaunched: this.connected });
        case "console":
          if (command.clear === true) { this.console = []; return reply({ cleared: true }); }
          return reply({ messages: this.console });
        case "errors": return reply({ errors: this.errors });
        case "requests": {
          if (command.clear === true) { this.requests = []; return reply({ cleared: true }); }
          const [low, high] = typeof command.status === "string" ? command.status.split("-").map(Number) : [null, null];
          const types = typeof command.type === "string" ? command.type.split(",") : null;
          return reply({ requests: this.requests.filter((request) => {
            const status = request.status;
            if (low !== null && (typeof status !== "number" || status < low! || status > high!)) return false;
            return !types || types.includes(String(request.resourceType).toLowerCase());
          }) });
        }
        case "url": return reply({ url: this.geometry.url });
        case "evaluate": {
          const script = String(command.script);
          if (script.includes("requestAnimationFrame")) return reply({ result: 1 });
          return reply({ result: JSON.stringify(this.geometry) });
        }
        case "boundingbox": {
          const box = this.boxes[String(command.selector)];
          return box ? reply({ ...box }) : reply(null, "Element not found");
        }
        case "screenshot":
          if (!this.picture) return reply(null, "capture failed");
          writeFileSync(String(command.path), this.picture);
          return reply({ path: command.path });
        case "keyboard":
          if (command.subaction === "insertText" && typeof command.text === "string") { this.typed.push(command.text); return reply({}); }
          return reply(null, "unsupported");
        default: return reply(null, `unknown action ${String(command.action)}`);
      }
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    this.writeStreamFile();
    return this;
  }

  writeStreamFile(port = this.port): void { writeFileSync(join(this.dir, "s", `${this.session}.stream`), String(port)); }
  /** The daemon exited: it removes its `.stream` file. */
  removeStreamFile(): void { rmSync(join(this.dir, "s", `${this.session}.stream`), { force: true }); }

  actions(): string[] { return this.commands.map((command) => `${String(command.action)}${command.clear === true ? ":clear" : ""}`); }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}
