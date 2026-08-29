// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes coordination and
// durable capture tools that
// let one bot talk to another, routed back through the harness so the
// harness stays the single owner of turns, permissions, and recursion
// limits:
//
//   list_bots()                          → the other bots in this section + their status
//   ask_bot(bot_id, msg)                 → send msg to that bot, wait, return its reply
//   delegate_bot(bot_id, msg, reason?)   → hand the task to a peer ASYNC: returns
//                                          immediately, the peer runs after your
//                                          current turn finishes, the user sees
//                                          the peer's reply as its own turn
//   create_bot(name, role, instructions) → coordinator-authorized agents can
//                                      add a specialist to
//                                          their own section
//   request_credential(id, reason?)       → show a secure, allowlisted key card
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { z } from "zod";

import { CREDENTIAL_TARGETS, isCredentialTargetId } from "../../shared/credential-request.ts";
import { EFFORT_LEVELS } from "../contracts.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.OMB_TURN_DEPTH ?? "0") || 0;
const TOOL_PROFILE = process.env.OMB_AGENTS_TOOL_PROFILE === "capture"
  ? "capture"
  : process.env.OMB_AGENTS_TOOL_PROFILE === "evidence"
    ? "evidence"
    : "full";
const MAX_CREATED_PER_TURN = 4;
let createdThisTurn = 0;

