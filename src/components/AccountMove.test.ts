import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSendNotice, CloudSendPageBridge } from "../../electron/cloud-send.mjs";
import type { OneHomeView } from "../../electron/one-home.mjs";
import { moveLine } from "@/lib/cloud-send";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
import { AccountMoveStatus, accountMoveWords, moveMenuItems, useAccountMove, useAccountMoveLine, type AccountMoveLine } from "./AccountMove";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const markup = (node: ReactNode) => renderToStaticMarkup(createElement("div", null, node)).replaceAll("&#x27;", "'");
const noop = () => {};
const tryAgainTag = (html: string) => html.match(/<button[^>]*data-move-retry[^>]*>/)?.[0] ?? "";
const line = (move: OneHomeView, page: "local" | "cloud" = "local") => moveLine(move, page) as AccountMoveLine;

const notice: CloudSendNotice = { ready: true, bots: ["Ember"], updatedBots: [], skills: 2, logins: 0, onePassword: true, settings: 0, signature: "sig-1", dismissed: false, running: false, last: null, whole: null };
let page: CloudSendPageBridge;
const pair = vi.fn(), open = vi.fn();
const hook = (cloudHome = false) => { f.index = 0; f.effects = []; return useAccountMove(cloudHome, { onOpen: open, onPairPhone: pair }); };
const lineHook = (cloudHome = false) => { f.index = 0; f.effects = []; return useAccountMoveLine(cloudHome); };
async function shown(value: CloudSendNotice, cloudHome = false) {
  page = { notice: vi.fn().mockResolvedValue(value), dismiss: vi.fn().mockResolvedValue({ ...value, move: undefined }), onNotice: vi.fn(() => () => {}) };
  vi.stubGlobal("window", { ogb: { cloudSendPage: page } });
  hook(cloudHome); for (const effect of f.effects) effect(); await flush();
  return hook(cloudHome);
}

