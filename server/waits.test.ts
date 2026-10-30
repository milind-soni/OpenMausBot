import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileStamp, PageResult, ProcessEntry } from "./wait-probes.ts";
import { CLOUD_IDLE_AWAKE_MS, createCloudPower } from "./cloud-power.ts";
import { describeCondition, WAIT_WAKE_MS, WaitManager, waitList, type NewWaitCondition, type WaitManagerOptions, type WaitNotice, type WaitRecord } from "./waits.ts";

const T0 = 1_800_000_000_000;
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: Partial<WaitManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-waits-"));
  dirs.push(dir);
  const file = join(dir, "waits.json");
  let clock = T0;
  const h = {
    file,
    stamp: null as FileStamp | null,
    page: { ok: true, text: "" } as PageResult,
    processes: [] as ProcessEntry[],
    stampCalls: 0,
    pageCalls: 0,
    processCalls: 0,
    pageInFlight: 0,
    pageMaxInFlight: 0,
    pageDelayMs: 0,
    pageGate: null as Promise<void> | null,
    busy: new Map<string, boolean>(),
    alive: true,
    postOk: true,
    posts: [] as WaitNotice[],
    now: () => clock,
    advance(ms: number) { clock += ms; },
    advanceTo(ms: number) { clock = ms; },
    post: vi.fn(),
    followUp: vi.fn(),
    showCard: vi.fn(() => "card-1" as string | undefined),
    settleCard: vi.fn(),
    manager: undefined as unknown as WaitManager,
    reload: () => build(),
    create(condition: NewWaitCondition, extra: { label?: string; followUp?: string; botId?: string; threadId?: string; hours?: number } = {}) {
      return h.manager.create({ botId: extra.botId ?? "bot-1", threadId: extra.threadId ?? "t-1", label: extra.label ?? "the report", condition, followUp: extra.followUp, hours: extra.hours });
    },
    waitOf(id: string): WaitRecord {
      const found = JSON.parse(readFileSync(file, "utf8")).waits.find((w: WaitRecord) => w.id === id);
      return found;
    },
  };
  h.post.mockImplementation((_wait: WaitRecord, notice: WaitNotice) => {
    if (h.postOk) h.posts.push(notice);
    return h.postOk;
  });
  function build(): WaitManager {
    h.manager = new WaitManager({
      file,
      now: options.now ?? h.now,
      probes: {
        async stamp() { h.stampCalls++; return h.stamp; },
        async page() {
          h.pageCalls++;
          h.pageInFlight++;
          h.pageMaxInFlight = Math.max(h.pageMaxInFlight, h.pageInFlight);
          try {
            if (h.pageDelayMs) await new Promise((resolve) => setTimeout(resolve, h.pageDelayMs));
            if (h.pageGate) await h.pageGate;
            return h.page;
          } finally { h.pageInFlight--; }
        },
        async processes() { h.processCalls++; return h.processes; },
      },
      sourceAlive: () => h.alive,
      botBusy: (id) => h.busy.get(id),
      post: h.post,
      followUp: h.followUp,
      showCard: h.showCard,
      settleCard: h.settleCard,
      ...options,
    });
    return h.manager;
  }
  build();
  return h;
}