const ParallelizeWorkInput = z.object({
  tasks: z.array(z.object({
    label: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    mode: z.enum(["coordinate", "execute"]).optional(),
    engine_id: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    effort: z.enum(["default", ...EFFORT_LEVELS]).optional(),
  })).min(1).max(8),
});

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in your OpenMausBot section you can message, with their model and whether they're busy. Call this before ask_bot to discover who's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_bot",
    description:
      "Send a message to another bot in your section and wait for its reply. Use it to delegate a subtask to a specialist bot or ask a peer a question. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text. Returns promptly with a note if that bot is busy.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "delegate_bot",
    description:
      "Hand a task to another bot ASYNCHRONOUSLY: returns immediately and the peer runs after your current turn finishes. Use this when you want to keep working or hand off a long-running subtask without waiting. The user sees the peer's reply as its own turn; you do NOT receive the reply inline.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What the peer should do / answer." },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "create_bot",
    description:
      "Create a specialist bot in your section. Only an agent with the coordination capability may use this. The new bot inherits the caller's engine, starts with connected apps and automatic approvals disabled, and can then receive work through delegate_bot. Create only the smallest useful team (maximum four per turn).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short, unique display name for the specialist." },
        role: { type: "string", description: "The specialist's job title or role." },
        instructions: { type: "string", description: "What this specialist is responsible for and how it should work." },
      },
      required: ["name", "role", "instructions"],
    },
  },
  {
    name: "parallelize_work",
    description:
      "Start a private execution graph of temporary workers and return immediately. Use this for substantial multi-part work: independent lanes dispatch together, declared prerequisites wait, and shared repository/computer locks serialize only conflicting mutations. The server enforces the eight-worker capacity and reports truthful wait reasons; keep one execution owner for a shared destination. After launching, keep the chat quiet; the task rail shows exact progress and material results return there.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short user-facing name for this workstream." },
              instructions: { type: "string", description: "Self-contained instructions and expected result for the worker." },
              key: { type: "string", description: "Stable private graph key; omitted keys become task-1, task-2, and so on." },
              depends_on: { type: "array", items: { type: "string" }, description: "Private graph keys that must complete before this lane can start." },
              resource_locks: { type: "array", items: { type: "string" }, description: "Shared resource names; lanes holding the same name run one at a time." },
              approval_gate: { type: "string", description: "A human approval label that keeps this lane waiting until an approval adapter releases it." },
              mode: {
                type: "string",
                enum: ["coordinate", "execute"],
                description: "Coordinate isolated analysis or execute bounded work. Defaults to coordinate; mark at most one task execute when it owns a shared repository or computer.",
              },
              engine_id: {
                type: "string",
                description: "Optional engine instance id (for example cursor, claude, or codex). Omit to use the coordinator's engine; Codex workers default to the Luna executor route.",
              },
              model: {
                type: "string",
                description: "Optional exact model id or unambiguous catalog label fragment (for example Fable or Haiku). Omit for the engine's worker route: Codex uses GPT-5.6 Luna; other same-engine workers inherit the coordinator model.",
              },
              effort: {
                type: "string",
                enum: ["default", ...EFFORT_LEVELS],
                description: "Optional reasoning effort. Codex workers default to high; other same-engine workers inherit. Use default to send no effort level.",
              },
            },
            required: ["label", "instructions"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "request_credential",
    description:
      "Ask the user for a supported API key through OpenMausBot's secure credential card. Use this instead of asking them to paste a secret into chat. The secret is saved by the desktop app and is never returned to you. After calling this tool, end the turn; OpenMausBot resumes the task after the user saves or declines.",
    inputSchema: {
      type: "object",
      properties: {
        credential_id: {
          type: "string",
          enum: Object.keys(CREDENTIAL_TARGETS),
          description: "The credential the current task requires.",
        },
        reason: {
          type: "string",
          description: "Optional short, non-sensitive explanation of why the task needs it.",
        },
      },
      required: ["credential_id"],
    },
  },
  {
    name: "record_task_evidence",
    description:
      "Record independently checkable evidence for the current scheduled or unattended task. Use this only after inspecting a test result, artifact, source, screen, or durable receipt; a tool invocation alone is not evidence.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["test", "artifact", "source", "screen", "receipt", "other"] },
        summary: { type: "string", description: "Concrete result that was independently checked." },
        reference: { type: "string", description: "Optional local path, URL, receipt id, or other audit reference." },
      },
      required: ["kind", "summary"],
    },
  },
  {
    name: "capture_status",
    description:
      "Read the redacted operational state of source-ingestion agents in this section without starting a sweep. Returns last run, last successful run, pending report count, and per-source freshness/status; it never returns captured content, provider cursors, actions, or raw errors. Use this before asking an ingestion agent for status or starting a catch-up run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_begin",
    description:
      "Begin a durable source-ingestion run before reading any sources. Returns each source's committed cursor, last-success time, and any reports still awaiting delivery. Use those cursors for catch-up; never infer an empty source from a failed read.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fast", "hourly", "manual"] },
        scheduled_for: { type: "number", description: "Scheduled Unix time in milliseconds; defaults to now." },
        sources: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              required: { type: "boolean" },
            },
            required: ["id", "required"],
          },
        },
      },
      required: ["kind", "sources"],
    },
  },
  {
    name: "capture_record_source",
    description:
      "Record exactly one source result in a capture run. Successful/empty results advance that source cursor atomically; failed or needs-auth results preserve the prior cursor. Record every source, including quiet ones.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        source_id: { type: "string" },
        status: { type: "string", enum: ["ok", "empty", "failed", "needs-auth"] },
        cursor: { description: "Opaque next cursor for ok/empty results." },
        item_count: { type: "number", minimum: 0 },
        error: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              class: { type: "string", enum: ["Build", "Money chase", "Collect then deliver", "Outbound follow-up", "Redline/legal", "Calendar/RSVP", "File a loop", "Ignore"] },
              source: { type: "string" },
              summary: { type: "string" },
              ask: { type: "string" },
              proposedMove: { type: "string" },
              evidenceRef: { type: "string" },
            },
            required: ["class", "source", "summary"],
          },
        },
      },
      required: ["run_id", "source_id", "status"],
    },
  },
  {
    name: "capture_finish",
    description:
      "Finish a source-ingestion run after all sources were attempted. Missing required results become failures. Returns a fail-closed report and, when action/failure retention is required, a durable outbox entry. The ledger, source health, and capture memory are the handoff; do not delegate the report or create a peer room. Acknowledge the outbox entry after the durable finish succeeds.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "capture_ack_delivery",
    description:
      "Acknowledge a durable source-ingestion outbox entry after capture_finish has retained the report in the ledger. Capture evidence and actions remain available through source health and capture memory; this acknowledgement must not delegate to another bot or create a peer room.",
    inputSchema: {
      type: "object",
      properties: { outbox_id: { type: "string" } },
      required: ["outbox_id"],
    },
  },
  {
    name: "capture_read_browser_receipts",
    description:
      "Read new local freshness receipts for one approved signed-in browser source from OpenMausBot's private capture inbox. The bridge silently submits heartbeats and changed-page receipts over loopback; missing or stale observations fail closed. AI-platform sources contain sidebar/title metadata only. Requires the source.ingestion capability and does not grant general computer control. This does not click, type, authenticate, or read cookies.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          enum: [
            "plaud", "monarch", "google-messages", "youtube", "mercury",
            "ai-chatgpt", "ai-claude", "ai-grok", "ai-gemini",
          ],
        },
        cursor: { description: "The source-specific cursor returned by capture_begin or the preceding read." },
      },
      required: ["source_id"],
    },
  },
  {
    name: "capture_read_notification_mirror",
    description:
      "Read new Google Messages notifications from the paired phone's notification mirror. This is a sensitive, source-scoped delta read with a durable transport heartbeat; a quiet phone is empty only when the mirror heartbeat is fresh. If the mirror is missing or stale it returns needs-auth, after which an approved Google Messages browser receipt may be used as fallback. Requires source.ingestion or source.memory.read for google-messages and never reads any other source.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { description: "The Google Messages mirror cursor returned by the preceding read." },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "capture_read_plaud_archive",
    description:
      "Read new Plaud recordings from the authenticated Plaud cloud CLI first, using Plaud-native transcripts by recording id without downloading audio. If cloud access fails, use the explicitly selected local archive; if that also fails, use only fresh approved Plaud browser receipts. Never guess the archive path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional absolute path to an explicitly reviewed Plaud Archive fallback folder." },
        cursor: { description: "The Plaud cursor returned by capture_begin or the preceding read." },
      },
    },
  },
  {
    name: "capture_read_chrome_history",
    description:
      "Read new title/domain-only entries from the default Chrome profile through a locked-safe local database copy. Requires the source.ingestion capability and does not grant general computer control; query strings, fragments, and page bodies are excluded.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { description: "The chrome-history cursor returned by capture_begin or the preceding read." },
        limit: { type: "number", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "capture_read_local_inbox",
    description:
      "Read new or changed files from a user-reviewed local inbox path. Pass the explicitly selected folder path; the source collector reconciles it, skips symlinks/reparse points, bounds reads, and extracts approved text files only. Requires the source.ingestion capability and does not grant general computer control.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the reviewed local inbox folder. Never guess this path." },
        cursor: { description: "The local-inbox cursor returned by capture_begin or the preceding read." },
        max_files: { type: "number", minimum: 1, maximum: 500 },
      },
      required: ["path"],
    },
  },
  {
    name: "capture_read_whoop_export",
    description:
      "Read a user-exported WHOOP JSON or CSV file/folder. Pass the explicitly selected path; credential-shaped fields are removed before output and no WHOOP token is accepted. Requires the source.ingestion capability and does not grant general computer control.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the reviewed WHOOP JSON/CSV export file or folder. Never guess this path." },
        cursor: { description: "The WHOOP cursor returned by capture_begin or the preceding read." },
        max_files: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["path"],
    },
  },
  {
    name: "capture_read_hevy_export",
    description:
      "Read a user-exported Hevy JSON or CSV file/folder. Pass the explicitly selected path; credential-shaped fields are removed before output and no Hevy token is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the reviewed Hevy JSON/CSV export file or folder. Never guess this path." },
        cursor: { description: "The Hevy cursor returned by capture_begin or the preceding read." },
        max_files: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["path"],
    },
  },
  {
    name: "capture_read_anvil_bi_health",
    description:
      "Read the documented local Anvil BI GET /api/health result after validating an explicitly selected Anvil BI project folder. This is read-only and never reads integration secrets.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the reviewed Anvil BI project folder. Never guess this path." },
        endpoint: { type: "string", description: "Optional loopback health URL. Omit it to validate the project-local adapter without probing Anvil's web server." },
      },
      required: ["path"],
    },
  },
  {
    name: "capture_read_anvil_bi_mercury",
    description:
      "Read account balances and settled transaction deltas through the selected local Anvil BI project's existing read-only Mercury adapter. Tokens remain inside Anvil BI; OpenMaus receives normalized records with capture timestamps, source posted dates, stable external ids, and a deterministic cursor. Browser capture is fallback-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the reviewed Anvil BI project folder. Never guess this path." },
        cursor: { description: "The Mercury cursor returned by capture_begin or the preceding read." },
      },
      required: ["path"],
    },
  },
  {
    name: "capture_read_telegram_relay_health",
    description:
      "Read an explicitly configured loopback Telegram relay health endpoint. No Bot API call, message send, browser login, or external URL is permitted.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Explicit loopback relay health URL, for example http://127.0.0.1:8787/api/health." },
      },
      required: ["endpoint"],
    },
  },
  {
    name: "capture_memory_search",
    description:
      "Search the durable captured-item memory for your exact section. Results are source/account/time filtered, include provenance, and exclude sensitive or restricted records unless the task has the appropriate source-memory capability.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional words to search in captured titles and text." },
        source_id: { type: "string" },
        source_ids: { type: "array", items: { type: "string" } },
        account_id: { type: "string" },
        since: { type: "number", description: "Earliest occurred-at Unix time in milliseconds." },
        until: { type: "number", description: "Latest occurred-at Unix time in milliseconds." },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "capture_memory_upsert",
    description:
      "Store one normalized captured item in durable memory. Use a source external_id when available so retries deduplicate and later content changes update the same event.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: { type: "string" },
        account_id: { type: "string" },
        external_id: { type: "string" },
        event_id: { type: "string" },
        kind: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        occurred_at: { type: "number" },
        captured_at: { type: "number" },
        sensitivity: { type: "string", enum: ["public", "internal", "sensitive", "restricted"] },
        evidence_ref: { type: "string" },
        payload_ref: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["source_id", "kind", "title", "occurred_at", "sensitivity"],
    },
  },
  {
    name: "capture_memory_tombstone",
    description: "Hide an incorrect captured item while preserving its audit history. Use only when a source correction or duplicate is confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["event_id", "reason"],
    },
  },
  {
    name: "capture_world_assert",
    description:
      "Add one source-backed fact to the shared section world model. Repeated facts deduplicate, changed facts from the same source supersede, and disagreement across sources remains visible. Capture only; evidence_ref is required.",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["person", "organization", "project", "place", "account", "device", "topic", "other"] },
            name: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
          },
          required: ["kind", "name"],
        },
        predicate: { type: "string", description: "Stable lowercase relation, for example birthday, works_on, status, or prefers." },
        object: {
          type: "object",
          description: "Either {kind:'value', value:'...'} or {kind:'entity', entity:{kind,name,aliases?}}.",
        },
        source_id: { type: "string" },
        account_id: { type: "string" },
        observed_at: { type: "number" },
        valid_from: { type: "number" },
        valid_until: { type: "number" },
        ttl_ms: { type: "number" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        sensitivity: { type: "string", enum: ["public", "internal", "sensitive", "restricted"] },
        evidence_ref: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["subject", "predicate", "object", "source_id", "observed_at", "sensitivity", "evidence_ref"],
    },
  },
  {
    name: "world_model_resolve",
    description:
      "Resolve current source-backed facts about a person, organization, project, account, or topic. Returns provenance, freshness, and explicit conflicts; stale and sensitive facts stay hidden by default.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Canonical name or known alias." },
        subject_kind: { type: "string", enum: ["person", "organization", "project", "place", "account", "device", "topic", "other"] },
        predicate: { type: "string" },
        include_stale: { type: "boolean" },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
    },
  },
];