beforeEach(() => { f.values = []; f.index = 0; f.effects = []; setLocale("en"); pair.mockReset(); open.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the move's words on the account", () => {
  it("needs the person once failing, goes quietly while on its way, and says nothing once done", () => {
    expect(accountMoveWords("failed")).toBe("My Cloud move needs you");
    expect(accountMoveWords("sending")).toBe("Moving to My Cloud…");
    expect(accountMoveWords("done")).toBeNull();
    expect(accountMoveWords(null)).toBeNull();
  });

  it("is a button that opens the account menu by the account, and plain words inside a trigger", () => {
    const opened = vi.fn();
    const failed = AccountMoveStatus({ kind: "failed", onOpen: opened }) as ReturnType<typeof createElement>;
    expect(markup(failed)).toContain('data-account-move="failed"');
    expect(markup(failed)).toContain("text-warning");
    expect(markup(failed)).toContain("<button");
    expect(markup(AccountMoveStatus({ kind: "sending", onOpen: opened }))).toContain("Moving to My Cloud…");
    expect(markup(AccountMoveStatus({ kind: "sending", onOpen: opened }))).not.toContain("text-warning");
    expect(markup(AccountMoveStatus({ kind: "failed" }))).not.toContain("<button");
    expect(markup(AccountMoveStatus({ kind: "failed" }))).toContain("My Cloud move needs you");
    expect(AccountMoveStatus({ kind: "done", onOpen: opened })).toBeNull();
    expect(AccountMoveStatus({ kind: null })).toBeNull();
  });

  it("ends with Try again, a button of its own named for the move, that runs the retry", () => {
    const onRetry = vi.fn();
    const status = AccountMoveStatus({ kind: "failed", onOpen: noop, retry: { onRetry, retrying: false, why: "My Cloud did not answer." } }) as ReturnType<typeof createElement>;
    const html = markup(status);
    const tag = tryAgainTag(html);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(tag).toContain('aria-label="Try again to move to My Cloud"');
    expect(tag).toContain('title="My Cloud did not answer."');
    expect(tag).not.toContain("aria-disabled");
    expect(html).toMatch(/data-move-retry[^>]*>Try again<\/button>/);
    expect(html.indexOf("My Cloud move needs you")).toBeLessThan(html.indexOf(">Try again<"));
    // The words shorten before Try again does.
    expect(html).toContain('<span class="truncate">My Cloud move needs you</span>');
    expect(tag).toMatch(/class="[^"]*\bshrink-0\b/);
    const tryAgain = (status.props as { children: ReturnType<typeof createElement>[] }).children[1]!;
    (tryAgain.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("while Try again runs: disabled and busy, with a spinner", () => {
    const html = markup(AccountMoveStatus({ kind: "failed", onOpen: noop, retry: { onRetry: noop, retrying: true, why: "My Cloud did not answer." } }));
    const tag = tryAgainTag(html);
    expect(tag).toContain('aria-busy="true"');
    expect(tag).toContain('aria-disabled="true"');
    expect(html).toMatch(/data-move-retry[^>]*>.*animate-spin.*Try again<\/button>/);
  });

  it("has no Try again on its way, inside a trigger, or when the move allows none", () => {
    const retry = { onRetry: noop, retrying: false, why: "" };
    expect(markup(AccountMoveStatus({ kind: "sending", onOpen: noop, retry }))).not.toContain("Try again");
    expect(markup(AccountMoveStatus({ kind: "failed", retry }))).not.toContain("Try again");
    expect(markup(AccountMoveStatus({ kind: "failed", onOpen: noop }))).not.toContain("Try again");
  });
});

describe("the move's row in the account menu", () => {
  const rows = (value: AccountMoveLine | null, patch: Partial<Parameters<typeof moveMenuItems>[1]> = {}) =>
    moveMenuItems(value, { onOpen: noop, onRetry: noop, onClose: noop, ...patch });

  it("failing: one row the size of the others that tries again, with why in its tooltip", () => {
    const onOpen = vi.fn(), onRetry = vi.fn();
    const items = rows(line({ phase: "copy", failing: { error: "Some of this computer's things did not reach My Cloud." } }), { onOpen, onRetry });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "cloud-move", label: "Try My Cloud move again", title: "Some of this computer's things did not reach My Cloud.", disabled: false, keepOpen: true });
    expect(items[0]).not.toHaveProperty("note");
    expect(items[0]).not.toHaveProperty("wrap");
    expect(markup(items[0]!.icon)).not.toContain("animate-spin");
    items[0]!.onSelect();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
    // Main gave no reason: the tooltip still says what happened.
    expect(rows(line({ phase: "finishing", failing: { error: null } }))[0]!.title).toBe("Your bots couldn't move to My Cloud yet.");
  });

  it("failing: the same one row, disabled with a spinner, while Try again runs, and main's words when it did not answer", () => {
    const failing = line({ phase: "wait", failing: { error: "My Cloud did not answer." } });
    const busy = rows(failing, { retrying: true });
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ label: "Try My Cloud move again", disabled: true });
    expect(markup(busy[0]!.icon)).toContain("animate-spin");
    expect(rows(failing, { unanswered: "OpenMausBot on this computer did not answer." })[0]!.title).toBe("OpenMausBot on this computer did not answer.");
    // Main gave no words: the reason it had stays.
    expect(rows(failing, { unanswered: "Your bots couldn't move to My Cloud yet." })[0]!.title).toBe("My Cloud did not answer.");
  });

  it("failing with no retry allowed: one row that opens My Cloud's settings", () => {
    const onOpen = vi.fn(), onRetry = vi.fn();
    const items = rows({ kind: "failed", text: "Your bots couldn't move to My Cloud yet.", extra: [], reason: "My Cloud is full." }, { onOpen, onRetry });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "cloud-move", label: "My Cloud move needs you", title: "My Cloud is full." });
    items[0]!.onSelect();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("on its way: one short row, the progress in its tooltip, nothing else to press", () => {
    const onOpen = vi.fn();
    const items = rows(line({ phase: "copy", chats: { done: 34, total: 120 } }), { onOpen });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "cloud-move", label: "Moving to My Cloud…", title: "Moving your bots to My Cloud… 34 of 120 chats" });
    expect(items[0]).not.toHaveProperty("wrap");
    expect(markup(items[0]!.icon)).toContain("animate-spin");
    expect(rows(line({ phase: "finishing" }))[0]).toMatchObject({ label: "Moving to My Cloud…", title: "Moving to My Cloud… almost done" });
    items[0]!.onSelect();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("done: what arrived and what was held, the phone to pair, and Got it", () => {
    const onPairPhone = vi.fn(), onClose = vi.fn();
    const done = line({ phase: "done", counts: { bots: 4, skills: 2, logins: 2, onePassword: true, chats: 148, routines: 2 }, phone: true, held: ["OPENAI_API_KEY"] }, "cloud");
    const items = rows(done, { onPairPhone, onClose });
    expect(items.map((item) => item.key)).toEqual(["cloud-move", "cloud-move-phone", "cloud-move-close"]);
    expect(items[0]!.label).toBe("Everything from this computer is here: 4 bots, 2 skills, 2 logins, 1Password, 148 chats, and 2 routines.");
    expect(items[0]!.note).toContain("OPENAI_API_KEY");
    expect(items[1]!.label).toBe("Pair your phone with My Cloud");
    expect(items[2]!.label).toBe("Got it");
    items[1]!.onSelect();
    items[2]!.onSelect();
    expect(onPairPhone).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(rows(done).map((item) => item.key)).toEqual(["cloud-move", "cloud-move-close"]);
    expect(rows(line({ phase: "home-again" })).map((item) => item.key)).toEqual(["cloud-move", "cloud-move-close"]);
  });

  it("no move, no rows", () => {
    expect(rows(null)).toEqual([]);
  });
});

