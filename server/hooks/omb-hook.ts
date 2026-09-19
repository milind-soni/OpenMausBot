// omb-hook — the one command OpenMausBot registers for Claude Code hooks
// (PostToolUse, PreCompact, SessionStart, Stop). Claude Code runs it with the
// hook's JSON on stdin and waits for it, so it obeys three rules learned
// the hard way by other harnesses:
//
//   1. It ALWAYS exits 0. A hook that fails or times out can block the
//      agent's next step; the harness observing is never worth that.
//   2. It has a hard budget (OMB_HOOK_TIMEOUT_MS, default 4000) below Claude
//      Code's own per-hook timeout, and speaks only to the loopback harness.
//   3. It is dependency-free and does no work itself: it forwards the event
//      to POST /api/internal/hook with the turn's capability token (read
//      from OMB_HOOK_TOKEN_FILE at run time — the token rotates per turn
//      while the CLI process, and its environment, live on) and prints the
//      harness's `hookSpecificOutput`, if any, for Claude Code to apply.
//
// stdout is the hook channel — never console.log anything else here.
import { readFileSync } from "node:fs";

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const requestedBudget = Number(process.env.OMB_HOOK_TIMEOUT_MS);
const budgetMs = Number.isFinite(requestedBudget) && requestedBudget > 0 ? Math.min(requestedBudget, 4_000) : 4_000;
const MAX_INPUT_BYTES = 1024 * 1024;
const url = process.env.OMB_HOOK_URL ?? "";
const tokenFile = process.env.OMB_HOOK_TOKEN_FILE ?? "";

const done = (out?: string) => {
  if (out === undefined) process.exit(0);
  process.stdout.write(out, () => process.exit(0));
};
process.stdout.on("error", () => process.exit(0));
// the outer fuse: whatever is still pending when this fires, we leave
const fuse = setTimeout(() => done(), budgetMs);
fuse.unref();

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) return done();
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return done();
    payload = parsed as Record<string, unknown>;
  } catch {
    return done();
  }
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if (!event || !/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(url) || !tokenFile) return done();
  let token = "";
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return done();
  }
  if (!token) return done();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(200, budgetMs - 300));
  try {
    const response = await fetch(`${url}/api/internal/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event, payload }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return done();
    const body = (await response.json().catch(() => null)) as { hookSpecificOutput?: unknown; context?: unknown } | null;
    if (body && typeof body === "object" && body.hookSpecificOutput && typeof body.hookSpecificOutput === "object") {
      return done(JSON.stringify({ hookSpecificOutput: body.hookSpecificOutput }));
    }
    // On SessionStart (and UserPromptSubmit) Claude Code reads plain-text
    // stdout as context the model sees; on every other event stdout is
    // only a debug line, so a context body is printed nowhere else.
    if (body && typeof body === "object" && typeof body.context === "string" && body.context && CONTEXT_EVENTS.has(event)) {
      return done(body.context);
    }
    return done();
  } catch {
    return done();
  } finally {
    clearTimeout(timer);
  }
}

void main();
