// Not atomic: a refused step stops the run, says what was already done, and exits 1; running it again carries on.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { approvalModeFor } from "../../shared/approval-mode.ts";
import { assertToolScopeSupported } from "../../shared/tool-scope-support.ts";
import { lineDiff } from "../../shared/line-diff.ts";
import { mask, redactSecretsInText } from "../../shared/redact.ts";
import { describeMs, EXIT, flag, HeadlessError, parseDuration, usageError } from "./args.ts";
import { explain, type HeadlessClient } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";
import { applyEngine, ENGINE_KINDS, readSecret } from "./engine.ts";
import { everyTool, loadTeamFile, type DesiredBot, type TeamFile } from "./team-file.ts";

type Rec = Record<string, any>;
const enc = encodeURIComponent;
const key = (name: string | undefined) => (name ?? "").trim().toLowerCase();
const APPROVAL_LABEL: Record<string, string> = { ask: "Ask", edits: "Accept edits", auto: "Auto", full: "Full access", custom: "Custom" };

export interface ApplyOptions {
  apply: boolean;
  prune: boolean;
  rotateSecrets: boolean;
  waitIdleMs: number;
  env: NodeJS.ProcessEnv;
  progress?(event: Rec): void;
}

export interface Tally {
  lines: string[];
  created: number;
  changed: number;
  unchanged: number;
  deleted: number;
  writes: number;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));
const canonicalScope = (scope: Rec | null | undefined) => everyTool(scope) ? "every tool"
  : JSON.stringify(Object.fromEntries(["allow", "deny"].filter((field) => Array.isArray(scope![field])).map((field) => [field, [...new Set(scope![field] as string[])].sort()])));

const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

function changedLines(before: string, after: string): number {
  const diff = lineDiff(before.trimEnd(), after.trimEnd());
  return Math.max(diff.filter((line) => line.startsWith("+")).length, diff.filter((line) => line.startsWith("-")).length);
}

export function botPatch(desired: DesiredBot, echo: Rec, team: string | undefined): { patch: Rec; changes: string[] } {
  const patch: Rec = {};
  const changes: string[] = [];
  if (echo.name !== desired.name) { patch.name = desired.name; changes.push(`renamed from "${echo.name}"`); }
  if (team !== undefined && key(echo.section) !== key(team)) { patch.section = team; changes.push(`team "${echo.section ?? "none"}" → "${team}"`); }
  if (desired.title !== undefined && (echo.title ?? "") !== desired.title) { patch.title = desired.title; changes.push(`title "${echo.title ?? ""}" → "${desired.title}"`); }
  if (desired.description !== undefined && (echo.description ?? "") !== desired.description) { patch.description = desired.description; changes.push("description changed"); }
  if (desired.soul !== undefined && (echo.soul ?? "").trimEnd() !== desired.soul.trimEnd()) {
    patch.soul = desired.soul.trimEnd();
    changes.push(echo.soul ? `soul ${lines(changedLines(echo.soul ?? "", desired.soul))} changed` : `soul set (${lines(desired.soul.trimEnd().split("\n").length)})`);
  }
  if (desired.model || desired.effort) {
    const current: Rec = echo.modelSelection ?? {};
    const instanceId = desired.model?.instanceId ?? current.instanceId;
    const model = desired.model?.model ?? current.model;
    if (current.instanceId !== instanceId || current.model !== model || (desired.effort !== undefined && current.effort !== desired.effort)) {
      const effort = desired.effort ?? (instanceId === current.instanceId ? current.effort : undefined);
      patch.modelSelection = { instanceId, model, ...(effort ? { effort } : {}) };
      patch.requireAvailableModel = true;
      changes.push(`model ${current.instanceId}/${current.model}${current.effort ? ` (${current.effort})` : ""} → ${instanceId}/${model}${effort ? ` (${effort})` : ""}`);
    }
  }
  const approval = approvalModeFor(echo);
  if (desired.approval && approval !== desired.approval) {
    patch.approvalMode = desired.approval;
    patch.applyToAllThreads = true;
    changes.push(`approval ${APPROVAL_LABEL[approval]} → ${APPROVAL_LABEL[desired.approval]}`);
  }
  const computer = echo.computer ?? "auto";
  if (desired.computer && computer !== desired.computer) {
    patch.computer = desired.computer === "auto" ? null : desired.computer;
    changes.push(`computer ${computer} → ${desired.computer}`);
  }
  // The file is the confirmation the server asks for to leave a bot on Auto on this computer.
  if ((patch.computer !== undefined || patch.approvalMode !== undefined) && (desired.computer ?? computer) === "local" && (desired.approval ?? approval) === "auto") {
    patch.acknowledgeLocalAuto = true;
  }
  if (desired.cwd && echo.cwd !== desired.cwd) { patch.cwd = desired.cwd; changes.push(`folder ${echo.cwd ?? "default"} → ${desired.cwd}`); }
  if (desired.browser) {
    if ((echo.browser !== false) !== desired.browser.enabled) { patch.browser = desired.browser.enabled; changes.push(`browser ${desired.browser.enabled ? "on" : "off"}`); }
    if (desired.browser.profile !== undefined && echo.browserProfile !== desired.browser.profile) {
      patch.browserProfile = desired.browser.profile;
      changes.push(`browser profile ${echo.browserProfile ?? "its own"} → ${desired.browser.profile}`);
    }
  }
  if (desired.tools !== undefined && canonicalScope(echo.toolScope) !== canonicalScope(desired.tools)) {
    // null clears the selection on the server: every tool
    patch.toolScope = desired.tools;
    changes.push(desired.tools === null ? "tools: every tool" : "tools changed");
  }
  return { patch, changes };
}

