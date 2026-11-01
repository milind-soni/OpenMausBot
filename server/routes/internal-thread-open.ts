import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { fitsOnOneLine } from "../../shared/bot-profile.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { CoordinateBotsCall } from "../coordinator.ts";
import { isThreadRole, ownThreadLevel, REQUEST_ID_MAX, THREAD_ROLES, withRole, type OwnThreadRequests } from "../host/own-threads.ts";
import type { PeerDeliveryReceipt } from "../peer-delivery.ts";
import { serverLine } from "../server-lines.ts";
import type { BotRecord, Message, Store } from "../store.ts";

type Reply = { status: number; body: Record<string, unknown> };
type Checked = { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string };

export const MAX_THREADS_OPENED_PER_TURN = 5;

/** Only called inside the internal capability gate: `from` and `fromThreadId` come from the caller's capability. */
export interface ThreadOpenDeps {
  store: Pick<Store, "bot" | "taskByThread" | "createTask" | "appendMessage">;
  from: BotRecord;
  fromThreadId: string;
  depth: number;
  /** The source conversation as the sender's: `group` when it is a room. Null when it is not the sender's. */
  owner: { group?: { name: string } } | null;
  openedThisTurn(): number;
  countOpened(): void;
  checkModel(raw: unknown): Checked;
  /** Why turn start would swap this model for the bot's own, or a falsy value when it runs as chosen. */
  givesWay(selection: ModelSelection): string | false | null | undefined;
  modelName(selection: ModelSelection): string;
  /** Whether moving this bot's level onto that engine must first drop it to Ask. */
  switchNeedsAsk(selection: ModelSelection): boolean;
  parentModel(): { modelSelection?: ModelSelection; approvalMode?: "ask" };
  /** The level the opening turn runs at, and the level a new thread of the bot starts at. */
  openerLevel(): ApprovalMode;
  botLevel(): ApprovalMode;
  engineRuns(selection: ModelSelection, mode: ApprovalMode): boolean;
  coordinate(call: CoordinateBotsCall): Promise<Reply>;
  startOpened(threadId: string, text: string): Promise<Record<string, unknown>>;
  language: string | undefined;
  limit: number;
  requests: OwnThreadRequests<Record<string, unknown>>;
}

function stringField(value: unknown, name: string, max: number): { value?: string; error?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.trim()) return { error: `${name} must be a non-empty string` };
  if (value.length > max) return { error: `${name} must be at most ${max} characters` };
  return { value: value.trim() };
}

