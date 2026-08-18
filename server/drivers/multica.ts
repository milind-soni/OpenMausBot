// Multica driver — a workspace's agents as contacts.
//
// Multica (github.com/multica-ai/multica) assigns issues to coding agents and
// runs them on its own server. This driver puts that workspace behind the
// chat window every other engine already uses: the model picker lists the
// workspace's agents instead of models, sending a message opens a ticket
// assigned to the selected one, and the run streams back into the bubble.
//
// Unlike every other driver here, no CLI is spawned and nothing runs on this
// machine — the work happens on the Multica server, so a turn survives the
// laptop closing, and a phone can follow it through the Telegram gateway or
// the companion app.
//
//   sendTurn(text)      → issue create (title = first line, rest = brief),
//                         assigned to the selected agent; follow-up turns
//                         with a resumeCursor comment on the SAME ticket
//   progress            → GET /api/issues/{id}/task-runs (latest run) +
//                         GET /api/tasks/{runId}/messages?since=<seq>
//                         mapped to item.started/completed + content.delta
//   turn.completed      → when the run settles (completed/failed/cancelled)
//   interruptTurn       → POST /api/tasks/{runId}/cancel
//
// The Multica REST client (server/integrations/multica-client.ts) is the
// only place that talks to the factory; this driver only maps.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { MulticaClient, resolveMulticaProfile, type MulticaAgent, type MulticaTaskRun } from "../integrations/multica-client.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "multicaAgent";

export interface MulticaAgentConfig {
  profile?: string;
  workspaceId?: string;
  pollMs?: number;
}

function decodeConfig(raw: unknown): MulticaAgentConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    profile: typeof o.profile === "string" ? o.profile : undefined,
    workspaceId: typeof o.workspaceId === "string" ? o.workspaceId : undefined,
    pollMs: typeof o.pollMs === "number" ? o.pollMs : 3000,
  };
}

// ── pure mapping helpers (unit-tested) ──────────────────────────────────

/** First non-empty line becomes the ticket title (Multica titles are
 * single-line); the rest is the brief. */
export function issueTitleFromText(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.slice(0, 200) || "OpenMausBot task";
}

export function issueDescriptionFromText(text: string): string | undefined {
  const rest = text.trim().split("\n").slice(1).join("\n").trim();
  return rest || undefined;
}

/** The ticket a follow-up turn belongs to, or undefined to open a new one.
 *
 * The harness stores `session.started`'s `sessionId` verbatim as the cursor
 * (server/index.ts, setResumeCursor) — so the cursor IS the ticket id, a bare
 * string, not an envelope. Reading it as `{ issueId }` silently yields
 * undefined and every follow-up opens a fresh ticket instead of commenting on
 * the running one. */
export function issueIdFromCursor(cursor: unknown): string | undefined {
  if (typeof cursor === "string") return cursor.trim() || undefined;
  // tolerate an envelope too: older stored cursors, and a shape a future
  // harness could hand back — cheap to accept, expensive to get wrong.
  if (cursor && typeof cursor === "object") {
    // SAFETY: reading one optional property off a checked object; the value
    // is typed unknown and narrowed before use.
    const id = (cursor as { issueId?: unknown }).issueId;
    if (typeof id === "string") return id.trim() || undefined;
  }
  return undefined;
}

/** Terminal run states → canonical outcome. Returns null while running. */
export function runSettled(run: MulticaTaskRun): { ok: boolean; stopReason: string } | null {
  const state = String(run.status ?? "").toLowerCase();
  if (/completed|succeeded|done|finished/.test(state)) return { ok: true, stopReason: state };
  if (/failed|error|cancelled|interrupted|timeout/.test(state)) return { ok: false, stopReason: state };
  return null;
}

export interface TaskMessage {
  seq: number;
  type: string;
  tool?: string;
  content?: string;
  output?: string;
}

/** One factory run message → canonical runtime events (may be none). */
export function messageToEvents(
  base: Omit<RuntimeEvent, "eventId" | "createdAt" | "type"> & { eventId: string; createdAt: string },
  msg: TaskMessage,
): RuntimeEvent[] {
  const kind = String(msg.type ?? "");
  if (kind === "text" && msg.content) {
    return [{ ...base, type: "content.delta", streamKind: "assistant_text", delta: msg.content }];
  }
  if (kind === "tool_use") {
    return [{ ...base, type: "item.started", itemType: "tool", itemId: `m${msg.seq}`, title: String(msg.tool ?? "tool").slice(0, 80) }];
  }
  if (kind === "tool_result") {
    return [{ ...base, type: "item.completed", itemType: "tool", itemId: `m${msg.seq}`, ok: true }];
  }
  if (kind === "error") {
    return [{ ...base, type: "runtime.error", message: String(msg.content ?? msg.output ?? "factory run error") }];
  }
  return [];
}

// ── driver ──────────────────────────────────────────────────────────────

