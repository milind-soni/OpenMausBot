import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { api } from "@/state/store";
import {
  detectionCount, detectionSources, type SetupDetection, type SetupImportRequest, type SetupImportResult, type SetupSource,
} from "../../shared/setup-import";

export interface SetupImportClient {
  detect(signal: AbortSignal): Promise<SetupDetection>;
  apply(request: SetupImportRequest): Promise<SetupImportResult>;
}

export const setupImportApi: SetupImportClient = {
  detect: (signal) => api<SetupDetection>("/api/setup-import", { signal }),
  apply: (request) => api<SetupImportResult>("/api/setup-import", { method: "POST", body: JSON.stringify(request), timeoutMs: 120_000 }),
};

/** The desktop app's own window on its own server: never a hosted server, another server it connects to, or a browser. */
export function localSetupImport(hosted: boolean): boolean {
  const remote = globalThis.window?.ogb?.remoteClient;
  return !hosted && remote !== undefined && remote.active !== true;
}

export const DETECT_TIME_BOX_MS = 2_000;

function isDetection(value: unknown): value is SetupDetection {
  const record = value as Partial<SetupDetection> | null;
  return Boolean(record) && Array.isArray(record!.skills) && Array.isArray(record!.tools);
}

/** Settles within the time box: a slow, failed or empty look skips the step rather than holding up the welcome flow. */
export function detectSetupWithin(client: SetupImportClient, ms = DETECT_TIME_BOX_MS): { found: Promise<SetupDetection | null>; cancel(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, ms);
  });
  const look = client.detect(controller.signal).then(
    (detection) => (isDetection(detection) && detectionCount(detection) > 0 ? detection : null),
    () => null,
  );
  return {
    found: Promise.race([look, late]).finally(() => clearTimeout(timer)),
    cancel: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

const list = (parts: string[]) => new Intl.ListFormat(activeLocale(), { style: "long", type: "conjunction" }).format(parts);

export function sourceNames(sources: readonly SetupSource[]): string {
  return list(sources.map((source) => t(`onboarding.import.source.${source}` as LocaleKey)));
}

export function skillsSummary(detection: SetupDetection): string {
  return t("onboarding.import.skillsFrom", { count: detection.skills.length, sources: sourceNames(detectionSources(detection.skills)) });
}

export function toolsSummary(detection: SetupDetection): string {
  const sources = sourceNames(detectionSources(detection.tools));
  return detection.tools.length === 1
    ? t("onboarding.import.toolsFromOne", { sources })
    : t("onboarding.import.toolsFrom", { count: detection.tools.length, sources });
}

/** One line for what was added, and a note for anything left out. `done` is false when nothing came in but something
 * was left out, so the line is not shown as a success. */
export function importOutcome(result: SetupImportResult): { line: string; notes: string[]; done: boolean } {
  const skills = result.skills?.added.length ?? 0;
  const tools = result.tools?.added.length ?? 0;
  const parts = [
    ...(skills ? [skills === 1 ? t("onboarding.import.addedSkillsOne") : t("onboarding.import.addedSkills", { count: skills })] : []),
    ...(tools ? [tools === 1 ? t("onboarding.import.addedToolsOne") : t("onboarding.import.addedTools", { count: tools })] : []),
  ];
  const named = (entries: ReadonlyArray<{ name: string }>) => list(entries.map((entry) => entry.name));
  const notes: string[] = [];
  const skipped = <Reason extends string>(entries: ReadonlyArray<{ name: string; reason: Reason }> | undefined, reason: Reason, key: LocaleKey) => {
    const matching = entries?.filter((entry) => entry.reason === reason) ?? [];
    if (matching.length) notes.push(t(key, { names: named(matching) }));
  };
  if (result.skills?.review?.length) notes.push(t("onboarding.import.review", { names: named(result.skills.review.map((name) => ({ name }))) }));
  skipped(result.skills?.skipped, "conflict", "onboarding.import.conflict");
  skipped(result.tools?.skipped, "conflict", "onboarding.import.toolConflict");
  skipped([...(result.skills?.skipped ?? []), ...(result.tools?.skipped ?? [])], "failed", "onboarding.import.failed");
  if (result.skills?.filesLeftOut) notes.push(t("onboarding.import.filesLeftOut"));
  skipped(result.tools?.skipped, "limit", "onboarding.import.limit");
  skipped(result.tools?.skipped, "policy", "onboarding.import.policy");
  skipped(result.tools?.skipped, "busy", "onboarding.import.busy");
  const leftOut = Boolean(result.skills?.skipped.length || result.tools?.skipped.length);
  if (parts.length) return { line: t("onboarding.import.added", { list: list(parts) }), notes, done: true };
  return { line: leftOut ? t("onboarding.import.nothingAdded") : t("onboarding.import.nothingNew"), notes, done: !leftOut };
}
