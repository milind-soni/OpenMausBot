// Startup migration pipeline for bots.json and groups.json. Each exported
// step is one legacy cohort: it can be deleted independently when that
// cohort has aged out of the fleet. Steps mutate the loaded records in
// place and report whether anything changed, so the constructor can save
// only when a write is needed. The per-cohort passes below preserve the
// per-record check order of the original single constructor loop; only
// records are touched here — transcript reads come in through
// MigrationDeps so this module never imports the message layer.
import { existsSync } from "node:fs";

import { soulFile, soulHash, writeSoulMirror } from "../bot-folder.ts";
import { loadBrowserProfileIdAliases } from "../config.ts";
import { peerAllowKey, type PeerAction } from "../peer-approval-key.ts";
import { botAvatarProfile } from "../../shared/bot-avatar.ts";
import { isApprovalMode } from "../../shared/approval-mode.ts";
import type { GroupTask as GroupTaskRecord } from "../../shared/wire.ts";
import {
  isProjectEmoji, normalizeGroupDefaultResponder, sectionKey, UNTITLED_TASK,
  type BotRecord, type GroupRecord,
} from "./records.ts";
import { mirrorActiveTask } from "./tasks.ts";

/** Transcript-derived titling for cohorts that need a thread's first user
 * line. Injected by the constructor; everything else here is records-only. */
export interface MigrationDeps {
  firstUserLine(threadId: string): string | null;
}

// ── bot cohorts ────────────────────────────────────────────────────────

/** Step 1: transient state never survives a restart — and if a previous
 * process died mid-turn, bots.json still says busy/working; persist the
 * reset so the next load does not read it again. */
export function migrateBotTransientActivity(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (b.busy || (b.activity !== undefined && b.activity !== "idle")) changed = true;
    b.busy = false;
    b.activity = "idle";
  }
  return changed;
}

/** Step 2: souls are strings with a content hash, always. */
export function migrateBotSoulDefaults(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (typeof b.soul !== "string") {
      b.soul = "";
      changed = true;
    }
    if (b.soulHash !== soulHash(b.soul)) {
      b.soulHash = soulHash(b.soul);
      changed = true;
    }
  }
  return changed;
}

/** Step 2b: existing bots predate their folders. Create missing mirrors
 * before their first history write, but preserve any edits already on
 * disk. (The one deliberately side-effecting step: mirrors are files, not
 * record fields.) */
export function ensureSoulMirrors(bots: BotRecord[]): void {
  for (const b of bots) {
    if (!existsSync(soulFile(b.id))) {
      // Step 2 has already normalized soul to a string; the fallback is
      // unreachable in pipeline order and keeps this step self-contained.
      try { writeSoulMirror(b.id, b.soul ?? ""); } catch (e) {
        console.warn(`[bot-folder] could not create SOUL.md for ${b.id}: ${(e as Error).message}`);
      }
    }
  }
}

/** Step 3: browser profiles were once keyed by display name; aliases map
 * those to the stable ids used now. */
export function migrateBotBrowserProfileAliases(bots: BotRecord[]): boolean {
  let changed = false;
  const browserProfileAliases = loadBrowserProfileIdAliases();
  for (const b of bots) {
    if (!b.browserProfile) continue;
    const browserProfile = browserProfileAliases.get(b.browserProfile);
    if (browserProfile && browserProfile !== b.browserProfile) {
      b.browserProfile = browserProfile;
      changed = true;
    }
  }
  return changed;
}

/** Step 4: only "box" and "vps" are valid cloud backends. */
export function migrateBotCloudBackend(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
      delete b.cloudBackend;
      changed = true;
    }
  }
  return changed;
}

/** Step 5: autoStartVps must be a real boolean when present. */
export function migrateBotAutoStartVps(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
      delete b.autoStartVps;
      changed = true;
    }
  }
  return changed;
}

/** Step 6: managedSections survive only on a Chief, within sane bounds. */
export function migrateBotManagedSections(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (b.managedSections !== undefined && (!b.chiefOfStaff || !Array.isArray(b.managedSections) ||
        b.managedSections.length > 100 || b.managedSections.some(section => typeof section !== "string" || section.length > 60))) {
      delete b.managedSections;
      changed = true;
    }
  }
  return changed;
}

/** Step 7: approvalMode must be a real mode when present. */
export function migrateBotApprovalMode(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (b.approvalMode !== undefined && !isApprovalMode(b.approvalMode)) {
      delete b.approvalMode;
      changed = true;
    }
  }
  return changed;
}