const EXPOSED_TOOLS = TOOL_PROFILE === "capture"
  ? TOOLS.filter((tool) => tool.name.startsWith("capture_") || tool.name === "world_model_resolve" || tool.name === "record_task_evidence")
  : TOOL_PROFILE === "evidence"
    ? TOOLS.filter((tool) => tool.name === "record_task_evidence")
    : TOOLS.filter((tool) => tool.name !== "parallelize_work" || DEPTH === 0);

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(HARNESS + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this section yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""}]`;
    });
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, fromThreadId: THREAD_ID, toBotId, message, depth: DEPTH }),
    });
    if (r.busy) return { text: `That bot is busy right now — try again after it finishes.` };
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "delegate_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!toBotId || !message) return { text: "delegate_bot needs bot_id and message.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID,
      fromThreadId: THREAD_ID,
      toBotId,
      message,
      depth: DEPTH,
    };
    if (reason) body.reason = reason;
    const r = await api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) return { text: `Couldn't queue the delegation: ${r.error}`, isError: true };
    // Fire-and-forget by contract: the harness returns immediately, the
    // peer turn runs after our current turn finishes.
    return { text: typeof r.message === "string" ? r.message : "Delegation queued." };
  }
  if (name === "create_bot") {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_bot needs name, role, and instructions.", isError: true };
    }
    if (createdThisTurn >= MAX_CREATED_PER_TURN) {
      return { text: `You can create at most ${MAX_CREATED_PER_TURN} bots in one turn. Use the team you have before adding more.`, isError: true };
    }
    const r = await api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        name: botName,
        role,
        instructions,
      }),
    });
    createdThisTurn += 1;
    return {
      text: `Created @${r.name ?? botName} in ${r.section ?? "General"} [id: ${r.id}]. Assign work with delegate_bot.`,
    };
  }
  if (name === "parallelize_work") {
    if (DEPTH !== 0 || TOOL_PROFILE !== "full") {
      return { text: "Only a top-level coordinator can parallelize work.", isError: true };
    }
    const parsed = ParallelizeWorkInput.safeParse(args);
    if (!parsed.success) {
      return { text: "parallelize_work needs one to eight labeled tasks; engine_id, model, effort, and coordinate/execute mode are optional.", isError: true };
    }
    const tasks = parsed.data.tasks;
    await api("/api/internal/parallelize-work", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        depth: DEPTH,
        requestKey: randomUUID(),
        tasks,
      }),
    });
    return {
      text: "Parallel work started. The task rail shows exact progress; material results return through the harness. Keep the chat quiet, do not poll for workers.",
    };
  }
  if (name === "request_credential") {
    const credentialId = args.credential_id;
    if (!isCredentialTargetId(credentialId)) {
      return { text: "request_credential needs a supported credential_id.", isError: true };
    }
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 240) : "";
    const r = await api("/api/internal/request-credential", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        fromThreadId: THREAD_ID,
        credentialId,
        ...(reason ? { reason } : {}),
      }),
    });
    if (r.alreadyConfigured) {
      return { text: `${r.label ?? CREDENTIAL_TARGETS[credentialId].label} is already configured. Continue the task.` };
    }
    return {
      text: `A secure ${r.label ?? CREDENTIAL_TARGETS[credentialId].label} card is now visible to the user. End this turn; OpenMausBot will resume the task after they save or decline. Never ask them to paste the key into chat.`,
    };
  }
  if (name === "record_task_evidence") {
    const kind = String(args.kind ?? "").trim();
    const summary = String(args.summary ?? "").trim();
    if (!kind || !summary) return { text: "record_task_evidence needs kind and summary.", isError: true };
    const response = await api("/api/internal/task-evidence", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        threadId: THREAD_ID,
        kind,
        summary,
        ...(typeof args.reference === "string" ? { reference: args.reference } : {}),
      }),
    });
    return { text: `Evidence recorded on run ${response.runId ?? "receipt"}.` };
  }
  if (name === "capture_status") {
    const response = await api("/api/internal/capture/status", {
      method: "POST",
      body: JSON.stringify({ botId: BOT_ID }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_begin") {
    const response = await api("/api/internal/capture/begin", {
      method: "POST",
      body: JSON.stringify({ ...args, botId: BOT_ID, threadId: THREAD_ID }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_record_source") {
    const response = await api("/api/internal/capture/source", {
      method: "POST",
      body: JSON.stringify({ ...args, botId: BOT_ID }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_finish") {
    const response = await api("/api/internal/capture/finish", {
      method: "POST",
      body: JSON.stringify({ ...args, botId: BOT_ID }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_ack_delivery") {
    const response = await api("/api/internal/capture/ack", {
      method: "POST",
      body: JSON.stringify({ ...args, botId: BOT_ID }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_browser_receipts") {
    const sourceId = String(args.source_id ?? "").trim();
    if (!sourceId) return { text: "capture_read_browser_receipts needs source_id.", isError: true };
    const response = await api("/api/internal/capture/read/browser", {
      method: "POST",
      body: JSON.stringify({ botId: BOT_ID, sourceId, cursor: args.cursor ?? null }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_notification_mirror") {
    const response = await api("/api/internal/capture/read/notification-mirror", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        cursor: args.cursor ?? null,
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_plaud_archive") {
    const selectedPath = String(args.path ?? "").trim();
    const response = await api("/api/internal/capture/read/plaud-archive", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        ...(selectedPath ? { path: selectedPath } : {}),
        cursor: args.cursor ?? null,
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_chrome_history") {
    const response = await api("/api/internal/capture/read/chrome-history", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        cursor: args.cursor ?? null,
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_local_inbox") {
    const selectedPath = String(args.path ?? "").trim();
    if (!selectedPath) return { text: "capture_read_local_inbox needs the explicitly selected folder path.", isError: true };
    const response = await api("/api/internal/capture/read/local-inbox", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        path: selectedPath,
        cursor: args.cursor ?? null,
        ...(typeof args.max_files === "number" ? { maxFiles: args.max_files } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_whoop_export") {
    const selectedPath = String(args.path ?? "").trim();
    if (!selectedPath) return { text: "capture_read_whoop_export needs the explicitly selected export path.", isError: true };
    const response = await api("/api/internal/capture/read/whoop", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        path: selectedPath,
        cursor: args.cursor ?? null,
        ...(typeof args.max_files === "number" ? { maxFiles: args.max_files } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_hevy_export") {
    const selectedPath = String(args.path ?? "").trim();
    if (!selectedPath) return { text: "capture_read_hevy_export needs the explicitly selected export path.", isError: true };
    const response = await api("/api/internal/capture/read/hevy", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        path: selectedPath,
        cursor: args.cursor ?? null,
        ...(typeof args.max_files === "number" ? { maxFiles: args.max_files } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_anvil_bi_health") {
    const selectedPath = String(args.path ?? "").trim();
    if (!selectedPath) return { text: "capture_read_anvil_bi_health needs the explicitly selected project path.", isError: true };
    const response = await api("/api/internal/capture/read/anvil-bi-health", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        path: selectedPath,
        ...(typeof args.endpoint === "string" ? { endpoint: args.endpoint } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_anvil_bi_mercury") {
    const selectedPath = String(args.path ?? "").trim();
    if (!selectedPath) return { text: "capture_read_anvil_bi_mercury needs the explicitly selected project path.", isError: true };
    const response = await api("/api/internal/capture/read/anvil-bi-mercury", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        path: selectedPath,
        cursor: args.cursor ?? null,
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_read_telegram_relay_health") {
    const endpoint = String(args.endpoint ?? "").trim();
    if (!endpoint) return { text: "capture_read_telegram_relay_health needs the explicitly configured endpoint.", isError: true };
    const response = await api("/api/internal/capture/read/telegram-relay-health", {
      method: "POST",
      body: JSON.stringify({ botId: BOT_ID, endpoint }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_memory_search") {
    const response = await api("/api/internal/capture/memory/search", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.source_id === "string" ? { sourceId: args.source_id } : {}),
        ...(Array.isArray(args.source_ids) ? { sourceIds: args.source_ids } : {}),
        ...(typeof args.account_id === "string" ? { accountId: args.account_id } : {}),
        ...(typeof args.since === "number" ? { since: args.since } : {}),
        ...(typeof args.until === "number" ? { until: args.until } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_memory_upsert") {
    const response = await api("/api/internal/capture/memory/upsert", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        item: {
          ...(typeof args.source_id === "string" ? { sourceId: args.source_id } : {}),
          ...(typeof args.account_id === "string" ? { accountId: args.account_id } : {}),
          ...(typeof args.external_id === "string" ? { externalId: args.external_id } : {}),
          ...(typeof args.event_id === "string" ? { eventId: args.event_id } : {}),
          ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          ...(typeof args.body === "string" ? { body: args.body } : {}),
          ...(typeof args.occurred_at === "number" ? { occurredAt: args.occurred_at } : {}),
          ...(typeof args.captured_at === "number" ? { capturedAt: args.captured_at } : {}),
          ...(typeof args.sensitivity === "string" ? { sensitivity: args.sensitivity } : {}),
          ...(typeof args.evidence_ref === "string" ? { evidenceRef: args.evidence_ref } : {}),
          ...(typeof args.payload_ref === "string" ? { payloadRef: args.payload_ref } : {}),
          ...(typeof args.metadata === "object" && args.metadata !== null ? { metadata: args.metadata } : {}),
        },
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_memory_tombstone") {
    const eventId = String(args.event_id ?? "").trim();
    const reason = String(args.reason ?? "").trim();
    if (!eventId || !reason) return { text: "capture_memory_tombstone needs event_id and reason.", isError: true };
    const response = await api("/api/internal/capture/memory/tombstone", {
      method: "POST",
      body: JSON.stringify({ botId: BOT_ID, eventId, reason }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "capture_world_assert") {
    const response = await api("/api/internal/world/assert", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        claim: {
          subject: args.subject,
          predicate: args.predicate,
          object: args.object,
          sourceId: args.source_id,
          ...(typeof args.account_id === "string" ? { accountId: args.account_id } : {}),
          observedAt: args.observed_at,
          ...(typeof args.valid_from === "number" ? { validFrom: args.valid_from } : {}),
          ...(typeof args.valid_until === "number" ? { validUntil: args.valid_until } : {}),
          ...(typeof args.ttl_ms === "number" ? { ttlMs: args.ttl_ms } : {}),
          ...(typeof args.confidence === "number" ? { confidence: args.confidence } : {}),
          sensitivity: args.sensitivity,
          evidenceRef: args.evidence_ref,
          ...(typeof args.metadata === "object" && args.metadata !== null ? { metadata: args.metadata } : {}),
        },
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  if (name === "world_model_resolve") {
    const response = await api("/api/internal/world/resolve", {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        ...(typeof args.subject === "string" ? { subject: args.subject } : {}),
        ...(typeof args.subject_kind === "string" ? { subjectKind: args.subject_kind } : {}),
        ...(typeof args.predicate === "string" ? { predicate: args.predicate } : {}),
        ...(typeof args.include_stale === "boolean" ? { includeStale: args.include_stale } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      }),
    });
    return { text: JSON.stringify(response, null, 2) };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: EXPOSED_TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!EXPOSED_TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
