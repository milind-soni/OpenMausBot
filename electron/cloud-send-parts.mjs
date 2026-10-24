// Send to My Cloud: what each server reports it has (GET /api/cloud-send), and what this computer sends. One direction,
// this computer to the person's own Cloud. Shared by the server (which hashes its own records) and main (which plans).

/** A bot, compared and sent part by part: each part is the fields PATCH /api/bots/:id takes for it. */
export const BOT_PARTS = Object.freeze({
  name: ["name"],
  title: ["title"],
  description: ["description"],
  soul: ["soul"],
  look: ["color", "mascotExpression", "mascotBody", "mascotProfile", "avatarCrop", "avatarZoom", "avatarFocusX", "avatarFocusY"],
  model: ["modelSelection"],
  access: ["approvalMode", "alwaysAllow"],
  voice: ["speakReplies", "replyStyle", "voice", "voiceNotes"],
  tools: ["browser", "composio", "connectorTools", "connectorScopes", "outbound", "xResearch", "mcpServers", "toolScope"],
  memory: ["memoryEnabled", "memoryUpkeep"],
  team: ["section", "approvePeerComms", "peers"],
  habits: ["notifications", "parkDirectMessages", "helperModel", "cacheKeepWarm", "recordBrowserSteps"],
});
/** A bot's parts only a move compares and carries: My Cloud sets them over its own move route, under the same ids. */
export const MOVE_BOT_PARTS = Object.freeze({
  archived: ["hidden"],
  pinned: ["pinned"],
  chief: ["chiefOfStaff", "managedSections"],
  helper: ["defaultBot", "sidebarHidden", "welcomed"],
  fallback: ["fallback"],
  projects: ["projects"],
  playbooks: ["playbooks"],
  package: ["installedPackage"],
  library: ["assignedSkills"],
});
/** Each server stores a picture under its own name, so the picture is compared by its bytes. */
export const PICTURE_PART = "picture";
export const SETTINGS = Object.freeze(["profile", "language"]);
/** What only a move carries, each by its own id: automations go last, after the chats, and arrive switched off. */
export const AUTOMATION_KINDS = Object.freeze(["routine", "call", "webhook", "app-event"]);
export const MOVE_KINDS = Object.freeze([...AUTOMATION_KINDS, "imported-skill", "library-skill"]);
export const KINDS = Object.freeze(["bot", "skill", "login", "1password", "setting", ...MOVE_KINDS]);
/** A part a server has no value for. */
export const EMPTY = "-";
/** What either page closes the one-time move's own line by (cloud-send:dismiss). */
export const MOVE_LINE = "one-home";
/** What My Cloud's page closes the line of a bot moving into a team by. */
export const TEAM_MOVE_LINE = "team-move";
/** Logins and 1Password are compared by when they changed, never by their secrets: two sides that both have one were
 * set up on their own, and from then on a change here goes. */
const CONTENT_COMPARED = new Set(["bot", "skill", "setting", ...MOVE_KINDS]);

export const itemKey = Object.freeze({
  bot: (id) => `bot:${id}`,
  skill: (botId, name) => `skill:${botId}:${name}`,
  /** A login kept to one exact host is its own account there, so the host is part of its key. */
  login: (site, username, exactHost) => `login:${site}|${String(username).toLowerCase()}${exactHost ? `|${exactHost}` : ""}`,
  onePassword: () => "1password",
  setting: (name) => `setting:${name}`,
  /** A move's kinds: `routine`, `call`, `webhook`, `app-event` by id, `imported-skill` and `library-skill` by name. */
  moved: (kind, id) => `${kind}:${id}`,
});

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const KEY = /^(?:bot:[\w-]{1,128}|skill:[\w-]{1,128}:[a-z0-9-]{1,64}|login:[^|\s]{1,253}\|[^\n]{0,512}|1password|setting:[a-z]{1,40}|(?:routine|call|webhook|app-event):[\w-]{1,128}|(?:imported|library)-skill:[a-z0-9-]{1,64})$/u;
const PART = /^[a-z]{1,20}$/u;
const HASH = /^[\w:.-]{1,80}$/u;

/** A server's answer, kept only in the shape main and the page rely on; anything else is dropped, never guessed. */
export function parseSendSummary(value) {
  if (!record(value) || value.v !== 1 || !Array.isArray(value.items)) return null;
  const items = [];
  for (const item of value.items.slice(0, 20_000)) {
    if (!record(item) || typeof item.key !== "string" || !KEY.test(item.key) || !KINDS.includes(item.kind) || !record(item.parts)) continue;
    const parts = Object.fromEntries(Object.entries(item.parts).filter(([part, hash]) => PART.test(part) && typeof hash === "string" && HASH.test(hash)));
    items.push({
      key: item.key, kind: item.kind, label: typeof item.label === "string" ? item.label.slice(0, 200) : "",
      ...(typeof item.detail === "string" && item.detail ? { detail: item.detail.slice(0, 200) } : {}),
      ...(typeof item.id === "string" && item.id.length <= 300 ? { id: item.id } : {}),
      ...(typeof item.bot === "string" && /^[\w-]{1,128}$/u.test(item.bot) ? { bot: item.bot } : {}),
      parts,
    });
  }
  return { v: 1, appVersion: typeof value.appVersion === "string" ? value.appVersion.slice(0, 40) : null, items, ...(value.chats === 1 ? { chats: true } : {}) };
}

