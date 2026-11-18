import { PreviewTestingBroker, testingViewport, validateTestingURL, testingError } from "./preview-testing.ts";
import { PREVIEW_BROWSER_RULES } from "./preview-guidance.ts";
import { saveTestingScreenshot } from "./preview-testing-files.ts";
import { writeJsonAtomic } from "./json-file.ts";
import { ScheduleStore, Scheduler, canManageSchedule, validateSchedule } from "./schedules.ts";
import type { ScheduleInput, ScheduleDelivery, ResumeContext } from "./schedule-types.ts";
import { canUseBackup, turnSelection } from "./backup-model.ts";
import type { UsageLimitFailure } from "./usage-types.ts";
import { UsageStore } from "./usage.ts";
import { UsageRefreshGate } from "./usage-refresh.ts";
import { USAGE_REFRESH_MS } from "./usage-types.ts";
import { usageLimitReset } from "./usage-classifiers.ts";
// Gerer Build Studio server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectService } from "../electron/projects.mjs";

import * as composio from "./composio.ts";
import * as trello from "./trello.ts";
import { TrelloLinkStore } from "./trelloLinks.ts";
import { TrelloSync } from "./trelloSync.ts";
import { ensureDirs, instanceConfigs, loadConfig, saveConfig, isRemovedComputerDriver, LEGACY_CLOUD_COMPUTER_DRIVER, DATA_DIR, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { ModelSelection, RuntimeEvent, SendTurnInput } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { handoffMentions, mentionedBots, ROOM_DEFAULT_HOPS, ROOM_IDLE_MINUTES_MAX, ROOM_MAX_HOPS, Store, type Attachment, type GroupRecord, type Message } from "./store.ts";
import { projectRegistryCandidates, readRegisteredProjects, resolveProjectContext } from "./projects.ts";
import { CHAT_FORMATTING_HINT } from "./chat-formatting.ts";
import { createTurnWatchdog, formatDuration, type TurnExpiry } from "./turn-watchdog.ts";
import {
  listProjectPreviewFiles,
  PreviewWatchManager,
  isEditablePreviewKind,
  readPreviewFileContent,
  resolveChatFileReference,
  resolvePreviewFile,
  writePreviewTextFile,
  type RegisteredProjectLike,
} from "./previewFiles.ts";
import { isJsonContentType, isLoopbackHostname, isPreviewAssetRead, rejectUntrustedRequest } from "./request-guard.ts";
import {
  resolveTaskContext,
  TaskConflictError,
  TaskStore,
  type CreateTaskInput,
  type TaskActor,
  type TaskFilters,
  type TaskRecord,
  type UpdateTaskInput,
} from "./tasks.ts";

const PORT = Number(process.env.GBS_PORT || 8899);
// Loopback only unless the operator explicitly opts into LAN exposure — the
// API drives agents that edit files and run commands (see request-guard.ts).
const HOST = process.env.GBS_HOST || "127.0.0.1";
const STATIC_DIR = process.env.GBS_STATIC_DIR || null;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

ensureDirs();
const cfg = loadConfig();
const usageStore = new UsageStore(DATA_DIR);
const usageRefreshGate = new UsageRefreshGate();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// ── peer-agent comms wiring ────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = randomBytes(24).toString("hex");
// Desktop-only credential stays in an owner-only file; never exposed through config or renderer IPC.
const previewToolTokens = new Map<string, string>();
const PREVIEW_BRIDGE_TOKEN = randomBytes(32).toString("hex");
writeJsonAtomic(join(DATA_DIR, "preview-testing-bridge.json"), { token: PREVIEW_BRIDGE_TOKEN, url: `http://127.0.0.1:${PORT}`, pid: process.pid });
const previewTesting = new PreviewTestingBroker();
const testingProjects = new Map<string, string>();
let testingEvidenceBytes = 0;
const testingBlockedOrigins = [`http://127.0.0.1:${PORT}`, process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199"];

// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// A peer invoked via ask_bot runs at depth 1: its proxy retains Preview,
// task and schedule tools, but filters peer discovery/messaging. The internal
// endpoint also enforces depth, so B→C (and A→B→A loops) never start.
const MAX_COMMS_DEPTH = 1;
// proxy entry: .ts in dev (node type-strips), .js in the packaged dist-server
const agentsProxyPath = (() => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "drivers", "agents-proxy.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(botId: string, depth: number) {
  if (!previewToolTokens.has(botId)) previewToolTokens.set(botId, randomBytes(32).toString("hex"));
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      GBS_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      GBS_BOT_ID: botId,
      GBS_COMMS_TOKEN: COMMS_TOKEN,
      GBS_TURN_DEPTH: String(depth),
      GBS_PREVIEW_TOKEN: previewToolTokens.get(botId)!,
    },
  };
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
function askBotAndWait(targetBotId: string, message: string, depth: number): Promise<string> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve("(no such bot)");
  const threadId = target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        finish(text || "(the bot finished without a text reply)");
      }
    });
    const timer = setTimeout(() => finish(text || "(timed out waiting for the bot to reply)"), 4 * 60_000);
    startTurn(targetBotId, message, { commsDepth: depth + 1 }).catch((err) =>
      finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`),
    );
  });
}

// default selection for new bots: first available instance, claude preferred
async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available" && d.models.options.length > 0);
  const pick = available.find((d) => d.driverKind === "claudeAgent") ?? available[0] ?? described[0];
  const model = pick?.models.default || "default";
  return { instanceId: pick?.instanceId ?? "claude", model, label: pick?.models.options.find((option) => option.id === model)?.label };
}
const bootSelection = await defaultSelection();
const removedComputerInstances = new Set([
  ...(!cfg.instances?.computer ? ["computer"] : []),
  LEGACY_CLOUD_COMPUTER_DRIVER,
  ...Object.entries(cfg.instances ?? {}).filter(([, entry]) => isRemovedComputerDriver(entry.driver)).map(([id]) => id),
]);
const store = new Store(() => bootSelection, removedComputerInstances);
const schedules = new ScheduleStore(DATA_DIR);
type ActiveTurnContext = { botId: string; message: Message; request: string; originalMessageId: string; attempt: number; selection: ModelSelection; usedBackup: boolean; commsDepth?: number };
const turnContexts = new Map<string, ActiveTurnContext>();
const activeSelections = new Map<string, ModelSelection>();
const stoppedConversations = new Set<string>();
const scheduler = new Scheduler(schedules, deliverSchedule);
schedules.onChange = () => { broadcast({ kind: "schedules", ...schedules.snapshot() }); scheduler.arm(); };

const taskStore = new TaskStore(DATA_DIR);
const trelloLinks = new TrelloLinkStore(DATA_DIR);
// Match the registry the desktop app (or an isolated test) is already using.
const projectRegistryFile = projectRegistryCandidates().find((file) => existsSync(file)) ?? projectRegistryCandidates()[0];
const projectService = new ProjectService({ dataDir: dirname(projectRegistryFile), filePath: projectRegistryFile });
const trelloSync = new TrelloSync({
  taskStore,
  trelloLinks,
  credentials: () => trelloCreds(),
  onTaskChanged: (task) => broadcast({ kind: "task.updated", task: taskView(task) }),
  log: (msg) => console.error(`[trello] ${msg}`),
});
const stopTrelloPolling = trelloSync.startPolling();
store.seedIfEmpty();

// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();
const notificationClients = new Set<ServerResponse>();
function broadcast(payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Preview files are served from the harness's own origin, and the request
// guard trusts same-origin callers. A previewed page or SVG that can run
// script must therefore get an opaque origin (CSP sandbox without
// allow-same-origin): its API requests then carry Origin "null" and are
// refused, so a file from an untrusted project can't drive the bots.
// PDFs run no page script and Chromium won't render them when sandboxed.
function previewFileCsp(mimeType: string): string {
  const frame = "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*";
  return mimeType.startsWith("application/pdf")
    ? frame
    : `sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; ${frame}`;
}

// In-memory project capabilities are issued only on trusted document reads.
// Relative resources carry the capability in their base URL; API URLs do not.
const previewCapabilities = new Map<string, string>();
const previewWatchManager = new PreviewWatchManager((payload) => broadcast(payload));

async function allRegisteredProjects(): Promise<RegisteredProjectLike[]> {
  const listed = await projectService.list();
  const byId = new Map<string, RegisteredProjectLike>();
  for (const project of listed) {
    byId.set(project.id, project);
  }
  for (const project of readRegisteredProjects()) {
    if (!byId.has(project.id)) {
      byId.set(project.id, project);
    }
  }
  return Array.from(byId.values());
}

function usageSnapshot() {
  return usageStore.list(registry.entries().map(instance => instance.instanceId));
}
async function refreshIdleUsage() {
  await Promise.allSettled(registry.instances().filter(instance => instance.enabled && instance.adapter.refreshUsage).map(instance =>
    usageRefreshGate.run(instance.instanceId, sseClients.size > notificationClients.size,
      !store.bots.some(bot => bot.busy && bot.modelSelection.instanceId === instance.instanceId) &&
      !store.groups.some(group => group.busyBotId && store.bot(group.busyBotId)?.modelSelection.instanceId === instance.instanceId),
      () => instance.adapter.refreshUsage!())));
}
const usageTimer = setInterval(() => void refreshIdleUsage(), USAGE_REFRESH_MS);
usageTimer.unref();

function deleteThreadLogs(threadId: string) {
  for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
    try {
      unlinkSync(join(dir, `${threadId}.ndjson`));
    } catch {}
  }
}

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
const toolMessageByItem = new Map<string, string>(); // itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // requestId -> messageId
const autoApprovedRequests = new Set<string>();
const requestKey = (threadId: string, requestId: string) => `${threadId}:${requestId}`;

// Group threads: the fold needs to know WHO is talking — the turn engine
// records the active member here before dispatching its turn.
const groupSpeakers = new Map<string, { botId: string; name: string; color: string }>();

bus.subscribe((event: RuntimeEvent) => {
  if (event.type === "usage.updated" && event.providerInstanceId) {
    usageStore.merge(event.providerInstanceId, event.usage);
    usageRefreshGate.noteRead(event.providerInstanceId);
    broadcast({ kind: "usage", engines: usageSnapshot() });
    return;
  }
  if ((event.type === "runtime.error" || event.type === "turn.completed") && event.failure && event.providerInstanceId) {
    const resetsAt = usageLimitReset(usageStore.get(event.providerInstanceId).windows);
    if (resetsAt) event.failure = { ...event.failure, resetsAt };
  }
  const bot = store.botByThread(event.threadId);
  const group = bot ? undefined : store.groupByThread(event.threadId);
  if (!bot && !group) return;
  const speaker = group ? groupSpeakers.get(event.threadId) : undefined;
  const autoApproved = event.type === "request.resolved" && event.behavior === "allow" && Boolean(event.requestId)
    ? autoApprovedRequests.delete(requestKey(event.threadId, event.requestId!)) : false;
  broadcast({ kind: "runtime", event: autoApproved ? { ...event, source: "auto" } : event, botId: bot?.id ?? speaker?.botId });

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, group && m.role === "bot" ? { ...m, from: speaker } : m);
    broadcast({ kind: "message", threadId: event.threadId, message });
    return message;
  };

  switch (event.type) {
    case "session.started":
      if (bot && event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        pushMessage({ role: "bot", kind: "text", text: event.text });
      } else if (event.itemType === "tool" && event.itemId) {
        const messageId = toolMessageByItem.get(event.itemId);
        if (messageId) {
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool?.name ?? "tool", ok: event.ok },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(event.itemId);
        }
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        // ask_bot's raw tool chip is redundant — the internal endpoint
        // appends a richer "Messaged @X" chip linking to the channel
        if (event.title?.endsWith("__ask_bot")) break;
        const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
        if (event.itemId) toolMessageByItem.set(event.itemId, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? "Approval needed" : "Your bot has a question",
          subtitle: event.summary,
          options: permission ? ["Allow", "Deny"] : event.choices ?? [],
          requestId: event.requestId,
          requestType: event.requestType,
        },
      });
      if (event.requestId) askMessageByRequest.set(event.requestId, message.id);
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          const patched = store.patchMessage(event.threadId, messageId, {
            card: { ...existing.card, answered: autoApproved ? "Allow" : event.behavior, autoApproved, dismissed: !autoApproved && event.source !== "user" },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          if (autoApproved && group) pushMessage({ role: "bot", kind: "activity", tool: { name: "Permission auto-approved" } });
        }
        if (event.requestId) askMessageByRequest.delete(event.requestId);
      }
      break;
    }
    case "runtime.error":
      pushMessage({ role: "bot", kind: "activity", tool: { name: event.failure?.kind === "usage_limit" ? "This AI app’s usage ran out." : `error: ${event.message.slice(0, 160)}`, ok: false } });
      break;
    case "turn.completed": {
      if (bot) {
        const context = turnContexts.get(event.threadId);
        turnContexts.delete(event.threadId);
        activeSelections.delete(event.threadId);
        queueMicrotask(() => void (async () => {
          if (!event.ok && event.failure && context) await handleUsageFailure(bot.id, context, event.failure);
          else if (event.ok) schedules.cancelResume(event.threadId);
          await scheduler.wake();
        })().catch(e => console.error("schedule continuation:", e instanceof Error ? e.message : "failed")));
        store.patchBot(bot.id, { busy: false, unread: true });
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
      }
      // group busy/unread settle in the group turn engine, which knows
      // whether more member turns are queued behind this one
      break;
    }
  }
});

// Where Electron's app.getPath("userData") lands, per platform — the
// hardcoded macOS path found nothing anywhere else, and threw the
// non-ENOENT errors into the same silent catch.
// `||`, not `??`: a set-but-empty APPDATA/XDG_CONFIG_HOME would otherwise
// join into a RELATIVE path resolved against the server's cwd — the same
// silent ENOENT this function exists to stop. Electron ignores empty values
// the same way.
function userDataRoot(): string {
  if (process.platform === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

// Local computer-use contract written by Electron main on startup
// (Electron's userData dir: ~/Library/Application Support on macOS,
// %APPDATA% on Windows — <dir>/cua-connection.json). Read fresh each turn —
// Electron may restart or permissions may change.
function readCuaConnection(): { command: string; args: string[]; env: Record<string, string> } | null {
  // new name first; pre-rename desktop builds used the old directory
  for (const dir of [
    "Gerer Build Studio",
    "gerer-build-studio",
  ]) {
    try {
      const p = join(userDataRoot(), dir, "cua-connection.json");
      const conn = JSON.parse(readFileSync(p, "utf8"));
      if (!conn || conn.mode === "unavailable" || !conn.mcpCommand) continue;
      return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function saveAttachmentsToWorkspace(threadId: string, attachments?: Attachment[]): Attachment[] | undefined {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return undefined;
  const tag = threadId.replace(/[^\w-]/g, "");
  const workspaceAttachmentsDir = join(DATA_DIR, "workspaces", tag, "attachments");
  try {
    mkdirSync(workspaceAttachmentsDir, { recursive: true });
  } catch {}

  return attachments.map((att) => {
    const rawName = typeof att.name === "string" ? att.name : "attachment";
    const base = basename(rawName).replace(/[^\w.-]/g, "_") || "attachment";
    const filename = `${String(att.id || "att").replace(/[^\w-]/g, "").slice(0, 8) || "att"}_${base}`;
    const filePath = join(workspaceAttachmentsDir, filename);
    // once the bytes are on disk, history keeps a link instead of the base64 —
    // a multi-MB data URL would otherwise be rewritten on every thread save
    const url = `/api/attachments/${tag}/${encodeURIComponent(filename)}`;
    const { dataUrl, ...rest } = att;

    if (dataUrl && typeof dataUrl === "string") {
      try {
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx !== -1) {
          writeFileSync(filePath, Buffer.from(dataUrl.slice(commaIdx + 1), "base64"));
          return { ...rest, path: filePath, url };
        }
      } catch (err) {
        console.error(`Failed to save attachment ${att.name} to ${filePath}:`, err);
      }
      return { ...att, path: filePath };
    }
    // edits and regenerations resend history attachments, which already live on disk
    return existsSync(filePath) ? { ...rest, path: filePath, url } : { ...att, path: filePath };
  });
}

const ATTACHMENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", json: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8",
};

/** Known safe types by extension; everything else downloads as bytes. */
function attachmentContentType(name: string): string {
  return ATTACHMENT_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function formatAttachmentContext(attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return "";
  const lines = ["[Attached files:]"];
  for (const att of attachments) {
    let line = `- ${att.name} (${att.mimeType || "application/octet-stream"}, ${formatBytes(att.size || 0)})`;
    if (att.path) {
      line += ` [Workspace path: ${att.path}]`;
    }
    lines.push(line);
    if (att.textContent && att.textContent.length < 50000) {
      const ext = att.name.includes(".") ? att.name.split(".").pop() : "";
      lines.push("```" + (ext || ""));
      lines.push(att.textContent);
      lines.push("```");
    }
  }
  return lines.join("\n");
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
type TurnIntegrations = NonNullable<SendTurnInput["integrations"]>;

