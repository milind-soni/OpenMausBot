import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddedProvider } from "../shared/hosted-computers.ts";
import type { HostedComputerManager } from "./hosted-computers/manager.ts";
import { codingCommand } from "./isolated-coding-runner.ts";
import { readBody } from "./harness/http.ts";
import { creditContext } from "./nation-credit-context.ts";
import type { CreditAccount } from "./nation-credits.ts";
import { beginModelSpend } from "./spend.ts";

export const CODING_PATH = /^\/api\/coding-model\/(ws_[A-Za-z0-9_-]{22}|operator)\/([a-f0-9]{32})\/(responses|lease)$/;
const failure = () => Object.assign(new Error("Coding is unavailable. Please retry or contact NATION support."), { status: 409 });
export type CodingOwner = { provider: AddedProvider; key: string; threadId: string; generation: string; account: CreditAccount; current: () => boolean };
type Run = { id: string; owner: CodingOwner; hash: string; model: string; expires: number; requests: number; requesting: boolean;
  controller: AbortController; state: "running" | "completed" | "failed" | "cancelled"; text?: string; project: string };
export function codingSettings(env: NodeJS.ProcessEnv = process.env): { origin: string; model: string } | null {
  if (env.NATION_CODING_ENABLED !== "1" || !env.OPENROUTER_API_KEY || !/^openai\/[a-zA-Z0-9._-]+$/.test(env.NATION_CODING_MODEL ?? "")) return null;
  try {
    const url = new URL(env.NATION_CODING_PUBLIC_ORIGIN ?? "");
    const fixture = env.NATION_TEST_CODING === "1" && url.protocol === "http:" && url.hostname === "127.0.0.1";
    if ((!fixture && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, model: env.NATION_CODING_MODEL! };
  } catch { return null; }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: CodingOwner, b: CodingOwner) => a.key === b.key && a.provider === b.provider && a.threadId === b.threadId && a.generation === b.generation && a.account.id === b.account.id;
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body));
}

/** Per-process jobs: restart revokes every capability. Files remain on the
 * user's existing machine; a missing machine is never silently replaced. */