/** Step 8: a trusted elevation is a prepare/confirm/activate commit. If the
 * desktop process or its private reply path died before activation, the
 * durable marker survives beside the mode in the same atomic bots.json
 * write. Revoke it before schedulers, listeners, or HTTP can start any
 * new work. */
export function migrateBotApprovalGrants(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (b.approvalGrant === undefined) continue;
    const threadOnly = b.approvalGrant.threadOnly === true;
    if (threadOnly) {
      // A crash may land between saving the target and clearing its
      // journal. Revoke that target only, never unrelated threads.
      const target = b.tasks?.find(task => task.threadId === b.approvalGrant?.threadId);
      if (target) { target.approvalMode = "ask"; target.autoApprove = false; }
    }
    if (!threadOnly) {
      b.approvalMode = "ask";
      b.autoApprove = false;
      for (const task of b.tasks ?? []) {
        if (task.approvalMode === "full" || task.approvalMode === "custom") {
          task.approvalMode = "ask";
          task.autoApprove = false;
        }
      }
    }
    delete b.approvalGrant;
    changed = true;
  }
  return changed;
}

/** Step 9: avatar fields survive only when they still match the app-owned
 * attachment they describe. */
export function migrateBotAvatarFields(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    const avatar = botAvatarProfile(b);
    if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
      delete b.avatarUrl;
      changed = true;
    }
    if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
      delete b.avatarCrop;
      changed = true;
    }
  }
  return changed;
}

/** Step 10: one visible Chief per section; duplicates are demoted and
 * their scope grants dropped. */
export function migrateChiefOfStaffDuplicates(bots: BotRecord[]): boolean {
  let changed = false;
  const chiefSectionsSeen = new Set<string>();
  for (const b of bots) {
    if (!b.chiefOfStaff) continue;
    const key = sectionKey(b.section);
    if (!chiefSectionsSeen.has(key)) {
      chiefSectionsSeen.add(key);
      if (b.hidden) {
        b.hidden = false;
        changed = true;
      }
      continue;
    }
    b.chiefOfStaff = false;
    delete b.managedSections;
    changed = true;
  }
  return changed;
}

/** Step 11: peer grants originally used mutable display names
 * (ask_bot:@Helper). Convert only when exactly one bot has that name;
 * ambiguous legacy entries remain inert rather than granting access to
 * the wrong bot. */
export function migratePeerAllowKeys(bots: BotRecord[]): boolean {
  let changedAny = false;
  for (const b of bots) {
    if (!b.alwaysAllow?.length) continue;
    let changed = false;
    const migrated = b.alwaysAllow.map((key) => {
      const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
      if (!match) return key;
      const candidates = bots.filter((candidate) => candidate.name === match[2]);
      if (candidates.length !== 1) return key;
      changed = true;
      return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
    });
    if (changed) {
      b.alwaysAllow = [...new Set(migrated)];
      changedAny = true;
    }
  }
  return changedAny;
}

/** Step 12: folders are organizational only. Preserve existing thread
 * model snapshots while discarding the unshipped folder-default setting. */
export function migrateBotProjects(bots: BotRecord[]): boolean {
  let changed = false;
  for (const b of bots) {
    if (b.projects?.some((candidate) => "modelSelection" in candidate)) {
      b.projects = b.projects.map(({ id, name, emoji }) => ({ id, name, ...(isProjectEmoji(emoji) ? { emoji } : {}) }));
      changed = true;
    }
  }
  return changed;
}

/** Step 13: bots saved before tasks existed have one endless thread; adopt
 * it as their first task so nothing is lost and nothing special-cases it. */