/** Connected apps and the bot's computer on this machine — shared
 * by 1:1 and room turns so the two paths can't drift apart. */
async function computerAndAppIntegrations(
  bot: { id: string; name: string; computer?: string },
): Promise<TurnIntegrations> {
  const integrations: TurnIntegrations = {};
  if (cfg.composio?.key) integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
  if (bot.computer !== "off") {
    const cua = readCuaConnection();
    if (cua) integrations.localComputer = cua;
  }
  return integrations;
}

function computerPromptHint(integrations: TurnIntegrations): string {
  if (integrations.localComputer) {
    return "You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully.";
  }
  return "";
}

function postActivity(threadId: string, text: string) {
  const message = store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: text } });
  broadcast({ kind: "message", threadId, message });
}
function publishBot(botId: string) { broadcast({ kind: "bot", bot: store.bot(botId) }); }
async function handleUsageFailure(botId: string, context: ActiveTurnContext, failure: UsageLimitFailure, groupId?: string, roomState?: { hop: number; spoken: Set<string>; epoch: number }): Promise<boolean> {
  const bot = store.bot(botId); if (!bot) return false;
  const threadId = groupId ? store.group(groupId)?.threadId : bot.threadId;
  if (!threadId) return false;
  const stillCurrent = () => !stoppedConversations.has(threadId) && [...store.messagesFor(threadId)].reverse().find(m => m.role === "user" && m.kind === "text")?.id === context.message.id;
  if (!stillCurrent()) return false;
  const failedName = registry.get(context.selection.instanceId)?.displayName ?? "This AI app";
  const behavior = bot.onUsageLimit ?? "stop";
  const backup = bot.backupModelSelection;
  if (behavior === "backup" && !context.usedBackup && backup && canUseBackup(context.selection, backup, Boolean(registry.get(backup.instanceId)?.enabled), usageStore.get(backup.instanceId).status)) {
    const candidate = registry.get(backup.instanceId)!;
    const health = await candidate.snapshot().catch(() => ({ state: "unavailable" }));
    const models = await registry.modelCatalog(backup.instanceId);
    if (!stillCurrent() || (!groupId && store.bot(botId)?.busy)) return false;
    if (health.state === "available" && models.options.some(m => m.id === backup.model)) {
      store.patchBot(botId, { usingBackup: true }); publishBot(botId);
      postActivity(threadId, `Switched to ${backup.label ?? backup.model} because ${failedName}’s usage ran out. Continuing your task…`);
      if (groupId) await runGroupMemberTurn(groupId, botId, roomState?.hop ?? 0, roomState?.spoken ?? new Set(), roomState?.epoch ?? groupQueueEpoch.get(groupId) ?? 0, { selection: backup, context });
      else await startTurn(botId, context.message.text ?? context.request, { userMessage: context.message, forceModel: backup, retry: context, commsDepth: context.commsDepth });
      return true;
    }
  }
  if (behavior === "stop") { postActivity(threadId, `${failedName}’s usage ran out, so I stopped here. You can choose another AI model in bot settings.`); return false; }
  // If a backup is missing, unavailable, or also exhausted, wait rather than loop through models.
  const resume: ResumeContext = { botId, threadId, userMessageId: context.originalMessageId, request: context.request, attempt: context.attempt };
  const resetsAt = failure.resetsAt ?? usageLimitReset(usageStore.get(context.selection.instanceId).windows);
  try {
    const schedule = schedules.upsertResume(groupId ? { groupId } : { botId }, resume, resetsAt);
    postActivity(threadId, `${failedName}’s usage ran out. I’ll check back at ${new Date(schedule.nextRunAt!).toLocaleString()}. You can cancel this retry or resume now below.`);
  } catch { postActivity(threadId, "Usage ran out. A retry could not be scheduled. Check Schedules or choose another AI model."); }
  return false;
}
async function deliverSchedule(job: ScheduleDelivery): Promise<boolean> {
  const source = schedules.get(job.scheduleId);
  if (source?.origin === "bot" && source.createdBy && !canManageSchedule(source, source.createdBy, store.groups)) {
    schedules.finish(job.id, "failed", "The bot that created this schedule no longer has access to this conversation."); return true;
  }
  const bot = job.target.botId ? store.bot(job.target.botId) : undefined;
  const group = job.target.groupId ? store.group(job.target.groupId) : undefined;
  if (!bot && !group) { schedules.finish(job.id, "failed", "The bot or room no longer exists."); return true; }
  if (bot?.busy || group?.busyBotId || (group?.queuedBotIds?.length ?? 0) > 0 || (group && groupQueues.has(group.id))) return false;
  if (job.resume && (job.resume.threadId !== (bot?.threadId ?? group?.threadId) || !store.bot(job.resume.botId) || (group && !group.memberIds.includes(job.resume.botId)))) {
    schedules.finish(job.id, "failed", "This retry no longer belongs to this conversation."); return true;
  }
  if (job.resume && !job.manual) {
    const owner = store.bot(job.resume.botId)!;
    const selection = turnSelection(owner, usageStore.get(owner.modelSelection.instanceId).status);
    const adapter = registry.get(selection.instanceId)?.adapter;
    if (adapter?.refreshUsage) await adapter.refreshUsage();
    if (usageStore.get(selection.instanceId).status === "exhausted") {
      const reset = usageLimitReset(usageStore.get(selection.instanceId).windows);
      schedules.finish(job.id, "failed", "Usage is still unavailable. The retry has been moved.");
      schedules.upsertResume(job.target, job.resume, reset);
      return true;
    }
  }
  // Recheck after any asynchronous availability read before claiming the delivery.
  if (!schedules.pending().some(pending => pending.id === job.id)) return false;
  if (bot?.busy || group?.busyBotId || (group?.queuedBotIds?.length ?? 0) > 0) return false;
  schedules.claim(job.id);
  const scheduled = { scheduleId: job.scheduleId, deliveryId: job.id };
  if (bot) await startTurn(bot.id, job.prompt, { scheduled, resume: job.resume });
  else if (group) startGroupTurn(group.id, job.prompt, undefined, { scheduled, resume: job.resume });
  schedules.finish(job.id, "sent");
  broadcast({ kind: "schedule.started", target: job.target, scheduleId: job.scheduleId, name: bot?.name ?? group?.name, notify: Boolean(bot?.notifications || group?.memberIds.some(id => store.bot(id)?.notifications)) });
  return true;
}
function assertScheduleTarget(input: ScheduleInput, callerId?: string) {
  const bot = input.target?.botId ? store.bot(input.target.botId) : undefined;
  const group = input.target?.groupId ? store.group(input.target.groupId) : undefined;
  if (!bot && !group) throw Object.assign(new Error("Choose an existing bot or room."), { status: 404 });
  if (callerId && !(bot?.id === callerId || group?.memberIds.includes(callerId))) throw Object.assign(new Error("You can schedule only your own chat or rooms you belong to."), { status: 403 });
}

