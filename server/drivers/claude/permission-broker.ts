// The Claude permission broker: a net server on a per-thread socket that
// the CLI's MCP proxy forwards asks over, plus the spawn-path constants and
// private-temp-dir cleanup the driver's launch plumbing shares with it.
// Split out of drivers/claude.ts.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, rmSync, unlinkSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { DATA_DIR } from "../../config.ts";
import { newId } from "../../contracts.ts";
import { brokerSocketPath } from "../../procs.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { askInputSummary } from "../../tool-summary.ts";
import {
  ASK_USER_QUESTION_TOOL,
  askQuestionSummary,
  parseAskQuestions,
  type AskQuestion,
} from "../../../shared/ask-question.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module into an entry one directory up, so a `".."` here would climb too
// far. See server/proxy-paths.ts.
export const PERM_PROXY_PATH = SPAWNED_PROXIES.permission;
export const DWEB_PROXY_PATH = SPAWNED_PROXIES.dweb;
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
export const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

export function removePrivateTempDir(filePath: string | null | undefined): boolean {
  if (!filePath) return true;
  try {
    rmSync(dirname(filePath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

// ── permission broker (ported from agentcal drivers/claude.js) ─────────
// A headless run that hits a permission acceptEdits doesn't cover should
// neither stall silently NOR get blanket-denied — it should ask the user.
// The broker is a net server on a per-turn socket; the proxy (spawned by
// the claude CLI) forwards asks over it and waits. Unanswered permission
// asks deny after timeoutMs with a keep-moving note; unanswered questions
// answer with "use your best judgment" — guidance, never a block.
export interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  at: number;
}
export type AskBehavior = "allow" | "deny" | "answer";
export type AskResolutionSource = "user" | "timeout" | "system";

const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "OpenMausBot: nobody answered in time. Use your best judgment and continue.";
const DUPLICATE_ASK_ID_NOTE = "OpenMausBot: duplicate ask id — skipping this request.";

/** The system-source reply for an ask that outlives the turn — used both to
 * drain in-flight `pending` asks on close() and to answer one that arrives
 * on an already-closed broker (see the `closed` branch below). */
function systemEndedReply(kind: Ask["kind"]): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "OpenMausBot: the turn is ending — wrap up." }
    : { behavior: "deny", message: "OpenMausBot: the turn ended" };
}

/** The structured questions behind an ask, when it is one. Claude's own
 * AskUserQuestion carries them; everything else answers null and keeps the
 * plain summary/choices card. */
export function askQuestions(ask: Ask): AskQuestion[] | null {
  return ask.tool === ASK_USER_QUESTION_TOOL ? parseAskQuestions(ask.input) : null;
}

/** One human-readable line for an ask — what the card subtitle shows. */
export function askSummary(ask: Ask): string {
  const questions = askQuestions(ask);
  if (questions) return askQuestionSummary(questions).slice(0, 300);
  return askInputSummary(ask.input) ?? ask.tool ?? "tool";
}


export function permissionSocketPath(threadId: string, botId?: string) {
  // A readable prefix alone is not unique: ids that agree on their first
  // characters ("t-perm-dup-1", "t-perm-dup-2") would share a socket. POSIX
  // hides that — a new broker's listen replaces the socket FILE, so the name
  // always points at the fresh server — but Windows named pipes live in a
  // global namespace that is never unlinked, and a reused name races the
  // previous broker's async teardown. Half the tag is a digest of the FULL
  // id so distinct threads get distinct sockets; the tag stays at 8 chars
  // total because the POSIX path already brushes the 104-byte sun_path
  // limit under deep tmp home dirs.
  //
  // botId is folded into the digest too (#1017): the driver's session/broker
  // maps are a single process-wide table keyed on threadId alone, so a
  // delegated child turn whose threadId ever coincides with its still-open
  // parent's (or any other bot's) would otherwise collide on the exact same
  // socket. Namespacing by bot makes that collision structurally impossible
  // regardless of how two turns end up sharing a threadId.
  const key = botId ? `${botId}\0${threadId}` : threadId;
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 4);
  return brokerSocketPath(DATA_DIR, `${prefix}${digest}`);
}