describe("WaitManager", () => {
  it("creates a wait with a 24-hour default and its first check due, and keeps it across a restart", async () => {
    const h = harness();
    const created = await h.manager.create({ botId: "bot-1", threadId: "t-1", label: "the report", condition: { kind: "file_exists", path: "/r.txt" } });
    expect(created).toMatchObject({ state: "created", wait: { expiresAt: T0 + 24 * 3_600_000, nextCheckAt: T0 + 5_000, errors: 0 } });
    expect(h.reload().list("bot-1")).toHaveLength(1);
    if (process.platform !== "win32") expect(statSync(h.file).mode & 0o777).toBe(0o600);
  });

  it("creates nothing when the condition is already true", async () => {
    const h = harness();
    h.stamp = { size: 1, mtimeMs: 1 };
    expect(await h.create({ kind: "file_exists", path: "/r.txt" })).toEqual({ state: "already", text: "/r.txt exists already. Nothing was set up: tell the person now." });
    h.processes = [{ pid: 9, name: "make" }];
    expect(await h.create({ kind: "process_running", process: "make" })).toMatchObject({ state: "already" });
    h.page = { ok: true, text: "Shipped" };
    expect(await h.create({ kind: "url_contains", url: "https://x.test/", text: "shipped" })).toMatchObject({ state: "already" });
    expect(h.manager.list("bot-1")).toEqual([]);
    expect(h.reload().list("bot-1")).toEqual([]);
  });

  it("keeps ten waits per bot and fifty in all, and names the bot's waits when full", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) await h.create({ kind: "file_exists", path: `/f${i}` }, { label: `file ${i}` });
    const full = await h.create({ kind: "file_exists", path: "/f10" });
    expect(full).toMatchObject({ state: "refused", status: 409, error: expect.stringContaining("cancel_wait") });
    expect((full as { error: string }).error).toContain("file 9");
    for (let i = 0; i < 40; i++) await h.create({ kind: "file_exists", path: `/g${i}` }, { botId: `bot-${2 + (i % 8)}` });
    expect(h.manager.owners()).toHaveLength(9);
    const total = await h.create({ kind: "file_exists", path: "/h" }, { botId: "bot-99" });
    expect(total).toEqual({ state: "refused", status: 409, error: "This computer already keeps 50 waits, the most it holds. Ask the person which ones to stop." });
  });

  it("names only this chat's waits when the bot is full, and counts the others", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) await h.create({ kind: "file_exists", path: `/here${i}` }, { label: `here ${i}` });
    for (let i = 0; i < 4; i++) await h.create({ kind: "file_exists", path: `/away${i}` }, { label: `away ${i}`, threadId: "t-2" });
    const full = await h.create({ kind: "file_exists", path: "/more" }) as { error: string };
    expect(full.error).toMatch(/^You already keep 10 waits, the most one bot may\. In this chat:\n- /);
    expect(full.error).toContain("here 5");
    expect(full.error).not.toContain("away");
    expect(full.error).toMatch(/\n4 more in other chats\.\nCancel one with cancel_wait first\.$/);
    const elsewhere = await h.create({ kind: "file_exists", path: "/more" }, { threadId: "t-3" });
    expect(elsewhere).toEqual({ state: "refused", status: 409, error: "You already keep 10 waits, the most one bot may, all in other chats. Ask the person to stop one in the chat it was made in." });
  });

  it("refuses a program wait where this computer can't list its programs, and keeps one whose later listing fails", async () => {
    const h = harness();
    const processes = vi.fn(async (): Promise<ProcessEntry[]> => { throw new Error("spawn ps ENOENT"); });
    h.manager = new WaitManager({ file: h.file, now: h.now, probes: { processes }, sourceAlive: () => true, botBusy: () => false, post: h.post, followUp: h.followUp, showCard: h.showCard, settleCard: h.settleCard });
    expect(await h.create({ kind: "process_gone", process: "make" })).toEqual({ state: "refused", status: 400, error: "This computer can't list its programs, so a program wait can't work here. Wait for a file or a page instead." });
    expect(h.manager.owners()).toEqual([]);
    processes.mockResolvedValueOnce([{ pid: 1, name: "make" }]);
    expect(await h.create({ kind: "process_gone", process: "make" })).toMatchObject({ state: "created" });
    h.advance(5_000); await h.manager.tick();
    expect([h.posts, h.manager.list("bot-1").length]).toEqual([[], 1]);
  });

  it("refuses a page at a private address, and keeps checking a page that only failed to load", async () => {
    const h = harness();
    const error = "x.test points at this computer or a private network, which waits never check.";
    h.page = { ok: false, refused: true, error };
    expect(await h.create({ kind: "url_contains", url: "http://x.test/", text: "ok" })).toEqual({ state: "refused", status: 400, error });
    expect(h.manager.list("bot-1")).toEqual([]);
    h.page = { ok: false, refused: false, error: "The page took too long to answer." };
    expect(await h.create({ kind: "url_contains", url: "http://x.test/", text: "ok" })).toMatchObject({ state: "created", note: expect.stringContaining("took too long") });
    expect(h.manager.list("bot-1")).toHaveLength(1);
  });

  it("shows the card only for a wait with a follow-up, and stores its message id", async () => {
    const h = harness();
    h.showCard.mockReturnValue("m-1");
    const withFollowUp = await h.create({ kind: "file_exists", path: "/r" }, { followUp: "Summarise it." });
    expect(withFollowUp).toMatchObject({ wait: { cardMessageId: "m-1" } });
    const stored = h.reload().list("bot-1");
    expect(stored[0]?.cardMessageId).toBe("m-1");
    await h.create({ kind: "file_exists", path: "/s" });
    expect(h.showCard).toHaveBeenCalledTimes(1);
  });

  it("fires once: one line, one follow-up, the card settled, and the wait gone", async () => {
    const h = harness();
    await h.create({ kind: "file_exists", path: "/r.txt" }, { label: "the report", followUp: "Summarise it." });
    h.stamp = { size: 1, mtimeMs: 1 }; h.advance(5_000); await h.manager.tick(); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "fired", text: "the report: done. /r.txt is there now." }]);
    expect(h.followUp).toHaveBeenCalledTimes(1);
    expect(h.settleCard.mock.calls.map(([, how]) => how)).toEqual(["fired"]);
    expect(h.manager.list("bot-1")).toEqual([]);
    expect(h.reload().owners()).toEqual([]);
  });

  it("holds the line while a turn runs in the chat, then posts it once, even across a restart", async () => {
    const h = harness();
    await h.create({ kind: "file_exists", path: "/r.txt" }, { followUp: "Go." });
    expect(h.manager.list("bot-1")).toHaveLength(1);
    h.stamp = { size: 1, mtimeMs: 1 }; h.postOk = false; h.advance(5_000); await h.manager.tick();
    expect(h.manager.list("bot-1")).toEqual([]);
    expect(h.manager.owners()).toEqual(["bot-1"]);
    const storedAtFollowUp: number[] = [];
    h.followUp.mockImplementation(() => { storedAtFollowUp.push(JSON.parse(readFileSync(h.file, "utf8")).waits.length); });
    const reloaded = h.reload(); h.postOk = true; await reloaded.tick();
    expect(storedAtFollowUp).toEqual([0]);
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.posts).toHaveLength(1);
    expect(h.followUp).toHaveBeenCalledTimes(1);
    await reloaded.tick(); expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.followUp).toHaveBeenCalledTimes(1);
  });

  it("expires after its hours with one last check, quietly and without a follow-up", async () => {
    const h = harness();
    await h.create({ kind: "file_exists", path: "/r" }, { label: "the build", followUp: "Deploy." });
    h.stampCalls = 0;
    h.advance(24 * 3_600_000); await h.manager.tick();
    expect(h.stampCalls).toBe(1);
    expect(h.posts).toEqual([{ status: "expired", text: "Stopped waiting for the build after 24 hours." }]);
    expect(h.followUp).not.toHaveBeenCalled();
    expect(h.settleCard.mock.calls.map(([, how]) => how)).toEqual(["expired"]);
    expect(h.manager.owners()).toEqual([]);
  });

  it("says one hour in the singular", async () => {
    const h = harness();
    await h.create({ kind: "file_exists", path: "/r" }, { label: "the build", hours: 1 });
    h.advance(3_600_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "expired", text: "Stopped waiting for the build after 1 hour." }]);
  });

  it("fires instead of expiring when the last check finds it", async () => {
    const h = harness();
    await h.create({ kind: "file_exists", path: "/r" }, { label: "the build" });
    h.stamp = { size: 1, mtimeMs: 1 }; h.advance(30 * 3_600_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "fired", text: "the build: done. /r is there now." }]);
  });

  it("lets the last check at expiry keep the page minimum interval", async () => {
    const h = harness();
    h.page = { ok: true, text: "building" };
    await h.create({ kind: "url_contains", url: "https://x.test/", text: "shipped" }, { label: "the page", hours: 1 });
    h.advanceTo(T0 + 3_600_000 - 30_000); await h.manager.tick();
    h.page = { ok: true, text: "shipped" };
    const calls = h.pageCalls;
    h.advanceTo(T0 + 3_600_000); await h.manager.tick();
    expect(h.pageCalls).toBe(calls);
    expect(h.posts).toEqual([{ status: "expired", text: "Stopped waiting for the page after 1 hour." }]);
  });

  it("checks a page every minute and backs off to 15 minutes while it fails", async () => {
    const h = harness();
    h.page = { ok: true, text: "building" };
    const { wait } = await h.create({ kind: "url_contains", url: "https://x.test/", text: "shipped" }) as { wait: WaitRecord };
    expect(wait.nextCheckAt - T0).toBe(60_000);
    h.page = { ok: false, refused: false, error: "down" };
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) { h.advanceTo(h.waitOf(wait.id).nextCheckAt); await h.manager.tick(); gaps.push(h.waitOf(wait.id).nextCheckAt - h.now()); }
    expect(gaps).toEqual([120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
    h.page = { ok: true, text: "building" }; h.advanceTo(h.waitOf(wait.id).nextCheckAt); await h.manager.tick();
    expect(h.waitOf(wait.id).nextCheckAt - h.now()).toBe(60_000);
    h.advance(5_000); await h.manager.tick(); expect(h.pageCalls).toBe(8);
  });

  it("fires url_missing only once a check saw the text, so a page its scripts draw is never gone at once", async () => {
    const h = harness();
    h.page = { ok: true, text: "Loading" };
    const created = await h.create({ kind: "url_missing", url: "https://shop.test/", text: "Sold out" }, { label: "the shoes" });
    expect(created).toMatchObject({ state: "created", wait: { condition: { sawText: false } }, note: expect.stringContaining("The page does not say “Sold out” now") });
    h.advance(60_000); await h.manager.tick();
    expect(h.posts).toEqual([]);
    h.page = { ok: true, text: "Shoes: Sold out" }; h.advance(60_000); await h.manager.tick();
    expect([h.posts, h.reload().list("bot-1")[0]?.condition]).toEqual([[], expect.objectContaining({ sawText: true })]);
    h.page = { ok: true, text: "Shoes: In stock" }; h.advance(60_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "fired", text: "the shoes: done. https://shop.test/ no longer says “Sold out”." }]);
  });

  it("counts text the page shows when a url_missing wait is made as seen, with no note", async () => {
    const h = harness();
    h.page = { ok: true, text: "Shoes: Sold out" };
    const created = await h.create({ kind: "url_missing", url: "https://shop.test/", text: "sold out" }, { label: "the shoes" });
    expect(created).toMatchObject({ state: "created", wait: { condition: { sawText: true } } });
    expect(created).not.toHaveProperty("note");
    h.page = { ok: true, text: "Shoes: In stock" }; h.advance(60_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "fired", text: "the shoes: done. https://shop.test/ no longer says “sold out”." }]);
  });

  it("lets a sleeping Cloud sleep while a wait is open and wake for it 30 minutes on, not at a page's next minute", async () => {
    const h = harness();
    expect(h.manager.nextWakeAt()).toBeNull();
    h.page = { ok: true, text: "building" };
    await h.create({ kind: "url_contains", url: "https://x.test/", text: "shipped" });
    const idle = () => false;
    const power = createCloudPower({ dataDir: dirname(h.file), now: h.now, broadcast: () => {}, probes: {
      turn: idle, run: idle, liveCall: idle, computer: idle, maintenance: idle, nextDueAt: () => h.manager.nextWakeAt(),
    } });
    try {
      for (let left = CLOUD_IDLE_AWAKE_MS; left > 0; left -= 5_000) { h.advance(5_000); power.tick(); }
      expect(power.prepareSleep()).toEqual({ ok: true, nextDueAt: h.now() + WAIT_WAKE_MS });
    } finally { power.close(); }
    h.page = { ok: true, text: "shipped" }; h.advance(60_000); await h.manager.tick();
    expect([h.posts.length, h.manager.nextWakeAt()]).toEqual([1, null]);
  });

  it("never fetches two pages at once, even for concurrent creates", async () => {
    const h = harness();
    h.page = { ok: true, text: "building" };
    h.pageDelayMs = 10;
    await Promise.all(["https://a.test/", "https://b.test/", "https://c.test/"].map((url) => h.create({ kind: "url_contains", url, text: "shipped" }, { label: url })));
    expect(h.pageCalls).toBe(3);
    expect(h.pageMaxInFlight).toBe(1);
    h.pageCalls = 0; h.pageMaxInFlight = 0;
    h.advance(60_000); await h.manager.tick();
    expect(h.pageCalls).toBe(3);
    expect(h.pageMaxInFlight).toBe(1);
  });

  it("leaves a due page for the next tick while another page fetch is in flight", async () => {
    const h = harness();
    h.page = { ok: true, text: "building" };
    await h.create({ kind: "url_contains", url: "https://a.test/", text: "shipped" });
    h.advance(60_000); h.pageCalls = 0; h.pageMaxInFlight = 0; h.pageDelayMs = 10;
    const creating = h.create({ kind: "url_contains", url: "https://b.test/", text: "shipped" });
    await vi.waitFor(() => expect(h.pageInFlight).toBe(1), { interval: 1 });
    await h.manager.tick();
    expect(h.pageCalls).toBe(1);
    await creating;
    expect(h.pageMaxInFlight).toBe(1);
    h.pageDelayMs = 0; await h.manager.tick();
    expect(h.pageCalls).toBe(2);
  });

  it("reads a slow page outside the ticking window, and posts nothing it found once stopped until started again", async () => {
    const h = harness();
    h.page = { ok: true, text: "building" };
    await h.create({ kind: "url_contains", url: "https://x.test/", text: "shipped" }, { label: "the page" });
    let open!: () => void;
    h.pageGate = new Promise((resolve) => { open = resolve; });
    h.page = { ok: true, text: "shipped" }; h.advance(60_000);
    const ticking = h.manager.tick();
    await vi.waitFor(() => expect(h.pageInFlight).toBe(1), { interval: 1 });
    expect(h.manager.isTicking).toBe(false);
    h.manager.stop(); open(); await ticking;
    expect([h.posts, h.manager.list("bot-1").length]).toEqual([[], 1]);
    h.pageGate = null; h.manager.start();
    await vi.waitFor(() => expect(h.posts).toEqual([{ status: "fired", text: "the page: done. https://x.test/ now says “shipped”." }]), { interval: 1 });
    h.manager.stop();
  });

  it("waits for another bot to start and then finish, even a turn shorter than a tick", async () => {
    const h = harness();
    h.busy.set("coder", false);
    await h.create({ kind: "bot_idle", botId: "coder", botName: "Coder" }, { label: "Coder's review" });
    h.advance(5_000); await h.manager.tick(); expect(h.posts).toEqual([]);
    h.manager.noteBotBusy("coder");
    h.advance(5_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "fired", text: "Coder's review: done. Coder finished." }]);
  });

  it("stops with a line when the bot it waits for is deleted", async () => {
    const h = harness();
    h.busy.set("coder", false);
    await h.create({ kind: "bot_idle", botId: "coder", botName: "Coder" }, { label: "Coder's review" });
    h.busy.delete("coder"); h.advance(5_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "stopped", text: "Stopped waiting for Coder's review: Coder no longer exists." }]);
    expect(h.manager.owners()).toEqual([]);
  });

  it("drops a wait silently when its chat or bot is gone, without posting or touching the card", async () => {
    const h = harness();
    await h.create({ kind: "file_exists", path: "/r" }, { followUp: "Go." });
    h.alive = false; h.stamp = { size: 1, mtimeMs: 1 }; h.advance(5_000); await h.manager.tick();
    expect([h.post.mock.calls.length, h.settleCard.mock.calls.length, h.manager.list("bot-1").length]).toEqual([0, 0, 0]);
    expect(h.reload().owners()).toEqual([]);
  });

  it("reads a file's change against the stamp taken when the wait was made", async () => {
    const h = harness();
    h.stamp = { size: 1, mtimeMs: 1 };
    await h.create({ kind: "file_changed", path: "/log" });
    h.advance(5_000); await h.manager.tick(); expect(h.posts).toEqual([]);
    h.stamp = { size: 2, mtimeMs: 2 }; h.advance(5_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "fired", text: "the report: done. /log changed." }]);
  });

  it("reads the process list once per tick for every process wait", async () => {
    const h = harness();
    h.processes = [{ pid: 1, name: "a" }, { pid: 2, name: "b" }, { pid: 3, name: "c" }];
    for (const name of ["a", "b", "c"]) await h.create({ kind: "process_gone", process: name }, { label: name });
    h.processCalls = 0; h.advance(5_000); await h.manager.tick();
    expect(h.processCalls).toBe(1);
    expect(h.posts).toEqual([]);
    h.processes = [];
    h.advance(5_000); await h.manager.tick();
    expect(h.processCalls).toBe(2);
    expect(h.posts.map((p) => p.text)).toEqual(["a: done. a stopped.", "b: done. b stopped.", "c: done. c stopped."]);
  });

  it("lets a bot cancel only its own waits, and settles the card", async () => {
    const h = harness();
    const { wait } = await h.create({ kind: "file_exists", path: "/r" }, { followUp: "Go." }) as { wait: WaitRecord };
    expect(h.manager.cancel(wait.id, "bot-2")).toBeNull();
    expect(h.manager.list("bot-1")).toHaveLength(1);
    expect(h.manager.list("bot-2")).toEqual([]);
    expect(h.manager.cancel(wait.id, "bot-1")?.id).toBe(wait.id);
    expect(h.settleCard.mock.calls.map(([, how]) => how)).toEqual(["cancelled"]);
    expect(h.manager.list("bot-1")).toEqual([]);
    expect(h.reload().owners()).toEqual([]);
  });

  it("removes a deleted bot's waits and nobody else's", async () => {
    const h = harness();
    await h.create({ kind: "file_exists", path: "/a" }); await h.create({ kind: "file_exists", path: "/b" });
    await h.create({ kind: "file_exists", path: "/c" }, { botId: "bot-2" });
    expect(h.manager.owners()).toEqual(["bot-1", "bot-2"]);
    expect(h.manager.removeForBot("bot-1")).toBe(2);
    expect([h.manager.list("bot-1").length, h.manager.list("bot-2").length, h.posts.length]).toEqual([0, 1, 0]);
  });

  it("describes conditions and lists waits in the exact copy", () => {
    expect(describeCondition({ kind: "url_missing", url: "https://x.test/", text: "beta" })).toBe("https://x.test/ no longer says “beta”");
    expect(describeCondition({ kind: "process_gone", process: "make" })).toBe("make has stopped");
    expect(describeCondition({ kind: "bot_idle", botId: "c", botName: "Coder", sawBusy: false })).toBe("Coder finishes its work");
    const wait: WaitRecord = { id: "w1", botId: "b", threadId: "t", label: "L", condition: { kind: "file_exists", path: "/p" }, followUp: "Go", createdAt: 0, expiresAt: 3_600_000, nextCheckAt: 0, errors: 0 };
    expect(waitList([wait])).toBe("- w1 · L · until /p exists · made 1970-01-01T00:00:00.000Z · stops 1970-01-01T01:00:00.000Z · follow_up: Go");
  });

  it("checks every five seconds once started, and not at all once stopped", async () => {
    vi.useFakeTimers();
    const h = harness({ now: () => Date.now() });
    await h.create({ kind: "file_exists", path: "/r" });
    h.manager.start(); await vi.advanceTimersByTimeAsync(0);
    const seen = h.stampCalls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.stampCalls).toBe(seen + 1);
    h.manager.stop(); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.stampCalls).toBe(seen + 1);
    expect(h.manager.isTicking).toBe(false);
  });

  it("keeps exactly ten waits for a bot when creates run at the same time", async () => {
    const h = harness();
    h.page = { ok: true, text: "building" };
    h.pageDelayMs = 2;
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => h.create({ kind: "url_contains", url: `https://x${i}.test/`, text: "shipped" }, { label: `p${i}` })));
    expect(results.filter((r) => r.state === "created")).toHaveLength(10);
    expect(results.filter((r) => r.state === "refused")).toHaveLength(5);
    expect(h.manager.list("bot-1")).toHaveLength(10);
    expect(h.reload().list("bot-1")).toHaveLength(10);
  });

  it("starts a bot_idle wait that was made while the bot is busy as already seen busy", async () => {
    const h = harness();
    h.busy.set("coder", true);
    const created = await h.create({ kind: "bot_idle", botId: "coder", botName: "Coder" }, { label: "Coder's review" });
    expect(created).toMatchObject({ state: "created", wait: { condition: { sawBusy: true } } });
    h.advance(5_000); await h.manager.tick(); expect(h.posts).toEqual([]);
    h.busy.set("coder", false); h.advance(5_000); await h.manager.tick();
    expect(h.posts).toEqual([{ status: "fired", text: "Coder's review: done. Coder finished." }]);
  });

  it("rolls a failed save back completely, and keeps a wait whose card id could not be saved", async () => {
    const h = harness();
    const save = vi.spyOn(h.manager as unknown as { save(): void }, "save");
    save.mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(h.create({ kind: "file_exists", path: "/r" })).rejects.toThrow("disk full");
    expect(h.manager.owners()).toEqual([]);

    const { wait } = await h.create({ kind: "file_exists", path: "/s" }) as { wait: WaitRecord };
    save.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => h.manager.cancel(wait.id, "bot-1")).toThrow("disk full");
    expect(h.manager.list("bot-1")).toHaveLength(1);

    h.showCard.mockReturnValue("m-9");
    save.mockImplementationOnce(() => undefined);
    save.mockImplementationOnce(() => { throw new Error("disk full"); });
    const withCard = await h.create({ kind: "file_exists", path: "/t" }, { followUp: "Go." });
    expect(withCard).toMatchObject({ state: "created" });
    expect((withCard as { wait: WaitRecord }).wait.cardMessageId).toBeUndefined();
    expect(h.manager.list("bot-1")).toHaveLength(2);
  });

  it("restores a bot_idle record's changed flag when its save fails", async () => {
    const h = harness();
    h.busy.set("coder", false);
    await h.create({ kind: "bot_idle", botId: "coder", botName: "Coder" });
    const save = vi.spyOn(h.manager as unknown as { save(): void }, "save");
    save.mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => h.manager.noteBotBusy("coder")).toThrow("disk full");
    expect(h.manager.list("bot-1")[0]?.condition).toMatchObject({ sawBusy: false });
  });

  it("logs a tick that throws instead of leaving it unhandled", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness({ now: () => Date.now() });
    await h.create({ kind: "file_exists", path: "/r" });
    h.stamp = { size: 1, mtimeMs: 1 };
    vi.spyOn(h.manager as unknown as { save(): void }, "save").mockImplementation(() => { throw new Error("disk full"); });
    h.manager.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(error).toHaveBeenCalledWith("wait tick failed", expect.objectContaining({ message: "disk full" }));
    h.manager.stop();
    error.mockRestore();
  });
});