export function migrateBotTaskBackfill(bots: BotRecord[], deps: MigrationDeps): boolean {
  let changed = false;
  for (const b of bots) {
    if (!b.tasks?.length) {
      b.tasks = [{
        threadId: b.threadId,
        title: deps.firstUserLine(b.threadId) ?? UNTITLED_TASK,
        createdAt: b.createdAt,
        resumeCursors: b.resumeCursors ?? {},
      }];
      changed = true;
    }
    // Retain an old active transcript even if a stale tasks array omitted
    // it. Repairing the pointer by selecting another task would hide it.
    let active = b.tasks.find((task) => task.threadId === b.threadId);
    if (!active) {
      active = {
        threadId: b.threadId,
        title: deps.firstUserLine(b.threadId) ?? UNTITLED_TASK,
        createdAt: b.createdAt,
        resumeCursors: b.resumeCursors ?? {},
      };
      b.tasks.unshift(active);
      changed = true;
    }
    for (const task of b.tasks) {
      if (task.modelSelection === undefined) {
        task.modelSelection = structuredClone(b.modelSelection);
        changed = true;
      }
      if (!task.resumeCursors) {
        task.resumeCursors = task === active ? (b.resumeCursors ?? {}) : {};
        changed = true;
      }
      if (task.unread === undefined) {
        task.unread = task === active && b.unread;
        changed = true;
      }
      if (task === active) {
        if (task.rewound === undefined && b.rewound !== undefined) {
          task.rewound = b.rewound;
          changed = true;
        }
        if (task.pinnedMessageId === undefined && b.pinnedMessageId !== undefined) {
          task.pinnedMessageId = b.pinnedMessageId;
          changed = true;
        }
      }
      if (task.approvalMode !== undefined && !isApprovalMode(task.approvalMode)) {
        delete task.approvalMode;
        changed = true;
      }
      if (task.busy !== undefined || task.activity !== undefined || task.turnStartedAt !== undefined) changed = true;
      task.busy = false;
      task.activity = "idle";
      task.turnStartedAt = undefined;
    }
    mirrorActiveTask(b, active);
    b.unread = b.tasks.some((task) => task.unread);
  }
  return changed;
}

// ── group cohorts ──────────────────────────────────────────────────────

/** Step 14: busy never survives a restart — no turn does either. Rooms
 * saved before default responders existed adopt their first member as
 * lead. Bot-to-bot channels intentionally remain one canonical thread. */
export function migrateGroupSessionState(groups: GroupRecord[]): boolean {
  let changed = false;
  for (const g of groups) {
    g.busyBotId = null;
    delete g.turnStartedAt;
    const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
    if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder)) changed = true;
    g.defaultResponder = normalized;
    if (g.dm && g.tasks !== undefined) {
      delete g.tasks;
      changed = true;
    }
  }
  return changed;
}

/** Step 15: rooms saved before channel tasks existed adopt their one
 * thread as the initial task. Repair a malformed/stale active pointer
 * conservatively: every task transcript is retained; the newest known
 * task becomes active. */
export function migrateGroupTasks(groups: GroupRecord[], deps: MigrationDeps): boolean {
  let changed = false;
  for (const g of groups) {
    if (g.dm) continue;
    if (!g.tasks?.length) {
      const initialTask: GroupTaskRecord = {
        threadId: g.threadId,
        title: deps.firstUserLine(g.threadId) ?? UNTITLED_TASK,
        createdAt: g.createdAt,
      };
      if (g.pinnedCwd !== undefined) initialTask.pinnedCwd = g.pinnedCwd;
      if (g.pinnedMessageId) initialTask.pinnedMessageId = g.pinnedMessageId;
      g.tasks = [initialTask];
      changed = true;
    }
    let active = g.tasks.find((task) => task.threadId === g.threadId);
    if (!active) {
      active = g.tasks[0]!;
      g.threadId = active.threadId;
      changed = true;
    }
    g.pinnedCwd = active.pinnedCwd;
    g.pinnedMessageId = active.pinnedMessageId;
  }
  return changed;
}

// ── pipelines ──────────────────────────────────────────────────────────

/** Run every bot cohort in order. The steps are independent passes: each
 * may be removed from this list without touching the others. */
export function migrateBots(raw: BotRecord[], deps: MigrationDeps): { bots: BotRecord[]; changed: boolean } {
  let changed = migrateBotTransientActivity(raw);
  changed = migrateBotSoulDefaults(raw) || changed;
  ensureSoulMirrors(raw);
  changed = migrateBotBrowserProfileAliases(raw) || changed;
  changed = migrateBotCloudBackend(raw) || changed;
  changed = migrateBotAutoStartVps(raw) || changed;
  changed = migrateBotManagedSections(raw) || changed;
  changed = migrateBotApprovalMode(raw) || changed;
  changed = migrateBotApprovalGrants(raw) || changed;
  changed = migrateBotAvatarFields(raw) || changed;
  changed = migrateChiefOfStaffDuplicates(raw) || changed;
  changed = migratePeerAllowKeys(raw) || changed;
  changed = migrateBotProjects(raw) || changed;
  changed = migrateBotTaskBackfill(raw, deps) || changed;
  return { bots: raw, changed };
}

/** Run every group cohort in order. */
export function migrateGroups(raw: GroupRecord[], deps: MigrationDeps): { groups: GroupRecord[]; changed: boolean } {
  let changed = migrateGroupSessionState(raw);
  changed = migrateGroupTasks(raw, deps) || changed;
  return { groups: raw, changed };
}
