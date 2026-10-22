// What only the one-time move carries, as main sends it over the move's owner session (cloud-send.mjs): automations,
// imported and library skills and the bot fields My Cloud sets by its own move route (server/cloud-send-kinds.ts), the
// bots' memory and the person's learned facts and teams (server/cloud-send-memory.ts), each conversation's own settings,
// and the bots' files (server/cloud-send-files.ts) once My Cloud has room for them.
import { AUTOMATION_KINDS, MOVE_BOT_PARTS } from "./cloud-send-parts.mjs";
import { moveFit, growToFit } from "./cloud-space.mjs";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, 300) : null);
const SHA = /^[a-f0-9]{64}$/u;
const FILE_PATH = /^(?:workspaces\/[\w-]{1,128}|task-workspaces\/[\w-]{1,128}\/[\w-]{1,200})\/[^\0]{1,3800}$/u;
/** A part of a file, as My Cloud takes one (server/cloud-send-files.ts). */
const FILE_PART_BYTES = 8 * 1024 * 1024;
const SETTINGS_BATCH = 500;
const AUTOMATIONS = new Set(AUTOMATION_KINDS);
const ATTACHMENT_NAMES = 2000;

/** A routine changed both here and on My Cloud since it last went is still one routine: its runs are history My Cloud
 * adds by id, so this computer's always go, and its definition is the one changed last (`newer`), which sendKind settles
 * from both sides' records. */
export function mergeRoutines(rows) {
  for (const row of rows) {
    if (row.kind !== "routine" || !row.differs?.length) continue;
    if (row.differs.includes("def")) row.newer = true;
    row.parts = [...(row.parts ?? []), ...row.differs];
    row.state = "to-update";
    delete row.differs;
  }
}

