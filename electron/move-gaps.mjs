// What a move's check (cloud-send.mjs `check`, cloud-send-check.mjs) still found missing on My Cloud, three ways:
// `gapKey`, the same answer however often it is asked while nothing changes, so one-home.mjs can tell a gap that sending
// again carries from one it never will; `gapSummary`, kinds and counts only, for the Admin's move report
// (move-status.mjs); and `stayedBehind`, what the person reads on the done line for what stayed on this computer.
import { createHash } from "node:crypto";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === "string" ? value : "");

/** The chats the check found short on My Cloud: rows it lacks, the owner's lines not yet theirs, or a path that breaks. */
const shortChats = (report) => list(report?.chats).filter((entry) => record(entry) && (entry.missing || entry.unstamped || entry.path === "broken"));
const secretsOf = (report) => [...list(report?.secrets?.differs), ...list(report?.secrets?.missing)];

/** Each gap by its ids only, sorted, so two checks that found the same things missing give the same key. */
export function gapKey(report) {
  const gaps = record(report?.gaps) ? report.gaps : {};
  const ids = (kind, entry) => {
    if (!record(entry)) return text(entry);
    if (kind === "items") return text(entry.key);
    if (kind === "parts") return `${text(entry.key)}:${list(entry.parts).join(",")}`;
    if (kind === "memory") return `${text(entry.bot)}/${text(entry.path)}`;
    if (kind === "rooms") return text(entry.id);
    return JSON.stringify(entry);
  };
  const shape = {
    gaps: Object.fromEntries(Object.keys(gaps).sort().map((kind) => [kind, list(gaps[kind]).map((entry) => ids(kind, entry)).sort()]).filter(([, entries]) => entries.length)),
    chats: shortChats(report).map((entry) => `${entry.threadId}:${entry.missing ?? 0}:${entry.unstamped ?? 0}:${entry.path}`).sort(),
    attachments: list(report?.attachments).map(text).sort(),
    secrets: { differs: list(report?.secrets?.differs).map(text).sort(), missing: list(report?.secrets?.missing).map(text).sort() },
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 24);
}

/** "2 chats (1 broken path, 3 rows), 4 attachments, 1 memory": what is missing by kind and count, never a name or an id. */
export function gapSummary(report) {
  const gaps = record(report?.gaps) ? report.gaps : {};
  const parts = Object.entries(gaps).flatMap(([kind, entries]) => (list(entries).length ? [`${list(entries).length} ${kind}`] : []));
  const chats = shortChats(report);
  if (chats.length) {
    const rows = chats.reduce((sum, entry) => sum + (Number.isSafeInteger(entry.missing) ? entry.missing : 0), 0);
    const unstamped = chats.reduce((sum, entry) => sum + (Number.isSafeInteger(entry.unstamped) ? entry.unstamped : 0), 0);
    const broken = chats.filter((entry) => entry.path === "broken").length;
    const detail = [...(rows ? [`${rows} rows`] : []), ...(unstamped ? [`${unstamped} unstamped`] : []), ...(broken ? [`${broken} broken paths`] : [])];
    parts.push(`${chats.length} chats (${detail.join(", ")})`);
  }
  if (list(report?.attachments).length) parts.push(`${report.attachments.length} attachments`);
  if (list(report?.secrets?.differs).length) parts.push(`${report.secrets.differs.length} credentials differ`);
  if (list(report?.secrets?.missing).length) parts.push(`${report.secrets.missing.length} credentials missing`);
  return parts.join(", ") || "something";
}

/** At most this many lines say what stayed behind; the rest are counted in the last. */
export const STAYED_MAX = 8;

/**
 * What stayed on this computer, in the person's words, one line per thing they know: a bot's name for its memory, chats
 * and files, a room's name, an app or a key. `report.names`: bot ids and `room:<id>` to their names; `report.owners`: each
 * short chat's bot id or `room:<id>`. Never a path, a secret or anything written in a chat.
 */
export function stayedBehind(report) {
  const gaps = record(report?.gaps) ? report.gaps : {};
  const names = record(report?.names) ? report.names : {};
  const owners = record(report?.owners) ? report.owners : {};
  const nameOf = (id) => (typeof names[id] === "string" && names[id].trim() ? names[id].trim() : null);
  const out = [];
  const add = (label, error) => { if (label && !out.some((entry) => entry.label === label && entry.error === error)) out.push({ label, error }); };
  const plural = (count, one, many) => (count === 1 ? one : many.replace("{n}", String(count)));
  const byBot = (entries, botOf) => {
    const counts = new Map();
    for (const entry of entries) { const bot = botOf(entry); counts.set(bot, (counts.get(bot) ?? 0) + 1); }
    return counts;
  };

  for (const item of list(gaps.items)) add(text(item?.label) || "Something", "It didn't reach My Cloud.");
  for (const item of list(gaps.parts)) add(text(item?.label) || "Something", "Some of its settings didn't reach My Cloud.");
  for (const room of list(gaps.rooms)) add(text(room?.name) || "A room", "This room didn't reach My Cloud.");
  for (const [bot, count] of byBot(list(gaps.memory), (entry) => entry?.bot)) add(nameOf(bot) ?? "A bot", plural(count, "One of its memory notes didn't reach My Cloud.", "{n} of its memory notes didn't reach My Cloud."));
  for (const bot of new Set(list(gaps.journal))) add(nameOf(bot) ?? "A bot", "Some of its memory history didn't reach My Cloud.");
  const files = byBot(list(gaps.files), (path) => /^(?:workspaces|task-workspaces)\/([\w-]{1,128})\//u.exec(text(path))?.[1]);
  for (const [bot, count] of files) add(nameOf(bot) ?? "A bot", plural(count, "One of its files didn't reach My Cloud.", "{n} of its files didn't reach My Cloud."));
  const chats = byBot([...list(gaps.conversations), ...list(gaps.settings), ...shortChats(report).map((entry) => entry.threadId)], (threadId) => owners[threadId]);
  for (const [owner, count] of chats) add(nameOf(owner) ?? "Chats", plural(count, "Part of one chat didn't reach My Cloud.", "Parts of {n} chats didn't reach My Cloud."));
  if (list(gaps.runs).length) add("Routine history", plural(gaps.runs.length, "One past run didn't reach My Cloud.", "{n} past runs didn't reach My Cloud."));
  if (list(gaps.learned).length) add("What your bots learned about you", "Some of it didn't reach My Cloud.");
  if (list(gaps.teams).length) add("Team notes", "Some of them didn't reach My Cloud.");
  for (const id of list(gaps.connections)) add(text(id).replace(/^(?:mcp|key):/u, "") || "An app", "It didn't reach My Cloud. Add it there again if a bot needs it.");
  const attachments = list(report?.attachments).length;
  if (attachments) add(plural(attachments, "An attachment", "{n} attachments"), plural(attachments, "It didn't reach My Cloud.", "They didn't reach My Cloud."));
  const secrets = secretsOf(report).length;
  if (secrets) add(plural(secrets, "A sign-in or key", "{n} sign-ins and keys"), plural(secrets, "It didn't reach My Cloud. Add it there again if a bot needs it.", "They didn't reach My Cloud. Add them there again if a bot needs them."));
  if (out.length <= STAYED_MAX) return out;
  return [...out.slice(0, STAYED_MAX - 1), { label: `${out.length - STAYED_MAX + 1} more`, error: "They didn't reach My Cloud." }];
}
