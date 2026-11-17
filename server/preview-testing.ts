import { randomUUID } from "node:crypto";

export type TestingSession = {
  id: string; botId: string; botName: string; name: string; url: string;
  source: { kind: "url"; url: string; raw: string; isLocalOrPrivate: boolean } | { kind: "file"; projectId: string; filePath: string; fileType: "html" };
  width: number; height: number; responsive: boolean;
  /** "new" opens its own Quick Preview tab; "active" attaches to the page the user is viewing. */
  target: "new" | "active";
  state: "opening" | "ready" | "paused" | "closed" | "error";
  activity: string; error?: string;
};
export type TestingCommand = { id: string; sessionId: string; operation: string; args: Record<string, unknown> };
type Pending = { command: TestingCommand; sent: boolean; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export const testingError = (message: string, status = 400) => Object.assign(new Error(message), { status });
export function testingViewport(value: Record<string, unknown>) {
  const presets: Record<string, [number, number]> = { phone: [393, 852], tablet: [744, 1133], desktop: [1440, 900], responsive: [800, 700] };
  if (value.preset !== undefined && !presets[String(value.preset)]) throw testingError("Choose phone, tablet, desktop or responsive.");
  const preset = presets[String(value.preset ?? "desktop")];
  const width = value.width ?? preset[0], height = value.height ?? preset[1];
  if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 240 || Number(width) > 2560 || Number(height) < 200 || Number(height) > 2560) throw testingError("Viewport must be 240–2560px wide and 200–2560px high.");
  return { width: Number(width), height: Number(height), responsive: value.preset === "responsive" };
}
export function validateTestingURL(raw: unknown, blockedOrigins: string[] = []) {
  if (typeof raw !== "string" || raw.length > 8192) throw testingError("Provide an http(s) URL.");
  let url: URL;
  try { url = new URL(raw); } catch { throw testingError("Provide an absolute http(s) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw testingError("Only http(s) URLs without embedded credentials are supported.");
  const blocked = blockedOrigins.some(origin => {
    const app = new URL(origin);
    const local = (host: string) => ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(host);
    return url.origin === app.origin || (local(url.hostname) && local(app.hostname) && url.port === app.port && url.protocol === app.protocol);
  });
  if (blocked) throw testingError("Preview testing cannot navigate to Studio's own application/API origin.");
  return url.href;
}
export class PreviewTestingBroker {
  private sessions = new Map<string, TestingSession>();
  private pending = new Map<string, Pending>();
  private lastHeartbeat = 0;
  private changed: () => void;
  private timeoutMs: number;
  constructor(changed: () => void = () => {}, timeoutMs = 30_000) { this.changed = changed; this.timeoutMs = timeoutMs; }
  views() { return [...this.sessions.values()].filter(s => s.state !== "closed").map(s => ({ ...s })); }
  status(botId: string) {
    return { available: Date.now() - this.lastHeartbeat < 5_000, reason: Date.now() - this.lastHeartbeat < 5_000 ? undefined : "Open the desktop app with Preview testing support. Restart the app/harness after updating.", sessions: this.views().filter(s => s.botId === botId).map(s => { const pending = [...this.pending.values()].filter(p => p.command.sessionId === s.id); return { ...s, pendingCount: pending.length, runningOperation: pending.find(p => p.sent)?.command.operation }; }), capabilities: ["snapshot", "click", "fill", "select", "press", "scroll", "wait", "navigate", "reload", "back", "forward", "resize", "screenshot", "diagnostics"] };
  }
  owned(id: unknown, botId: string) {
    const s = this.sessions.get(String(id));
    if (!s || s.botId !== botId || s.state === "closed") throw testingError("No such Preview session owned by this bot.", 404);
    return s;
  }
  async open(input: Omit<TestingSession, "id" | "state" | "activity">, created: (id: string) => void = () => {}) {
    if (!this.status(input.botId).available) throw testingError(this.status(input.botId).reason!, 503);
    if (this.views().length >= 6) throw testingError("Preview has reached its six-session limit. Close a session first.", 409);
    const s: TestingSession = { ...input, id: randomUUID(), state: "opening", activity: "Opening page" };
    this.sessions.set(s.id, s);
    created(s.id);
    return this.execute(s, "open", {});
  }
  execute(s: TestingSession, operation: string, args: Record<string, unknown>): Promise<any> {
    if (s.state === "paused" || s.state === "error" || s.state === "closed") throw testingError("This session is stopped. The user must resume it, or the bot can close it.", 409);
    if (!this.status(s.botId).available) throw testingError("Desktop Preview is disconnected.", 503);
    if ([...this.pending.values()].filter(p => p.command.sessionId === s.id).length >= 8 || this.pending.size >= 32) throw testingError("Too many queued Preview actions.", 429);
    const command: TestingCommand = { id: randomUUID(), sessionId: s.id, operation, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.control(s.id, "pause", "Preview command timed out; stopped to prevent later input."); }, this.timeoutMs);
      this.pending.set(command.id, { command, sent: false, resolve, reject, timer });
      s.activity = operation;
      this.changed();
    });
  }
  poll() {
    this.lastHeartbeat = Date.now();
    const busy = new Set([...this.pending.values()].filter(p => p.sent).map(p => p.command.sessionId));
    const commands: TestingCommand[] = [];
    for (const p of this.pending.values()) {
      if (!p.sent && !busy.has(p.command.sessionId)) { p.sent = true; busy.add(p.command.sessionId); commands.push(p.command); }
    }
    return { sessions: this.views(), commands };
  }
  pendingSession(id: unknown) { return this.pending.get(String(id))?.command.sessionId; }
  finish(id: unknown, result: any, error?: string) {
    const p = this.pending.get(String(id));
    if (!p || !p.sent) return false;
    clearTimeout(p.timer); this.pending.delete(p.command.id);
    const s = this.sessions.get(p.command.sessionId)!;
    if (error) {
      if (p.command.operation === "open") { s.state = "error"; s.error = error.slice(0, 1000); }
      p.reject(testingError(error.slice(0, 1000), 422));
    } else {
      s.state = "ready";
      if (result?.url && s.source.kind === "url") s.url = String(result.url).slice(0, 8192);
      if (p.command.operation === "resize") Object.assign(s, testingViewport(p.command.args));
      // An attached view keeps the user's size, so adopt what the desktop reports.
      if (p.command.operation === "open" && s.target === "active" && result?.viewport) {
        const { width, height, responsive } = result.viewport;
        if (Number.isInteger(width) && Number.isInteger(height)) Object.assign(s, { width, height, responsive: Boolean(responsive) });
        if (result.source?.kind === "url" && typeof result.url === "string") s.source = { kind: "url", url: result.url, raw: result.url, isLocalOrPrivate: false };
      }
      p.resolve({ sessionId: s.id, ...result });
    }
    s.activity = [...this.pending.values()].some(v => v.command.sessionId === s.id) ? "Queued actions" : "Idle";
    this.changed(); return true;
  }
  control(id: string, action: "pause" | "resume" | "close", reason = "Stopped by user") {
    const s = this.sessions.get(id);
    if (!s || s.state === "closed") throw testingError("No such session.", 404);
    if (action === "resume") {
      if (s.state !== "paused") throw testingError("Only a paused session can be resumed.", 409);
      s.state = "ready"; s.error = undefined; s.activity = "Idle";
    } else {
      s.state = action === "close" ? "closed" : "paused"; s.activity = reason;
      for (const [key, p] of this.pending) if (p.command.sessionId === id) { clearTimeout(p.timer); this.pending.delete(key); p.reject(testingError(reason, 409)); }
      if (action === "close") this.sessions.delete(id);
    }
    this.changed(); return { ...s };
  }
  stopOwner(botId: string, reason = "Bot stopped") { for (const s of this.views()) if (s.botId === botId) this.control(s.id, "pause", reason); }
  disconnect() { this.lastHeartbeat = 0; for (const s of this.views()) this.control(s.id, "pause", "Desktop Preview disconnected"); }
}
