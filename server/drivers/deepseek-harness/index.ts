import { z } from "zod";
import { homedir } from "node:os";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { DshApiClient } from "./client.ts";
import { flattenDshModelCatalog } from "./models.ts";
import { decodeDshModelId } from "./models.ts";
import { dshJsonValueSchema, type DshJsonValue, type DshRpcResult, type DshServerRequest } from "./protocol.ts";

const DRIVER_KIND = "deepseekHarness";
const DEFAULT_BASE_URL = "http://127.0.0.1:3080";
const STREAM_GRACE_MS = 750;
const BASELINE_MAX_SESSIONS = 64;
const BASELINE_MAX_FRAMES = 256;
const BASELINE_MAX_FRAMES_PER_SESSION = 16;
const BASELINE_MAX_BYTES = 256_000;
const BASELINE_MAX_BYTES_PER_SESSION = 32_000;
const BASELINE_TTL_MS = 10_000;
const RESUME_BARRIER_TIMEOUT_MS = 8_000;

export interface DeepSeekHarnessConfig {
  baseUrl: string;
  transport: "direct" | "paired";
  deviceCookie?: string;
  agentPreset?: string;
}

const configSchema = z.object({
  baseUrl: z.string().optional(),
  transport: z.enum(["direct", "paired"]).optional(),
  deviceCookie: z.string().min(1).max(4_096).regex(/^[^\r\n]+$/).optional(),
  agentPreset: z.string().min(1).max(512).optional(),
}).strict();
const jsonObjectSchema = z.record(z.string(), z.json());
const sessionResultSchema = z.object({ sessionId: z.string().min(1).max(512) });
const selectedModelResultSchema = z.object({
  selected: z.object({
    provider: z.string().min(1).max(512),
    model: z.string().min(1).max(512),
    reasoningEffort: z.string().min(1).max(80).optional(),
  }),
});
const hostDescribeSchema = z.object({ version: z.string().max(200).optional() });
const usageSchema = z.object({ inputTokens: z.number().int().safe().nonnegative(), outputTokens: z.number().int().safe().nonnegative() });
const resumeCursorSchema = z.string().min(1).max(512);
const persistedCursorSchema = z.object({ version: z.literal(1), sessionId: z.string().min(1).max(512), personaDelivered: z.boolean() }).strict();

interface SessionCreatePayload {
  cwd: string;
  agentPreset?: string;
}

interface ModelSelectPayload {
  sessionId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
}
interface SessionRecord {
  sessionId: string;
  personaDelivered: boolean;
}
type TurnPhase = "starting" | "selecting" | "resuming" | "queued" | "running";
interface ResumeBarrier {
  pending: Set<string>;
  terminalSeen: boolean;
  promise: Promise<void>;
  release(error?: Error): void;
}
interface ActiveTurn {
  readonly generation: string;
  readonly sessionKey: string;
  turnId: string;
  sessionId: string;
  phase: TurnPhase;
  cancelled: boolean;
  completed: boolean;
  ready: Promise<void>;
  releaseReady: () => void;
  failReady: () => void;
  startupSettled: Promise<void>;
  settleStartup: () => void;
  cancelPromise?: Promise<void>;
  resumeBarrier?: ResumeBarrier;
  usage?: { input: number; output: number };
}
interface PendingApproval {
  threadId: string; turnId: string; sessionId: string; rpcId: string; approvalId: string;
  requestId: string; inFlight: boolean; cleanupRequested: boolean; settled: boolean;
  resolution?: "allowed-once" | "rejected" | "cancelled" | "unavailable";
}
interface QuestionAnswer { selected: string[]; custom?: string; multiSelect: boolean }
interface PendingQuestionEntry {
  key: string; hostId: string; requestId: string; options: Set<string>; multiSelect: boolean;
}
interface PendingQuestionBatch {
  threadId: string; turnId: string; sessionId: string; rpcId: string;
  answers: Map<string, QuestionAnswer>; entries: PendingQuestionEntry[]; inFlight: boolean; cleanupRequested: boolean; settled: boolean;
  resolution?: "answered" | "cancelled";
}

interface BaselineFrame {
  frame: DshServerRequest;
  bytes: number;
  receivedAt: number;
  generation: number;
}
interface BaselineClaim {
  owner: string;
  frames: BaselineFrame[];
}

function decodeConfig(raw: z.input<typeof configSchema>): DeepSeekHarnessConfig {
  const parsed = configSchema.parse(raw ?? {});
  const baseUrl = parsed.baseUrl ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("deepseekHarness.baseUrl must be an absolute HTTP or HTTPS origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("deepseekHarness.baseUrl must be an absolute HTTP or HTTPS origin");
  }
  const transport = parsed.transport ?? "direct";
  if (transport === "paired" && !parsed.deviceCookie) {
    throw new Error("deepseekHarness.deviceCookie is required for paired transport");
  }
  const config: DeepSeekHarnessConfig = { baseUrl: url.origin, transport };
  if (parsed.deviceCookie) config.deviceCookie = parsed.deviceCookie;
  if (parsed.agentPreset) config.agentPreset = parsed.agentPreset;
  return config;
}

