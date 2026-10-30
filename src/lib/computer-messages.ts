import { t } from "./i18n";
import type { LocaleKey } from "@/locales";

/**
 * Computer status responses come from the server so they can also be useful
 * in logs and API clients. Translate the known user-facing status messages at
 * the UI boundary, including statuses that only occur in failure branches.
 */
export function localizeComputerProblem(problem: string | null | undefined): string | null {
  if (!problem) return problem ?? null;
  const exact: Record<string, Parameters<typeof t>[0]> = {
    "Create the Local VM": "computer.problem.createVm",
    "The Local VM is stopped; start it to continue": "computer.problem.vmStopped",
    "The Local VM started, but Cua Driver is not ready yet": "computer.problem.cuaNotReady",
    "The existing Local VM uses an older desktop or Cua Driver; recreate it": "computer.problem.oldImage",
    "The existing container was not created by OpenMausBot; recreate it": "computer.problem.unmanaged",
    "The existing Local VM exposes its viewer publicly; recreate it": "computer.problem.publicViewer",
    "The existing Local VM is missing safety limits; recreate it": "computer.problem.missingLimits",
    "The existing Local VM is missing its durable folder; recreate it": "computer.problem.missingDurableFolder",
    "Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port": "computer.problem.perBotRuntime",
  };
  const key = exact[problem];
  if (key) return t(key);
  const desktopFailure = /^The Local VM desktop failed to start: (.+)$/.exec(problem);
  if (desktopFailure) return t("computer.problem.desktopFailed", { detail: desktopFailure[1]! });
  return problem;
}

/** A Computer panel error worded by locale key, so it is translated when shown rather than when thrown. */
export class LocalizedPanelError extends Error {
  constructor(
    readonly key: LocaleKey,
    readonly problem?: string | null,
    readonly fallbackKey?: LocaleKey,
  ) {
    super(key);
  }
}

export function panelErrorText(error: Error | string | null): string | null {
  if (error instanceof LocalizedPanelError) {
    return t(error.key, error.fallbackKey ? { problem: localizeComputerProblem(error.problem) ?? t(error.fallbackKey) } : undefined);
  }
  return localizeComputerProblem(error instanceof Error ? error.message : error);
}
