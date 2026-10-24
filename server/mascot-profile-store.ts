import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  addOrSelectCustomMascot,
  createMascotProfile,
  legacyMascotBody,
  mascotProfileSchema,
  selectBuiltinMascot,
  type CustomMascotShape,
  type MascotProfile,
} from "../shared/mascot-profile.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { BotRecord } from "./store.ts";

export type BotMascotState = Pick<BotRecord, "mascotBody" | "mascotProfile">;
type BotCustomMascotState = BotMascotState & { avatarUrl: undefined; avatarCrop: "mascot" };
export type { CustomMascotShape };
type BotMascotInput = Partial<BotMascotState>;

function isEmptyCursorProfile(profile: MascotProfile): boolean {
  return profile.shapes.length === 0 && profile.selected.kind === "builtin" && profile.selected.bodyId === "cursor";
}

function ensureRecoveryMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  if ((lstatSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
  if ((lstatSync(path).mode & 0o777) !== mode) throw new Error("Mascot profile recovery permissions could not be secured.");
}

/** Normalize the canonical profile while keeping absence distinct from an explicit legacy cursor selection. */
export function normalizeStoredBotMascotState(bot: BotMascotState, onInvalidProfile: () => void): boolean {
  let changed = false;
  const parsed = mascotProfileSchema.safeParse(bot.mascotProfile);
  if (parsed.success) {
    bot.mascotProfile = parsed.data;
  } else {
    if (bot.mascotProfile !== undefined) onInvalidProfile();
    bot.mascotProfile = createMascotProfile(bot.mascotBody);
    changed = true;
  }

  if (isEmptyCursorProfile(bot.mascotProfile) && bot.mascotBody === undefined) return changed;

  const legacyBody = legacyMascotBody(bot.mascotProfile);
  if (bot.mascotBody !== legacyBody) changed = true;
  bot.mascotBody = legacyBody;
  return changed;
}

export function preserveInvalidMascotProfileRegistry(file: string, botId: string): void {
  const registry = readFileSync(file);
  const recoveryDirectory = join(dirname(file), "mascot-profile-recovery");
  mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(recoveryDirectory);
  if (!directoryStat.isDirectory()) throw new Error("Mascot profile recovery path is not a directory.");
  ensureRecoveryMode(recoveryDirectory, 0o700);

  const digest = createHash("sha256").update(registry).digest("hex");
  const recoveryFile = join(recoveryDirectory, `bots-mascot-profile-${digest}.json`);
  let existingStat: ReturnType<typeof lstatSync> | undefined;
  try {
    existingStat = lstatSync(recoveryFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existingStat) {
    if (!existingStat.isFile() || !readFileSync(recoveryFile).equals(registry)) {
      throw new Error("Mascot profile recovery file does not match the source registry.");
    }
    ensureRecoveryMode(recoveryFile, 0o600);
  } else {
    writeFileAtomic(recoveryFile, registry, { mode: 0o600 });
    const writtenStat = lstatSync(recoveryFile);
    if (!writtenStat.isFile() || !readFileSync(recoveryFile).equals(registry)) {
      throw new Error("Mascot profile recovery file does not match the source registry.");
    }
    ensureRecoveryMode(recoveryFile, 0o600);
  }

  console.warn(`[mascot-profile] invalid profile for bot ${botId}; preserved registry at ${recoveryFile}`);
}

export function mascotStateForCreation(input: BotMascotInput): BotMascotState {
  const mascotProfile = input.mascotProfile === undefined
    ? createMascotProfile(input.mascotBody)
    : mascotProfileSchema.parse(input.mascotProfile);
  return {
    mascotProfile,
    ...(input.mascotProfile !== undefined || input.mascotBody !== undefined
      ? { mascotBody: legacyMascotBody(mascotProfile) }
      : {}),
  };
}

export function mascotStateForProfile(profile: MascotProfile): BotMascotState {
  const mascotProfile = mascotProfileSchema.parse(profile);
  return { mascotProfile, mascotBody: legacyMascotBody(mascotProfile) };
}

export function mascotStateForBody(profile: MascotProfile | undefined, bodyId: string | null): BotMascotState {
  const mascotProfile = selectBuiltinMascot(profile, bodyId ?? "cursor");
  return { mascotProfile, mascotBody: legacyMascotBody(mascotProfile) };
}

export function mascotStateWithCustomShape(profile: MascotProfile | undefined, shape: CustomMascotShape): BotCustomMascotState {
  const mascotProfile = addOrSelectCustomMascot(profile, structuredClone(shape));
  return { mascotProfile, mascotBody: legacyMascotBody(mascotProfile), avatarUrl: undefined, avatarCrop: "mascot" };
}