export async function openInternalThread(deps: ThreadOpenDeps, body: Record<string, unknown>): Promise<Reply> {
  const { store, from, fromThreadId, owner } = deps;
  const refuse = (status: number, error: string): Reply => ({ status, body: { error } });
  if (!owner) return refuse(403, "source conversation does not belong to sender");
  if (body.depth !== undefined && (!Number.isInteger(body.depth) || body.depth !== deps.depth)) return refuse(403, "the recursion depth does not match this turn");
  const title = String(body.title ?? "").trim();
  const message = String(body.message ?? "").trim();
  if (!title || !message) return refuse(400, "title and message are required");
  if (title.length > 80) return refuse(400, "title must be at most 80 characters");
  if (!fitsOnOneLine(title)) return refuse(400, "title must fit on one line");
  if (body.role !== undefined && !isThreadRole(body.role)) return refuse(400, `role must be one of ${THREAD_ROLES.join(", ")}`);
  const role = isThreadRole(body.role) ? body.role : undefined;
  const requestId = stringField(body.requestId, "request_id", REQUEST_ID_MAX);
  if (requestId.error) return refuse(400, requestId.error);
  const toBotId = typeof body.toBotId === "string" && body.toBotId.trim() ? body.toBotId.trim() : from.id;
  const self = toBotId === from.id;
  const again = self && requestId.value ? deps.requests.find(from.id, fromThreadId, requestId.value, (id) => Boolean(store.taskByThread(from.id, id))) : undefined;
  if (again) return { status: 200, body: { ...again, existing: true } };
  if (deps.openedThisTurn() >= MAX_THREADS_OPENED_PER_TURN) {
    return refuse(429, `You have already opened ${MAX_THREADS_OPENED_PER_TURN} threads this turn, which is the limit. Do not retry — finish your turn and tell the person which threads you still wanted to open, so they can open them or ask you again.`);
  }
  const target = store.bot(toBotId);
  if (!target) return refuse(404, "no such bot");
  const folder = typeof body.folder === "string" ? body.folder.trim() : "";
  let projectId: string | undefined;
  if (folder) {
    const project = (target.projects ?? []).find((candidate) => candidate.id === folder || candidate.name.trim().toLowerCase() === folder.toLowerCase());
    if (!project) {
      const names = (target.projects ?? []).map((candidate) => candidate.name).join(", ");
      return refuse(400, `@${target.name} has no folder named "${folder}"${names ? ` — the folders are: ${names}` : " — it has no folders; leave folder out"}`);
    }
    projectId = project.id;
  }
  const work = withRole(role, message);
  if (!self) return deps.coordinate({ botIds: [target.id], message: work, rework: false, thread: "new", reply: "resume", consult: false, title, projectId });

  const chosen = body.modelSelection === undefined ? undefined : deps.checkModel(body.modelSelection);
  if (chosen && !chosen.ok) return refuse(chosen.status, chosen.error);
  // A second opinion must never quietly come from the opener's own model: refuse what turn start would swap out.
  const givesWay = chosen && deps.givesWay(chosen.selection);
  if (chosen && givesWay) return refuse(409, `${deps.modelName(chosen.selection)} can't run now: ${givesWay === "signed-out" ? "it is signed out" : "its engine is unavailable"}. Pick a model whose engine list_models shows as available, or leave modelSelection out.`);
  const picked = chosen ? { modelSelection: chosen.selection, ...(deps.switchNeedsAsk(chosen.selection) ? { approvalMode: "ask" as const } : {}) } : deps.parentModel();
  const own = picked.approvalMode ?? deps.botLevel();
  const capped = ownThreadLevel(deps.openerLevel(), own);
  const level = capped === own ? picked.approvalMode : deps.engineRuns(picked.modelSelection ?? from.modelSelection, capped) ? capped : "ask";
  const inherited = { ...(picked.modelSelection ? { modelSelection: picked.modelSelection } : {}), ...(level ? { approvalMode: level } : {}) };
  const remember = (reply: Reply): Reply => {
    if (requestId.value && reply.status < 300) deps.requests.remember(from.id, fromThreadId, requestId.value, reply.body);
    return reply;
  };

  if (body.reportBack === true) {
    if (owner.group) return refuse(400, "report_back works only from your own conversation, not a room. Leave it out; the thread's result then stays in that thread.");
    const result = await deps.coordinate({ botIds: [from.id], message: work, rework: false, thread: "new", reply: "resume", consult: false, title, projectId, ownThread: inherited });
    const receipt = (result.body.receipts as PeerDeliveryReceipt[] | undefined)?.[0];
    return remember({ status: result.status === 200 ? 201 : result.status,
      body: { ...result.body, self: true, reportBack: true, title, botId: from.id, botName: from.name, threadId: receipt?.threadId, requestId: receipt?.requestId } });
  }
  const task = store.createTask(from.id, title, false, projectId, { botId: from.id, name: from.name, at: Date.now() }, inherited.approvalMode, inherited.modelSelection);
  if (!task) return refuse(500, "couldn't create that thread");
  deps.countOpened();
  const chip: Omit<Message, "id" | "at"> = {
    role: "bot", kind: "activity",
    tool: { name: serverLine(deps.language, "server.rooms.openedThread", { title: task.title }), ok: true },
    threadRef: { botId: from.id, threadId: task.threadId, title: task.title },
  };
  if (owner.group) chip.from = { botId: from.id, name: from.name, color: from.color };
  store.appendMessage(fromThreadId, chip);
  const sourceTitle = owner.group ? owner.group.name : (store.taskByThread(from.id, fromThreadId)?.title ?? "");
  // Mark the bot's own words, so a later turn never mistakes the request for the person's.
  const opening = `[Thread you opened yourself${sourceTitle ? ` from #${sourceTitle}` : ""}. The request below is your own words, not the person's: do the work here and end with a clear result they can read.]\n\n${work}`;
  const outcome = await deps.startOpened(task.threadId, opening);
  return remember({ status: 201, body: { threadId: task.threadId, title: task.title, botId: from.id, botName: from.name, self: true, limit: deps.limit, ...outcome } });
}