/** The name a file arriving beside My Cloud's own different one takes: "notes (MacBook Air).md". */
export function keptBoth(path, label) {
  const at = path.lastIndexOf("/");
  const folder = path.slice(0, at + 1), name = path.slice(at + 1);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const computer = String(label ?? "").replace(/[^\p{L}\p{N} ._'-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "this computer";
  return `${folder}${stem} (${computer})${extension}`;
}

/** Whether My Cloud holds this file of this computer's: at its path, or kept beside a different one under a name that
 * starts with its own and the same bytes. */
export function fileArrived(file, there) {
  if (there.get(file.path)?.sha256 === file.sha256) return true;
  const at = file.path.lastIndexOf("/");
  const name = file.path.slice(at + 1), dot = name.lastIndexOf(".");
  const prefix = `${file.path.slice(0, at + 1)}${dot > 0 ? name.slice(0, dot) : name} (`;
  for (const [path, held] of there) if (held.sha256 === file.sha256 && path.startsWith(prefix)) return true;
  return false;
}

/** Each file a move sends, and how: a new path, one the move put there and that changed only here (`replace`), or kept
 * beside My Cloud's own different file (`kept`). */
export function planFiles(here, there, sent, label) {
  const plan = [];
  for (const file of here) {
    if (fileArrived(file, there)) continue;
    const held = there.get(file.path);
    if (!held) plan.push({ ...file, to: file.path, mode: "new" });
    else if (sent[file.path] === held.sha256) plan.push({ ...file, to: file.path, mode: "replace", expect: held.sha256 });
    else plan.push({ ...file, to: keptBoth(file.path, label), mode: "new", kept: true });
  }
  return plan;
}

const parseFiles = (value) => list(value?.files).filter((file) => record(file) && typeof file.path === "string" && FILE_PATH.test(file.path)
  && Number.isSafeInteger(file.size) && file.size >= 0 && typeof file.sha256 === "string" && SHA.test(file.sha256));

/**
 * @param {{
 *   localJson(route: string): Promise<any>,
 *   localBytes(route: string): Promise<Uint8Array | null>,
 *   localSend(method: string, route: string): Promise<{ ok: boolean, status: number }>,
 *   entry(origin: string): { files: Record<string, string>, on: Record<string, boolean> },
 *   persist(): void,
 *   progress(value: { done: number, total: number } | null): void,
 *   space?: { disk(): unknown, grow(sizeGb: number): Promise<unknown> },
 *   refusal(answer: { status: number, body: any }, fallback: string): string,
 *   scoped?(route: string): string,
 * }} deps `scoped`: a route as a move of one bot asks it of either side.
 */
export function createMoveKinds({ localJson, localBytes, localSend, entry, persist, progress, space, refusal, scoped = (route) => route }) {
  const failed = (ctx, key, kind, label, error, final = false) => ctx.result.failed.push({ key, kind, label, error: sentence(error) ?? "It did not move.", ...(final ? { final: true } : {}) });

  /** The definition a routine goes with in the person's own move: this computer's when only it changed it or it changed it
   * last, or else My Cloud's own, sent back with this computer's runs so they arrive without undoing what changed there.
   * Which side changed last comes from each side's record (`changedAt`); one that can't say keeps My Cloud's. */
  async function routineDefinition(ctx, row, held) {
    const here = ctx.localItems.get(row.key)?.parts.def, there = ctx.cloudItems.get(row.key)?.parts.def;
    if (!there || there === here || (row.parts?.includes("def") && !row.newer)) return held.record;
    const theirs = await ctx.session.call("GET", `/api/cloud-send/kind?key=${encodeURIComponent(row.key)}`);
    if (!theirs.ok || !record(theirs.body?.record)) throw new Error(refusal(theirs, "My Cloud's copy of this routine could not be read, so it was left as it is."));
    const changed = (side) => (Number.isSafeInteger(side?.changedAt) ? side.changedAt : null);
    const mine = changed(held), cloud = changed(theirs.body);
    return row.newer && mine !== null && cloud !== null && mine > cloud ? held.record : theirs.body.record;
  }

  /** One item only a move carries, as this computer holds it; an automation's switch here is kept (`on`) for the switch
   * that turns on there what was on here; an app event this computer then lets go of, so only My Cloud collects it. */
  async function sendKind(ctx, row) {
    const held = await localJson(`/api/cloud-send/kind?key=${encodeURIComponent(row.key)}`);
    if (!record(held) || !("record" in held)) throw Object.assign(new Error("It could not be read on this computer."), { code: "local" });
    const sent = row.kind === "routine" && ctx.ownMove ? await routineDefinition(ctx, row, held) : held.record;
    const answer = await ctx.session.call("PUT", "/api/cloud-send/kind", { v: 1, key: row.key, dataDir: held.dataDir, record: sent, ...(Array.isArray(held.runs) ? { runs: held.runs } : {}) });
    if (!answer.ok) throw Object.assign(new Error(refusal(answer, "My Cloud could not take it.")), answer.status === 400 || answer.status === 403 ? { final: true } : {});
    if (AUTOMATIONS.has(row.kind) && record(held.record)) {
      entry(ctx.origin).on[row.key] = row.kind === "call" ? held.record.nextRunAt !== null && held.record.nextRunAt !== undefined : held.record.enabled === true;
      persist();
    }
    if (row.kind === "app-event") {
      const released = await localSend("DELETE", `/api/cloud-send/kind?key=${encodeURIComponent(row.key)}`).catch(() => null);
      if (!released?.ok) throw new Error("My Cloud has this app event, but this computer could not stop collecting it yet. It tries again next time.");
    }
  }

  /** A bot's fields only a move carries, for these parts: one absent here is cleared there. */
  async function sendBotFields(ctx, botId, parts) {
    const names = parts.flatMap((part) => MOVE_BOT_PARTS[part] ?? []);
    if (!names.length) return {};
    const held = await localJson(`/api/cloud-send/kind?key=${encodeURIComponent(`bot:${botId}`)}`);
    const fields = Object.fromEntries(names.map((name) => [name, record(held?.record) && held.record[name] !== undefined ? held.record[name] : null]));
    const answer = await ctx.session.call("PUT", "/api/cloud-send/kind", { v: 1, key: `bot:${botId}`, dataDir: held?.dataDir ?? "-", record: fields });
    return answer.ok ? {} : Object.fromEntries(parts.filter((part) => MOVE_BOT_PARTS[part]).map((part) => [part, refusal(answer, "My Cloud refused this setting.")]));
  }

  /** Each bot's memory and journal, then what bots learned about the person and the teams' context and memory, merged
   * into My Cloud's: nothing is lost, nothing is doubled. */
  async function moveMemory(ctx, bots) {
    let merged = 0;
    for (const bot of bots) {
      try {
        const held = await localJson(`/api/cloud-send/memory?bot=${bot.id}`);
        const answer = await ctx.session.call("POST", "/api/cloud-send/memory", { v: 1, bot: bot.id, files: list(held?.files), journal: list(held?.journal) });
        if (!answer.ok) throw new Error(refusal(answer, "My Cloud could not keep this bot's memory."));
        merged += (answer.body?.files ?? 0) + (answer.body?.journal ?? 0);
        if (list(answer.body?.failed).length) failed(ctx, `memory:${bot.id}`, "memory", bot.name, "My Cloud could not keep some of this bot's memory notes: they are too long.", true);
      } catch (error) { failed(ctx, `memory:${bot.id}`, "memory", bot.name, error?.message); }
    }
    try {
      const shared = await localJson("/api/cloud-send/memory");
      const answer = await ctx.session.call("POST", "/api/cloud-send/memory", { v: 1, about: shared?.about ?? { learned: [], removed: [] }, teams: list(shared?.teams) });
      if (!answer.ok) throw new Error(refusal(answer, "My Cloud could not keep what your bots learned and your teams' notes."));
      merged += (answer.body?.about ?? 0) + (answer.body?.teams ?? 0);
      if (list(answer.body?.failed).length) failed(ctx, "memory:shared", "memory", "About me and teams", "My Cloud has no room for some of what your bots learned about you.", true);
    } catch (error) { failed(ctx, "memory:shared", "memory", "About me and teams", error?.message); }
    ctx.result.memory = merged;
  }

  /** Each conversation's own settings My Cloud's copy lacks: its model, approval, snooze and project; a room's time limit
   * and audience floor. */
  async function moveSettings(ctx) {
    const here = list((await localJson(scoped("/api/cloud-send/chats")))?.conversations);
    const answer = await ctx.session.call("GET", scoped("/api/cloud-send/chats"));
    if (!answer.ok) throw new Error(refusal(answer, "My Cloud did not list its conversations."));
    const there = new Map(list(answer.body?.conversations).filter(record).map((head) => [head.threadId, record(head.settings) ? head.settings : {}]));
    const lacking = here.filter((head) => record(head) && record(head.settings) && there.has(head.threadId)
      && Object.keys(head.settings).some((key) => there.get(head.threadId)[key] === undefined)).map((head) => ({ threadId: head.threadId, settings: head.settings }));
    let changed = 0;
    for (let i = 0; i < lacking.length; i += SETTINGS_BATCH) {
      const sent = await ctx.session.call("POST", "/api/cloud-send/chats/settings", { v: 1, conversations: lacking.slice(i, i + SETTINGS_BATCH) });
      if (!sent.ok) throw new Error(refusal(sent, "My Cloud could not set its conversations as they were."));
      changed += Number.isSafeInteger(sent.body?.changed) ? sent.body.changed : 0;
    }
    return changed;
  }

  /** The attachments My Cloud lacks of those this computer's chats name, in bytes. */
  async function missingAttachmentBytes(session) {
    const listed = list((await localJson(scoped("/api/cloud-send/chats?attachments=1")))?.attachments).filter((item) => record(item) && typeof item.name === "string" && Number.isSafeInteger(item.size));
    let bytes = 0;
    for (let i = 0; i < listed.length; i += ATTACHMENT_NAMES) {
      const asked = listed.slice(i, i + ATTACHMENT_NAMES);
      const answer = await session.call("POST", "/api/cloud-send/chats/attachments", { names: asked.map((item) => item.name) });
      const missing = new Set(answer.ok ? list(answer.body?.missing) : []);
      for (const item of asked) if (missing.has(item.name)) bytes += item.size;
    }
    return bytes;
  }

  /** Room for `bytes` on My Cloud: true when it fits now or once its volume grew; why not otherwise. */
  async function makeRoom(session, bytes, measured) {
    const disk = (() => { try { return space?.disk() ?? null; } catch { return null; } })();
    const fit = moveFit({ localBytes: bytes, freeBytes: measured.freeBytes, volumeBytes: measured.volumeBytes, disk, copies: 1 });
    if (fit.fit === "now") return null;
    if (fit.fit === "never" || !space) return "My Cloud does not have enough space for this computer's files. Delete some there, or choose a bigger plan.";
    const grown = await growToFit(fit, { grow: (sizeGb) => space.grow(sizeGb), free: async () => {
      const answer = await session.call("GET", scoped("/api/cloud-send/files"));
      return answer.ok && Number.isSafeInteger(answer.body?.space?.freeBytes) ? answer.body.space.freeBytes : null;
    } });
    return grown === "grown" ? null : grown === "full" ? "My Cloud does not have enough space for this computer's files." : "My Cloud could not make room for this computer's files just now. It tries again next time.";
  }

  /** One file in parts, from where My Cloud's copy ends; on a conflict, once more beside My Cloud's own file. */
  async function sendFile(ctx, file, label) {
    let to = file.to, mode = file.mode, expect = file.expect, offset = 0, kept = Boolean(file.kept);
    for (let rounds = 0; rounds < 100_000; rounds++) {
      const length = Math.min(FILE_PART_BYTES, file.size - offset);
      const bytes = length > 0 ? await localBytes(`/api/cloud-send/files?path=${encodeURIComponent(file.path)}&offset=${offset}&length=${length}`) : new Uint8Array();
      if (!bytes || bytes.length !== length) throw new Error("This file could not be read on this computer.");
      const query = new URLSearchParams({ path: to, size: String(file.size), sha256: file.sha256, offset: String(offset), mode, ...(expect ? { expect } : {}) });
      const answer = await ctx.session.upload(`/api/cloud-send/files?${query}`, bytes, "application/octet-stream");
      if (answer.status === 201) return { to, kept };
      if (answer.ok && Number.isSafeInteger(answer.body?.received)) { offset = answer.body.received; continue; }
      if (answer.status === 409 && answer.body?.conflict === true && !kept) { to = keptBoth(file.path, label); mode = "new"; expect = undefined; kept = true; continue; }
      if (answer.status === 409 && Number.isSafeInteger(answer.body?.received)) { offset = Math.min(answer.body.received, file.size); continue; }
      throw new Error(refusal(answer, "My Cloud could not take this file."));
    }
    throw new Error("My Cloud could not take this file.");
  }

  /** The bots' files My Cloud lacks, once it has room for them and for the attachments still to go. */
  async function moveFiles(ctx, bots, label) {
    const carried = new Set(bots.map((bot) => bot.id));
    const owner = (path) => /^(?:workspaces|task-workspaces)\/([\w-]{1,128})\//u.exec(path)?.[1];
    const here = parseFiles(await localJson(scoped("/api/cloud-send/files"))).filter((file) => carried.has(owner(file.path)));
    const listed = await ctx.session.call("GET", scoped("/api/cloud-send/files"));
    if (!listed.ok) throw new Error(refusal(listed, "My Cloud did not list its files."));
    const there = new Map(parseFiles(listed.body).map((file) => [file.path, file]));
    const kept = entry(ctx.origin);
    const plan = planFiles(here, there, kept.files, label);
    ctx.result.files = { sent: 0, kept: 0 };
    const bytes = plan.reduce((sum, file) => sum + file.size, 0) + await missingAttachmentBytes(ctx.session);
    const measured = record(listed.body?.space) ? listed.body.space : null;
    if (measured && bytes) {
      const short = await makeRoom(ctx.session, bytes, measured);
      if (short) return void failed(ctx, "files", "files", "Files", short);
    }
    progress(plan.length ? { done: 0, total: plan.length } : null);
    let done = 0;
    for (const file of plan) {
      try {
        const stored = await sendFile(ctx, file, label);
        kept.files[stored.to] = file.sha256;
        ctx.result.files.sent++;
        if (stored.kept) ctx.result.files.kept++;
        persist();
      } catch (error) { failed(ctx, `file:${file.path}`, "files", file.path.split("/").pop(), error?.message); }
      progress({ done: ++done, total: plan.length });
    }
  }

  return { sendKind, sendBotFields, moveMemory, moveSettings, moveFiles };
}