async function serveSchedules(req: IncomingMessage, res: ServerResponse, suffix: string, method: string, callerId?: string) {
  try {
    const scoped = (target: ScheduleInput["target"]) => target.botId === callerId || Boolean(target.groupId && store.group(target.groupId)?.memberIds.includes(callerId!));
    if (!suffix && method === "GET") {
      const snapshot = schedules.snapshot();
      return json(res, 200, callerId ? { ...snapshot, schedules: snapshot.schedules.filter(s => scoped(s.target)), deliveries: snapshot.deliveries.filter(j => scoped(j.target)), rooms: store.groups.filter(g => g.memberIds.includes(callerId)).map(g => ({ id: g.id, name: g.name })) } : snapshot);
    }
    if (!suffix && method === "POST") {
      const input = await readBody(req) as ScheduleInput; validateSchedule(input); assertScheduleTarget(input, callerId);
      const schedule = schedules.create(input, callerId ? "bot" : "user", callerId);
      return json(res, 201, { schedule });
    }
    if (suffix === "/pause" && method === "POST" && !callerId) {
      const body = await readBody(req); if (typeof body.paused !== "boolean") return json(res, 400, { error: "Choose whether schedules should be paused." });
      schedules.pause(body.paused); void scheduler.wake(); return json(res, 200, schedules.snapshot());
    }
    const match = suffix.match(/^\/([\w-]+)(?:\/(run-now))?$/);
    if (!match) return json(res, 404, { error: "Schedule action not found." });
    const schedule = schedules.get(match[1]); if (!schedule) return json(res, 404, { error: "Schedule not found." });
    if (callerId && !canManageSchedule(schedule, callerId, store.groups)) return json(res, 403, { error: "You can cancel only schedules you created in your own conversations." });
    if (method === "DELETE" && !match[2]) { schedules.remove(schedule.id); return json(res, 200, { ok: true }); }
    if (method === "PATCH" && !match[2] && !callerId) {
      const body = await readBody(req); const patch: Partial<ScheduleInput> = {};
      for (const key of ["target", "prompt", "repeat", "timezone", "enabled", "graceMinutes"] as const) if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
      validateSchedule({ ...schedule, ...patch }); assertScheduleTarget({ ...schedule, ...patch });
      return json(res, 200, { schedule: schedules.update(schedule.id, patch) });
    }
    if (method === "POST" && match[2] === "run-now" && !callerId) { schedules.runNow(schedule.id); void scheduler.wake(); return json(res, 202, { ok: true }); }
    return json(res, 405, { error: "This schedule action is not available." });
  } catch (e) { return json(res, (e as { status?: number }).status ?? 400, { error: e instanceof Error ? e.message : "Could not save this schedule." }); }
}