const describeNew = (bot: DesiredBot) => [
  bot.chief === true ? `Chief of ${bot.team ?? "General"}` : bot.team ? `team ${bot.team}` : "",
  bot.model ? `${bot.model.instanceId}/${bot.model.model}` : "",
  bot.approval ? APPROVAL_LABEL[bot.approval] : "",
  bot.computer && bot.computer !== "auto" ? `computer ${bot.computer}` : "",
].filter(Boolean).join(" · ");

export async function reconcile(client: HeadlessClient, file: TeamFile, options: ApplyOptions): Promise<Tally> {
  const tally: Tally = { lines: [], created: 0, changed: 0, unchanged: 0, deleted: 0, writes: 0 };
  const note = (line: string, kind: "created" | "changed" | "unchanged" | "deleted" | "kept") => {
    if (kind !== "unchanged") tally.lines.push(line);
    if (kind !== "kept") tally[kind] += 1;
  };
  const write = async (path: string, init: RequestInit): Promise<any> => { tally.writes += 1; return client.json(path, init); };
  const tool = async (name: string, args: Rec): Promise<any> => { tally.writes += 1; return client.tool(name, args); };
  const fleet = async () => client.json<Rec>("/api/bots?messages=0");
  const findBot = (bots: Rec[], name: string, team?: string) => {
    const inTeam = (bot: Rec) => Number(team !== undefined && key(bot.section) === key(team));
    return bots.filter((bot) => key(bot.name) === key(name)).sort((a, b) => inTeam(b) - inTeam(a) || Number(Boolean(a.hidden)) - Number(Boolean(b.hidden)))[0];
  };

  if (file.engines.length) {
    const config = await client.json<Rec>("/api/config");
    const instances: Rec[] = (await client.json<Rec>("/api/instances")).instances ?? [];
    for (const engine of file.engines) {
      const spec = ENGINE_KINDS[engine.kind]!;
      const status: Rec = config[spec.config] ?? {};
      const onlyClaudeApi = engine.kind === "claude" && engine.everyClaudeBot === false;
      const needsKey = status.configured !== true || options.rotateSecrets;
      const instanceId = onlyClaudeApi ? spec.apiInstance! : spec.instance;
      const install = engine.install === true && instances.find((instance) => instance.instanceId === instanceId)?.snapshot?.state !== "available";
      const keyValue = needsKey ? readSecret(engine.key, options.env, `engine ${engine.kind} key`) : "";
      // A secret base URL is read only when it is written or compared, and never shown.
      const secretUrl = engine.baseUrl !== undefined && typeof engine.baseUrl !== "string";
      const baseUrl = engine.baseUrl === undefined ? undefined : typeof engine.baseUrl === "string" ? engine.baseUrl
        : needsKey || typeof status.url === "string" ? readSecret(engine.baseUrl, options.env, `engine ${engine.kind} base URL`) : undefined;
      const request = { kind: engine.kind, key: keyValue, ...(baseUrl ? { baseUrl } : {}), onlyClaudeApi, rotate: options.rotateSecrets, install, dryRun: !options.apply,
        ...(options.progress ? { progress: options.progress } : {}) };
      const result = await applyEngine(client, request);
      if (options.apply && (result.changed.length || install)) tally.writes += (result.changed.length ? 1 : 0) + (install ? 1 : 0);
      if (!needsKey && engine.baseUrl !== undefined && typeof status.url !== "string") {
        note(`engine ${engine.kind}: its key is already set and the server does not show its base URL, so the file's was not compared (--rotate-secrets writes both)`, "kept");
      }
      if (!result.changed.length && !install) { note(`engine ${engine.kind}: already set`, "unchanged"); continue; }
      note(`engine ${engine.kind}: ${[...result.changed.map((field: string) => field === "key" ? `key ${mask(keyValue)}` : field === "everyClaudeBot" ? (onlyClaudeApi ? "only Claude (API key) bots use the key" : "every Claude bot uses the key") : secretUrl ? "base URL set" : `base URL ${baseUrl}`),
        ...(install ? ["install"] : [])].join(" · ")}`, status.configured === true ? "changed" : "created");
    }
  }

  const sections: string[] = [...((await client.json<Rec>("/api/sidebar-sections")).sections ?? [])];
  const sectionNamed = (name: string) => sections.find((section) => key(section) === key(name));
  const teamNames: string[] = [];
  for (const name of [...file.teams.map((team) => team.name), ...file.bots.flatMap((bot) => [bot.team, ...bot.manages]), ...file.rooms.map((room) => room.team)]) {
    if (name && !teamNames.some((known) => key(known) === key(name))) teamNames.push(name);
  }
  for (const name of teamNames) {
    const existing = sectionNamed(name);
    const brief = file.teams.find((team) => key(team.name) === key(name))?.brief;
    const parts: string[] = [];
    if (!existing) {
      parts.push("create");
      if (options.apply) await write("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name, botIds: [] }) });
      sections.push(name);
    }
    if (brief !== undefined) {
      const current = existing ? String((await client.json<Rec>(`/api/section-context?section=${enc(existing)}`)).text ?? "") : "";
      if (current.trimEnd() !== brief.trimEnd()) {
        parts.push(current.trim() ? `brief ${lines(changedLines(current, brief))} changed` : `brief set (${lines(brief.trimEnd().split("\n").length)})`);
        if (options.apply) await write(`/api/section-context?section=${enc(existing ?? name)}`, { method: "PUT", body: JSON.stringify({ text: brief.trimEnd() }) });
      }
    }
    note(`team "${name}": ${parts.join(" · ")}`, !parts.length ? "unchanged" : existing ? "changed" : "created");
  }
  const teamOf = (bot: DesiredBot) => bot.team ? sectionNamed(bot.team) ?? bot.team : undefined;

  const instances: Rec[] = (await client.json<Rec>("/api/instances")).instances ?? [];
  for (const desired of file.bots.filter((bot) => bot.model)) {
    const { instanceId, model } = desired.model!;
    const instance = instances.find((candidate) => candidate.instanceId === instanceId);
    if (!instance) throw new HeadlessError(`bot "${desired.name}": no engine "${instanceId}" here`, EXIT.failed, "openmausbot models lists the engines and their models");
    const offered = [instance.models?.default, ...(instance.models?.options ?? []).map((option: Rec) => option.id)];
    if (instance.snapshot?.state === "available" && !offered.includes(model)) {
      throw new HeadlessError(`bot "${desired.name}": ${instanceId} offers no model "${model}"`, EXIT.failed, "openmausbot models lists them");
    }
  }
  let current = await fleet();
  const existingFor = (desired: DesiredBot): Rec | undefined =>
    (desired.was ? findBot(current.bots ?? [], desired.was, teamOf(desired)) : undefined) ?? findBot(current.bots ?? [], desired.name, teamOf(desired));
  for (const desired of file.bots.filter((bot) => bot.was)) {
    const old = findBot(current.bots ?? [], desired.was!, teamOf(desired));
    const taken = findBot(current.bots ?? [], desired.name, teamOf(desired));
    if (old && taken && old.id !== taken.id) {
      throw new HeadlessError(`bot "${desired.name}": both "${old.name}" (its was:) and "${taken.name}" exist, so the rename would make two bots of one name`, EXIT.failed,
        "delete or rename one of them, or take was: out of the file");
    }
  }
  let workspaceDefault: string | undefined;
  for (const desired of file.bots) {
    if (!desired.tools) continue;
    const existing = existingFor(desired);
    if (!desired.model && !existing) workspaceDefault ??= (await client.json<Rec>("/api/bot-defaults")).modelSelection?.instanceId;
    const instanceId = desired.model?.instanceId ?? existing?.modelSelection?.instanceId ?? workspaceDefault;
    const driverKind = instances.find((instance) => instance.instanceId === instanceId)?.driverKind;
    if (typeof driverKind !== "string") continue;
    try {
      assertToolScopeSupported(driverKind, desired.tools);
    } catch (error) {
      throw new HeadlessError(`bot "${desired.name}": ${error instanceof Error ? error.message : String(error)}`, EXIT.failed,
        "this engine limits only MCP tools (mcp:SERVER:TOOL): leave native tools out of its selection, or give the bot an engine that can limit them (docs/tool-selection.md)");
    }
  }
  const created = new Set<string>();
  for (const desired of file.bots) {
    const existing = existingFor(desired);
    if (!existing) {
      note(`bot "${desired.name}": create${describeNew(desired) ? ` (${describeNew(desired)})` : ""}`, "created");
      created.add(key(desired.name));
      if (!options.apply) continue;
      const made = await write("/api/bots", { method: "POST", body: JSON.stringify({
        useDefaults: false, name: desired.name, ...(desired.title !== undefined ? { title: desired.title } : {}),
        ...(desired.description !== undefined ? { description: desired.description } : {}), ...(teamOf(desired) ? { section: teamOf(desired) } : {}),
        ...(desired.model ? { modelSelection: { ...desired.model, ...(desired.effort ? { effort: desired.effort } : {}) }, requireAvailableModel: true } : {}),
      }) });
      const { patch } = botPatch(desired, made.bot, teamOf(desired));
      if (Object.keys(patch).length) await write(`/api/bots/${enc(made.bot.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      continue;
    }
    const { patch, changes } = botPatch(desired, existing, teamOf(desired));
    if (!changes.length) { note("", "unchanged"); continue; }
    note(`bot "${desired.name}": update ${changes.join("; ")}`, "changed");
    if (!options.apply) continue;
    if (existing.busy) await waitIdle(client, existing, options.waitIdleMs);
    await write(`/api/bots/${enc(existing.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  }
  if (options.apply) current = await fleet();
  const named = (name: string) => file.bots.find((bot) => key(bot.name) === key(name));
  const botId = (name: string) => {
    const desired = named(name);
    const team = desired ? teamOf(desired) : undefined;
    return (findBot(current.bots ?? [], name, team) ?? (desired?.was ? findBot(current.bots ?? [], desired.was, team) : undefined))?.id as string | undefined;
  };

  for (const desired of file.bots.filter((bot) => bot.skills.length)) {
    const id = botId(desired.name);
    const listing: Rec[] = id ? (await client.json<Rec>(`/api/bots/${enc(id)}/skills`)).skills ?? [] : [];
    for (const skill of desired.skills) {
      const installed = listing.find((entry) => entry.name === skill.name);
      const sha = createHash("sha256").update(skill.text).digest("hex");
      const same = installed && (installed.sha256 === sha || (await client.json<Rec>(`/api/bots/${enc(id!)}/skills/${enc(skill.name)}`)).text === skill.text);
      const template = { name: skill.name, description: skill.description, warnings: [], source: `team file ${basename(file.path)}: ${skill.file}`, text: skill.text, enabled: skill.enabled };
      if (!installed) {
        if (!created.has(key(desired.name))) note(`skill "${skill.name}" for "${desired.name}": add`, "created");
        if (options.apply) await write(`/api/bots/${enc(id!)}/skill-template`, { method: "POST", body: JSON.stringify(template) });
      } else if (!same) {
        note(`skill "${skill.name}" for "${desired.name}": replace with ${skill.file}`, "changed");
        if (options.apply) {
          await write(`/api/bots/${enc(id!)}/skills/${enc(skill.name)}`, { method: "DELETE" });
          await write(`/api/bots/${enc(id!)}/skill-template`, { method: "POST", body: JSON.stringify(template) });
        }
      } else if (installed.enabled !== skill.enabled) {
        note(`skill "${skill.name}" for "${desired.name}": ${skill.enabled ? "turn on" : "turn off"}`, "changed");
        if (options.apply) await write(`/api/bots/${enc(id!)}/skills/${enc(skill.name)}`, { method: "PATCH", body: JSON.stringify({ enabled: skill.enabled }) });
      } else note("", "unchanged");
    }
  }

  for (const desired of file.bots.filter((bot) => bot.chief !== undefined)) {
    const bot = (current.bots ?? []).find((candidate: Rec) => candidate.id === botId(desired.name));
    const managed = desired.manages.map((name) => sectionNamed(name) ?? name);
    if (desired.chief === false) {
      if (!bot?.chiefOfStaff) continue;
      note(`bot "${desired.name}": no longer Chief of Staff`, "changed");
      if (options.apply) await write(`/api/bots/${enc(bot.id)}`, { method: "PATCH", body: JSON.stringify({ chiefOfStaff: false }) });
      continue;
    }
    if (bot?.chiefOfStaff === true && sameSet(bot.managedSections ?? [], managed)) continue;
    if (!created.has(key(desired.name))) note(`bot "${desired.name}": Chief of Staff of ${desired.team ?? "General"}${managed.length ? `, also in charge of ${managed.join(", ")}` : ""}`, "changed");
    if (options.apply) await write(`/api/bots/${enc(bot!.id)}`, { method: "PATCH", body: JSON.stringify({ chiefOfStaff: true, managedSections: managed, acknowledgePeerScope: true }) });
  }

  const rooms: Rec[] = (current.groups ?? []).filter((group: Rec) => !group.dm);
  for (const room of file.rooms) {
    const memberIds = room.members.map((name) => botId(name) ?? (!options.apply && created.has(key(name)) ? `new:${name}` : undefined));
    const missing = room.members.filter((_name, index) => !memberIds[index]);
    if (missing.length) throw new HeadlessError(`room "${room.name}": no bot named ${missing.map((name) => `"${name}"`).join(", ")}`, EXIT.failed);
    const ids = memberIds as string[];
    const responder = room.responder === undefined ? undefined : room.responder === "everyone" || room.responder === "mentions" ? { kind: room.responder }
      : { kind: "member", bot_id: ids[room.members.findIndex((member) => key(member) === key(room.responder))]! };
    const team = room.team ? sectionNamed(room.team) ?? room.team : undefined;
    const existing = rooms.find((group) => key(group.name) === key(room.name));
    if (!existing) {
      note(`room "${room.name}": create (${room.members.length} member${room.members.length === 1 ? "" : "s"}${team ? `, team ${team}` : ""})`, "created");
      if (options.apply) await tool("create_channel", { name: room.name, member_ids: ids, ...(team ? { section: team } : {}),
        ...(room.brief !== undefined ? { bulletin: room.brief.trimEnd() } : {}), ...(responder ? { default_responder: responder } : {}) });
      continue;
    }
    const change: Rec = {};
    const words: string[] = [];
    if (!sameSet(existing.memberIds ?? [], ids)) { change.member_ids = ids; words.push(`members → ${room.members.join(", ")}`); }
    if (team !== undefined && key(existing.section) !== key(team)) { change.section = team; words.push(`team → ${team}`); }
    if (room.brief !== undefined && String(existing.bulletin ?? "").trimEnd() !== room.brief.trimEnd()) { change.bulletin = room.brief.trimEnd(); words.push("brief changed"); }
    const echo: Rec = existing.defaultResponder ?? {};
    if (responder && (echo.kind !== responder.kind || (responder.kind === "member" && echo.botId !== (responder as Rec).bot_id))) {
      change.default_responder = responder;
      words.push(`answered by ${room.responder}`);
    }
    if (!words.length) { note("", "unchanged"); continue; }
    note(`room "${room.name}": update ${words.join("; ")}`, "changed");
    if (options.apply) await tool("update_channel", { channel_id: existing.id, ...change });
  }

  for (const team of file.teams) {
    const section = sectionNamed(team.name);
    if (!section) continue;
    const listed = new Set(file.bots.flatMap((bot) => [key(bot.name), ...(bot.was ? [key(bot.was)] : [])]));
    for (const bot of (current.bots ?? []).filter((candidate: Rec) => !candidate.hidden && key(candidate.section) === key(section) && !listed.has(key(candidate.name)))) {
      if (!options.prune || !team.prune) { note(`bot "${bot.name}": not in file (kept${team.prune ? "; --prune deletes it" : ""})`, "kept"); continue; }
      note(`bot "${bot.name}": delete (not in file)`, "deleted");
      if (options.apply) await write(`/api/bots/${enc(bot.id)}`, { method: "DELETE" });
    }
    const roomNames = new Set(file.rooms.map((room) => key(room.name)));
    for (const group of rooms.filter((candidate) => key(candidate.section) === key(section) && !roomNames.has(key(candidate.name)))) {
      if (!options.prune || !team.prune) { note(`room "${group.name}": not in file (kept${team.prune ? "; --prune deletes it" : ""})`, "kept"); continue; }
      note(`room "${group.name}": delete (not in file)`, "deleted");
      if (options.apply) await write(`/api/groups/${enc(group.id)}`, { method: "DELETE" });
    }
  }
  return tally;
}

async function waitIdle(client: HeadlessClient, bot: Rec, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const now = ((await client.json<Rec>("/api/bots?messages=0")).bots ?? []).find((candidate: Rec) => candidate.id === bot.id);
    if (!now?.busy) return;
  }
  throw new HeadlessError(`"${bot.name}" is still working after ${describeMs(waitMs)}, so it was not changed`, EXIT.failed,
    "apply again once it is idle, or wait longer with --wait-idle 10m");
}

const summary = (tally: Tally) => `${tally.created} to create, ${tally.changed} to change, ${tally.unchanged} unchanged, ${tally.deleted} to delete`;

export async function teamApplyVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const path = ctx.positionals[0];
  if (!path) throw usageError("name the team file: openmausbot team apply FILE");
  const check = ctx.flags.check === true;
  const dryRun = ctx.flags["dry-run"] === true;
  if (check && dryRun) throw usageError("choose one of --dry-run and --check");
  const file = loadTeamFile(path);
  const options = {
    prune: ctx.flags.prune === true, rotateSecrets: ctx.flags["rotate-secrets"] === true, env: ctx.env, progress: (event: Rec) => ctx.output.progress(event),
    waitIdleMs: flag(ctx.flags, "wait-idle") ? parseDuration(flag(ctx.flags, "wait-idle")!, "--wait-idle", { min: 0 }) : 120_000,
  };
  for (const warning of file.warnings) ctx.output.progress({ event: "warning", warning });
  const client = await ctx.client();
  const plan = await reconcile(client, file, { ...options, apply: false });
  const changes = plan.created + plan.changed + plan.deleted;
  const planText = [...plan.lines, changes ? `Plan: ${summary(plan)}.` : "No changes."];
  if (!changes || dryRun || check) {
    return {
      result: { ok: !check || !changes, file: file.path, plan: plan.lines, ...countsOf(plan), applied: false, writes: 0, warnings: file.warnings },
      exitCode: check && changes ? EXIT.changes : EXIT.done, human: planText,
    };
  }
  let applied: Tally | undefined;
  try {
    applied = await reconcile(client, file, { ...options, apply: true });
  } catch (error) {
    const reported = await explain(error, client.baseUrl);
    throw new HeadlessError(`${reported.message} (stopped part way: apply the file again to carry on)`, reported.exitCode, reported.hint);
  }
  return {
    result: { ok: true, file: file.path, plan: plan.lines, ...countsOf(plan), applied: true, writes: applied.writes, warnings: file.warnings },
    exitCode: EXIT.done,
    human: [...planText, `Applied: ${applied.created} created, ${applied.changed} changed, ${applied.deleted} deleted.`],
  };
}

const countsOf = (tally: Tally) => ({ created: tally.created, changed: tally.changed, unchanged: tally.unchanged, deleted: tally.deleted });

export const skillFilePath = (botDir: string, skillName: string): string => posix.join("skills", botDir, skillName, "SKILL.md");

export function botSkillDirs(botNames: string[]): string[] {
  const taken = new Set<string>();
  return botNames.map((name) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
    let dir = base;
    for (let n = 2; taken.has(dir); n += 1) dir = `${base}-${n}`;
    taken.add(dir);
    return dir;
  });
}

/** Keys never leave the server. */
export async function teamExportVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const out = flag(ctx.flags, "out")?.trim();
  if (!out) throw usageError("--out FILE is required (the team file to write)");
  const wanted = ((ctx.flags.team as string[] | undefined) ?? []).map(key);
  const client = await ctx.client();
  const fleet = await client.json<Rec>("/api/bots?messages=0");
  const sections: string[] = (await client.json<Rec>("/api/sidebar-sections")).sections ?? [];
  for (const name of wanted) if (!sections.some((section) => key(section) === name)) throw usageError(`no team named "${name}"`);
  const inScope = (section: string | undefined) => !wanted.length || wanted.includes(key(section));
  const bots: Rec[] = (fleet.bots ?? []).filter((bot: Rec) => !bot.hidden && inScope(bot.section));
  const names = new Set<string>();
  for (const bot of bots) {
    if (names.has(key(bot.name))) throw new HeadlessError(`two bots are named "${bot.name}"; rename one before exporting`, EXIT.failed);
    names.add(key(bot.name));
  }
  const dir = dirname(resolve(out));
  // A team file travels: a key written into a soul, a brief or a skill is taken out.
  const redacted: string[] = [];
  const clean = (text: string, where: string): string => {
    const cleaned = redactSecretsInText(text);
    if (cleaned !== text) redacted.push(where);
    return cleaned;
  };
  const teams = sections.filter((section) => inScope(section) && (wanted.length || bots.some((bot) => key(bot.section) === key(section))));
  const teamEntries = await Promise.all(teams.map(async (name) => {
    const brief = String((await client.json<Rec>(`/api/section-context?section=${enc(name)}`)).text ?? "");
    return { name, ...(brief.trim() ? { brief: clean(brief, `team "${name}" brief`) } : {}) };
  }));
  const skipped: string[] = [];
  let skills = 0;
  const botEntries = [];
  const skillDirs = botSkillDirs(bots.map((bot) => bot.name));
  for (const [index, bot] of bots.entries()) {
    const entry: Rec = { name: bot.name, ...(bot.section ? { team: bot.section } : {}), ...(bot.title ? { title: bot.title } : {}),
      ...(bot.description ? { description: clean(bot.description, `bot "${bot.name}" description`) } : {}) };
    if (bot.chiefOfStaff) Object.assign(entry, { chief: true, ...(bot.managedSections?.length ? { manages: bot.managedSections } : {}) });
    if (bot.soul?.trim()) entry.soul = clean(bot.soul, `bot "${bot.name}" soul`);
    if (bot.modelSelection?.instanceId) {
      entry.model = `${bot.modelSelection.instanceId}/${bot.modelSelection.model}`;
      if (bot.modelSelection.effort) entry.effort = bot.modelSelection.effort;
    }
    const approval = approvalModeFor(bot);
    if (approval === "custom") skipped.push(`${bot.name}: its Custom approval level is set in the desktop app, not in a team file`);
    else entry.approval = approval;
    if (bot.computer) entry.computer = bot.computer;
    if (bot.cwd) entry.cwd = bot.cwd;
    if (bot.browser === false || bot.browserProfile) entry.browser = { enabled: bot.browser !== false, ...(bot.browserProfile ? { profile: bot.browserProfile } : {}) };
    if (!everyTool(bot.toolScope)) entry.tools = bot.toolScope;
    const listing: Rec[] = (await client.json<Rec>(`/api/bots/${enc(bot.id)}/skills`)).skills ?? [];
    if (listing.length) entry.skills = [];
    for (const skill of listing) {
      const text = clean(String((await client.json<Rec>(`/api/bots/${enc(bot.id)}/skills/${enc(skill.name)}`)).text ?? ""), `bot "${bot.name}" skill ${skill.name}`);
      const relativePath = skillFilePath(skillDirs[index]!, skill.name);
      mkdirSync(dirname(join(dir, relativePath)), { recursive: true });
      writeFileSync(join(dir, relativePath), text);
      entry.skills.push({ file: relativePath, ...(skill.enabled ? {} : { enabled: false }) });
      skills += 1;
    }
    botEntries.push(entry);
  }
  const byId = new Map((fleet.bots ?? []).map((bot: Rec) => [bot.id, bot.name]));
  const roomEntries = (fleet.groups ?? []).filter((group: Rec) => !group.dm && inScope(group.section)).map((group: Rec) => {
    const responder: Rec = group.defaultResponder ?? {};
    return {
      name: group.name, ...(group.section ? { team: group.section } : {}), members: (group.memberIds ?? []).map((id: string) => byId.get(id) ?? id),
      ...(String(group.bulletin ?? "").trim() ? { brief: clean(String(group.bulletin), `room "${group.name}" brief`) } : {}),
      ...(responder.kind === "everyone" || responder.kind === "mentions" ? { responder: responder.kind }
        : responder.kind === "member" && byId.has(responder.botId) ? { responder: byId.get(responder.botId) } : {}),
    };
  });
  const config = await client.json<Rec>("/api/config");
  const engines: Rec = {};
  for (const [kind, spec] of Object.entries(ENGINE_KINDS)) {
    if (config[spec.config]?.configured !== true) continue;
    const name = kind === "openai-compatible" ? "openaiCompatible" : kind;
    engines[name] = { key: { env: "SET_ME" }, ...(kind === "openai-compatible" && config.openaiCompat?.url ? { baseUrl: config.openaiCompat.url } : {}),
      ...(kind === "claude" && config.anthropic?.everyClaudeBot === false ? { everyClaudeBot: false } : {}) };
  }
  const document = { version: 1, ...(Object.keys(engines).length ? { engines } : {}), ...(teamEntries.length ? { teams: teamEntries } : {}),
    bots: botEntries, ...(roomEntries.length ? { rooms: roomEntries } : {}) };
  if (!botEntries.length) throw new HeadlessError("no bots to export", EXIT.failed);
  writeFileSync(resolve(out), `# Written by openmausbot team export on ${new Date().toISOString().slice(0, 10)}.\n# Engine keys are placeholders (SET_ME): set them before applying this elsewhere.\n${stringifyYaml(document, { lineWidth: 0 })}`);
  return {
    result: { ok: true, file: resolve(out), teams: teamEntries.length, bots: botEntries.length, rooms: roomEntries.length, skills, engines: Object.keys(engines), skipped, redacted },
    exitCode: EXIT.done,
    human: [`Wrote ${out}: ${teamEntries.length} teams, ${botEntries.length} bots, ${roomEntries.length} rooms, ${skills} skills.`,
      ...(Object.keys(engines).length ? ["Engine keys are placeholders (SET_ME): set them before applying it elsewhere."] : []),
      ...(redacted.length ? [`A secret was taken out of: ${redacted.join(", ")} (apply leaves those as they are).`] : []),
      ...skipped.map((line) => `not exported: ${line}`)],
  };
}
