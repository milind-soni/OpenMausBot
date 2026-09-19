// The bot profile HTTP routes (the imported Agent Skills list/detail
// with enable/disable and GitHub import, the user-owned section-context
// brief, SOUL.md read plus apply-file/discard-file drift reconciliation,
// the system-prompt preview, the bot overview, and profile history with
// its soul-only rollback), extracted verbatim from index.ts's dispatch
// chain. Path matching, methods, and status codes are unchanged; the
// handler returns false for anything it does not own so the chain falls
// through in the same order. The module's call site sits exactly where
// the family sat — immediately after bot management and immediately
// before the bot-memory module — so dispatch order is unchanged. The
// wire views, events broadcast and the staged-skill listing helper are
// index-local and cross via deps (stagedSkillListing stayed behind
// because the system payload builder also uses it); store is a live
// binding from ../runtime.ts and the skills/section-context/profile
// helpers are imported from their source modules. index.ts's
// `return json(...)` statements became `json(...); return true;`
// (json returns void).
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import { json, readBody, type RouteContext } from "./http.ts";
import type { createEventsRoutes } from "./events.ts";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import { readSoulDrift, soulFile, writeSoulMirror } from "../bot-folder.ts";
import { profileRevision, profileSnapshot } from "../profile-revision.ts";
import { flushProfileHistory, readHistory, recordProfileChange } from "../profile-versions.ts";
import { store } from "../runtime.ts";
import {
  readSectionContext,
  sectionContextKey,
  sectionContextLabel,
  writeSectionContext,
  SECTION_CONTEXT_MAX_BYTES,
} from "../section-context.ts";
import { fetchSkillFromSource } from "../skill-fetch.ts";
import {
  installSkill,
  listSkills,
  listStagedSkillWrites,
  readSkillFile,
  removeSkill,
  setSkillEnabled,
} from "../skills.ts";
import { sectionKey } from "../store.ts";
import type { createBotViews } from "../bot-views.ts";

type BotViews = ReturnType<typeof createBotViews>;

/** stagedSkillListing stayed in index.ts (the system payload builder uses
 *  it too); this mirrors its exact signature for the dep below. */
type StagedSkillListing = (staged: ReturnType<typeof listStagedSkillWrites>[number]) =>
  Omit<ReturnType<typeof listStagedSkillWrites>[number], "files" | "baseSha256" | "baseAppliedStageId">;