/**
 * The one rule, three-way per part. `sent[key][part]` is [this computer's hash, My Cloud's hash] right after the last
 * send, or when both were last seen equal. A part goes when it changed here since and is unchanged there, or when My
 * Cloud has nothing for it ("-"). Any other difference is My Cloud's to keep ("differs") unless the person chooses
 * this computer's (`force`). An item sent before and gone from My Cloud was removed there: it is never brought back,
 * and its switch turns off. `off[key]`: the "Also on My Cloud" switch, off ("you") or off after a removal ("removed").
 *
 * @returns {{ rows: Array<{ key: string, kind: string, label: string, detail?: string, id?: string, bot?: string,
 *   state: "only-here" | "on-both" | "to-update" | "differs" | "removed" | "off", parts?: string[], differs?: string[] }>,
 *   cloudOnly: Array<{ key: string, kind: string, label: string, detail?: string, bot?: string }>,
 *   baseline: Record<string, Record<string, [string, string]>>, removed: string[] }}
 */
export function planSend({ local, cloud, sent = {}, off = {}, force = [] }) {
  const forced = new Set(force);
  const there = new Map((cloud?.items ?? []).map((item) => [item.key, item]));
  const here = new Set();
  const rows = [], baseline = {}, removed = [];
  const botRow = new Map();
  const ordered = [...(local?.items ?? [])].sort((a, b) => (a.kind === "bot" ? 0 : 1) - (b.kind === "bot" ? 0 : 1));
  for (const item of ordered) {
    here.add(item.key);
    const base = { key: item.key, kind: item.kind, label: item.label, ...(item.detail ? { detail: item.detail } : {}), ...(item.id ? { id: item.id } : {}),
      ...(item.bot ? { bot: item.bot } : {}) };
    const parent = item.bot ? botRow.get(itemKey.bot(item.bot)) : null;
    const settled = (row) => { rows.push(row); if (item.kind === "bot") botRow.set(item.key, row); };
    if (off[item.key] || (parent && (parent.state === "off" || parent.state === "removed"))) {
      settled({ ...base, state: off[item.key] === "removed" || parent?.state === "removed" ? "removed" : "off" });
      continue;
    }
    const theirs = there.get(item.key), last = record(sent[item.key]) ? sent[item.key] : null;
    if (!theirs) {
      if (last && !(parent && parent.state === "only-here")) {
        removed.push(item.key);
        settled({ ...base, state: "removed" });
      } else settled({ ...base, state: "only-here" });
      continue;
    }
    const parts = [], differs = [];
    for (const [part, mine] of Object.entries(item.parts)) {
      const cloudHash = theirs.parts[part] ?? EMPTY;
      const pair = Array.isArray(last?.[part]) ? last[part] : null;
      if (mine === cloudHash || (!pair && !CONTENT_COMPARED.has(item.kind) && cloudHash !== EMPTY)) {
        if (!pair || pair[0] !== mine || pair[1] !== cloudHash) (baseline[item.key] ??= {})[part] = [mine, cloudHash];
      } else if (pair && mine === pair[0]) continue;
      else if ((pair && cloudHash === pair[1]) || (cloudHash === EMPTY && mine !== EMPTY) || forced.has(item.key)) parts.push(part);
      else differs.push(part);
    }
    settled({ ...base, state: parts.length ? "to-update" : differs.length ? "differs" : "on-both",
      ...(parts.length ? { parts } : {}), ...(differs.length ? { differs } : {}) });
  }
  const cloudOnly = (cloud?.items ?? []).filter((item) => !here.has(item.key))
    .map((item) => ({ key: item.key, kind: item.kind, label: item.label, ...(item.detail ? { detail: item.detail } : {}), ...(item.bot ? { bot: item.bot } : {}) }));
  return { rows, cloudOnly, baseline, removed };
}

/** What waits to go: rows a send would carry. A skill of a bot that goes whole goes with it. */
export function pendingRows(plan) {
  const adding = new Set(plan.rows.filter((row) => row.kind === "bot" && row.state === "only-here").map((row) => row.key));
  return plan.rows.filter((row) => (row.state === "only-here" || row.state === "to-update") && !(row.bot && adding.has(itemKey.bot(row.bot))));
}

/** A stable name for one set of differences: the strip on My Cloud hides until it changes. */
export function differenceSignature(plan) {
  return pendingRows(plan).map((row) => `${row.key}#${row.state}#${(row.parts ?? []).join(",")}`).sort().join("\n");
}

const FAILURE_REASONS = 3;

/** What a send did not get across, grouped by reason (bots by name, logins only counted, never a site), and why a send
 * stopped as a whole; the strip on My Cloud and Settings → MausBot Cloud both say it. */
export function failedSummary(outcome) {
  const reasons = new Map();
  for (const entry of outcome.result.failed) {
    const reason = reasons.get(entry.error) ?? { what: { bots: [], skills: 0, logins: 0, onePassword: false, settings: 0, connections: 0, chats: false }, error: entry.error };
    const what = reason.what;
    if (entry.kind === "bot") what.bots.push(entry.label);
    else if (entry.kind === "connection") what.connections++;
    else if (entry.kind === "skill") what.skills++;
    else if (entry.kind === "login") what.logins++;
    else if (entry.kind === "setting") what.settings++;
    else if (entry.kind === "1password") what.onePassword = true;
    else if (entry.kind === "chats") what.chats = true;
    reasons.set(entry.error, reason);
  }
  return { ...(reasons.size ? { reasons: [...reasons.values()].slice(0, FAILURE_REASONS) } : {}), ...(outcome.error ? { error: outcome.error } : {}) };
}

/** Close on My Cloud's strip: kept with the send whose result it closed. */
export const resultKey = (last) => `result:${last.at}`;