export const DeepSeekHarnessDriver: ProviderDriver<DeepSeekHarnessConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: true, access: "custom" },
  models: { default: "", options: [] },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),
  async create(input: DriverCreateInput<DeepSeekHarnessConfig>): Promise<ProviderInstance> {
    const client = new DshApiClient(input.config);
    const listeners = new Set<RuntimeEventListener>();
    let models: ModelCatalog = { default: "", options: [] };
    let catalogUnavailable = false;
    const sessions = new Map<string, SessionRecord>();
    const sessionOwners = new Map<string, string>();
    const baselineFrames = new Map<string, BaselineFrame[]>();
    const baselineClaims = new Map<string, BaselineClaim>();
    let baselineFrameCount = 0;
    let baselineByteCount = 0;
    let muxGeneration = 0;
    const active = new Map<string, ActiveTurn>();
    const seenFrames = new Set<string>();
    const pendingApprovals = new Map<string, PendingApproval>();
    const pendingQuestions = new Map<string, PendingQuestionBatch>();
    const requestKeysByPublicId = new Map<string, { kind: "approval" | "question"; key: string }>();
    const inFlightResponses = new Set<Promise<unknown>>();
    let streamLossTimer: ReturnType<typeof setTimeout> | undefined;
    const streamHealthy = { mux: false, host: false };
    let lifecycle = 0;
    let stopping = false;
    let disposed = false;
    let stopAllPromise: Promise<void> | undefined;

    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) listener(event);
    };
    const respondTracked = (rpcId: string, result: DshRpcResult) => {
      const delivery = client.respond(rpcId, result);
      inFlightResponses.add(delivery);
      void delivery.then(() => inFlightResponses.delete(delivery), () => inFlightResponses.delete(delivery));
      return delivery;
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: input.instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });
    const asObject = (value: DshJsonValue | undefined): z.infer<typeof jsonObjectSchema> | null => {
      const parsed = jsonObjectSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    };
    const asText = (value: DshJsonValue | undefined, limit = 4_000): string => {
      const parsed = z.string().max(limit).safeParse(value);
      return parsed.success ? parsed.data : "";
    };
    const asString = (value: DshJsonValue | undefined, limit = 4_000): string | undefined => {
      const parsed = z.string().max(limit).safeParse(value);
      return parsed.success ? parsed.data : undefined;
    };
    const usageFor = (value: DshJsonValue | undefined): { input: number; output: number } | undefined => {
      const parsed = usageSchema.safeParse(value);
      return parsed.success ? { input: parsed.data.inputTokens, output: parsed.data.outputTokens } : undefined;
    };
    const activeForSession = (sessionId: string) => {
      const sessionKey = sessionOwners.get(sessionId);
      if (!sessionKey) return null;
      for (const [threadId, running] of active) {
        if (running.sessionKey === sessionKey && running.sessionId === sessionId) return { threadId, running };
      }
      return null;
    };
    const requestKey = (threadId: string, sessionId: string, requestId: string) => `${threadId}\u0000${sessionId}\u0000${requestId}`;
    const clearUnclaimedBaseline = () => {
      baselineFrames.clear();
      baselineFrameCount = 0;
      baselineByteCount = 0;
    };
    const clearBaseline = () => {
      clearUnclaimedBaseline();
      baselineClaims.clear();
    };
    const deleteBaseline = (sessionId: string) => {
      const frames = baselineFrames.get(sessionId) ?? [];
      baselineFrameCount -= frames.length;
      baselineByteCount -= frames.reduce((total, entry) => total + entry.bytes, 0);
      baselineFrames.delete(sessionId);
    };
    const pruneBaseline = (now = Date.now()) => {
      for (const [sessionId, frames] of baselineFrames) {
        const retained = frames.filter((entry) => (
          entry.generation === muxGeneration
          && now - entry.receivedAt <= BASELINE_TTL_MS
        ));
        if (retained.length === frames.length) continue;
        deleteBaseline(sessionId);
        if (retained.length) {
          baselineFrames.set(sessionId, retained);
          baselineFrameCount += retained.length;
          baselineByteCount += retained.reduce((total, entry) => total + entry.bytes, 0);
        }
      }
      while (baselineFrames.size > BASELINE_MAX_SESSIONS || baselineFrameCount > BASELINE_MAX_FRAMES || baselineByteCount > BASELINE_MAX_BYTES) {
        const oldest = [...baselineFrames.entries()].sort((a, b) => a[1][0]!.receivedAt - b[1][0]!.receivedAt)[0];
        if (!oldest) break;
        deleteBaseline(oldest[0]);
      }
    };
    const bufferBaseline = (sessionId: string, frame: DshServerRequest) => {
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (bytes > BASELINE_MAX_BYTES_PER_SESSION) return;
      const claimed = baselineClaims.get(sessionId);
      if (claimed) {
        if (claimed.frames.some((entry) => entry.frame.rpcId === frame.rpcId)) return;
        const claimedBytes = claimed.frames.reduce((total, entry) => total + entry.bytes, 0);
        if (claimed.frames.length >= BASELINE_MAX_FRAMES_PER_SESSION || claimedBytes + bytes > BASELINE_MAX_BYTES_PER_SESSION) return;
        claimed.frames.push({ frame, bytes, receivedAt: Date.now(), generation: muxGeneration });
        return;
      }
      pruneBaseline();
      const existing = baselineFrames.get(sessionId) ?? [];
      if (existing.length >= BASELINE_MAX_FRAMES_PER_SESSION || existing.reduce((total, entry) => total + entry.bytes, 0) + bytes > BASELINE_MAX_BYTES_PER_SESSION) return;
      existing.push({ frame, bytes, receivedAt: Date.now(), generation: muxGeneration });
      baselineFrames.set(sessionId, existing);
      baselineFrameCount++;
      baselineByteCount += bytes;
      pruneBaseline();
    };
    const withdrawBaseline = (sessionId: string, method: string, payload: z.infer<typeof jsonObjectSchema>) => {
      const claim = baselineClaims.get(sessionId);
      const frames = claim?.frames ?? baselineFrames.get(sessionId);
      if (!frames) return;
      const kept = frames.filter(({ frame }) => {
        const candidate = asObject(frame.payload);
        if (method === "approval/resolved") return !(frame.method === "approval/requested" && asText(candidate?.approvalId, 512) === asText(payload.approvalId, 512));
        return !(frame.method === "question/requested" && frame.rpcId === asText(payload.questionRpcId, 128));
      });
      if (claim) {
        claim.frames = kept;
        return;
      }
      deleteBaseline(sessionId);
      if (kept.length) {
        baselineFrames.set(sessionId, kept);
        baselineFrameCount += kept.length;
        baselineByteCount += kept.reduce((total, entry) => total + entry.bytes, 0);
      }
    };
    const claimBaseline = (sessionId: string, generation: string) => {
      const claimed = baselineClaims.get(sessionId);
      if (claimed && claimed.owner !== generation) throw new Error("DeepSeek Harness resume is already being claimed");
      if (claimed) return;
      pruneBaseline();
      const frames = baselineFrames.get(sessionId) ?? [];
      deleteBaseline(sessionId);
      baselineClaims.set(sessionId, { owner: generation, frames });
    };
    const takeBaseline = (sessionId: string, generation: string) => {
      const claim = baselineClaims.get(sessionId);
      if (claim?.owner !== generation) return [];
      baselineClaims.delete(sessionId);
      return claim.frames.map((entry) => entry.frame);
    };
    const releaseBaseline = (sessionId: string, generation: string, drop: boolean) => {
      const claim = baselineClaims.get(sessionId);
      if (claim?.owner !== generation) return;
      baselineClaims.delete(sessionId);
      if (!drop && claim.frames.length) {
        baselineFrames.set(sessionId, claim.frames);
        baselineFrameCount += claim.frames.length;
        baselineByteCount += claim.frames.reduce((total, entry) => total + entry.bytes, 0);
        pruneBaseline();
      }
    };
    const requestIdNamespace = newId();
    let requestIdSequence = 0;
    const publicRequestId = (kind: "approval" | "question") => `${kind}:${requestIdNamespace}:${++requestIdSequence}`;
    const encodeCursor = (record: SessionRecord) => `dsh1:${Buffer.from(JSON.stringify({ version: 1, sessionId: record.sessionId, personaDelivered: record.personaDelivered })).toString("base64url")}`;
    const decodeCursor = (raw: SendTurnInput["resumeCursor"]): SessionRecord | null => {
      const plain = resumeCursorSchema.safeParse(raw);
      if (!plain.success) return null;
      if (!plain.data.startsWith("dsh1:")) return { sessionId: plain.data, personaDelivered: false };
      try {
        const parsed = persistedCursorSchema.safeParse(JSON.parse(Buffer.from(plain.data.slice(5), "base64url").toString("utf8")));
        return parsed.success ? { sessionId: parsed.data.sessionId, personaDelivered: parsed.data.personaDelivered } : null;
      } catch { return null; }
    };
    const rememberFrame = (rpcId: string): boolean => {
      if (seenFrames.has(rpcId)) return false;
      seenFrames.add(rpcId);
      if (seenFrames.size > 4_096) seenFrames.delete(seenFrames.values().next().value!);
      return true;
    };
    const isCurrent = (threadId: string, running: ActiveTurn, fence?: number) => active.get(threadId) === running && !running.cancelled && !stopping && !disposed && (fence === undefined || fence === lifecycle);
    const createResumeBarrier = (): ResumeBarrier => {
      let resolve = () => {};
      let reject = (_error: Error) => {};
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      const barrier: ResumeBarrier = {
        pending: new Set(),
        terminalSeen: false,
        promise,
        release(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      };
      timer = setTimeout(() => barrier.release(new Error("DeepSeek Harness resumed turn did not settle")), RESUME_BARRIER_TIMEOUT_MS);
      timer.unref?.();
      return barrier;
    };
    const maybeReleaseResumeBarrier = (running: ActiveTurn) => {
      const barrier = running.resumeBarrier;
      if (barrier?.terminalSeen && barrier.pending.size === 0) barrier.release();
    };
    const settleResumeRequest = (threadId: string, turnId: string, token: string) => {
      const running = active.get(threadId);
      if (!running || running.turnId !== turnId || !running.resumeBarrier) return;
      running.resumeBarrier.pending.delete(token);
      maybeReleaseResumeBarrier(running);
    };
    const approvalBarrierToken = (sessionId: string, approvalId: string) => `approval\u0000${sessionId}\u0000${approvalId}`;
    const questionBarrierToken = (sessionId: string, rpcId: string) => `question\u0000${sessionId}\u0000${rpcId}`;
    const claimSession = (sessionKey: string, sessionId: string) => {
      const owner = sessionOwners.get(sessionId);
      if (owner && owner !== sessionKey) throw new Error("DeepSeek Harness session is already active on another thread");
      sessionOwners.set(sessionId, sessionKey);
    };

    const refreshModels = async (): Promise<void> => {
      try {
        const response = await client.unary("llm.models", {});
        const catalog = flattenDshModelCatalog(response.value).catalog;
        if (!catalog) throw new Error("catalog invalid");
        models = catalog;
        catalogUnavailable = false;
      } catch {
        models = { default: "", options: [] };
        catalogUnavailable = true;
      }
    };
    const snapshot = async (): Promise<ProviderSnapshot> => {
      try {
        const response = await client.unary("host.describe", {});
        if (!models.options.length) await refreshModels();
        if (catalogUnavailable || !models.options.length) {
          return { state: "unavailable", reason: "DeepSeek Harness model catalog is unavailable" };
        }
        const version = hostDescribeSchema.safeParse(response.value).data?.version ?? null;
        return { state: "available", authenticated: true, version };
      } catch {
        return { state: "unavailable", reason: "DeepSeek Harness host is unavailable" };
      }
    };
    const promptText = (turn: SendTurnInput, firstSession: boolean): string => {
      if (!firstSession || !turn.system) return turn.text;
      return `<openmausbot-persona>\n${turn.system}\n</openmausbot-persona>\n\n${turn.text}`;
    };
    const resolveSession = async (turn: SendTurnInput, sessionKey: string): Promise<SessionRecord> => {
      const remembered = sessions.get(sessionKey);
      if (remembered) {
        claimSession(sessionKey, remembered.sessionId);
        return remembered;
      }
      const hasResumeCursor = turn.resumeCursor !== undefined && turn.resumeCursor !== null;
      const parsedCursor = decodeCursor(turn.resumeCursor);
      if (hasResumeCursor && !parsedCursor) throw new Error("DeepSeek Harness resume cursor is invalid");
      if (parsedCursor) {
        const resumed = await client.unary("session.create", { sessionId: parsedCursor.sessionId, cwd: turn.cwd ?? homedir() });
        const sessionId = sessionResultSchema.safeParse(resumed.value).data?.sessionId;
        if (!sessionId) throw new Error("DeepSeek Harness resume response was invalid");
        claimSession(sessionKey, sessionId);
        // A persisted cursor proves only that a host session exists, not that
        // this adapter ever had an accepted persona-bearing queue prompt.
        const record = { sessionId, personaDelivered: parsedCursor.personaDelivered };
        sessions.set(sessionKey, record);
        return record;
      }
      const payload: SessionCreatePayload = { cwd: turn.cwd ?? homedir() };
      if (input.config.agentPreset) payload.agentPreset = input.config.agentPreset;
      const created = await client.unary("session.create", dshJsonValueSchema.parse(payload));
      const sessionId = sessionResultSchema.safeParse(created.value).data?.sessionId ?? null;
      if (!sessionId) throw new Error("DeepSeek Harness did not return a session id");
      claimSession(sessionKey, sessionId);
      const record = { sessionId, personaDelivered: false };
      sessions.set(sessionKey, record);
      return record;
    };
    const sendTurn = async (turn: SendTurnInput) => {
      if (stopping || disposed) throw new Error("DeepSeek Harness provider is stopping");
      const fence = lifecycle;
      const sessionKey = turn.sessionKey ?? turn.threadId;
      const cursor = decodeCursor(turn.resumeCursor);
      if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      let releaseReady = () => {};
      let failReady = () => {};
      let settleStartup = () => {};
      const ready = new Promise<void>((resolve) => {
        releaseReady = resolve;
        failReady = resolve;
      });
      const startupSettled = new Promise<void>((resolve) => { settleStartup = resolve; });
      // Reservation occurs before the first await, so a concurrent turn cannot race session creation.
      const running: ActiveTurn = { generation: newId(), sessionKey, turnId, sessionId: "", phase: "starting", cancelled: false, completed: false, ready, releaseReady, failReady, startupSettled, settleStartup };
      active.set(turn.threadId, running);
      emit({ ...base(turn.threadId, turnId), type: "turn.started" });
      try {
        if (cursor) claimBaseline(cursor.sessionId, running.generation);
        await client.waitForStreamsOpen();
        if (!isCurrent(turn.threadId, running, fence)) throw new Error("DeepSeek Harness turn was cancelled during startup");
        const session = await resolveSession(turn, sessionKey);
        const { sessionId } = session;
        // session.create may finish after an interrupt. Remember its concrete
        // id before checking the fence so cancelRunning can compensate it,
        // while the fence still prevents selectModel or prompt from escaping.
        running.sessionId = sessionId;
        if (!isCurrent(turn.threadId, running, fence)) throw new Error("DeepSeek Harness turn was cancelled during startup");
        claimBaseline(sessionId, running.generation);
        running.phase = "selecting";
        const selection = decodeDshModelId(turn.model ?? models.default);
        if (!selection) throw new Error("DeepSeek Harness requires a valid DSH model selection");
        const selectPayload: ModelSelectPayload = {
          sessionId,
          provider: selection.provider,
          model: selection.model,
        };
        if (turn.effort) selectPayload.reasoningEffort = turn.effort === "none" ? "off" : turn.effort;
        await client.waitForStreamsOpen();
        if (!isCurrent(turn.threadId, running, fence)) throw new Error("DeepSeek Harness turn was cancelled during startup");
        const selectedResponse = await client.unary("session.selectModel", dshJsonValueSchema.parse(selectPayload));
        const selected = selectedModelResultSchema.safeParse(selectedResponse.value).data?.selected;
        if (
          !selected
          || selected.provider !== selectPayload.provider
          || selected.model !== selectPayload.model
          // Omitting effort delegates to the model's default. The Host may
          // materialize that effective default in its acknowledgement; only
          // an effort OMB explicitly requested must round-trip byte-for-byte.
          || (selectPayload.reasoningEffort !== undefined
            && selected.reasoningEffort !== selectPayload.reasoningEffort)
        ) {
          throw new Error("DeepSeek Harness did not preserve the requested model and effort");
        }
        if (!isCurrent(turn.threadId, running, fence)) throw new Error("DeepSeek Harness turn was cancelled during startup");
        const replayed = takeBaseline(sessionId, running.generation);
        if (cursor && cursor.sessionId !== sessionId) releaseBaseline(cursor.sessionId, running.generation, true);
        if (replayed.length) {
          running.phase = "resuming";
          const barrier = createResumeBarrier();
          running.resumeBarrier = barrier;
          for (const frame of replayed) handleFrame(frame);
          if (barrier.pending.size) {
            await barrier.promise;
            if (!isCurrent(turn.threadId, running, fence)) throw new Error("DeepSeek Harness turn was cancelled during startup");
          } else {
            barrier.release();
          }
          running.resumeBarrier = undefined;
          running.phase = "selecting";
        }
        await client.waitForStreamsOpen();
        if (!isCurrent(turn.threadId, running, fence)) throw new Error("DeepSeek Harness turn was cancelled during startup");
        await client.unary("session.prompt", {
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: promptText(turn, !session.personaDelivered) }],
        });
        if (!isCurrent(turn.threadId, running, fence)) throw new Error("DeepSeek Harness turn was cancelled during startup");
        session.personaDelivered = true;
        running.phase = "queued";
        // A stream can close while the final queue HTTP response is held.
        // Its health event occurred while this turn was still selecting, so
        // arm the normal terminal-loss path explicitly at the phase boundary.
        if (!streamHealthy.mux || !streamHealthy.host) scheduleStreamFailure();
        // Persist only after the persona-bearing queue prompt was accepted. A
        // crash after create/select therefore safely re-delivers it on resume.
        emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId, model: turn.model ?? null, resumeCursor: encodeCursor(session) });
        running.releaseReady();
        running.settleStartup();
        return { turnId };
      } catch (error) {
        running.resumeBarrier?.release();
        running.resumeBarrier = undefined;
        if (cursor) releaseBaseline(cursor.sessionId, running.generation, true);
        if (running.sessionId) releaseBaseline(running.sessionId, running.generation, true);
        await resolvePendingUnavailable(turn.threadId);
        running.failReady();
        running.settleStartup();
        if (active.get(turn.threadId) === running) {
          active.delete(turn.threadId);
          if (!running.completed) {
            running.completed = true;
            emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: "DeepSeek Harness turn could not start" });
            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: false, stopReason: "start_failed", cost: null });
          }
        }
        throw error;
      }
    };
    const steer = async (threadId: string, text: string): Promise<boolean> => {
      const running = active.get(threadId);
      if (!running) return false;
      await running.ready;
      if (!isCurrent(threadId, running) || running.phase !== "queued" || !running.sessionId) return false;
      await client.unary("session.prompt", { sessionId: running.sessionId, mode: "steer", content: [{ type: "text", text }] });
      return true;
    };
    const cancelRunning = (running: ActiveTurn): Promise<void> => {
      if (running.cancelPromise) return running.cancelPromise;
      running.cancelled = true;
      running.failReady();
      running.resumeBarrier?.release();
      // Serialize cancellation after create/select/queue settles. If queue won
      // the race, this is the compensating final cancel; if it did not, no
      // empty id or late prompt can escape.
      running.cancelPromise = (async () => {
        await running.startupSettled;
        if (running.sessionId) {
          try { await client.unary("session.cancel", { sessionId: running.sessionId }); } catch { /* bounded local cancellation wins */ }
        }
      })();
      return running.cancelPromise;
    };
    const interruptTurn = async (threadId: string, turnId?: string): Promise<void> => {
      const running = active.get(threadId);
      if (!running || (turnId && running.turnId !== turnId)) return;
      return cancelRunning(running);
    };
    const failActiveTurnsForStream = async () => {
      streamLossTimer = undefined;
      const lost = [...active.entries()].filter(([, running]) => !running.completed);
      // Fence terminal state before the best-effort Host cancels. The mux can
      // still deliver a turn/end caused by that cancel; it must not complete a
      // turn a second time.
      for (const [threadId, running] of lost) {
        running.completed = true;
        running.cancelled = true;
        running.failReady();
        if (active.get(threadId) === running) active.delete(threadId);
      }
      await Promise.allSettled(lost.map(([, running]) => running.sessionId
        ? client.unary("session.cancel", { sessionId: running.sessionId })
        : Promise.resolve()));
      for (const [threadId, running] of lost) {
        emit({ ...base(threadId, running.turnId), type: "runtime.error", message: "DeepSeek Harness event stream was lost" });
        emit({ ...base(threadId, running.turnId), type: "turn.completed", ok: false, stopReason: "stream_lost", cost: null });
      }
      await resolvePendingUnavailable();
    };
    const scheduleStreamFailure = () => {
      if (streamLossTimer || ![...active.values()].some((running) => running.phase === "queued" || running.phase === "running")) return;
      streamLossTimer = setTimeout(() => { void failActiveTurnsForStream(); }, STREAM_GRACE_MS);
      streamLossTimer.unref?.();
    };
    const recoverStream = () => {
      if (streamHealthy.mux && streamHealthy.host) {
        if (streamLossTimer) clearTimeout(streamLossTimer);
        streamLossTimer = undefined;
      }
    };
    const handleFrame = (frame: DshServerRequest): void => {
      let payload = asObject(frame.payload);
      let method = frame.method;
      if (method === "session/event") {
        const event = asObject(payload?.event);
        const eventData = asObject(event?.data);
        const sessionId = asText(payload?.sessionId, 512);
        if (!event || !eventData || !sessionId) return;
        method = asText(event.type, 160);
        payload = { ...eventData, sessionId };
      }
      // stream/error is a host-level durable signal and intentionally has no session id.
      if (method === "stream/error") {
        scheduleStreamFailure();
        return;
      }
      const sessionId = asText(payload?.sessionId, 512);
      const current = sessionId ? activeForSession(sessionId) : null;
      if (!current) {
        // DSH replays pending asks synchronously when mux opens, before OMB
        // knows which persisted cursor it will resume. Keep only valid ask
        // frames in the bounded, generation-scoped broker. Matching resolved
        // frames withdraw a replay that stopped being pending before claim.
        if (sessionId && (method === "approval/requested" || method === "question/requested")) bufferBaseline(sessionId, frame);
        else if (sessionId && (method === "approval/resolved" || method === "question/resolved")) withdrawBaseline(sessionId, method, payload ?? {});
        return;
      }
      const { threadId, running } = current;
      const eventBase = base(threadId, running.turnId);
      if (running.phase === "starting" || running.phase === "selecting") {
        if (method === "approval/requested" || method === "question/requested") bufferBaseline(sessionId, frame);
        else if (method === "approval/resolved" || method === "question/resolved") withdrawBaseline(sessionId, method, payload ?? {});
        // A replayed terminal belongs to the turn that existed before this
        // queue prompt. It must never complete the new OMB turn while startup
        // is still selecting or queueing it.
        return;
      }
      if (running.phase === "resuming") {
        if (method === "turn/end") {
          if (running.resumeBarrier) {
            running.resumeBarrier.terminalSeen = true;
            maybeReleaseResumeBarrier(running);
          }
          return;
        }
        if (
          method !== "approval/requested"
          && method !== "approval/resolved"
          && method !== "question/requested"
          && method !== "question/resolved"
        ) return;
      }
      if (!rememberFrame(`${sessionId}\u0000${frame.rpcId}`)) return;
      switch (method) {
        case "turn/start":
          running.phase = "running";
          return;
        case "assistant/chunk.text-delta":
        case "assistant/chunk": {
          const chunk = asObject(payload?.chunk);
          const delta = asText(chunk?.text ?? payload?.delta, 100_000);
          const kind = asText(chunk?.type, 80);
          if (delta) emit({ ...eventBase, type: "content.delta", streamKind: kind === "reasoning-delta" ? "reasoning_text" : "assistant_text", delta });
          return;
        }
        case "assistant/chunk.reasoning-delta": {
          const delta = asText(asObject(payload?.chunk)?.text ?? payload?.delta, 100_000);
          if (delta) emit({ ...eventBase, type: "content.delta", streamKind: "reasoning_text", delta });
          return;
        }
        case "tool/call": {
          const itemId = asText(payload?.callId, 512);
          if (!itemId) return;
          emit({ ...eventBase, type: "item.started", itemType: "tool", itemId, title: asText(payload?.name, 200) || "tool" });
          return;
        }
        case "tool/result": {
          const itemId = asText(asObject(asObject(payload?.message)?.source)?.callId ?? payload?.callId, 512);
          if (!itemId) return;
          const toolContent = asObject(payload?.message)?.content;
          const firstContent = Array.isArray(toolContent) ? toolContent[0] : undefined;
          const isError = asObject(firstContent)?.isError === true;
          emit({ ...eventBase, type: "item.completed", itemType: "tool", itemId, ok: payload?.error === undefined && !isError });
          return;
        }
        case "assistant/message": {
          const message = asObject(payload?.message);
          const content = message?.content ?? payload?.content;
          const blocks = Array.isArray(content) ? content.map((block) => dshJsonValueSchema.parse(block)) : [];
          const text = blocks.reduce<string>((combined, block) => {
            const value = asObject(block);
            return value?.type === "text" ? combined + asText(value.text, 100_000) : combined;
          }, "");
          if (text.trim()) emit({ ...eventBase, type: "item.completed", itemType: "assistant_text", text });
          const usage = usageFor(payload?.usage);
          if (usage) {
            const input = (running.usage?.input ?? 0) + usage.input;
            const output = (running.usage?.output ?? 0) + usage.output;
            if (Number.isSafeInteger(input) && Number.isSafeInteger(output)) {
              running.usage = { input, output };
              emit({ ...eventBase, type: "thread.token-usage.updated", ...usage });
            }
          }
          return;
        }
        case "turn/end": {
          if (running.completed) return;
          running.completed = true;
          const terminalUsage = usageFor(payload?.usage);
          const usage = terminalUsage ?? running.usage;
          if (terminalUsage) emit({ ...eventBase, type: "thread.token-usage.updated", ...terminalUsage });
          if (active.get(threadId) === running) active.delete(threadId);
          void resolvePendingUnavailable(threadId);
          const reason = asText(asObject(payload?.reason)?.kind ?? payload?.reason, 200) || null;
          const completed: RuntimeEvent = { ...eventBase, type: "turn.completed", ok: !reason || reason === "completed", stopReason: reason, cost: null };
          if (usage) completed.usage = usage;
          emit(completed);
          return;
        }
        case "host/agent-error": {
          emit({ ...eventBase, type: "runtime.error", message: "DeepSeek Harness agent failed" });
          return;
        }
        case "approval/resolved": {
          const approvalId = asText(payload?.approvalId, 512);
          const key = requestKey(threadId, sessionId, approvalId);
          const approval = pendingApprovals.get(key);
          if (!approval) return;
          const outcome = asText(payload?.outcome, 80);
          approval.settled = true;
          approval.resolution = outcome === "allowed-once" ? "allowed-once" : outcome === "rejected" ? "rejected" : outcome === "cancelled" ? "cancelled" : "unavailable";
          pendingApprovals.delete(key);
          requestKeysByPublicId.delete(approval.requestId);
          emit({ ...base(threadId, approval.turnId), type: "request.resolved", requestId: approval.requestId, behavior: outcome === "allowed-once" ? "allow" : "deny", source: "system" });
          settleResumeRequest(threadId, approval.turnId, approvalBarrierToken(sessionId, approvalId));
          return;
        }
        case "question/resolved": {
          const questionRpcId = asText(payload?.questionRpcId, 128);
          if (!questionRpcId) return;
          const batches = new Set([...pendingQuestions.values()].filter((batch) => batch.threadId === threadId && batch.sessionId === sessionId && batch.rpcId === questionRpcId));
          for (const batch of batches) {
            batch.settled = true;
            batch.resolution = asText(payload?.outcome, 80) === "answered" ? "answered" : "cancelled";
            for (const entry of batch.entries) {
              pendingQuestions.delete(entry.key);
              requestKeysByPublicId.delete(entry.requestId);
              emit({ ...base(threadId, batch.turnId), type: "request.resolved", requestId: entry.requestId, behavior: "answer", source: "system" });
            }
            settleResumeRequest(threadId, batch.turnId, questionBarrierToken(sessionId, questionRpcId));
          }
          return;
        }
        case "approval/requested": {
          const approvalId = asText(payload?.approvalId, 512);
          const key = requestKey(threadId, sessionId, approvalId);
          if (!approvalId || pendingApprovals.has(key)) return;
          const publicId = publicRequestId("approval");
          pendingApprovals.set(key, { threadId, turnId: running.turnId, sessionId, rpcId: frame.rpcId, approvalId, requestId: publicId, inFlight: false, cleanupRequested: false, settled: false });
          requestKeysByPublicId.set(publicId, { kind: "approval", key });
          if (running.phase === "resuming") running.resumeBarrier?.pending.add(approvalBarrierToken(sessionId, approvalId));
          emit({
            ...eventBase,
            type: "request.opened",
            requestId: publicId,
            requestType: "permission",
            // `toolName` is required but the official wire permits an empty
            // string. Keep a truthy presentation marker so OMB never renders
            // a valid permission ask as a free-form question.
            tool: asText(payload?.toolName, 200) || "tool",
            summary: asText(payload?.reason, 500) || "Approval requested",
          });
          return;
        }
        case "question/requested": {
          const rows = Array.isArray(payload?.questions) ? payload.questions.map(asObject).filter(Boolean) : [];
          const batch: PendingQuestionBatch = { threadId, turnId: running.turnId, sessionId, rpcId: frame.rpcId, answers: new Map(), entries: [], inFlight: false, cleanupRequested: false, settled: false };
          for (const [position, row] of rows.entries()) {
            const id = asString(row?.id, 512);
            if (id === undefined) continue;
            const publicId = publicRequestId("question");
            const choices = Array.isArray(row?.options)
              ? row.options.map((choice) => asString(asObject(choice)?.label, 200)).filter((label): label is string => label !== undefined)
              : undefined;
            const key = requestKey(threadId, sessionId, `${frame.rpcId}:${position}`);
            const entry: PendingQuestionEntry = { key, hostId: id, requestId: publicId, options: new Set(choices ?? []), multiSelect: row?.multiSelect === true };
            batch.entries.push(entry);
            pendingQuestions.set(key, batch);
            requestKeysByPublicId.set(publicId, { kind: "question", key });
            const opened: RuntimeEvent = {
              ...eventBase,
              type: "request.opened",
              requestId: publicId,
              requestType: "question",
              tool: "ask_user",
              summary: asText(row?.question, 500) || "Question requested",
            };
            if (choices?.length) opened.choices = choices;
            if (entry.multiSelect) opened.multiSelect = true;
            emit(opened);
          }
          if (!batch.entries.length) return;
          if (running.phase === "resuming") running.resumeBarrier?.pending.add(questionBarrierToken(sessionId, frame.rpcId));
          return;
        }
      }
    };
    const unsubscribeHealth = client.subscribeHealth((health) => {
      if (health.kind === "mux") {
        const generationChanged = health.generation !== muxGeneration;
        if (generationChanged) muxGeneration = health.generation;
        // Drop unclaimed frames as soon as the physical generation is lost,
        // not only when its replacement reports open. The server-side socket
        // can otherwise be observable just before the client's open callback,
        // leaving a brief window where a stale generation could be claimed.
        if (health.state === "reconnecting" || generationChanged) clearUnclaimedBaseline();
      }
      streamHealthy[health.kind] = health.state === "connected";
      if (streamHealthy[health.kind]) recoverStream();
      else scheduleStreamFailure();
    });
    // Install generation tracking before either socket can open and replay
    // pending requests. Host emits the baseline immediately on mux open.
    const unsubscribeMux = client.subscribeMux(handleFrame);
    const unsubscribeHost = client.subscribeHost(handleFrame);
    const respondToRequest = async (
      threadId: string,
      requestId: string,
      decision: { behavior: "allow" | "deny" | "answer"; message?: string; selected?: string[]; custom?: string },
    ) => {
      const session = sessions.get(threadId);
      const routed = requestKeysByPublicId.get(requestId) ?? (session && pendingApprovals.has(requestKey(threadId, session.sessionId, requestId))
        ? { kind: "approval" as const, key: requestKey(threadId, session.sessionId, requestId) }
        : session && pendingQuestions.has(requestKey(threadId, session.sessionId, requestId))
          ? { kind: "question" as const, key: requestKey(threadId, session.sessionId, requestId) }
          : undefined);
      const key = routed?.key ?? "";
      const approval = routed?.kind === "approval" ? pendingApprovals.get(key) : undefined;
      if (approval && approval.threadId === threadId) {
        if (approval.inFlight) return "retryable" as const;
        approval.inFlight = true;
        try {
          const result: DshRpcResult = {
            ok: true,
            value: { sessionId: approval.sessionId, approvalId: approval.approvalId, outcome: decision.behavior === "allow" ? "allowed-once" : "rejected" },
          };
          const receipt = await respondTracked(approval.rpcId, result);
          if (approval.settled) return "already-resolved" as const;
          if (!receipt.accepted) {
            approval.inFlight = false;
            if (approval.cleanupRequested) await resolvePendingUnavailable(threadId);
            return approval.cleanupRequested ? "unavailable" as const : "retryable" as const;
          }
          // A Host resolved frame can win the race with the HTTP receipt. It
          // already owns the only resolution; do not emit a second user one.
          if (approval.settled || pendingApprovals.get(key) !== approval) {
            return "already-resolved" as const;
          }
          pendingApprovals.delete(key);
          requestKeysByPublicId.delete(approval.requestId);
          emit({
            ...base(threadId, approval.turnId),
            type: "request.resolved",
            requestId: approval.requestId,
            behavior: decision.behavior === "allow" ? "allow" : "deny",
            source: "user",
          });
          settleResumeRequest(threadId, approval.turnId, approvalBarrierToken(approval.sessionId, approval.approvalId));
          return decision.behavior === "allow" ? "allowed-once" as const : "rejected" as const;
        } catch {
          if (approval.settled) return "already-resolved" as const;
          approval.inFlight = false;
          if (approval.cleanupRequested) await resolvePendingUnavailable(threadId);
          return approval.cleanupRequested ? "unavailable" as const : "retryable" as const;
        }
      }
      const batch = routed?.kind === "question" ? pendingQuestions.get(key) : undefined;
      if (!batch || batch.threadId !== threadId) return "unavailable" as const;
      if (batch.inFlight) return "retryable" as const;
      const entry = batch.entries.find((item) => item.key === key) ?? batch.entries.find((item) => item.requestId === requestId);
      if (!entry) return "unavailable" as const;
      if (decision.behavior !== "answer") {
        batch.inFlight = true;
        try {
          const receipt = await respondTracked(batch.rpcId, { ok: false, error: { code: "cancelled", message: "Question dismissed by the user", details: {} } });
          if (batch.settled) return "already-resolved" as const;
          if (!receipt.accepted) {
            batch.inFlight = false;
            if (batch.cleanupRequested) await resolvePendingUnavailable(threadId);
            return batch.cleanupRequested ? "unavailable" as const : "retryable" as const;
          }
          for (const item of batch.entries) {
            pendingQuestions.delete(item.key);
            requestKeysByPublicId.delete(item.requestId);
            emit({ ...base(threadId, batch.turnId), type: "request.resolved", requestId: item.requestId, behavior: "answer", source: "user" });
          }
          settleResumeRequest(threadId, batch.turnId, questionBarrierToken(batch.sessionId, batch.rpcId));
          return "rejected" as const;
        } catch {
          if (batch.settled) return "already-resolved" as const;
          batch.inFlight = false;
          if (batch.cleanupRequested) await resolvePendingUnavailable(threadId);
          return batch.cleanupRequested ? "unavailable" as const : "retryable" as const;
        }
      }
      if (!batch.answers.has(entry.key)) {
        const details = entry;
        const requested = decision.selected ?? (decision.message && details.options.has(decision.message) ? [decision.message] : []);
        const selected = [...new Set(requested.filter((label) => details.options.has(label)))];
        const rawCustom = decision.custom ?? (decision.message && !details.options.has(decision.message) ? decision.message : undefined);
        const custom = rawCustom?.trim() || undefined;
        // A non-multi-select prompt gets at most its first offered label.
        const answer: QuestionAnswer = { selected: details.multiSelect ? selected : selected.slice(0, 1), multiSelect: details.multiSelect };
        // The official single-select shape represents either an offered label
        // or a custom answer, never both. Multi-select may carry both.
        if (custom && (details.multiSelect || answer.selected.length === 0)) answer.custom = custom;
        batch.answers.set(entry.key, answer);
      }
      if (batch.answers.size !== batch.entries.length) return "answered" as const;
      batch.inFlight = true;
      try {
        const result: DshRpcResult = {
          ok: true,
          value: dshJsonValueSchema.parse({ sessionId: batch.sessionId, answer: { answers: batch.entries.map((item) => {
            const answer = batch.answers.get(item.key)!;
            return answer.custom ? { id: item.hostId, selected: answer.selected, custom: answer.custom } : { id: item.hostId, selected: answer.selected };
          }) } }),
        };
        const receipt = await respondTracked(batch.rpcId, result);
        if (batch.settled) return "already-resolved" as const;
        if (!receipt.accepted) {
          batch.inFlight = false;
          if (batch.cleanupRequested) await resolvePendingUnavailable(threadId);
          return batch.cleanupRequested ? "unavailable" as const : "retryable" as const;
        }
        if (batch.settled || !batch.entries.some((item) => pendingQuestions.get(item.key) === batch)) return "already-resolved" as const;
        for (const item of batch.entries) {
          pendingQuestions.delete(item.key);
          requestKeysByPublicId.delete(item.requestId);
          emit({ ...base(threadId, batch.turnId), type: "request.resolved", requestId: item.requestId, behavior: "answer", source: "user" });
        }
        settleResumeRequest(threadId, batch.turnId, questionBarrierToken(batch.sessionId, batch.rpcId));
        return "answered" as const;
      } catch {
        if (batch.settled) return "already-resolved" as const;
        batch.inFlight = false;
        if (batch.cleanupRequested) await resolvePendingUnavailable(threadId);
        return batch.cleanupRequested ? "unavailable" as const : "retryable" as const;
      }
    };
    const resolvePendingUnavailable = async (onlyThreadId?: string): Promise<void> => {
      const responses: Promise<unknown>[] = [];
      for (const [requestId, approval] of pendingApprovals) {
        if (onlyThreadId && approval.threadId !== onlyThreadId) continue;
        if (approval.inFlight) {
          approval.cleanupRequested = true;
          continue;
        }
        pendingApprovals.delete(requestId);
        approval.settled = true;
        requestKeysByPublicId.delete(approval.requestId);
        emit({ ...base(approval.threadId, approval.turnId), type: "request.resolved", requestId: approval.requestId, behavior: "deny", source: "unavailable" });
        settleResumeRequest(approval.threadId, approval.turnId, approvalBarrierToken(approval.sessionId, approval.approvalId));
        responses.push(respondTracked(approval.rpcId, { ok: true, value: { sessionId: approval.sessionId, approvalId: approval.approvalId, outcome: "rejected" } }).catch(() => undefined));
      }
      for (const batch of new Set(pendingQuestions.values())) {
        if ((!onlyThreadId || batch.threadId === onlyThreadId) && batch.inFlight) batch.cleanupRequested = true;
      }
      const batches = new Set([...pendingQuestions.values()].filter((batch) => (!onlyThreadId || batch.threadId === onlyThreadId) && !batch.inFlight));
      for (const [requestId, batch] of pendingQuestions) {
        if (batches.has(batch)) pendingQuestions.delete(requestId);
      }
      for (const batch of batches) {
        batch.settled = true;
        for (const entry of batch.entries) {
          requestKeysByPublicId.delete(entry.requestId);
          emit({ ...base(batch.threadId, batch.turnId), type: "request.resolved", requestId: entry.requestId, behavior: "answer", source: "unavailable" });
        }
        settleResumeRequest(batch.threadId, batch.turnId, questionBarrierToken(batch.sessionId, batch.rpcId));
        responses.push(respondTracked(batch.rpcId, {
          ok: false,
          error: { code: "cancelled", message: "OpenMausBot request cleanup", details: {} },
        }).catch(() => undefined));
      }
      await Promise.all(responses);
    };
    const stopAll = async (): Promise<void> => {
      if (stopAllPromise) return stopAllPromise;
      const cleanup = (async () => {
      stopping = true;
      lifecycle++;
      const stoppingTurns = [...active.entries()];
      for (const [, running] of stoppingTurns) {
        running.cancelled = true;
        running.failReady();
      }
      for (const approval of pendingApprovals.values()) approval.cleanupRequested = true;
      for (const batch of pendingQuestions.values()) batch.cleanupRequested = true;
      client.abortOperations();
      await Promise.allSettled(inFlightResponses);
      // Startup may be between create/select/prompt. Its generation checks prevent late host calls.
      await Promise.all(stoppingTurns.map(([, running]) => cancelRunning(running)));
      await Promise.all(stoppingTurns.map(async ([threadId, running]) => {
        if (active.get(threadId) === running) active.delete(threadId);
      }));
      await resolvePendingUnavailable();
      sessions.clear();
      sessionOwners.clear();
      clearBaseline();
      recoverStream();
      stopping = false;
      })();
      stopAllPromise = cleanup;
      try {
        await cleanup;
      } finally {
        if (stopAllPromise === cleanup) stopAllPromise = undefined;
      }
    };

    return {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session", queueing: true },
        sendTurn,
        steer,
        interruptTurn,
        respondToRequest,
        hasSession: (threadId) => sessions.has(threadId),
        stopAll,
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        disposed = true;
        stopping = true;
        lifecycle++;
        await stopAll();
        unsubscribeMux();
        unsubscribeHost();
        unsubscribeHealth();
        client.close();
        listeners.clear();
      },
    };
  },
};
