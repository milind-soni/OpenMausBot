// `openmausbot doctor --data [--fix] [--data-dir DIR] [--json]`: the doctor on this computer's data folder, without the
// server. It reports; with --fix it applies the safe repairs, only while no server uses the folder.
import { join, resolve } from "node:path";

import { dataHome } from "../data-dir.ts";
import { serverVersion } from "../environment.ts";
import { EXIT, flag } from "../headless/args.ts";
import type { VerbContext, VerbOutcome } from "../headless/context.ts";
import { runDoctor } from "./run.ts";
import type { DoctorReport } from "./types.ts";

const MARK: Record<string, string> = { ok: "ok", fixed: "fixed", problem: "PROBLEM", failed: "FAILED" };

export function dataDoctorOutcome(report: DoctorReport): VerbOutcome {
  const { problems, fixed } = report.counts;
  const human = [
    `Data folder: ${report.dataDir} (checked by ${report.version})`,
    ...report.checks.flatMap((result) => [
      `${MARK[result.status]!.padEnd(8)}${result.title}: ${result.summary}`,
      ...(result.fixed ? [`        done: ${result.fixed}`] : []),
      ...(result.status !== "ok" && result.status !== "fixed" && result.instruction ? [`        what to do: ${result.instruction}`] : []),
      ...(result.status === "problem" && result.fixable && !report.fix.ran ? ["        openmausbot doctor --data --fix repairs it"] : []),
    ]),
    ...(report.fix.asked && !report.fix.ran && report.fix.why ? [`No fixes ran: ${report.fix.why}`] : []),
    ...(report.backup ? [`What was changed was copied to ${report.backup} first.`] : []),
    problems ? `${problems} problem${problems === 1 ? "" : "s"} left${fixed ? `, ${fixed} fixed` : ""}.` : fixed ? `All fine now: ${fixed} fixed.` : "All fine.",
  ];
  return { result: { ok: problems === 0, ...report }, exitCode: problems ? EXIT.dataProblems : EXIT.done, human };
}

export async function dataDoctor(ctx: VerbContext): Promise<VerbOutcome> {
  const dataDir = resolve(flag(ctx.flags, "data-dir") ?? (ctx.env.OMB_DATA_DIR || join(dataHome(), ".openmausbot")));
  return dataDoctorOutcome(runDoctor({ dataDir, version: serverVersion(), mode: "command", fix: ctx.flags.fix === true }));
}