/** Paths the broker may bind, tried in order. Windows named pipes are never
 * unlinkable, and a hung CLI child from an earlier server process can hold a
 * name for minutes, so fresh suffixes let the new broker bind immediately.
 * POSIX gets a short temp fallback because macOS rejects Unix socket paths
 * longer than its small `sun_path` limit; a deep test HOME or long username
 * can otherwise make every approval silently unavailable. The proxy learns
 * the actual bound path from its argv, so either fallback is transparent. */
export function brokerSocketCandidates(threadId: string, botId?: string): string[] {
  const base = permissionSocketPath(threadId, botId);
  if (process.platform !== "win32") {
    const scope = createHash("sha256")
      .update(`${DATA_DIR}\0${process.pid}\0${botId ?? ""}\0${threadId}`)
      .digest("hex")
      .slice(0, 16);
    return [base, join(tmpdir(), `omb-perm-${scope}.sock`)];
  }
  return [
    base,
    `${base}-${randomBytes(3).toString("hex")}`,
    `${base}-${randomBytes(3).toString("hex")}`,
  ];
}

export async function createPermissionBroker(opts: {
  /** Candidate bind paths, tried in order; the first that listens wins. */
  socketPaths: string[];
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: AskBehavior; source: AskResolutionSource }) => void;
  isActive?: () => boolean;
  timeoutMs?: number;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pending = new Map<
    string,
    { ask: Ask; finish: (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource, always?: boolean) => void }
  >();
  // server.close() only stops accepting NEW connections — it does not touch
  // a connection that's already open. A still-alive child's MCP proxy can
  // keep sending asks on such a connection after the turn has ended, and
  // this handler stays fully wired to it. Without this flag those asks would
  // become new `pending` entries and `request.opened` cards for a turn the
  // driver already forgot (the active turn was already ended), which can
  // never be answered — the "zombie card" in issue #211.
  let closed = false;
  let boundPath = opts.socketPaths[0] ?? "";
  const connectionHandler = (conn: import("node:net").Socket) => {
    conn.on("error", () => {});
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.t !== "ask") continue;
        const askId = String(msg.id ?? newId());
        const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
        if (closed) {
          // Closure is terminal and takes precedence over every active-turn
          // rule, including duplicate-id rejection. Never register a pending
          // entry or notify onAsk, but always answer an existing connection:
          // permission-proxy.ts only resolves on an explicit answer (or a
          // connection error/close), so a silent drop would hang the tool.
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        // A retained Claude process keeps its proxy connection between
        // turns. Late/background asks must still fail closed without opening
        // a card for a turn that has already settled.
        if (opts.isActive && !opts.isActive()) {
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
          } catch {}
          continue;
        }
        // `pending` is server-scoped, not per-connection: two asks with the
        // same id — a buggy/adversarial client, never a legitimate retry
        // (permission-proxy mints a fresh randomUUID per ask) — would
        // otherwise let the second `pending.set` silently overwrite the
        // first, orphaning it as an unanswerable card once the first
        // resolves and deletes the shared key. Reject before either ask
        // becomes visible to onAsk.
        if (pending.has(askId)) {
          // askId is client-controlled; JSON.stringify escapes newlines and
          // control characters so it can't corrupt the log line or terminal.
          console.error(`permission broker on ${boundPath}: duplicate ask id ${JSON.stringify(askId)} — denying`);
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior: "deny", message: DUPLICATE_ASK_ID_NOTE }) + "\n");
          } catch {}
          continue;
        }
        const ask: Ask = { id: askId, kind, tool: msg.tool ?? "tool", input: msg.input ?? {}, at: Date.now() };
        const finish = (behavior: AskBehavior, message: string | undefined, source: AskResolutionSource, always?: boolean) => {
          if (!pending.delete(askId)) return;
          clearTimeout(timer);
          try {
            // `always` rides to the proxy, which hands the CLI's own suggested
            // permission rules back as updatedPermissions: Claude remembers
            // the allow for the session, the harness remembers nothing.
            // `source` travels with the answer too: a proxy that cannot tell
            // the human's words from a timeout note would file the timeout
            // note as the human's words.
            conn.write(
              JSON.stringify({ t: "answer", id: askId, behavior, message, source, ...(always ? { always: true } : {}) }) + "\n",
            );
          } catch {}
          opts.onResolve({ ...ask, behavior, source });
        };
        const timer = setTimeout(
          () =>
            kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
          timeoutMs,
        );
        timer.unref?.();
        pending.set(askId, { ask, finish });
        opts.onAsk(ask);
      }
    });
  };
  // Bind the first candidate that will take a listener. A broker that
  // never came up used to be silent — every approval then timed out into a
  // deny nobody could explain. Keep the turn fail-closed on total failure,
  // but leave an actionable diagnostic either way.
  let server: ReturnType<typeof createNetServer> | null = null;
  for (const [index, candidate] of opts.socketPaths.entries()) {
    const attempt = createNetServer(connectionHandler);
    try {
      unlinkSync(candidate);
    } catch {}
    let outcome = await new Promise<"listening" | (Error & { code?: string })>((resolve) => {
      attempt.once("listening", () => resolve("listening"));
      // SAFETY: net 'error' events carry syscall errors; the optional
      // `code` is only read defensively below.
      attempt.once("error", (error) => resolve(error as Error & { code?: string }));
      attempt.listen(candidate);
    });
    // A fallback under the shared OS temp root must not be connectable by
    // another local account. DATA_DIR is private already, but applying the
    // same mode to every POSIX socket keeps the rule simple and fail-closed.
    if (outcome === "listening" && process.platform !== "win32") {
      try {
        chmodSync(candidate, 0o600);
      } catch (error) {
        try {
          attempt.close();
        } catch {}
        try {
          unlinkSync(candidate);
        } catch {}
        outcome = error as Error & { code?: string };
      }
    }
    if (outcome === "listening") {
      if (index > 0) {
        console.error(`permission broker: ${opts.socketPaths[0]} is still held — bound fallback ${candidate}`);
      }
      boundPath = candidate;
      server = attempt;
      attempt.on("error", (error) => {
        console.error(`permission broker error on ${candidate}: ${error.message}`);
      });
      break;
    }
    try {
      attempt.close();
    } catch {}
    if (index === opts.socketPaths.length - 1) {
      console.error(`permission broker unavailable on ${candidate}: ${outcome.message}`);
      break;
    }
  }
  // Never hand the proxy an occupied candidate when every bind failed. That
  // could connect it to a stale (or unrelated) listener instead of this
  // broker, defeating the fail-closed boundary.
  if (!server) throw new Error("claude: permission broker could not bind a local socket");
  const drain = () => {
    for (const p of Array.from(pending.values())) {
      const { behavior, message } = systemEndedReply(p.ask.kind);
      p.finish(behavior, message, "system");
    }
  };
  return {
    answer(askId: string, behavior: AskBehavior, message?: string, always?: boolean): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      if (p.ask.kind === "question" ? behavior !== "answer" : behavior === "answer") return false;
      p.finish(behavior, message, "user", always && behavior === "allow");
      return true;
    },
    pause() {
      drain();
    },
    close() {
      closed = true;
      drain();
      try {
        server?.close();
      } catch {}
      try {
        unlinkSync(boundPath);
      } catch {}
    },
    /** Where the broker actually listens — argv for the proxy child must
     * use this, not the deterministic base, when a fallback was bound. */
    socketPath: boundPath,
  };
}
