import { useEffect, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { createOperationOutages, OPERATION_ASK_MS, type CloudOperation } from "../../electron/cloud-operation.mjs";

// What the person reads while an operation of the Admin's own has their Cloud down (electron/cloud-operation.mjs): what is
// happening and when it is usually back, never "can't be reached". This computer's screen (HomeScreen) shows it whole; the
// Cloud's own page says it in its connection strip, and a send that failed meanwhile says it calmly (ChatErrorBanner).

const MINUTE = 60_000;
/** A typical wait this short reads "a minute or two"; up to SOON_MAX_MS, "a few minutes"; longer, the time it is expected. */
const SOON_MS = 3 * MINUTE, SOON_MAX_MS = 10 * MINUTE;
/** What the window says has this Cloud down, and the name of a team's or other Cloud (absent for My Cloud). */
export type CloudWork = CloudOperation & { name?: string };

const TITLES: Record<string, readonly [LocaleKey, LocaleKey]> = {
  update: ["cloudWork.update", "cloudWork.updateNamed"],
  rollback: ["cloudWork.rollback", "cloudWork.rollbackNamed"],
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

/** The strip's one line on the Cloud's own page: "Updating My Cloud to the latest version. Back in a minute or two.", with a
 * team's or other Cloud's own name. */
export const cloudWorkLine = (operation: CloudWork, now = Date.now()) => `${cloudWorkTitle(operation, operation.name ?? null)}. ${cloudWorkWhen(operation, now)}`;

const PAGE = "page";
/** This page's outage: from the first time it shows what has its Cloud down until its live stream is back. Past its hard end
 * (electron/cloud-operation.mjs `operationEndsAt`) it says nothing more, whatever the window says, and the strip is the plain
 * "reconnecting" again. */
const outages = createOperationOutages(() => Date.now());
let current: CloudWork | null = null;
let unanswered = false;
const listeners = new Set<(operation: CloudWork | null) => void>();
const unansweredListeners = new Set<() => void>();
/** What the window last said has this Cloud down, while the page's live stream is down and its outage's hard end hasn't
 * passed; null otherwise. */
export const cloudWorkNow = (): CloudWork | null => (current && outages.shown(PAGE, current) ? current : null);
/** When this page's outage ends by itself (epoch ms), or null while none is shown. */
export const cloudWorkEndsAt = () => (current ? outages.endsAt(PAGE) : null);
export function setCloudWork(next: CloudWork | null) {
  if (next) outages.shown(PAGE, next);
  if (next === current || (next && current && next.kind === current.kind && next.since === current.since && next.until === current.until && next.expectedAt === current.expectedAt && next.name === current.name)) return;
  current = next;
  for (const listener of listeners) listener(cloudWorkNow());
}
/** The live stream is back: the Cloud answers, so its next operation is a new outage. */
export function endCloudWork() {
  outages.clear(PAGE);
  setCloudWork(null);
}
export function onCloudWork(listener: (operation: CloudWork | null) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Something this page sent got no answer from its Cloud (a send that failed to reach it): while its live stream is down, the
 * page asks what has it down at once instead of after the strip's own wait. */
export function noteCloudUnanswered() {
  if (unanswered) return;
  unanswered = true;
  for (const listener of unansweredListeners) listener();
}

/** The window's bridge on the Cloud's own page (absent in a browser, on another server, and in an app before it). */
const ask = () => {
  const operation = typeof window === "undefined" ? undefined : window.ogb?.home?.operation;
  return typeof operation === "function" ? operation : null;
};

/** How long the page waits before its `n`th ask after the first (n from 0): OPERATION_ASK_MS, 60 s from then on. */
export const cloudWorkAskDelay = (n: number) => OPERATION_ASK_MS[Math.min(n, OPERATION_ASK_MS.length - 1)]!;

/**
 * While `down` (the page's live stream is down), what the window says has the Cloud down; null otherwise, at once when the stream
 * is back, and past this outage's hard end. It asks only once the stream has been down long enough to say so (`late`: the strip's
 * own 4 s) or once a send got no answer (`noteCloudUnanswered`), so a page load or a short dropout asks nothing; then again after
 * 10, 20, 40 and every 60 s. Shared through `cloudWorkNow` with the chat's error line. A page with no bridge (a browser) says
 * what it says today.
 */
export function useCloudWork(down: boolean, late: boolean): CloudWork | null {
  const [operation, setOperation] = useState<CloudWork | null>(cloudWorkNow);
  const [early, setEarly] = useState(unanswered);
  // Keeps this page's copy in step with the window's word and a send that got no answer, which live outside React.
  useEffect(() => onCloudWork(setOperation), []);
  useEffect(() => {
    const heard = () => setEarly(true);
    unansweredListeners.add(heard);
    return () => { unansweredListeners.delete(heard); };
  }, []);
  // A send that got no answer counts for this drop only; the stream back ends the outage.
  useEffect(() => {
    unanswered = false;
    setEarly(false);
    if (!down) endCloudWork();
  }, [down]);
  const asking = down && (late || early) && Boolean(ask());
  useEffect(() => {
    const read = ask();
    if (!asking || !read) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | null = null, asked = 0;
    const look = () => {
      void read().then((next) => { if (alive) setCloudWork((next as CloudWork | null) ?? null); }, () => {});
      timer = setTimeout(look, cloudWorkAskDelay(asked++));
    };
    look();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [asking]);
  // The hard end: the words go by themselves when it passes, with nothing more asked of the window.
  const [, setEnded] = useState(0);
  const endsAt = operation ? cloudWorkEndsAt() : null;
  useEffect(() => {
    if (endsAt === null) return;
    const timer = setTimeout(() => setEnded((n) => n + 1), Math.max(0, endsAt - Date.now()));
    return () => clearTimeout(timer);
  }, [endsAt]);
  return operation && cloudWorkNow() ? operation : null;
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