describe("useAccountMove", () => {
  it("says nothing without the one-time move, whatever an older desktop's send did, nor in a browser", async () => {
    expect(await shown(notice)).toEqual({ kind: null, items: [] });
    f.values = [];
    expect(await shown({ ...notice, running: true, runningReason: "first", last: { at: 3, reason: "first", failed: 2, seen: false, sent: { bots: 2, updatedBots: 0, skills: 0, logins: 0, onePassword: false, settings: 0, chats: null },
      reasons: [{ what: { bots: [], skills: 0, logins: 2, onePassword: false, settings: 0, chats: false }, error: "OpenMausBot on this computer did not answer." }] } })).toEqual({ kind: null, items: [] });
    f.values = [];
    vi.stubGlobal("window", {});
    expect(hook()).toEqual({ kind: null, items: [] });
    expect(lineHook()).toEqual({ kind: null, retry: null });
  });

  it("on its way on either page, with nothing to press", async () => {
    const bringing = await shown({ ...notice, move: { phase: "copy", chats: { done: 34, total: 120 } } }, true);
    expect(bringing.kind).toBe("sending");
    expect(bringing.items.map((item) => [item.label, item.title])).toEqual([["Moving to My Cloud…", "Bringing this computer's bots to My Cloud… 34 of 120 chats"]]);
    f.values = [];
    const waiting = await shown({ ...notice, move: { phase: "wait", waitingFor: "Scout" } });
    expect(waiting.items.map((item) => item.title)).toEqual(["Moving your bots to My Cloud… waiting for Scout to finish"]);
    expect(lineHook().retry).toBeNull();
  });

  it("after a day of failing, Try again runs the move's own retry, with a spinner meanwhile", async () => {
    const failing = await shown({ ...notice, move: { phase: "copy", failing: { error: "My Cloud did not answer." } } });
    expect(failing.kind).toBe("failed");
    let answer!: (value: CloudSendNotice) => void;
    page.moveRetry = vi.fn(() => new Promise<CloudSendNotice>((resolve) => { answer = resolve; }));
    failing.items[0]!.onSelect();
    expect(page.moveRetry).toHaveBeenCalledTimes(1);
    expect(hook().items[0]).toMatchObject({ key: "cloud-move", disabled: true });
    answer({ ...notice, move: { phase: "finishing" } }); await flush();
    expect(hook()).toMatchObject({ kind: "sending", items: [{ label: "Moving to My Cloud…" }] });
  });

  it("says main's words in the tooltip when Try again goes unanswered", async () => {
    const failing = await shown({ ...notice, move: { phase: "copy", failing: { error: "My Cloud did not answer." } } });
    page.moveRetry = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'cloud-send:move-retry': Error: OpenMausBot on this computer did not answer."));
    failing.items[0]!.onSelect(); await flush();
    const after = hook();
    expect(after.items[0]).toMatchObject({ title: "OpenMausBot on this computer did not answer.", disabled: false });
    expect(lineHook().retry).toMatchObject({ retrying: false, why: "OpenMausBot on this computer did not answer." });
  });

  it("the line's Try again and the menu's are one: either runs it, both wait for it, and it runs once at a time", async () => {
    await shown({ ...notice, move: { phase: "copy", failing: { error: "My Cloud did not answer." } } });
    let answer!: (value: CloudSendNotice) => void;
    page.moveRetry = vi.fn(() => new Promise<CloudSendNotice>((resolve) => { answer = resolve; }));
    const before = lineHook();
    expect(before).toMatchObject({ kind: "failed", retry: { retrying: false, why: "My Cloud did not answer." } });
    before.retry!.onRetry();
    expect(lineHook().retry).toMatchObject({ retrying: true });
    expect(hook().items[0]).toMatchObject({ disabled: true });
    hook().items[0]!.onSelect();
    before.retry!.onRetry();
    expect(page.moveRetry).toHaveBeenCalledTimes(1);
    answer({ ...notice, move: { phase: "finishing" } }); await flush();
    expect(lineHook()).toEqual({ kind: "sending", retry: null });
  });

  it("My Cloud's page says once what arrived, with the phone to pair, until Got it", async () => {
    const done = await shown({ ...notice, move: { phase: "done", counts: { bots: 4, skills: 2, logins: 2, onePassword: true, chats: 148, routines: 2 }, phone: true, held: [] } }, true);
    expect(done.kind).toBe("done");
    expect(lineHook(true)).toEqual({ kind: "done", retry: null });
    done.items.find((item) => item.key === "cloud-move-phone")!.onSelect();
    expect(pair).toHaveBeenCalledOnce();
    done.items.find((item) => item.key === "cloud-move-close")!.onSelect(); await flush();
    expect(page.dismiss).toHaveBeenCalledWith("one-home");
    expect(hook(true)).toEqual({ kind: null, items: [] });
    // This computer's own page never says what arrived on My Cloud.
    f.values = [];
    expect((await shown({ ...notice, move: { phase: "done", phone: false, held: [] } })).kind).toBeNull();
  });

  it("the move's row opens My Cloud's settings when it does not retry", async () => {
    (await shown({ ...notice, move: { phase: "copy", chats: { done: 1, total: 2 } } })).items[0]!.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });
});