export function createBotProfileRoutes(deps: {
  broadcast: ReturnType<typeof createEventsRoutes>["broadcast"];
  wireBot: BotViews["wireBot"];
  previewSystemPrompt: BotViews["previewSystemPrompt"];
  botOverview: BotViews["botOverview"];
  stagedSkillListing: StagedSkillListing;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path, url } = rctx;
    /** scratch for route matches, shared by every `path.match` below */
    let m: RegExpMatchArray | null = null;
    const { broadcast, wireBot, previewSystemPrompt, botOverview, stagedSkillListing } = deps;
    // ── bot skills: imported Agent Skills (SKILL.md) ────────────────────
    // Import lands DISABLED; the UI shows SKILL.md + scan warnings and a
    // person enables after reading. See server/skills.ts for the policy.
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      json(res, 200, {
        skills: listSkills(m[1]),
        staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
      });
      return true;
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "source must be a GitHub URL or owner/repo" }); return true; }
      const fetched = await fetchSkillFromSource(parsed.data.source);
      if ("error" in fetched) { json(res, 422, { error: fetched.error }); return true; }
      const results = fetched.skills.map((skill) => installSkill(m![1]!, skill.source, skill.files));
      const installed = results.filter((entry): entry is Exclude<typeof entry, { error: string }> => !("error" in entry));
      const errors = results.flatMap((entry) => ("error" in entry ? [entry.error] : []));
      if (!installed.length) { json(res, 422, { error: errors.join("; ") || "nothing importable found" }); return true; }
      json(res, 201, { installed, errors });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)$/);
    if (m && method === "GET") {
      const text = readSkillFile(m[1]!, m[2]!);
      if (text === null) { json(res, 404, { error: "no such skill" }); return true; }
      json(res, 200, { text });
      return true;
    }
    if (m && method === "PATCH") {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "enabled must be true or false" }); return true; }
      const result = setSkillEnabled(m[1]!, m[2]!, parsed.data.enabled);
      if ("error" in result) { json(res, 404, { error: result.error }); return true; }
      json(res, 200, { skill: result });
      return true;
    }
    if (m && method === "DELETE") {
      const result = removeSkill(m[1]!, m[2]!);
      if ("error" in result) { json(res, 404, { error: result.error }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    // ── section context: a user-owned team brief ────────────────────────
    // Bots receive this in their system context, but no agent tool can write
    // it. That keeps one bot from silently changing every teammate's future
    // turns. The section query parameter is required even for General (""),
    // so a malformed client cannot accidentally read or replace that brief.
    if (path === "/api/section-context" && (method === "GET" || method === "PUT")) {
      if (!url.searchParams.has("section")) { json(res, 400, { error: "section is required" }); return true; }
      const requested = url.searchParams.get("section") ?? "";
      const section = sectionContextKey(requested);
      if (section.length > 60) { json(res, 400, { error: "section must be at most 60 characters" }); return true; }
      const exists =
        section === "" ||
        store.sections.includes(section) ||
        store.bots.some((bot) => !bot.hidden && sectionKey(bot.section) === section) ||
        store.groups.some((group) => sectionKey(group.section) === section);
      if (!exists) { json(res, 404, { error: "no such team" }); return true; }

      if (method === "GET") {
        const context = readSectionContext(section);
        json(res, 200, {
          section,
          label: sectionContextLabel(section),
          text: context?.text ?? "",
          updatedAt: context?.updatedAt ?? null,
          maxBytes: SECTION_CONTEXT_MAX_BYTES,
        });
        return true;
      }

      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) { json(res, 400, { error: "text must be a string" }); return true; }
      if (Buffer.byteLength(parsed.data.text, "utf8") > SECTION_CONTEXT_MAX_BYTES) {
        json(res, 400, { error: `section context is capped at ${SECTION_CONTEXT_MAX_BYTES / 1000}KB` });
        return true;
      }
      const context = writeSectionContext(section, parsed.data.text);
      json(res, 200, {
        ok: true,
        section,
        label: sectionContextLabel(section),
        text: context?.text ?? "",
        updatedAt: context?.updatedAt ?? null,
        maxBytes: SECTION_CONTEXT_MAX_BYTES,
      });
      return true;
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/soul$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      const soul = bot.soul ?? "";
      const drift = readSoulDrift(bot.id, soul, bot.soulHash ?? "");
      json(res, 200, {
        soul,
        revision: profileRevision(bot),
        bytes: Buffer.byteLength(soul, "utf8"),
        limit: BOT_PROFILE_LIMITS.soul,
        file: soulFile(bot.id),
        drift: drift.drift,
        ...(drift.drift ? { fileText: drift.fileText } : {}),
      });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/soul\/apply-file$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (body?.expectedRevision !== profileRevision(bot)) {
        json(res, 409, { error: "This bot's profile changed; reload and look again" });
        return true;
      }
      const drift = readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
      if (!drift.drift) { json(res, 409, { error: "SOUL.md matches the record; nothing to apply" }); return true; }
      if (typeof body?.fileText !== "string" || body.fileText !== drift.fileText) {
        json(res, 409, { error: "SOUL.md changed since you read it; reload and look again" });
        return true;
      }
      // The file is user input like any other: same cap, same error copy.
      const parsed = parseBotProfilePatch({ soul: drift.fileText });
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return true; }
      // store.bot() returns the live record and setSoul mutates it in place,
      // so the snapshot must be taken before the call — after, `bot` and
      // `updated` are the same object and the diff would always be empty.
      const beforeProfile = profileSnapshot(bot);
      const updated = store.setSoul(bot.id, parsed.patch.soul ?? "");
      if (!updated) { json(res, 404, { error: "no such bot" }); return true; }
      recordProfileChange(bot.id, "file", "ui", beforeProfile, profileSnapshot(updated));
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      json(res, 200, { bot: visible });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/soul\/discard-file$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (body?.expectedRevision !== profileRevision(bot)) {
        json(res, 409, { error: "This bot's profile changed; reload and look again" });
        return true;
      }
      const drift = readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
      if (!drift.drift || typeof body?.fileText !== "string" || body.fileText !== drift.fileText) {
        json(res, 409, { error: "SOUL.md changed since you read it; reload and look again" });
        return true;
      }
      writeSoulMirror(bot.id, bot.soul ?? "");
      const updated = store.patchBot(bot.id, { soulDrift: false }) ?? bot;
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      json(res, 200, { bot: visible });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/system-prompt$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      json(res, 200, previewSystemPrompt(bot));
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/overview$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      json(res, 200, await botOverview(bot));
      return true;
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/history$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) { json(res, 404, { error: "no such bot" }); return true; }
      // Writes queue in profile-versions.ts and land asynchronously; a client
      // reading history right after causing a change must see its own row.
      await flushProfileHistory(m[1]);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      // A soul row's full before/after can be the entire standing
      // instructions (up to 24,000 bytes) — fine for a rollback, which
      // reads the file server-side, but not for a client that only asked
      // to see what changed. Strip the bodies (keep the byte-count
      // summary) unless the caller explicitly wants them.
      const full = url.searchParams.get("full") === "1";
      const rows = readHistory(m[1], limit).map((row) => {
        if (full || row.field !== "soul") return row;
        const rest: typeof row = { ...row };
        delete rest.before;
        delete rest.after;
        return rest;
      });
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      json(res, 200, { rows, revision: profileRevision(bot) });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/history\/rollback$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      // Same flush as the GET route: the row this rollback targets may have
      // been recorded moments ago and not yet reached disk.
      await flushProfileHistory(m[1]);
      const bot = store.bot(m[1]);
      if (!bot) { json(res, 404, { error: "no such bot" }); return true; }
      if (body?.expectedRevision !== profileRevision(bot)) {
        json(res, 409, { error: "This bot's profile changed; reload history before undoing" });
        return true;
      }
      const row = typeof body?.id === "string"
        ? readHistory(bot.id, Number.MAX_SAFE_INTEGER).find((r) => r.id === body.id && r.field === "soul")
        : undefined;
      if (!row || row.field !== "soul" || typeof row.before !== "string") {
        json(res, 400, { error: "rollback is available for SOUL.md entries only" });
        return true;
      }
      if (!row.canRestore) {
        json(res, 400, { error: row.restoreUnavailableReason });
        return true;
      }
      const parsed = parseBotProfilePatch({ soul: row.before });
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return true; }
      const before = profileSnapshot(bot);
      const updated = store.setSoul(bot.id, parsed.patch.soul ?? "");
      if (!updated) { json(res, 404, { error: "no such bot" }); return true; }
      recordProfileChange(bot.id, "user", "rollback", before, profileSnapshot(updated));
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      json(res, 200, { bot: visible });
      return true;
    }
    return false;
  };
}