export const MulticaAgentDriver: ProviderDriver<MulticaAgentConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Multica Factory", supportsMultipleInstances: true },
  models: { default: "", options: [] }, // per-instance: live roster getter
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<MulticaAgentConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const profile = resolveMulticaProfile(config.profile);
    // Config first, then whatever the signed-in CLI already knows. Someone
    // running one workspace should not have to restate its uuid to use this.
    const workspaceId =
      config.workspaceId ?? input.environment.MULTICA_WORKSPACE_ID ?? profile?.workspaceId ?? "";
    const pollMs = config.pollMs ?? 3000;
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { cancel: () => void; turnId: string; issueId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const client = () => {
      if (!profile) throw new Error("multica CLI is not signed in — run `multica login`");
      if (!workspaceId) {
        throw new Error("no multica workspace — set workspaceId on the instance, or sign the CLI into one");
      }
      return new MulticaClient(profile.baseUrl, profile.token, workspaceId);
    };

    // Live roster as the model catalog: fetched at create, refreshed in the
    // background so the model picker tracks factory changes without blocking.
    let catalog: ModelCatalog = { default: "", options: [] };
    let roster: MulticaAgent[] = [];
    const refreshRoster = async () => {
      try {
        roster = await client().listAgents();
        catalog = {
          default: roster[0]?.id ?? "",
          options: roster.map((a) => ({ id: a.id, label: a.name })),
        };
      } catch {
        /* keep the last-known roster; snapshot() reports unavailability */
      }
    };
    await refreshRoster();
    const rosterTimer = setInterval(() => void refreshRoster(), 60_000);
    rosterTimer.unref?.();

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const c = client();
      const turnId = newId();
      const agentId = turn.model || catalog.default;
      if (!agentId) throw new Error("no Multica agent selected — pick a factory agent in the model picker");

      // Follow-up turns comment on the same ticket; the first turn creates it.
      let issueId = issueIdFromCursor(turn.resumeCursor);
      if (!issueId) {
        const issue = await c.createIssue({
          title: issueTitleFromText(turn.text),
          description: issueDescriptionFromText(turn.text),
          assigneeType: "agent",
          assigneeId: agentId,
        });
        issueId = issue.id;
        appendNative(threadId, { dir: "out", source: "multica.issue.create", msg: { issueId, agentId } });
      } else {
        await c.comment(issueId, turn.text);
        appendNative(threadId, { dir: "out", source: "multica.issue.comment", msg: { issueId } });
      }

      let cancelled = false;
      active.set(threadId, {
        turnId,
        issueId,
        cancel: () => {
          cancelled = true;
        },
      });
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: issueId, model: agentId });

      // poll the latest run + its messages until the ticket settles
      (async () => {
        const startedAt = Date.now();
        let lastRunId: string | null = null;
        let sinceSeq = 0;
        let lastText = "";
        let seenRun = false;
        try {
          for (;;) {
            if (cancelled) break;
            await new Promise((r) => setTimeout(r, pollMs));
            // Errors propagate (no silent []): a transient API failure must
            // surface as the real cause, never as a fake "never started".
            const runs = await c.taskRuns(issueId);
            const run = Array.isArray(runs) ? runs[0] : undefined;
            if (run) seenRun = true;
            if (!run) {
              // once a run was seen, a runless response is a transient
              // anomaly — keep polling instead of misdiagnosing
              if (!seenRun && Date.now() - startedAt > 60_000) {
                throw new Error("factory never started a run for this ticket");
              }
              continue;
            }
            if (run.id !== lastRunId) {
              lastRunId = run.id;
              sinceSeq = 0;
              emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: run.id, title: "factory run" });
            }
            const messages = await c.taskMessages(run.id).catch(() => []);
            // SAFETY: taskMessages types the route's documented shape, and the
            // failure path substitutes []. Every field is read optionally in
            // messageToEvents, so an unexpected message maps to no event
            // rather than a crash.
            for (const m of messages as TaskMessage[]) {
              if (m.seq <= sinceSeq) continue;
              sinceSeq = m.seq;
              appendNative(threadId, { dir: "in", source: "multica.task.message", msg: m });
              for (const ev of messageToEvents(base(threadId, turnId), m)) {
                if (ev.type === "content.delta") lastText += ev.delta;
                emit(ev);
              }
            }
            const settled = runSettled(run);
            if (settled) {
              if (lastText) {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: lastText });
              }
              active.delete(threadId);
              emit({ ...base(threadId, turnId), type: "turn.completed", ok: settled.ok, stopReason: settled.stopReason, cost: null });
              return;
            }
            if (Date.now() - startedAt > 30 * 60_000) {
              throw new Error("factory run exceeded 30 minutes — interrupted");
            }
          }
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        } catch (e) {
          active.delete(threadId);
          // SAFETY: everything thrown in this loop is an Error — the client
          // wraps fetch failures and non-2xx into MulticaError, and the two
          // explicit throws above are Errors.
          emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      // These two read as setup instructions in the engine list, so they name
      // the next command rather than the file that happens to be missing.
      if (!profile) return { state: "unavailable", reason: "Multica CLI is not signed in — run `multica login`" };
      if (!workspaceId) return { state: "unavailable", reason: "No Multica workspace selected" };
      try {
        const agents = await client().listAgents();
        if (!agents.length) return { state: "unavailable", reason: "multica workspace has no agents" };
        return { state: "available", authenticated: true, version: null };
      } catch (e) {
        // SAFETY: listAgents only rejects with Errors raised by the client.
        return { state: "unavailable", reason: `multica API unreachable: ${(e as Error).message}` };
      }
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return catalog;
      },
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" },
        sendTurn,
        interruptTurn: async (threadId) => {
          const turn = active.get(threadId);
          if (!turn) return;
          turn.cancel();
          // best-effort: cancel the factory run too
          try {
            const c = client();
            const runs = await c.taskRuns(turn.issueId).catch(() => []);
            if (runs[0]) await c.cancelTask(runs[0].id);
          } catch {
            /* the poll loop settles the turn */
          }
        },
        respondToRequest: async () => {
          throw new Error("multica agents do not ask permission requests");
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { cancel } of active.values()) cancel();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        clearInterval(rosterTimer);
        for (const { cancel } of active.values()) cancel();
        listeners.clear();
      },
    };
  },
};