async function startTurn(
  botId: string,
  text: string,
  opts?: { commsDepth?: number; userMessage?: Message; attachments?: Attachment[]; scheduled?: Message["scheduled"]; forceModel?: ModelSelection; retry?: ActiveTurnContext; resume?: ResumeContext },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  stoppedConversations.delete(bot.threadId);
  const commsDepth = opts?.commsDepth ?? 0;

  const selection = opts?.forceModel ?? turnSelection(bot, usageStore.get(bot.modelSelection.instanceId).status);
  const instance = registry.get(selection.instanceId);
  if (!instance || !instance.enabled) {
    throw Object.assign(
      new Error(`provider instance "${selection.instanceId}" is unavailable — pick another model in settings`),
      { status: 409 },
    );
  }

  const currentCatalog = await registry.modelCatalog(selection.instanceId);
  if (currentCatalog.status === "ready" && !currentCatalog.options.some((model) => model.id === selection.model)) {
    throw Object.assign(new Error(`model "${selection.model}" is no longer available — choose a current model`), { status: 409 });
  }

  if (stoppedConversations.has(bot.threadId)) throw Object.assign(new Error("This task was stopped."), { status: 409 });
  if (bot.busy) throw Object.assign(new Error("The bot is already working."), { status: 409 });
  if (!opts?.retry && !opts?.resume) schedules.cancelResume(bot.threadId);
  if (bot.usingBackup && selection.instanceId === bot.modelSelection.instanceId) { store.patchBot(botId, { usingBackup: false }); publishBot(botId); }
  // an edit hands us its already-branched user message; a plain send appends
  let userMessage = opts?.userMessage;
  if (!userMessage) {
    const savedAttachments = saveAttachmentsToWorkspace(bot.threadId, opts?.attachments);
    userMessage = store.appendMessage(bot.threadId, { role: "user", kind: "text", text, scheduled: opts?.scheduled, attachments: savedAttachments });
    broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
  }

  // transcript for API-backed drivers: settled text turns on the ACTIVE
  // branch only — abandoned forks never reach the model
  const transcript = store
    .activePath(bot.threadId)
    .filter((m) => m.kind === "text" && (m.text || (m.attachments && m.attachments.length > 0)) && m.id !== userMessage.id)
    .slice(-40)
    .map((m) => {
      const attSummary = m.attachments?.length ? ` [Attached: ${m.attachments.map((a) => a.name).join(", ")}]` : "";
      return { role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: `${m.text || ""}${attSummary}`.trim() };
    });

  // After a rewind (edit / branch switch), or after selecting a different
  // model, the provider's native session cannot be trusted to represent the
  // active conversation. Start fresh and replay the visible path inline for
  // cursor-resuming drivers; transcript-replay drivers get it via transcript.
  // The rewind flag is cleared only once dispatch succeeds — clearing it here
  // would cost the next attempt its history if this dispatch fails.
  const rewound = Boolean(bot.rewound || opts?.forceModel);
  const resumeCursor = rewound ? undefined : bot.resumeCursors[selection.instanceId];
  const attPrompt = formatAttachmentContext(userMessage.attachments);
  const promptBody = [opts?.forceModel ? "A previous attempt may already have completed some actions. Inspect the current results before repeating actions, and continue the saved request below." : "", text, attPrompt].filter(Boolean).join("\n\n");
  const turnText =
    instance.driverKind !== "grok" && !resumeCursor && transcript.length
      ? [
          "[Continue this conversation using the following prior history. It was replayed because this is a fresh model session:]",
          "",
          ...transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`),
          "",
          "[Now reply to the user's latest message:]",
          "",
          promptBody,
        ].join("\n")
      : promptBody;

  const persona = [
    `You are ${bot.name}, a personal bot in Gerer Build Studio.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");
  const projectContext = resolveProjectContext([text, bot.description]);
  const taskContext = resolveTaskContext([text, bot.description], taskStore.list());

  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background so the HTTP request can finish promptly
  const context: ActiveTurnContext = { botId, message: userMessage, request: opts?.retry?.request ?? opts?.resume?.request ?? text,
    originalMessageId: opts?.retry?.originalMessageId ?? opts?.resume?.userMessageId ?? userMessage.id,
    attempt: opts?.retry?.attempt ?? opts?.resume?.attempt ?? 0, selection,
    usedBackup: Boolean(opts?.forceModel || selection.instanceId !== bot.modelSelection.instanceId), commsDepth };
  turnContexts.set(bot.threadId, context);
  activeSelections.set(bot.threadId, selection);
  store.patchBot(bot.id, { busy: true, unread: false });
  broadcast({ kind: "bot", bot: store.bot(bot.id) });

  void (async () => {
    try {
      const integrations = await computerAndAppIntegrations(bot);
      const computerHint = computerPromptHint(integrations);
      // peer-agent comms: give a user-initiated turn the list_bots/ask_bot
      // tools. Delegated turns retain the proxy for Preview/task/schedule
      // work; the proxy filters peer calls and the endpoint enforces depth.
      // Only drivers that mount the tools get the integration (and, via the
      // integrations.agents gate below, the prompt hint) — a bot on a driver
      // without it must not be told about tools it cannot call. Any bot can
      // still be the TARGET of ask_bot regardless of its driver.
      const canMessagePeers =
        commsDepth < MAX_COMMS_DEPTH && store.bots.some((candidate) => candidate.id !== bot.id && !candidate.hidden);
      if (instance.adapter.capabilities.agentsMcp === true) {
        integrations.agents = agentsIntegration(bot.id, commsDepth);
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit delegation nudge — the agent still does the ask_bot call
      // itself, so the harness stays the single owner of turns/permissions
      const tagged = integrations.agents && canMessagePeers
        ? mentionedBots(
            text,
            store.bots.filter((b) => b.id !== bot.id),
          )
        : [];

      const composioPrompt = await composio.formatConnectedAppsPrompt(cfg);

      if (turnContexts.get(bot.threadId) !== context || stoppedConversations.has(bot.threadId)) return;
      await instance.adapter.sendTurn({
        threadId: bot.threadId,
        text: turnText,
        attachments: userMessage.attachments,
        model: selection.model,
        // a rewound thread never resumes the abandoned branch's session
        resumeCursor,
        transcript,
        system:
          persona +
          `\n\n${CHAT_FORMATTING_HINT}` +
          (projectContext.system ? `\n\n${projectContext.system}` : "") +
          (taskContext.system ? `\n\n${taskContext.system}` : "") +
          composioPrompt +
          (computerHint ? ` ${computerHint}` : "") +
          (integrations.agents
            ? ` ${PREVIEW_BROWSER_RULES} You can create_schedule, list_schedules, and cancel_schedule for your own conversation or rooms you belong to. Schedules remain visible to the user and are capped at 20 active schedules per bot. You can use the shared task board through list_tasks, create_task, claim_task, update_task, delegate_task, and delete_task. Always use these tools for task changes; never read, edit, or replace tasks.json directly. Claim a suitable unassigned task before starting it, keep its status current, and move completed work to review so the user can verify it. If asked about your current, assigned, or in-progress work, call list_tasks (filter by your own assignee) before answering — do not guess from the filesystem or say none exist without checking.${canMessagePeers ? " You can also work with the user's other bots — list_bots shows who's available, and ask_bot sends one of them a message and returns their reply." : ""}`
            : "") +
          (tagged.length
            ? ` The user tagged ${tagged
                .map((t) => `@${t.name} (ask_bot bot_id ${t.id})`)
                .join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
            : ""),
        cwd: projectContext.cwd,
        integrations,
      });
      // dispatched: the rewind is spent, and the old cursors are dead
      if (rewound && turnContexts.get(bot.threadId) === context) store.patchBot(bot.id, { rewound: false, resumeCursors: {} });
    } catch (e) {
      if (turnContexts.get(bot.threadId) !== context) return;
      const message = e instanceof Error ? e.message : String(e);
      const failure = store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      broadcast({ kind: "message", threadId: bot.threadId, message: failure });
      turnContexts.delete(bot.threadId); activeSelections.delete(bot.threadId);
      store.patchBot(bot.id, { busy: false });
      void scheduler.wake();
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
    }
  })();
}

// ── config hot-reload ─────────────────────────────────────────────────
// ── group turn engine ──────────────────────────────────────────────────
// The Buzz rule: in a room, a bot replies only when @mentioned. Mentioned
// members run SEQUENTIALLY (one speaker at a time — the transcript and the
// streaming bubble stay coherent), each on a fresh session with the recent
// room conversation serialized into its prompt. A member's reply may
// @mention teammates; each gets a chained turn, up to the room's safety cap.
const groupQueues = new Map<string, Promise<void>>();
const groupQueueEpoch = new Map<string, number>();
// A room turn is stopped only when the bot goes quiet for GROUP_TURN_IDLE_MS
// (paused while it waits on an approval) or outlives GROUP_TURN_MAX_MS.
// GBS_GROUP_TURN_TIMEOUT_MS is the legacy name for the idle window.
const GROUP_TURN_IDLE_MS = Math.max(1_000, Number(process.env.GBS_GROUP_TURN_IDLE_MS ?? process.env.GBS_GROUP_TURN_TIMEOUT_MS) || 20 * 60_000);
const GROUP_TURN_MAX_MS = Math.max(GROUP_TURN_IDLE_MS, Number(process.env.GBS_GROUP_TURN_MAX_MS) || 3 * 60 * 60_000);
const GROUP_CONTEXT_MESSAGES = 30;

/** The room's handoff setting, falling back to the app-wide one. */
function roomHandoffsEnabled(group: GroupRecord): boolean {
  return group.handoffs === "inherit" ? (cfg.autoHandoffs ?? true) : group.handoffs === "on";
}

function queueGroupResponders(groupId: string, botIds: string[]) {
  if (botIds.length === 0) return;
  const group = store.group(groupId);
  if (!group) return;
  store.patchGroup(groupId, { queuedBotIds: [...(group.queuedBotIds ?? []), ...botIds] });
  broadcastGroup(groupId);
}

function startQueuedResponder(groupId: string, botId: string) {
  const group = store.group(groupId);
  if (!group) return;
  const queuedBotIds = [...(group.queuedBotIds ?? [])];
  const index = queuedBotIds.indexOf(botId);
  if (index >= 0) queuedBotIds.splice(index, 1);
  store.patchGroup(groupId, { busyBotId: botId, queuedBotIds });
  broadcastGroup(groupId);
}

function dropQueuedResponder(groupId: string, botId: string) {
  const group = store.group(groupId);
  if (!group) return;
  const queuedBotIds = [...(group.queuedBotIds ?? [])];
  const index = queuedBotIds.indexOf(botId);
  if (index < 0) return;
  queuedBotIds.splice(index, 1);
  store.patchGroup(groupId, { queuedBotIds });
  broadcastGroup(groupId);
}

/** Cancel one member's queued or active room activity. */
async function stopRoomActivity(group: GroupRecord, botId: string): Promise<"ok" | "busy-other" | "no-provider"> {
  if (group.queuedBotIds?.includes(botId)) {
    dropQueuedResponder(group.id, botId);
    return "ok";
  }
  if (group.busyBotId && group.busyBotId !== botId) return "busy-other";
  const bot = store.bot(botId);
  const instance = registry.get((activeSelections.get(group.threadId) ?? bot?.modelSelection)?.instanceId ?? "");
  if (!instance) return "no-provider";
  stoppedConversations.add(group.threadId); schedules.cancelResume(group.threadId);
  await instance.adapter.interruptTurn(group.threadId).catch(() => {});
  return "ok";
}

function serializeRoomContext(threadId: string, userName: string): string {
  return store
    .messagesFor(threadId)
    .filter((m) => m.kind === "text" && (m.text || (m.attachments && m.attachments.length > 0)))
    .slice(-GROUP_CONTEXT_MESSAGES)
    .map((m) => {
      const author = m.role === "user" ? userName : (m.from?.name ?? "Bot");
      const attSummary = m.attachments?.length
        ? ` [Attached: ${m.attachments.map((a) => a.name).join(", ")}]`
        : "";
      return `${author}: ${m.text || ""}${attSummary}`.trim();
    })
    .join("\n");
}

function broadcastGroup(groupId: string) {
  const group = store.group(groupId);
  if (group) broadcast({ kind: "group", group });
}

async function runGroupMemberTurn(
  groupId: string,
  botId: string,
  hop: number,
  // bots that already spoke for this user message — "@Scout ask @Pixel"
  // must not run Pixel twice (once chained, once as a direct responder).
  // Only the direct-responder loop reads it; chained mentions always run.
  spoken: Set<string> = new Set(),
  epoch = groupQueueEpoch.get(groupId) ?? 0,
  retry?: { selection: ModelSelection; context: ActiveTurnContext },
): Promise<void> {
  const group = store.group(groupId);
  const bot = store.bot(botId);
  if (!group) return;
  if (!bot || !group.memberIds.includes(botId)) {
    dropQueuedResponder(groupId, botId);
    return;
  }
  spoken.add(botId);
  const selection = retry?.selection ?? turnSelection(bot, usageStore.get(bot.modelSelection.instanceId).status);
  if (bot.usingBackup && selection.instanceId === bot.modelSelection.instanceId) { store.patchBot(botId, { usingBackup: false }); publishBot(botId); }
  const instance = registry.get(selection.instanceId);
  const userName = cfg.profile?.name?.trim() || "User";
  if (!instance) {
    const failure = store.appendMessage(group.threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: `error: ${bot.name}'s model is unavailable`, ok: false },
    });
    broadcast({ kind: "message", threadId: group.threadId, message: failure });
    return;
  }

  const groupCatalog = await registry.modelCatalog(selection.instanceId);
  if (groupCatalog.status === "ready" && !groupCatalog.options.some((model) => model.id === selection.model)) {
    const failure = store.appendMessage(group.threadId, {
      role: "bot", kind: "activity", from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: `error: ${bot.name}'s selected model was retired; choose another model`, ok: false },
    });
    broadcast({ kind: "message", threadId: group.threadId, message: failure });
    return;
  }

  startQueuedResponder(group.id, bot.id);
  groupSpeakers.set(group.threadId, { botId: bot.id, name: bot.name, color: bot.color });

  const roster = group.memberIds
    .map((id) => store.bot(id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
    .map((b) => `@${b.name}${b.title ? ` (${b.title})` : ""}`)
    .join(", ");
  const latestUserMessage = [...store.messagesFor(group.threadId)]
    .reverse()
    .find((message) => message.role === "user" && message.kind === "text");
  const latestUserText = latestUserMessage?.text ?? "";
  const integrations = await computerAndAppIntegrations(bot);
  if (instance.adapter.capabilities.agentsMcp === true) integrations.agents = agentsIntegration(bot.id, MAX_COMMS_DEPTH);

  const attPrompt = formatAttachmentContext(latestUserMessage?.attachments);
  const projectContext = resolveProjectContext([latestUserText, group.bulletin, bot.description]);
  const taskContext = resolveTaskContext([latestUserText, group.bulletin, bot.description], taskStore.list());
  const composioPrompt = await composio.formatConnectedAppsPrompt(cfg);
  const system = [
    `You are ${bot.name}, a bot in the room "${group.name}" in Gerer Build Studio.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
    `Room members: ${roster}, and ${userName} (the human).`,
    group.bulletin.trim() && `Room bulletin (shared instructions for everyone):\n${group.bulletin.trim()}`,
    projectContext.system,
    taskContext.system,
    composioPrompt.trim(),
    computerPromptHint(integrations),
    integrations.agents && PREVIEW_BROWSER_RULES,
    `Reply as yourself, briefly and conversationally. To bring a teammate in, mention them like @Name — they'll see the conversation and respond.`,
    CHAT_FORMATTING_HINT,
  ]
    .filter(Boolean)
    .join("\n");

  const text = `${serializeRoomContext(group.threadId, userName)}${attPrompt ? `\n\n${attPrompt}` : ""}\n\n(Reply to the conversation above as ${bot.name}.)`;


  // run the turn and wait for it to settle, folding the reply text so a
  // chained @mention can be routed afterwards
  let replyText = "";
  let usageFailure: UsageLimitFailure | undefined;
  activeSelections.set(group.threadId, selection);
  let timedOut: TurnExpiry | null = null;
  const idleMs = group.turnIdleMinutes ? group.turnIdleMinutes * 60_000 : GROUP_TURN_IDLE_MS;
  const maxMs = Math.max(idleMs, GROUP_TURN_MAX_MS);
  await new Promise<void>((resolve) => {
    let done = false;
    let interruptFallback: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      watchdog.stop();
      if (interruptFallback) clearTimeout(interruptFallback);
      unsub();
      resolve();
    };
    const watchdog = createTurnWatchdog({
      idleMs,
      maxMs,
      onExpire: (reason) => {
        timedOut = reason;
        void instance.adapter.interruptTurn(group.threadId)
          .catch(() => {})
          .finally(() => {
            interruptFallback = setTimeout(finish, 6_000);
          });
      },
    });
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== group.threadId) return;
      if (e.type === "request.opened") watchdog.requestOpened(e.requestId ?? "request");
      else if (e.type === "request.resolved") watchdog.requestResolved(e.requestId ?? "request");
      else watchdog.activity();
      if (e.type === "item.completed" && e.itemType === "assistant_text") replyText += `\n${e.text}`;
      else if (e.type === "turn.completed") { usageFailure = !e.ok ? e.failure : undefined; finish(); }
    });
    instance.adapter
      .sendTurn({ threadId: group.threadId, text, system, model: selection.model, cwd: projectContext.cwd, integrations })
      .catch((err) => {
        const failure = store.appendMessage(group.threadId, {
          role: "bot",
          kind: "activity",
          from: { botId: bot.id, name: bot.name, color: bot.color },
          tool: { name: `error: ${err instanceof Error ? err.message.slice(0, 140) : "turn failed"}`, ok: false },
        });
        broadcast({ kind: "message", threadId: group.threadId, message: failure });
        finish();
      });
  });
  activeSelections.delete(group.threadId);
  if (!timedOut && !stoppedConversations.has(group.threadId) && usageFailure && latestUserMessage) {
    const resume = roomResumes.get(group.threadId);
    const context: ActiveTurnContext = retry?.context ?? { botId, message: latestUserMessage, request: resume?.request ?? latestUserText,
      originalMessageId: resume?.userMessageId ?? latestUserMessage.id, attempt: resume?.attempt ?? 0, selection, usedBackup: selection.instanceId !== bot.modelSelection.instanceId };
    if (await handleUsageFailure(botId, { ...context, selection, usedBackup: Boolean(retry) || context.usedBackup }, usageFailure, groupId, { hop, spoken, epoch })) return;
  }
  if (timedOut) {
    const failure = store.appendMessage(group.threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: {
        name: timedOut === "max"
          ? `error: activity hit the ${formatDuration(maxMs)} limit and was stopped`
          : `error: activity went quiet for ${formatDuration(idleMs)} and was stopped`,
        ok: false,
      },
    });
    broadcast({ kind: "message", threadId: group.threadId, message: failure });
  }
  groupSpeakers.delete(group.threadId);
  store.patchGroup(group.id, { busyBotId: null, unread: true });
  broadcastGroup(group.id);

  // chained mentions: every teammate a reply @mentions gets a turn, including
  // one who already spoke — handing work back is the point. The room's cap
  // only stops a runaway loop, and a mention it can't answer is announced.
  const latestGroup = store.group(groupId);
  if (latestGroup && replyText.trim() && (groupQueueEpoch.get(groupId) ?? 0) === epoch) {
    const members = latestGroup.memberIds
      .map((id) => store.bot(id))
      .filter((b): b is NonNullable<typeof b> => Boolean(b) && b!.id !== bot.id);
    const mentioned = handoffMentions(replyText, members);
    const limit = latestGroup.maxHops ?? ROOM_DEFAULT_HOPS;
    if (mentioned.length && (!roomHandoffsEnabled(latestGroup) || hop >= limit)) {
      const names = mentioned.map((b) => b.name).join(" and ");
      const line = store.appendMessage(group.threadId, {
        role: "bot",
        kind: "activity",
        from: { botId: bot.id, name: bot.name, color: bot.color },
        tool: {
          name: roomHandoffsEnabled(latestGroup)
            ? `Paused after ${limit} handoffs. Mention ${names} to continue.`
            : `Auto handoffs are off. Mention ${names} to continue.`,
          ok: true,
        },
      });
      broadcast({ kind: "message", threadId: group.threadId, message: line });
    } else {
      for (const next of mentioned) {
        if ((groupQueueEpoch.get(groupId) ?? 0) !== epoch) break;
        queueGroupResponders(groupId, [next.id]);
        await runGroupMemberTurn(groupId, next.id, hop + 1, spoken, epoch);
      }
    }
  }
}

const roomResumes = new Map<string, ResumeContext>();
function startGroupTurn(groupId: string, text: string, attachments?: Attachment[], options?: { scheduled?: Message["scheduled"]; resume?: ResumeContext }) {
  const group = store.group(groupId);
  if (!group) throw Object.assign(new Error("no such group"), { status: 404 });
  if (!options?.resume) { schedules.cancelResume(group.threadId); roomResumes.delete(group.threadId); }
  else roomResumes.set(group.threadId, options.resume);
  stoppedConversations.delete(group.threadId);
  const savedAttachments = saveAttachmentsToWorkspace(group.threadId, attachments);
  const userMessage = store.appendMessage(group.threadId, { role: "user", kind: "text", text, scheduled: options?.scheduled, attachments: savedAttachments });
  broadcast({ kind: "message", threadId: group.threadId, message: userMessage });

  const members = group.memberIds
    .map((id) => store.bot(id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  const mentioned = mentionedBots(text, members);
  // Buzz rule: nobody replies unless mentioned — except a one-member room,
  // where the single bot obviously IS the addressee, or a room with a
  // default responder
  const fallback = members.length === 1 ? members : members.filter((b) => b.id === group.defaultResponderId);
  let responders = options?.resume ? members.filter(b => b.id === options.resume!.botId) : mentioned.length ? mentioned : fallback;
  // bot⇄bot channels: chipping in without a tag addresses the last speaker
  if (!responders.length && group.dm) {
    const lastSpeakerId = [...store.messagesFor(group.threadId)]
      .reverse()
      .find((msg) => msg.kind === "text" && msg.from)?.from?.botId;
    const last = members.find((b) => b.id === lastSpeakerId) ?? members[0];
    responders = last ? [last] : [];
  }
  if (!responders.length) return;

  const scheduled = responders.filter((responder, index) => responders.findIndex((item) => item.id === responder.id) === index);
  const epoch = groupQueueEpoch.get(groupId) ?? 0;
  queueGroupResponders(groupId, scheduled.map((responder) => responder.id));

  const prev = groupQueues.get(groupId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const spoken = new Set<string>();
    for (const responder of scheduled) {
      if ((groupQueueEpoch.get(groupId) ?? 0) !== epoch) break;
      if (spoken.has(responder.id)) continue;
      const latest = store.group(groupId);
      if (!latest?.queuedBotIds?.includes(responder.id)) continue;
      await runGroupMemberTurn(groupId, responder.id, 0, spoken, epoch);
    }
  });
  const settled = next.catch(() => {}).finally(() => {
    if (groupQueues.get(groupId) === settled) { groupQueues.delete(groupId); roomResumes.delete(group.threadId); }
    void scheduler.wake();
  });
  groupQueues.set(groupId, settled);
}

function configStatus() {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    trello: { keyConfigured: Boolean(cfg.trello?.key), configured: Boolean(cfg.trello?.token) },
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
    usageDisplay: cfg.usageDisplay,
    autoHandoffs: cfg.autoHandoffs ?? true,
    autoApprovePermissions: cfg.autoApprovePermissions ?? true,
    autoApproveDelaySeconds: cfg.autoApproveDelaySeconds ?? 10,
  };
}

function trelloCreds(): trello.TrelloCredentials | null {
  return cfg.trello?.key && cfg.trello?.token ? { key: cfg.trello.key, token: cfg.trello.token } : null;
}

// Served at GET /trello/callback (not under /api/) — the return_url Trello
// redirects the user's browser to after they approve access. Trello puts
// the token in the URL fragment, which only client-side JS can read, so
// this page reads it and hands it to the server itself.
const TRELLO_CALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Connecting Trello…</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #070707; color: #fcfcfc; font: 14px/1.5 -apple-system, "Segoe UI", Inter, system-ui, sans-serif; }
  .card { max-width: 360px; padding: 28px; border-radius: 14px; background: #111111; border: 1px solid #333333; text-align: center; }
  h1 { font-size: 15px; margin: 0 0 8px; }
  p { margin: 0; color: #fcfcfc99; }
  .ok { color: #38d591; } .err { color: #ff5667; }
</style></head>
<body><div class="card" id="card">
  <h1 id="title">Connecting your Trello account…</h1>
  <p id="detail">Hang on a second.</p>
</div>
<script>
(function () {
  var title = document.getElementById("title");
  var detail = document.getElementById("detail");
  var hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  var token = hash.get("token");
  if (!token) {
    title.textContent = "Trello wasn't connected";
    title.className = "err";
    detail.textContent = "Authorization was cancelled or didn't complete. You can close this tab and try again from Settings.";
    return;
  }
  fetch("/api/trello/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: token }),
  }).then(function (res) {
    if (!res.ok) throw new Error("save failed");
    title.textContent = "Trello connected";
    title.className = "ok";
    detail.textContent = "You can close this tab and return to Gerer Build Studio.";
  }).catch(function () {
    title.textContent = "Couldn't finish connecting";
    title.className = "err";
    detail.textContent = "The token was received but saving it failed. Close this tab and try again.";
  });
})();
</script>
</body></html>`;

function taskActorForBot(botId: string): Extract<TaskActor, { kind: "bot" }> | null {
  const bot = store.bot(botId);
  return bot ? { kind: "bot", botId: bot.id, name: bot.name } : null;
}

function taskFilters(url: URL): TaskFilters {
  const value = (name: string) => url.searchParams.get(name) || undefined;
  const nullable = (name: string) => {
    const current = url.searchParams.get(name);
    return current === "unassigned" || current === "none" ? null : current || undefined;
  };
  return {
    text: value("text"),
    projectId: nullable("projectId"),
    assigneeBotId: nullable("assigneeBotId"),
    status: value("status") as TaskFilters["status"],
    type: value("type") as TaskFilters["type"],
    priority: value("priority") as TaskFilters["priority"],
    tag: value("tag"),
    overdue: url.searchParams.has("overdue") ? url.searchParams.get("overdue") === "true" : undefined,
  };
}

function validateTaskReferences(input: CreateTaskInput | UpdateTaskInput, agentsOnly = false): string | null {
  if (input.projectId) {
    const project = readRegisteredProjects().find((candidate) => candidate.id === input.projectId);
    if (!project) return "no such project";
  }
  if (input.assigneeBotId) {
    const bot = store.bot(input.assigneeBotId);
    if (!bot || (agentsOnly && bot.hidden)) return "no such agent";
  }
  return null;
}

function taskView(task: TaskRecord, includeProjectPath = false) {
  const project = task.projectId
    ? readRegisteredProjects().find((candidate) => candidate.id === task.projectId)
    : undefined;
  const assignee = task.assigneeBotId ? store.bot(task.assigneeBotId) : undefined;
  return {
    ...task,
    project: task.projectId
      ? {
          id: task.projectId,
          name: project?.name ?? "Unavailable project",
          mention: project?.mention ?? task.projectId,
          available: Boolean(project?.available),
          ...(includeProjectPath && project?.available ? { path: project.path } : {}),
        }
      : null,
    assignee: task.assigneeBotId
      ? { id: task.assigneeBotId, name: assignee?.name ?? "Unavailable agent", available: Boolean(assignee && !assignee.hidden) }
      : null,
  };
}

function trelloLinkView(link: import("./trelloLinks.ts").TrelloLink) {
  const project = readRegisteredProjects().find((candidate) => candidate.id === link.projectId);
  return {
    ...link,
    project: project
      ? { id: project.id, name: project.name, mention: project.mention, available: project.available }
      : { id: link.projectId, name: "Unavailable project", mention: link.projectId, available: false },
  };
}

function taskBoardPayload() {
  return {
    tasks: taskStore.list().map((task) => taskView(task)),
    projects: readRegisteredProjects().map(({ id, name, mention, available }) => ({ id, name, mention, available })),
  };
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
}

// ── HTTP plumbing ─────────────────────────────────────────────────────
// Packaged UI only (Vite dev needs inline scripts for HMR). Scripts and API
// traffic stay on this origin; images may be remote (app logos, favicons).
const UI_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com",
    "frame-src 'self' http: https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

// messages carry attachments as base64, so they get more room than other routes;
// keep src/lib/messageSize.ts in step
const MAX_MESSAGE_BODY_CHARS = 25_000_000;

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      data += c;
      if (data.length > limit) {
        tooLarge = true;
        data = "";
        reject(httpError(413, "body too large"));
        // keep draining (and discarding) the upload: pausing leaves the client
        // mid-write, and a big body then sees ECONNRESET instead of the 413
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (data && !isJsonContentType(req.headers)) return reject(httpError(415, "request body must be application/json"));
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (path.startsWith("/api/")) {
      const refused = rejectUntrustedRequest(
        isPreviewAssetRead(method, req.url) ? { host: req.headers.host } : req.headers,
        { allowAnyHost: !isLoopbackHostname(HOST) },
      );
      if (refused) return json(res, 403, { error: refused });
    }
    // Desktop companion only. Normal app pages and website guests never receive this token.
    if (path === "/api/preview-testing/bridge") {
      res.setHeader("cache-control", "no-store");
      if (req.headers.authorization !== `Bearer ${PREVIEW_BRIDGE_TOKEN}`) return json(res, 401, { error: "unauthorized" });
      if (method === "GET") return json(res, 200, previewTesting.poll());
      if (method === "POST") {
        const body = await readBody(req, 12_000_000);
        if (body.control) {
          const action = body.control;
          if (!["pause", "resume", "close"].includes(action)) throw testingError("Invalid session control.");
          previewTesting.control(String(body.sessionId), action, typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined);
          return json(res, 200, { ok: true });
        }
        if (body.disconnected) { previewTesting.disconnect(); return json(res, 200, { ok: true }); }
        const pendingSession = previewTesting.pendingSession(body.id);
        if (!pendingSession) return json(res, 200, { accepted: false });
        if (body.result?.image) {
          if (testingEvidenceBytes > 64 * 1024 * 1024) throw testingError("Preview evidence budget reached for this app run.", 413);
          const project = testingProjects.get(pendingSession);
          try {
            const artifact = saveTestingScreenshot(body.result.image, DATA_DIR, project);
            testingEvidenceBytes += artifact.bytes;
            Object.assign(body.result, artifact);
          } catch (error) { body.error = (error as Error).message; body.result = undefined; }
        }
        return json(res, 200, { accepted: previewTesting.finish(body.id, body.result, body.error) });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    // ── internal peer-agent comms (localhost + shared token only) ──────
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (path.startsWith("/api/internal/")) {
      if (req.headers.authorization !== `Bearer ${COMMS_TOKEN}`) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (path.startsWith("/api/internal/preview-testing/")) {
        res.setHeader("cache-control", "no-store");
        const botId = String(req.headers["x-gbs-bot-id"] ?? "");
        if (!previewToolTokens.has(botId) || req.headers["x-gbs-preview-token"] !== previewToolTokens.get(botId)) return json(res, 401, { error: "Preview caller authentication failed" });
        const bot = store.bot(botId);
        if (!bot || bot.hidden) return json(res, 404, { error: "no such bot" });
        const operation = path.slice("/api/internal/preview-testing/".length);
        if (operation === "status" && method === "GET") return json(res, 200, previewTesting.status(botId));
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const body = await readBody(req);
        if (operation === "open" && body.target === "active") {
          // Act on the page the user already has open in Quick Preview; the desktop supplies its URL and size.
          const pending = previewTesting.open({ botId, botName: bot.name, name: typeof body.name === "string" ? body.name.slice(0, 100) : "Your page", url: "about:blank", source: { kind: "url", url: "about:blank", raw: "about:blank", isLocalOrPrivate: false }, width: 1440, height: 900, responsive: false, target: "active" });
          return json(res, 200, await pending);
        }
        if (operation === "open") {
          if (body.target !== undefined && body.target !== "new") throw testingError("target must be \"new\" or \"active\".");
          const viewport = testingViewport(body);
          let source: import("./preview-testing.ts").TestingSession["source"];
          let targetURL: string;
          let projectPath: string | undefined;
          if (body.project_id) {
            const project = (await allRegisteredProjects()).find(p => p.id === body.project_id);
            if (!project) throw testingError("No such registered project.", 404);
            if (body.path) {
              const resolved = resolvePreviewFile([project], String(body.project_id), String(body.path));
              if (resolved.kind !== "html") throw testingError("Interactive testing supports project HTML files.");
              source = { kind: "file", projectId: String(body.project_id), filePath: String(body.path), fileType: "html" };
              targetURL = `http://127.0.0.1:${PORT}/api/preview/file/${encodeURIComponent(String(body.project_id))}/${String(body.path).split("/").map(encodeURIComponent).join("/")}`;
            } else { targetURL = validateTestingURL(body.url, testingBlockedOrigins); source = { kind: "url", url: targetURL, raw: targetURL, isLocalOrPrivate: false }; }
            projectPath = project.path;
          } else { targetURL = validateTestingURL(body.url, testingBlockedOrigins); source = { kind: "url", url: targetURL, raw: targetURL, isLocalOrPrivate: false }; }
          const pending = previewTesting.open({ botId, botName: bot.name, name: typeof body.name === "string" ? body.name.slice(0, 100) : `${bot.name}'s test`, url: targetURL, source, ...viewport, target: "new" }, id => { if (projectPath) testingProjects.set(id, projectPath); });
          return json(res, 200, await pending);
        }
        const session = previewTesting.owned(body.session_id, botId);
        if (operation === "close") { testingProjects.delete(session.id); previewTesting.control(session.id, "close"); return json(res, 200, { closed: true }); }
        if (!["snapshot", "action", "screenshot", "diagnostics"].includes(operation)) throw testingError("Unknown Preview operation.");
        let action = operation;
        if (operation === "action") {
          action = String(body.action);
          if (!["click", "fill", "select", "press", "scroll", "wait", "navigate", "reload", "back", "forward", "resize"].includes(action)) throw testingError("Unknown Preview action.");
          if (action === "resize") Object.assign(body, testingViewport(body));
          if (action === "navigate") body.url = validateTestingURL(body.url, testingBlockedOrigins);
          if (typeof body.text === "string" && body.text.length > 20_000) throw testingError("Input text is too long.");
        }
        return json(res, 200, await previewTesting.execute(session, action, body));
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const self = url.searchParams.get("self");
        // title/description included so a "chief of staff"-style bot can
        // judge the team (who does what, who has no job description yet)
        const bots = store.bots
          .filter((b) => b.id !== self && !b.hidden)
          .map((b) => ({
            id: b.id,
            name: b.name,
            model: b.modelSelection.model,
            busy: !!b.busy,
            title: b.title || undefined,
            description: b.description || undefined,
          }));
        return json(res, 200, { bots });
      }
      if (method === "GET" && path === "/api/internal/connectors/active") {
        if (!cfg.composio?.key) return json(res, 200, { configured: false, activeConnections: [] });
        const activeConnections = await composio.listActiveConnections(cfg);
        return json(res, 200, { configured: true, activeConnections });
      }
      const callerId = String(req.headers["x-gbs-bot-id"] ?? "");
      const caller = taskActorForBot(callerId);
      if (path === "/api/internal/schedules" || path.startsWith("/api/internal/schedules/")) {
        if (!caller) return json(res, 401, { error: "Unknown calling bot." });
        return await serveSchedules(req, res, path.slice("/api/internal/schedules".length), method, callerId);
      }
      if (method === "GET" && path === "/api/internal/tasks") {
        if (!caller) return json(res, 401, { error: "unknown calling agent" });
        return json(res, 200, { tasks: taskStore.list(taskFilters(url)).map((task) => taskView(task, true)) });
      }
      if (method === "POST" && path === "/api/internal/tasks") {
        if (!caller) return json(res, 401, { error: "unknown calling agent" });
        const body = await readBody(req) as CreateTaskInput;
        const referenceError = validateTaskReferences(body, true);
        if (referenceError) return json(res, 404, { error: referenceError });
        const task = taskStore.create(body, caller);
        broadcast({ kind: "task.created", task: taskView(task) });
        void trelloSync.pushTask(task.id).catch(() => {});
        return json(res, 201, { task: taskView(task, true) });
      }
      let taskMatch = path.match(/^\/api\/internal\/tasks\/([\w-]+)$/);
      if (taskMatch && method === "PATCH") {
        if (!caller) return json(res, 401, { error: "unknown calling agent" });
        const body = await readBody(req);
        const patch = (body.patch ?? {}) as UpdateTaskInput;
        const referenceError = validateTaskReferences(patch, true);
        if (referenceError) return json(res, 404, { error: referenceError });
        const task = taskStore.update(taskMatch[1], Number(body.revision), patch, caller);
        broadcast({ kind: "task.updated", task: taskView(task) });
        void trelloSync.pushTask(task.id).catch(() => {});
        return json(res, 200, { task: taskView(task, true) });
      }
      taskMatch = path.match(/^\/api\/internal\/tasks\/([\w-]+)\/claim$/);
      if (taskMatch && method === "POST") {
        if (!caller) return json(res, 401, { error: "unknown calling agent" });
        const body = await readBody(req);
        const task = taskStore.claim(taskMatch[1], Number(body.revision), caller);
        broadcast({ kind: "task.updated", task: taskView(task) });
        void trelloSync.pushTask(task.id).catch(() => {});
        return json(res, 200, { task: taskView(task, true) });
      }
      taskMatch = path.match(/^\/api\/internal\/tasks\/([\w-]+)\/delegate$/);
      if (taskMatch && method === "POST") {
        if (!caller) return json(res, 401, { error: "unknown calling agent" });
        const body = await readBody(req);
        const target = store.bot(String(body.botId ?? ""));
        if (!target || target.hidden) return json(res, 404, { error: "no such agent" });
        const task = taskStore.delegate(taskMatch[1], Number(body.revision), target.id, target.name, caller);
        broadcast({ kind: "task.updated", task: taskView(task) });
        void trelloSync.pushTask(task.id).catch(() => {});
        return json(res, 200, { task: taskView(task, true) });
      }
      taskMatch = path.match(/^\/api\/internal\/tasks\/([\w-]+)$/);
      if (taskMatch && method === "DELETE") {
        if (!caller) return json(res, 401, { error: "unknown calling agent" });
        const body = await readBody(req);
        const task = taskStore.delete(taskMatch[1], Number(body.revision));
        broadcast({ kind: "task.deleted", taskId: task.id });
        void trelloSync.archiveTask(task).catch(() => {});
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        if (toBotId === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
        if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        if (target.busy) return json(res, 200, { busy: true });
        const from = store.bot(fromBotId);
        const fromName = from?.name ?? "another bot";

        // the exchange is mirrored into a bot⇄bot channel: it shows up in
        // the sidebar like any room, keeps the pair's full history, and the
        // user can open it and chip in
        let channel = from ? store.dmGroup(from.id, target.id) : undefined;
        if (from && !channel) {
          channel = store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true);
        }
        const mirror = (speaker: { id: string; name: string; color: string }, text: string) => {
          if (!channel || !text.trim()) return;
          const msg = store.appendMessage(channel.threadId, {
            role: "bot",
            kind: "text",
            text,
            from: { botId: speaker.id, name: speaker.name, color: speaker.color },
          });
          broadcast({ kind: "message", threadId: channel.threadId, message: msg });
        };
        // both 1:1 threads get a clickable chip that opens the channel, so
        // bot-to-bot turns are never invisible (they cost the user tokens)
        const chip = (
          threadId: string,
          label: string,
          withBot: { id: string; name: string; color: string },
        ) => {
          const note = store.appendMessage(threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: label },
            comm: channel
              ? { groupId: channel.id, withBotId: withBot.id, withName: withBot.name, withColor: withBot.color }
              : undefined,
          });
          broadcast({ kind: "message", threadId, message: note });
        };
        if (from) {
          mirror(from, message);
          chip(from.threadId, `Messaged @${target.name}`, target);
          chip(target.threadId, `Message from @${from.name}`, from);
          if (channel) {
            store.patchGroup(channel.id, { unread: true });
            broadcastGroup(channel.id);
          }
        }
        const prefixed = `[Message from @${fromName}, another bot in this Gerer Build Studio workspace. Reply to them.]\n\n${message}`;
        const reply = await askBotAndWait(toBotId, prefixed, depth);
        if (from) {
          mirror(target, reply);
          if (channel) {
            store.patchGroup(channel.id, { unread: true });
            broadcastGroup(channel.id);
          }
        }
        return json(res, 200, { botName: target.name, text: reply });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }

    if (path === "/api/schedules" || path.startsWith("/api/schedules/")) return await serveSchedules(req, res, path.slice("/api/schedules".length), method);

    if (method === "GET" && path === "/api/usage") return json(res, 200, { engines: usageSnapshot() });

    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      sseClients.add(res);
      if (url.searchParams.get("notifications") === "1") notificationClients.add(res);
      res.write(`data: ${JSON.stringify({ kind: "usage", engines: usageSnapshot() })}\n\n`);
      res.write(`data: ${JSON.stringify({ kind: "schedules", ...schedules.snapshot() })}\n\n`);
      void refreshIdleUsage();
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(res);
        notificationClients.delete(res);
        if (sseClients.size === 0) {
          previewWatchManager.closeAll();
        }
      });
      return;
    }

    // ── shared task board ─────────────────────────────────────────────
    if (method === "GET" && path === "/api/tasks") {
      return json(res, 200, taskBoardPayload());
    }
    if (method === "POST" && path === "/api/tasks") {
      const body = await readBody(req) as CreateTaskInput;
      const referenceError = validateTaskReferences(body);
      if (referenceError) return json(res, 404, { error: referenceError });
      const task = taskStore.create(body, { kind: "user" });
      broadcast({ kind: "task.created", task: taskView(task) });
      void trelloSync.pushTask(task.id).catch(() => {});
      return json(res, 201, { task: taskView(task) });
    }
    let taskMatch = path.match(/^\/api\/tasks\/([\w-]+)$/);
    if (taskMatch && method === "PATCH") {
      const body = await readBody(req);
      const patch = (body.patch ?? {}) as UpdateTaskInput;
      const referenceError = validateTaskReferences(patch);
      if (referenceError) return json(res, 404, { error: referenceError });
      const task = taskStore.update(taskMatch[1], Number(body.revision), patch, { kind: "user" });
      broadcast({ kind: "task.updated", task: taskView(task) });
      void trelloSync.pushTask(task.id).catch(() => {});
      return json(res, 200, { task: taskView(task) });
    }
    taskMatch = path.match(/^\/api\/tasks\/([\w-]+)\/delegate$/);
    if (taskMatch && method === "POST") {
      const body = await readBody(req);
      const target = store.bot(String(body.botId ?? ""));
      if (!target) return json(res, 404, { error: "no such agent" });
      const task = taskStore.delegate(taskMatch[1], Number(body.revision), target.id, target.name, { kind: "user" });
      broadcast({ kind: "task.updated", task: taskView(task) });
      void trelloSync.pushTask(task.id).catch(() => {});
      return json(res, 200, { task: taskView(task) });
    }
    taskMatch = path.match(/^\/api\/tasks\/([\w-]+)$/);
    if (taskMatch && method === "DELETE") {
      const body = await readBody(req);
      const task = taskStore.delete(taskMatch[1], Number(body.revision));
      broadcast({ kind: "task.deleted", taskId: task.id });
      void trelloSync.archiveTask(task).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      return json(res, 200, {
        bots: store.bots.map((b) => ({
          ...b,
          messages: store.messagesFor(b.threadId),
          activeLeafId: store.activeLeaf(b.threadId),
        })),
        groups: store.groups.map((g) => ({ ...g, messages: store.messagesFor(g.threadId) })),
      });
    }

    // ── rooms (group chats) ─────────────────────────────────────────────
    let m: RegExpMatchArray | null = null;
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      const memberIds = (Array.isArray(body.memberIds) ? body.memberIds : []).filter(
        (id: unknown): id is string => typeof id === "string" && Boolean(store.bot(id)),
      );
      if (memberIds.length === 0) return json(res, 400, { error: "a room needs at least one bot" });
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : `${store.bot(memberIds[0])!.name} & co.`;
      const group = store.createGroup(name, memberIds);
      broadcast({ kind: "group", group });
      return json(res, 201, { group: { ...group, messages: [] } });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const current = store.group(m[1]);
      if (!current) return json(res, 404, { error: "no such room" });
      const patch: Parameters<typeof store.patchGroup>[1] = {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim()) return json(res, 400, { error: "name must be a non-empty string" });
        patch.name = body.name.trim().slice(0, 80);
      }
      if (body.bulletin !== undefined) {
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        patch.bulletin = body.bulletin;
      }
      if (body.unread !== undefined) patch.unread = Boolean(body.unread);
      // legacy boolean from older clients
      if (body.autoHandoffs !== undefined) {
        if (typeof body.autoHandoffs !== "boolean") return json(res, 400, { error: "autoHandoffs must be a boolean" });
        patch.handoffs = body.autoHandoffs ? "on" : "off";
      }
      if (body.handoffs !== undefined) {
        if (!["inherit", "on", "off"].includes(body.handoffs)) return json(res, 400, { error: "handoffs must be inherit, on or off" });
        patch.handoffs = body.handoffs;
      }
      if (body.maxHops !== undefined) {
        if (!Number.isInteger(body.maxHops) || body.maxHops < 1 || body.maxHops > ROOM_MAX_HOPS) {
          return json(res, 400, { error: `maxHops must be a whole number from 1 to ${ROOM_MAX_HOPS}` });
        }
        patch.maxHops = body.maxHops;
      }
      if (body.turnIdleMinutes !== undefined) {
        if (body.turnIdleMinutes !== null && (!Number.isInteger(body.turnIdleMinutes) || body.turnIdleMinutes < 1 || body.turnIdleMinutes > ROOM_IDLE_MINUTES_MAX)) {
          return json(res, 400, { error: `turnIdleMinutes must be null or a whole number from 1 to ${ROOM_IDLE_MINUTES_MAX}` });
        }
        patch.turnIdleMinutes = body.turnIdleMinutes;
      }
      if (body.memberIds !== undefined) {
        if (!Array.isArray(body.memberIds)) return json(res, 400, { error: "memberIds must be an array" });
        const ids = [...new Set(body.memberIds.filter((id: unknown): id is string => typeof id === "string" && Boolean(store.bot(id))))] as string[];
        if (!ids.length) return json(res, 400, { error: "a room needs at least one bot" });
        patch.memberIds = ids;
      }
      const memberIds = patch.memberIds ?? current.memberIds;
      if (body.defaultResponderId !== undefined) {
        if (body.defaultResponderId !== null && (typeof body.defaultResponderId !== "string" || !memberIds.includes(body.defaultResponderId))) {
          return json(res, 400, { error: "defaultResponderId must be null or a room member" });
        }
        patch.defaultResponderId = body.defaultResponderId;
      } else if (current.defaultResponderId && !memberIds.includes(current.defaultResponderId)) {
        patch.defaultResponderId = null;
      }
      if (body.projectId !== undefined) {
        if (body.projectId !== null && typeof body.projectId !== "string") {
          return json(res, 400, { error: "projectId must be a string or null" });
        }
        patch.projectId = body.projectId;
      }
      const removed = current.memberIds.filter((id) => !memberIds.includes(id));
      const added = memberIds.filter((id) => !current.memberIds.includes(id));
      // stop what a removed member is doing before it leaves the roster
      for (const id of removed) await stopRoomActivity(current, id);
      const group = store.patchGroup(m[1], patch);
      if (!group) return json(res, 404, { error: "no such room" });
      broadcast({ kind: "group", group });
      for (const [ids, verb] of [[added, "joined"], [removed, "left"]] as const) {
        for (const id of ids) {
          const member = store.bot(id);
          if (!member) continue;
          const line = store.appendMessage(group.threadId, {
            role: "bot",
            kind: "activity",
            from: { botId: member.id, name: member.name, color: member.color },
            tool: { name: `${member.name} ${verb} the room`, ok: true },
          });
          broadcast({ kind: "message", threadId: group.threadId, message: line });
        }
      }
      return json(res, 200, { group });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      store.deleteGroup(group.id);
      deleteThreadLogs(group.threadId);
      broadcast({ kind: "group.deleted", groupId: group.id });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req, MAX_MESSAGE_BODY_CHARS);
      const text = String(body.text ?? "").trim();
      const attachments = Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : undefined;
      if (!text && (!attachments || attachments.length === 0)) {
        return json(res, 400, { error: "text or attachment required" });
      }
      startGroupTurn(m[1], text, attachments);
      return json(res, 202, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      const busy = group.busyBotId ? store.bot(group.busyBotId) : undefined;
      if (busy) previewTesting.stopOwner(busy.id);
      const instance = busy ? registry.get((activeSelections.get(group.threadId) ?? busy.modelSelection).instanceId) : undefined;
      stoppedConversations.add(group.threadId); schedules.cancelResume(group.threadId);
      groupQueueEpoch.set(group.id, (groupQueueEpoch.get(group.id) ?? 0) + 1);
      store.patchGroup(group.id, { queuedBotIds: [] });
      broadcastGroup(group.id);
      await instance?.adapter.interruptTurn(group.threadId).catch(() => {});
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/activities\/([\w-]+)\/stop$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      const bot = store.bot(m[2]);
      if (!group || !bot || !group.memberIds.includes(bot.id)) return json(res, 404, { error: "no such room activity" });
      const stopped = await stopRoomActivity(group, bot.id);
      if (stopped === "busy-other") return json(res, 409, { error: "another agent owns the active room turn" });
      if (stopped === "no-provider") return json(res, 409, { error: "provider unavailable" });
      return json(res, 200, { ok: true });
    }

    // Erase one transcript without deleting its bot or room. The idle guard
    // prevents a late runtime event from repopulating history after clearing.
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (m && method === "DELETE") {
      const threadId = m[1];
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      if (!bot && !group) return json(res, 404, { error: "no such conversation" });
      if (bot?.busy || group?.busyBotId || (group?.queuedBotIds?.length ?? 0) > 0) {
        return json(res, 409, { error: "Wait for the conversation to finish before clearing it." });
      }

      store.clearThread(threadId);
      deleteThreadLogs(threadId);
      broadcast({ kind: "thread.cleared", threadId });
      return json(res, 200, { ok: true });
    }

    // emoji reactions — works on any thread (1:1 or room)
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const emoji = String(body.emoji ?? "").slice(0, 8);
      if (!emoji) return json(res, 400, { error: "emoji required" });
      const patched = store.toggleReaction(m[1], m[2], emoji, typeof body.by === "string" ? body.by : "user");
      if (!patched) return json(res, 404, { error: "no such message" });
      broadcast({ kind: "message.patch", threadId: m[1], message: patched });
      return json(res, 200, { message: patched });
    }
    if (method === "POST" && path === "/api/bots") {
      const bot = store.createBot();
      store.patchBot(bot.id, { modelSelection: await defaultSelection() });
      return json(res, 201, {
        bot: {
          ...store.bot(bot.id)!,
          messages: store.messagesFor(bot.threadId),
          activeLeafId: store.activeLeaf(bot.threadId),
        },
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "backupModelSelection", "onUsageLimit", "unread", "computer", "color", "mascotExpression", "pinned", "hidden"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const current = store.bot(m[1]);
      if (!current) return json(res, 404, { error: "no such bot" });
      if ((patch.modelSelection !== undefined || patch.backupModelSelection !== undefined || patch.onUsageLimit !== undefined) &&
        (current.busy || store.groups.some(g => g.busyBotId === current.id))) return json(res, 409, { error: "Wait for this bot to finish before changing its AI model." });
      if (patch.onUsageLimit !== undefined && !["backup", "wait", "stop"].includes(String(patch.onUsageLimit))) return json(res, 400, { error: "Choose what should happen when usage runs out." });
      for (const key of ["modelSelection", "backupModelSelection"] as const) {
        const value = patch[key];
        if (value === null && key === "backupModelSelection") { patch[key] = undefined; continue; }
        if (value !== undefined && (!value || typeof value !== "object" || typeof (value as ModelSelection).instanceId !== "string" || typeof (value as ModelSelection).model !== "string")) return json(res, 400, { error: "Choose an AI model." });
      }
      if (patch.modelSelection !== undefined || patch.backupModelSelection !== undefined) patch.usingBackup = false;
      const nextSelection = patch.modelSelection as ModelSelection | undefined;
      if (
        nextSelection &&
        (nextSelection.instanceId !== current.modelSelection.instanceId || nextSelection.model !== current.modelSelection.model)
      ) {
        // Native sessions are model-specific. Dropping their cursors makes
        // the next turn start under the selected model; startTurn replays the
        // active local transcript so switching never loses chat context.
        patch.resumeCursors = {};
      }
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      broadcast({ kind: "bot", bot });
      return json(res, 200, { bot });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // a running turn dies with its bot
      await registry.get((activeSelections.get(bot.threadId) ?? bot.modelSelection).instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
      previewTesting.stopOwner(bot.id, "Bot deleted");
      store.deleteBot(bot.id);
      deleteThreadLogs(bot.threadId);
      broadcast({ kind: "bot.deleted", botId: bot.id });
      return json(res, 200, { ok: true });
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    // saved chat attachments. Served sandboxed so an uploaded .html/.svg
    // opened from the chat can't run script in the app's origin.
    m = path.match(/^\/api\/attachments\/([\w-]+)\/([^/]+)$/);
    if (m && method === "GET") {
      const name = decodeURIComponent(m[2]);
      if (!/^[\w-]+_[\w.-]+$/.test(name) || name.includes("..")) return json(res, 400, { error: "bad attachment name" });
      const file = join(DATA_DIR, "workspaces", m[1], "attachments", name);
      if (!existsSync(file)) return json(res, 404, { error: "no such attachment" });
      res.writeHead(200, {
        "content-type": attachmentContentType(name),
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
      });
      res.end(readFileSync(file));
      return;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req, MAX_MESSAGE_BODY_CHARS);
      const text = String(body.text ?? "").trim();
      const attachments = Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : undefined;
      if (!text && (!attachments || attachments.length === 0)) {
        return json(res, 400, { error: "text or attachment required" });
      }
      await startTurn(m[1], text, { attachments });
      return json(res, 202, { ok: true });
    }

    // edit a user message → fork the conversation there and rerun the turn.
    // Rewinding a live thread is refused, exactly like switching versions
    // below: interrupting mid-flight and branching under the dying turn is
    // how a conversation ends up with two tails. Stop, then edit.
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req, MAX_MESSAGE_BODY_CHARS);
      const text = String(body.text ?? "").trim();
      const attachments = Array.isArray(body.attachments) ? (body.attachments as Attachment[]) : undefined;
      if (!text && (!attachments || attachments.length === 0)) {
        return json(res, 400, { error: "text or attachment required" });
      }
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn flips busy before the
      // next request is handled
      if (bot.busy) return json(res, 409, { error: "the bot is working — stop it before editing" });
      const source = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        return json(res, 404, { error: "only user messages can be edited" });
      }
      if (!registry.get(bot.modelSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
        });
      }
      const savedAttachments = saveAttachmentsToWorkspace(bot.threadId, attachments ?? source.attachments);
      const message = store.branchMessage(bot.threadId, messageId, text, savedAttachments);
      if (!message) return json(res, 404, { error: "no such message" });
      store.patchBot(bot.id, { rewound: true });
      broadcast({ kind: "message", threadId: bot.threadId, message });
      broadcast({ kind: "thread", threadId: bot.threadId, activeLeafId: message.id });
      await startTurn(bot.id, text, { userMessage: message });
      return json(res, 202, { ok: true });
    }

    // switch which fork of the conversation is visible (no new turn)
    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (bot.busy) return json(res, 409, { error: "the bot is working — stop it before switching versions" });
      const body = await readBody(req);
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      // provider sessions still hold the other branch — next turn replays
      store.patchBot(bot.id, { rewound: true });
      broadcast({ kind: "thread", threadId: bot.threadId, activeLeafId: leaf });
      return json(res, 200, { activeLeafId: leaf });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const requestedThreadId = typeof body.threadId === "string" && body.threadId ? body.threadId : bot.threadId;
      const instance = registry.get((activeSelections.get(requestedThreadId) ?? bot.modelSelection).instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      if (requestedThreadId !== bot.threadId) {
        const group = store.groupByThread(requestedThreadId);
        if (!group || !group.memberIds.includes(bot.id) || groupSpeakers.get(requestedThreadId)?.botId !== bot.id) {
          return json(res, 403, { error: "agent is not awaiting input in that room" });
        }
      }
      const requestId = String(body.requestId);
      const autoApproved = body.autoApproved === true;
      const autoKey = requestKey(requestedThreadId, requestId);
      if (autoApproved) {
        const pending = store.messagesFor(requestedThreadId).find((message) => message.card?.requestId === requestId);
        if (cfg.autoApprovePermissions === false || body.behavior !== "allow" || pending?.card?.requestType !== "permission" || pending.card.answered || pending.card.dismissed) {
          return json(res, 409, { error: "That permission card is not available for auto-approval." });
        }
        autoApprovedRequests.add(autoKey);
      }
      try {
        await instance.adapter.respondToRequest(requestedThreadId, requestId, {
          behavior: body.behavior,
          message: body.message,
        });
      } catch (error) {
        if (autoApproved) autoApprovedRequests.delete(autoKey);
        throw error;
      }
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get((activeSelections.get(bot.threadId) ?? bot.modelSelection).instanceId);
      previewTesting.stopOwner(bot.id);
      stoppedConversations.add(bot.threadId); schedules.cancelResume(bot.threadId); turnContexts.delete(bot.threadId);
      if (!instance?.adapter.hasSession(bot.threadId)) { activeSelections.delete(bot.threadId); store.patchBot(bot.id, { busy: false }); publishBot(bot.id); void scheduler.wake(); }
      await instance?.adapter.interruptTurn(bot.threadId);
      return json(res, 200, { ok: true });
    }

    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "gerer-build-studio", pid: process.pid, static: Boolean(STATIC_DIR) });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      return json(res, 200, { instances: await registry.describe(url.searchParams.get("refresh") === "1") });
    }

    // ── per-instance auto-approve permission toggle (Settings → Models) ──
    m = path.match(/^\/api\/instances\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const instanceId = m[1];
      const body = await readBody(req);
      if (typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be a boolean" });
      const driverConfig = registry.getDriverConfig(instanceId);
      if (!driverConfig) return json(res, 404, { error: "no such instance" });
      const { driver, config } = driverConfig;
      if (!driver.setAutoApprove) return json(res, 400, { error: "this provider has no configurable permission mode" });
      if (body.autoApprove && driver.driverKind === "claudeAgent" && process.getuid?.() === 0) {
        return json(res, 400, { error: "Claude Full auto is unavailable while the app runs as root. Use Ask before actions or run the app as a regular user." });
      }
      const nextConfig = driver.setAutoApprove(config, body.autoApprove);
      // `instances` is all-or-nothing on disk (instanceConfigs only falls
      // back to the built-in default fleet when disk has NO instances key
      // at all) — writing just the touched instance would silently drop
      // every other default-fleet instance the next time config loads.
      // Materialize the full effective fleet first, patch only this one.
      const fullFleet = instanceConfigs(cfg);
      const instancesPatch: typeof fullFleet = {};
      for (const [id, entry] of Object.entries(fullFleet)) {
        const { environment: _environment, ...rest } = entry; // don't persist injected secrets
        instancesPatch[id] = id === instanceId ? { ...rest, config: nextConfig } : rest;
      }
      saveConfig({ instances: instancesPatch });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const instances = await registry.describe();
      broadcast({ kind: "instances", instances });
      return json(res, 200, { instances });
    }

    // ── registered projects ──
    if (method === "GET" && path === "/api/projects") {
      const projects = (await projectService.list()).map((project) => ({ ...project, available: !project.missing }));
      return json(res, 200, { projects });
    }
    if (method === "POST" && path.startsWith("/api/projects/")) {
      const body = await readBody(req);
      let project;
      if (path === "/api/projects/add-existing") {
        if (typeof body.projectPath !== "string") return json(res, 400, { error: "projectPath must be a string" });
        project = await projectService.addExisting(body.projectPath);
      } else if (path === "/api/projects/create") {
        if (typeof body.parentPath !== "string" || typeof body.name !== "string") {
          return json(res, 400, { error: "parentPath and name must be strings" });
        }
        project = await projectService.createProject({ parentPath: body.parentPath, name: body.name, allowedRoot: homedir() });
      } else if (path === "/api/projects/clone") {
        if (typeof body.repositoryUrl !== "string" || typeof body.destinationPath !== "string") {
          return json(res, 400, { error: "repositoryUrl and destinationPath must be strings" });
        }
        project = await projectService.cloneProject({ repositoryUrl: body.repositoryUrl, destinationPath: body.destinationPath, allowedRoot: homedir() });
      } else {
        return json(res, 404, { error: `no route: ${method} ${path}` });
      }
      return json(res, 201, { project });
    }

    // ── read-only project file preview & auto-refresh watchers ──
    if (method === "GET" && path === "/api/preview/files") {
      const projectId = url.searchParams.get("projectId") ?? "";
      const projects = await allRegisteredProjects();
      const { project, files } = listProjectPreviewFiles(projects, projectId);
      return json(res, 200, {
        project: { id: project.id, name: project.name, path: project.path },
        files,
      });
    }
    if (method === "GET" && (path === "/api/preview/file" || path.startsWith("/api/preview/file/") || path.startsWith("/api/preview/asset/"))) {
      const assetMatch = path.match(/^\/api\/preview\/asset\/([a-f0-9]{64})\/([^/]+)\/(.+)$/);
      if (path.startsWith("/api/preview/asset/") && (!assetMatch || previewCapabilities.get(decodeURIComponent(assetMatch[2])) !== assetMatch[1])) {
        return json(res, 403, { error: "Invalid preview access" });
      }
      let projectId = url.searchParams.get("projectId") ?? "";
      let relativePath = url.searchParams.get("path") ?? "";
      if (path.startsWith("/api/preview/file/")) {
        const rest = path.slice("/api/preview/file/".length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx > 0) {
          projectId = decodeURIComponent(rest.slice(0, slashIdx));
          relativePath = decodeURIComponent(rest.slice(slashIdx + 1));
        }
      }
      if (assetMatch) {
        projectId = decodeURIComponent(assetMatch[2]);
        relativePath = decodeURIComponent(assetMatch[3]);
      }
      const projects = await allRegisteredProjects();
      const resolved = resolvePreviewFile(projects, projectId, relativePath);
      let data = readPreviewFileContent(resolved);
      if (resolved.kind === "html") {
        let capability = previewCapabilities.get(projectId);
        if (!capability) {
          capability = randomBytes(32).toString("hex");
          previewCapabilities.set(projectId, capability);
        }
        const directory = resolved.relativePath.split("/").slice(0, -1).map(encodeURIComponent).join("/");
        const base = `<base href="/api/preview/asset/${capability}/${encodeURIComponent(projectId)}/${directory ? directory + "/" : ""}">`;
        const html = data.toString("utf8");
        data = Buffer.from(/<head(?:\s[^>]*)?>/i.test(html)
          ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + base)
          : base + html);
      }
      res.writeHead(200, {
        "content-type": resolved.mimeType,
        ...(assetMatch ? { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" } : {}),
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": previewFileCsp(resolved.mimeType),
        ...(isEditablePreviewKind(resolved.kind) ? { "x-file-mtime": String(resolved.mtimeMs) } : {}),
      });
      return res.end(data);
    }
    if (method === "GET" && path === "/api/preview/resolve") {
      const resolved = resolveChatFileReference(await allRegisteredProjects(), url.searchParams.get("path") ?? "", homedir());
      if (resolved.kind === "resource") return json(res, 415, { error: "Unsupported preview file type" });
      return json(res, 200, {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        path: resolved.relativePath,
        kind: resolved.kind,
      });
    }
    if (method === "PUT" && path === "/api/preview/file") {
      const body = await readBody(req);
      if (typeof body.projectId !== "string" || typeof body.path !== "string" || typeof body.content !== "string") {
        return json(res, 400, { error: "projectId, path and content must be strings" });
      }
      const baseMtimeMs = typeof body.baseMtimeMs === "number" && Number.isFinite(body.baseMtimeMs) ? body.baseMtimeMs : null;
      const resolved = resolvePreviewFile(await allRegisteredProjects(), body.projectId, body.path);
      const mtimeMs = writePreviewTextFile(resolved, body.content, baseMtimeMs);
      return json(res, 200, { ok: true, mtimeMs });
    }
    if (method === "POST" && path === "/api/preview/watch") {
      const body = await readBody(req);
      const clientId = typeof body.clientId === "string" && body.clientId.trim() ? body.clientId.trim() : "default";
      const enabled = body.enabled !== false;
      if (!enabled) {
        previewWatchManager.unwatchClient(clientId);
        return json(res, 200, { ok: true, watching: false });
      }
      const projectId = typeof body.projectId === "string" ? body.projectId : "";
      const relativePath = typeof body.path === "string" ? body.path : "";
      const projects = await allRegisteredProjects();
      const resolved = resolvePreviewFile(projects, projectId, relativePath);
      previewWatchManager.watchFile(clientId, resolved);
      return json(res, 200, {
        ok: true,
        watching: true,
        projectId: resolved.project.id,
        path: resolved.relativePath,
      });
    }
    if (method === "DELETE" && path === "/api/preview/watch") {
      const clientId = url.searchParams.get("clientId") ?? "";
      if (clientId) {
        previewWatchManager.unwatchClient(clientId);
      } else {
        previewWatchManager.closeAll();
      }
      return json(res, 200, { ok: true, watching: false });
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const key of ["xai", "composio", "trello", "profile"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (typeof body.autoHandoffs === "boolean") patch.autoHandoffs = body.autoHandoffs;
      if (body.autoApprovePermissions !== undefined) {
        if (typeof body.autoApprovePermissions !== "boolean") return json(res, 400, { error: "autoApprovePermissions must be a boolean" });
        patch.autoApprovePermissions = body.autoApprovePermissions;
      }
      if (body.autoApproveDelaySeconds !== undefined) {
        if (!Number.isInteger(body.autoApproveDelaySeconds) || body.autoApproveDelaySeconds < 1 || body.autoApproveDelaySeconds > 120) {
          return json(res, 400, { error: "autoApproveDelaySeconds must be an integer from 1 to 120" });
        }
        patch.autoApproveDelaySeconds = body.autoApproveDelaySeconds;
      }
      if (body.usageDisplay !== undefined) {
        const display = body.usageDisplay;
        if (!display || typeof display.show !== "boolean" || !Array.isArray(display.hiddenInstances) || display.hiddenInstances.length > 100 ||
          !display.hiddenInstances.every((id: unknown) => typeof id === "string" && id.length <= 200)) {
          return json(res, 400, { error: "Choose which AI apps to show." });
        }
        patch.usageDisplay = { show: display.show, hiddenInstances: [...new Set(display.hiddenInstances)] };
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      // provider keys change the fleet; a profile, Trello, or autoHandoffs edit must not
      // kill in-flight turns with a pointless reload
      if (Object.keys(patch).some((k) => !["profile", "trello", "autoHandoffs", "autoApprovePermissions", "autoApproveDelaySeconds", "usageDisplay"].includes(k))) await reloadProviders();
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── Trello connection (browser authorize flow → personal token) ──
    if (method === "GET" && path === "/trello/callback") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(TRELLO_CALLBACK_HTML);
    }
    if (method === "GET" && path === "/api/trello/authorize-url") {
      if (!cfg.trello?.key) return json(res, 400, { error: "Add a Trello API key first." });
      const returnUrl = `http://127.0.0.1:${PORT}/trello/callback`;
      return json(res, 200, { url: trello.authorizeUrl(cfg.trello.key, returnUrl) });
    }
    if (method === "POST" && path === "/api/trello/token") {
      const body = await readBody(req);
      const token = String(body.token ?? "").trim();
      if (!token) return json(res, 400, { error: "missing token" });
      saveConfig({ trello: { token } });
      Object.assign(cfg, loadConfig());
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── Trello project ↔ board linking ──
    if (method === "GET" && path === "/api/trello/boards") {
      const creds = trelloCreds();
      if (!creds) return json(res, 200, { configured: false, boards: [] });
      const boards = await trello.listBoards(creds);
      return json(res, 200, { configured: true, boards: boards.filter((b) => !b.closed) });
    }
    if (method === "GET" && path === "/api/trello/links") {
      return json(res, 200, { links: trelloLinks.list().map(trelloLinkView) });
    }
    m = path.match(/^\/api\/trello\/links\/([\w-]+)$/);
    if (m && method === "POST") {
      const creds = trelloCreds();
      if (!creds) return json(res, 400, { error: "Connect Trello first." });
      const projectId = m[1];
      const project = readRegisteredProjects().find((candidate) => candidate.id === projectId);
      if (!project) return json(res, 404, { error: "no such project" });
      const body = await readBody(req);
      const createName = typeof body.createBoard === "string" ? body.createBoard.trim() : "";
      const board = createName
        ? await trello.createBoard(creds, createName.slice(0, 200) || project.name)
        : { id: String(body.boardId ?? "").trim(), name: String(body.boardName ?? "").trim(), url: String(body.boardUrl ?? "").trim() };
      if (!board.id) return json(res, 400, { error: "boardId or createBoard is required" });
      const lists = await trello.ensureStatusLists(creds, board.id);
      const link = trelloLinks.set(projectId, { boardId: board.id, boardName: board.name, boardUrl: board.url, lists, linkedAt: Date.now() });
      return json(res, 200, { link: trelloLinkView(link) });
    }
    if (m && method === "DELETE") {
      trelloLinks.unlink(m[1]);
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/trello\/links\/([\w-]+)\/sync$/);
    if (m && method === "POST") {
      if (!trelloLinks.get(m[1])) return json(res, 404, { error: "project is not linked to Trello" });
      await trelloSync.pullProject(m[1]);
      return json(res, 200, { ok: true });
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/active") {
      if (!cfg.composio?.key) return json(res, 200, { configured: false, activeConnections: [] });
      const activeConnections = await composio.listActiveConnections(cfg);
      return json(res, 200, { configured: true, activeConnections });
    }
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: {} });
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") return json(res, 200, await composio.authorizeService(cfg, m[1]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));

    // packaged app: the server serves the built UI too (window → :8899 for
    // everything, no dev proxy to die). GBS_STATIC_DIR is set by Electron.
    if (method === "GET" && !path.startsWith("/api/") && STATIC_DIR) {
      const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
      const file = join(STATIC_DIR, safe);
      try {
        const data = readFileSync(file);
        const type = MIME[extname(file)] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": type, ...(type.startsWith("text/html") ? UI_SECURITY_HEADERS : {}) });
        return res.end(data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, { "content-type": "text/html", ...UI_SECURITY_HEADERS });
          return res.end(data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? ((e as Error)?.name === "ProjectError" ? 400 : 500);
    return json(res, status, {
      error: e instanceof Error ? e.message : String(e),
      ...(e instanceof TaskConflictError ? { latest: taskView(e.latest) } : {}),
    });
  }
});

scheduler.start();
server.listen(PORT, HOST, () => {
  console.log(`gerer-build-studio server on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopTrelloPolling();
    previewWatchManager.closeAll();
    clearInterval(usageTimer);
    scheduler.stop();
    void registry.disposeAll().finally(() => process.exit(0));
  });
}
