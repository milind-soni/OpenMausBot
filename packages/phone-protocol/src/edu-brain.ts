import { z } from "zod";

/** Where a bot's Edu brain lives. `own` (the default when absent): a brain of its own in the app's data folder, created on
 * first use. `folder`: the `.edu` brain already in `path`, which several bots may share. `off`: no Edu brain. */
export type EduBrainSetting = { mode: "off" } | { mode: "own" } | { mode: "folder"; path: string };

export interface EduBrainField {
  /** This bot's Edu brain. Absent: its own. */
  eduBrain?: EduBrainSetting;
}

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** An `EduBrainSetting` as a file carries it; `folder` needs an absolute path. */
export const eduBrainSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("own") }),
  z.object({ mode: z.literal("folder"), path: z.string().trim().max(4096).refine((path) => ABSOLUTE_PATH.test(path) && !path.includes("\0"), "must be an absolute folder path") }),
]);