export class IsolatedCoding {
  private runs = new Map<string, Run>();
  private deps: { manager: HostedComputerManager; scope: string; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch;
    spend?: typeof beginModelSpend };
  constructor(deps: IsolatedCoding["deps"]) { this.deps = deps; }
  enabled(provider: AddedProvider) { return provider === "daytona" && Boolean(codingSettings(this.deps.env)); }
  private active(run: Run) { return run.state === "running" && run.expires > Date.now() && run.owner.current() && !run.controller.signal.aborted; }
  revoke(threadId: string, generation?: string) {
    for (const run of this.runs.values()) if (run.owner.threadId === threadId && (!generation || run.owner.generation === generation)) {
      if (run.state === "running") run.state = "cancelled";
      run.controller.abort();
    }
  }
  start(owner: CodingOwner, project: string, prompt: string) {
    const settings = codingSettings(this.deps.env);
    if (!this.enabled(owner.provider) || !settings || !owner.current() || !owner.account.verified) throw failure();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(project) || !prompt.trim() || prompt.length > 8000) throw failure();
    for (const run of this.runs.values()) {
      if (run.expires + 60_000 < Date.now()) this.runs.delete(run.id);
      else if (run.state === "running" && run.owner.provider === owner.provider && run.owner.key === owner.key) throw failure();
    }
    if (this.runs.size >= 100) throw failure();
    const token = randomBytes(32).toString("hex"), id = randomBytes(16).toString("hex");
    const run: Run = { id, owner, hash: hash(token), model: settings.model, expires: Date.now() + 600_000,
      requests: 0, requesting: false, controller: new AbortController(), state: "running", project };
    this.runs.set(id, run);
    const command = codingCommand({ id, project, prompt, token, model: run.model, expires: run.expires,
      url: `${settings.origin}/api/coding-model/${this.deps.scope}/${id}` });
    void this.deps.manager.code(owner.provider, owner.key, command, () => this.active(run), run.expires).then(result => {
      if (!this.active(run)) { if (run.state === "running") run.state = "cancelled"; return; }
      try {
        const receipt = JSON.parse(result.stdout.trim());
        if (!["completed", "failed", "cancelled"].includes(receipt.status) || typeof receipt.text !== "string") throw failure();
        run.state = receipt.status;
        run.text = receipt.text.slice(-18000).replaceAll(token, "[redacted]");
      } catch { run.state = "failed"; run.text = "The coding result could not be confirmed. Inspect the project before retrying."; }
    }).catch(() => { if (run.state === "running") run.state = "failed"; run.text = "The coding task could not be confirmed. Inspect the project before retrying."; })
      .finally(() => run.controller.abort());
    return { taskId: id, state: "running", project };
  }
  status(owner: CodingOwner, id: string) {
    const run = this.runs.get(id);
    if (!run || !same(run.owner, owner) || !owner.current()) throw failure();
    if (run.state === "running" && !this.active(run)) { run.state = "cancelled"; run.controller.abort(); }
    return { taskId: id, state: run.state, project: run.project, ...(run.text ? { text: run.text } : {}) };
  }
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const match = CODING_PATH.exec(path);
    if (!match || match[1] !== this.deps.scope) return false;
    const run = this.runs.get(match[2]);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!run || !token || hash(token) !== run.hash || !this.active(run) || req.headers.origin) {
      send(res, 403, { error: "Coding task authorization ended." }); return true;
    }
    if (match[3] === "lease") { send(res, req.method === "GET" ? 200 : 405, { active: true }); return true; }
    if (req.method !== "POST" || !String(req.headers["content-type"]).startsWith("application/json")) { send(res, 405, { error: "Invalid coding request." }); return true; }
    if (run.requesting || run.requests >= 32) { send(res, 429, { error: "Coding task limit reached." }); return true; }
    run.requesting = true;
    const disconnected = () => {
      if (!res.writableEnded && run.state === "running") { run.state = "cancelled"; run.controller.abort(); }
    };
    res.on("close", disconnected);
    let charge: ReturnType<typeof beginModelSpend> | undefined;
    let sent = false;
    try {
      const bodyDeadline = setTimeout(() => req.destroy(), 15_000);
      const body = await readBody(req, 2_000_000).finally(() => clearTimeout(bodyDeadline));
      if (!this.active(run) || !body || typeof body !== "object" || Array.isArray(body)) throw failure();
      // Only model inference is exposed. No remote background jobs, stored
      // response retrieval, caller-selected providers or hosted tools.
      if (body.background || body.previous_response_id || body.conversation || body.store === true ||
        (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t: any) => !["function", "custom", "local_shell"].includes(t?.type))))) throw failure();
      const safe = { input: body.input, instructions: body.instructions, tools: body.tools, tool_choice: body.tool_choice,
        parallel_tool_calls: body.parallel_tool_calls, reasoning: body.reasoning, text: body.text,
        model: run.model, stream: true, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: 8192 };
      charge = creditContext.run(run.owner.account, () => (this.deps.spend ?? beginModelSpend)());
      run.requests++;
      const env = this.deps.env ?? process.env;
      const base = (env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
      sent = true;
      const response = await (this.deps.fetcher ?? fetch)(`${base}/responses`, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(safe), signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(180_000)]) });
      if (!response.ok || !response.body) throw failure();
      // Buffer before forwarding so missing usage never permits another call.
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 8_000_000) throw failure(); chunks.push(chunk); }
      const text = Buffer.concat(chunks).toString("utf8");
      let cost: number | undefined;
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (typeof event.response?.id === "string") charge.providerId(event.response.id);
        if (event.type === "response.completed" && typeof event.response?.usage?.cost === "number" && Number.isFinite(event.response.usage.cost) && event.response.usage.cost >= 0) cost = event.response.usage.cost;
      }
      if (cost === undefined) throw failure();
      charge.settle(cost); charge = undefined;
      if (!this.active(run)) throw failure();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); res.end(text);
    } catch {
      if (charge) { if (sent) charge.unconfirmed(); else charge.reject(); }
      if (run.state === "running") run.state = "failed";
      run.text = "The coding request could not be confirmed. Inspect the project before retrying.";
      run.controller.abort();
      if (!res.headersSent) send(res, 502, { error: "Coding request could not be confirmed." }); else res.destroy();
    } finally { run.requesting = false; res.off("close", disconnected); }
    return true;
  }
}
