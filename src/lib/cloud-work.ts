import { useEffect, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { CloudOperation } from "../../electron/cloud-operation.mjs";

// What the person reads while an operation of the Admin's own has their Cloud down (electron/cloud-operation.mjs): what is
// happening and when it is usually back, never "can't be reached". This computer's screen (HomeScreen) shows it whole; the
// Cloud's own page says it in its connection strip, and a send that failed meanwhile says it calmly (ChatErrorBanner).

const MINUTE = 60_000;
/** A typical wait this short reads "a minute or two"; up to SOON_MAX_MS, "a few minutes"; longer, the time it is expected. */
const SOON_MS = 3 * MINUTE, SOON_MAX_MS = 10 * MINUTE;
/** The Cloud's own page asks the window this often while its live stream is down. */
export const CLOUD_WORK_ASK_MS = 10_000;

const TITLES: Record<string, readonly [LocaleKey, LocaleKey]> = {
  update: ["cloudWork.update", "cloudWork.updateNamed"],
  resize: ["cloudWork.resize", "cloudWork.resizeNamed"],
  resizeUp: ["cloudWork.resizeUp", "cloudWork.resizeUpNamed"],
  move: ["cloudWork.move", "cloudWork.moveNamed"],
  disk: ["cloudWork.disk", "cloudWork.diskNamed"],
  restore: ["cloudWork.restore", "cloudWork.restoreNamed"],
  start: ["cloudWork.start", "cloudWork.startNamed"],
};
const OTHER = ["cloudWork.other", "cloudWork.otherNamed"] as const;

/** "Updating My Cloud to the latest version", or the team's Cloud by its `name`; a kind this app doesn't know is "restarting". */
export function cloudWorkTitle(operation: CloudOperation, name: string | null = null): string {
  const key = operation.kind === "resize" && operation.bigger ? "resizeUp" : operation.kind;
  const [plain, named] = Object.hasOwn(TITLES, key) ? TITLES[key]! : OTHER;
  return name ? t(named, { name }) : t(plain);
}

/** When it is back, as honestly as the Admin knows: its usual time while that hasn't passed; past it, a little longer than
 * usual; past the operation's own deadline (the Admin's alert has gone out), that it takes longer and we've been told. With no
 * usual time (a move, a restore), only that it comes back by itself. */
export function cloudWorkWhen(operation: CloudOperation, now = Date.now()): string {
  if (now >= operation.until) return t("cloudWork.late");
  if (operation.expectedAt === undefined) return t("cloudWork.backWhenDone");
  if (now >= operation.expectedAt) return t("cloudWork.longer");
  const usual = operation.expectedAt - operation.since;
  if (usual <= SOON_MS) return t("cloudWork.backSoon");
  if (usual <= SOON_MAX_MS) return t("cloudWork.backMinutes");
  return t("cloudWork.backAround", { time: new Intl.DateTimeFormat(activeLocale(), { timeStyle: "short" }).format(new Date(operation.expectedAt)) });
}

/** The whole of it for this computer's screen: the title, the backup's note (an update that backs everything up first), when
 * it is back, and the one line about the bots' work. */
export function cloudWorkText(operation: CloudOperation, now = Date.now(), name: string | null = null) {
  const late = now >= operation.until;
  return { title: cloudWorkTitle(operation, name), backup: operation.backup && !late ? t("cloudWork.backup") : null, when: cloudWorkWhen(operation, now), bots: t("cloudWork.bots") };
}

/** The strip's one line on the Cloud's own page: "Updating My Cloud to the latest version. Back in a minute or two." */
export const cloudWorkLine = (operation: CloudOperation, now = Date.now()) => `${cloudWorkTitle(operation)}. ${cloudWorkWhen(operation, now)}`;

let current: CloudOperation | null = null;
const listeners = new Set<(operation: CloudOperation | null) => void>();
/** What the window last said has this Cloud down, while the page's live stream is down; null otherwise. */
export const cloudWorkNow = () => current;
export function setCloudWork(next: CloudOperation | null) {
  if (next === current || (next && current && next.kind === current.kind && next.since === current.since && next.until === current.until && next.expectedAt === current.expectedAt)) return;
  current = next;
  for (const listener of listeners) listener(next);
}
export function onCloudWork(listener: (operation: CloudOperation | null) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The window's bridge on the Cloud's own page (absent in a browser, on another server, and in an app before it). */
const ask = () => {
  const operation = typeof window === "undefined" ? undefined : window.ogb?.home?.operation;
  return typeof operation === "function" ? operation : null;
};

/**
 * While `down` (the page's live stream is down), what the window says has the Cloud down, asked now and every
 * CLOUD_WORK_ASK_MS; null otherwise, and at once when the stream is back. Shared through `cloudWorkNow` with the chat's
 * error line. A page with no bridge (a browser) says what it says today.
 */
export function useCloudWork(down: boolean): CloudOperation | null {
  const [operation, setOperation] = useState<CloudOperation | null>(cloudWorkNow);
  // Keeps this page's copy in step with the window's word, which lives outside React.
  useEffect(() => onCloudWork(setOperation), []);
  useEffect(() => {
    const read = ask();
    if (!down || !read) { setCloudWork(null); return; }
    let alive = true;
    const look = () => { void read().then((next) => { if (alive) setCloudWork(next ?? null); }, () => {}); };
    look();
    const timer = setInterval(look, CLOUD_WORK_ASK_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [down]);
  return operation;
}

/** Re-renders every `everyMs` while `on`, so words that depend on the time ("taking longer than usual") change by themselves. */
export function useNow(on: boolean, everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [on, everyMs]);
  return now;
}
