import { describe, expect, it, vi } from "vitest";

import { ComputerControl } from "../computer-control.ts";
import { SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget, poolLocalVmTarget, type LocalVmTarget } from "../container-computer.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import { teamComputerOwner } from "../team-computers.ts";
import { viewerTargetId } from "../../shared/desktop-viewer.ts";
import { createSharedVmControl, SHARED_VM_CONTROL_KEY as DESK } from "./shared-vm-control.ts";

type Fixture = {
  mode?: "shared" | "per-bot" | "pool";
  cloudHome?: boolean;
  bots?: Array<Partial<BotRecord> & { id: string }>;
  /** threadId → [botId, pinned place] */
  tasks?: Record<string, [string, string | undefined]>;
  team?: Record<string, string>;
  teamTurns?: Record<string, { computerId: string; botId: string }>;
  /** threadId → the settings a running turn there uses instead of the stored bot's */
  turnBots?: Record<string, Partial<BotRecord>>;
  /** threadId → the Local VM its running turn works on */
  vmTurns?: Record<string, LocalVmTarget>;
  busy?: boolean;
};

function fixture(f: Fixture = {}) {
  const control = new ComputerControl();
  const bots = (f.bots ?? [{ id: "ada" }]) as BotRecord[];
  let mode = f.mode ?? "shared";
  let places = 0;
  const vm = createSharedVmControl({
    control,
    store: {
      get bots() { return bots; },
      bot: (id) => bots.find(bot => bot.id === id) ?? null,
      tasks: (botId) => Object.entries(f.tasks ?? {}).filter(([, [owner]]) => owner === botId).map(([threadId, [, surface]]) => ({ threadId, surface })),
    },
    mode: () => f.cloudHome ? null : mode,
    turnBots: { entries: () => Object.entries(f.turnBots ?? {}).flatMap(([threadId, settings]) => {
      const stored = bots.find(bot => bot.id === settings.id);
      return stored ? [[threadId, { ...stored, ...settings }] as [string, BotRecord]] : [];
    }).values() },
    botForThread: (botId, threadId) => {
      const stored = bots.find(bot => bot.id === botId);
      return stored ? { ...stored, ...f.turnBots?.[threadId] } : null;
    },
    teamTurns: { get: (threadId) => f.teamTurns?.[threadId], values: () => Object.values(f.teamTurns ?? {}).values() },
    teamComputer: (bot) => f.team?.[bot.id],
    place: (bot, threadId) => { places++; return f.tasks?.[threadId]?.[1] ?? bot.computer; },
    turnVmTargets: { get: (threadId) => f.vmTurns?.[threadId] },
    busy: () => f.busy ?? false,
  });
  const bot = (id: string) => bots.find(candidate => candidate.id === id)!;
  return { control, vm, bot, setMode: (next: typeof mode) => { mode = next; }, places: () => places };
}

const phone: RequestAuth = { kind: "session", via: "bearer", scopes: ["admin"], session: {} as never };
const desktop: RequestAuth = { kind: "loopback", scopes: ["admin"] };

const keyRows = [
  { row: "shared, Auto, no conversation", f: {}, thread: undefined, key: DESK },
  { row: "shared, set to the VM", f: { bots: [{ id: "ada", computer: "vm" }] }, thread: undefined, key: DESK },
  { row: "shared, cloud, conversation pinned to the VM", f: { bots: [{ id: "ada", computer: "cloud" }], tasks: { t: ["ada", "vm"] } }, thread: "t", key: DESK },
  { row: "shared, cloud, asked without the conversation", f: { bots: [{ id: "ada", computer: "cloud" }], tasks: { t: ["ada", "vm"] } }, thread: undefined, key: "ada" },
  { row: "shared, Auto, conversation pinned to this computer", f: { tasks: { t: ["ada", "local"] } }, thread: "t", key: "ada" },
  { row: "shared, Auto on a VPS, unpinned conversation", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] } }, thread: "t", key: "ada" },
  { row: "shared, Auto on a VPS, unpinned conversation whose running turn is on the shared VM",
    f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] }, vmTurns: { t: SHARED_LOCAL_VM_TARGET } }, thread: "t", key: DESK },
  { row: "shared, Auto, unpinned conversation", f: { tasks: { t: ["ada", undefined] } }, thread: "t", key: DESK },
  { row: "shared, Auto on a VPS, no conversation", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] } }, thread: undefined, key: "ada" },
  { row: "shared, Auto on a VPS, its conversations on the VPS", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", "cloud"] } }, thread: "t", key: "ada" },
  { row: "per-bot, Auto", f: { mode: "per-bot" }, thread: undefined, key: "ada" },
  { row: "pool, Auto", f: { mode: "pool" }, thread: undefined, key: "ada" },
  { row: "a Cloud home", f: { cloudHome: true }, thread: undefined, key: "ada" },
  { row: "a team's cloud computer", f: { team: { ada: "c1" } }, thread: undefined, key: teamComputerOwner("c1") },
  { row: "a turn on a team's cloud computer", f: { teamTurns: { t: { computerId: "c2", botId: "ada" } } }, thread: "t", key: teamComputerOwner("c2") },
  { row: "another bot's turn on a team's cloud computer", f: { bots: [{ id: "ada" }, { id: "bea" }], teamTurns: { t: { computerId: "c2", botId: "bea" } } }, thread: "t", key: DESK },
] as Array<{ row: string; f: Fixture; thread?: string; key: string }>;

describe("the one control key", () => {
  it.each(keyRows)("$row", ({ f, thread, key }) => {
    const { vm, bot } = fixture(f);
    expect(vm.keyFor(bot("ada"), thread)).toBe(key);
    expect(vm.signInKey(bot("ada"), thread ?? "t", "vm")).toBe(vm.keyFor(bot("ada"), thread ?? "t"));
    expect(vm.signInKey(bot("ada"), "t", "browser")).toBe("ada");
  });

  it.each(keyRows)("the bot list tells the bot about every hold a take through its panels lands on: $row", ({ f, thread }) => {
    const { control, vm, bot } = fixture(f);
    for (const key of [vm.keyFor(bot("ada"), thread), ...[thread, undefined].flatMap(t => [vm.holdKey(bot("ada"), t, "local/shared"), vm.holdKey(bot("ada"), t, "vps/ada")])]) {
      if (!key) continue;
      control.take(key);
      expect(vm.botSnapshot("ada").held, key).toBe(true);
      control.release(key);
    }
  });
});

describe("what a hold on the shared desktop reaches", () => {
  it("a thread-less hold on a bot's default key pauses its conversation elsewhere, and a hold on the desktop pauses every Auto bot", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada" }, { id: "bea" }], tasks: { t: ["ada", "cloud"] } });
    control.take(DESK);
    expect(vm.snapshot("ada", "t").held).toBe(true);
    expect(vm.snapshot("bea").held).toBe(true);
  });

  it.each(["cloud", "off"] as const)("a turn still on the shared VM after its bot moved to %s waits for a hold on the desktop", (computer) => {
    const { control, vm } = fixture({ bots: [{ id: "ada", computer }], vmTurns: { r: SHARED_LOCAL_VM_TARGET } });
    control.take(DESK);
    expect(vm.snapshot("ada", "r").held).toBe(true);
    expect(vm.snapshot("ada").held).toBe(false);
  });

  it("outside shared mode a turn's mounted VM adds no key to its gate", () => {
    const { control, vm } = fixture({ mode: "per-bot", bots: [{ id: "ada", computer: "cloud" }], vmTurns: { r: SHARED_LOCAL_VM_TARGET } });
    control.take(DESK);
    expect(vm.snapshot("ada", "r").held).toBe(false);
  });

  it.each([{ held: "ada", plea: DESK }, { held: DESK, plea: "ada" }])("a bot's hold on $held still shows its sign-in plea on $plea", ({ held, plea }) => {
    const { control, vm } = fixture({ bots: [{ id: "ada" }] });
    control.take(held);
    control.requestHelp(plea, "sign in to a.example", { botId: "ada", threadId: "t", messageId: "m", site: "a.example", place: "browser" });
    expect(vm.botSnapshot("ada")).toMatchObject({ held: true, helpReason: "sign in to a.example", help: { messageId: "m" } });
    expect(vm.botSnapshot("ada").heldSinceMs).toBe(control.snapshot(held).heldSinceMs);
  });

  it("a control answer for a viewer who cannot see the asking conversation carries no sign-in request", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada" }] });
    control.requestHelp(DESK, "sign in to a.example", { botId: "ada", threadId: "t", messageId: "m", site: "a.example", place: "vm" });
    expect(vm.shown(control.snapshot(DESK), "ada", (id) => id === "t")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
    expect(vm.shown(control.snapshot("ada"), "ada", () => false)).toMatchObject({ helpReason: "sign in to a.example", help: { messageId: "m" } });
  });

  it("a bot's held computer with its own sign-in plea shows that plea, not one on another of its computers", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada" }] });
    control.requestHelp("ada", "sign in to b.example", { botId: "ada", threadId: "t", messageId: "own", site: "b.example", place: "browser" });
    control.take(DESK);
    control.requestHelp(DESK, "sign in to d.example", { botId: "ada", threadId: "t", messageId: "desk", site: "d.example", place: "vm" });
    expect(vm.botSnapshot("ada")).toMatchObject({ held: true, helpReason: "sign in to d.example", help: { messageId: "desk" } });
  });

  it("tells every bot with a conversation on the desktop, and each its merged state", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada" }, { id: "books", computer: "cloud" }, { id: "cy", computer: "cloud" }], tasks: { t: ["books", "vm"] } });
    expect(vm.membersOf(DESK)).toEqual(["ada", "books"]);
    expect(vm.membersOf("cy")).toEqual(["cy"]);
    control.take(DESK);
    control.requestHelp("books", "sign in", { botId: "books", threadId: "u", messageId: "m", site: "a.example", place: "browser" });
    expect(vm.botSnapshot("books")).toMatchObject({ held: true });
    expect(vm.botSnapshot("gone").held).toBe(false);
  });

  it.each(["per-bot", "pool"] as const)("outside shared mode tells a change on the desktop to every bot, and one on a bot's own key to that bot: %s", (mode) => {
    const { vm, setMode } = fixture({ bots: [{ id: "ada" }, { id: "books", computer: "cloud" }, { id: "cy", computer: "cloud" }], tasks: { t: ["books", "vm"] } });
    setMode(mode);
    expect(vm.membersOf(DESK)).toEqual(["ada", "books", "cy"]);
    expect(vm.membersOf("cy")).toEqual(["cy"]);
  });

  it("tells a change on a team's cloud computer to the bots that inherit it or run a turn on it", () => {
    const { vm } = fixture({ bots: [{ id: "ada" }, { id: "bea" }, { id: "cy" }], team: { ada: "c1" }, teamTurns: { r: { computerId: "c1", botId: "bea" } } });
    expect(vm.membersOf(teamComputerOwner("c1"))).toEqual(["ada", "bea"]);
  });

  it.each([
    { row: "a conversation pinned to the desktop", f: { bots: [{ id: "ada", computer: "cloud" }], tasks: { t: ["ada", "vm"], c: ["ada", "cloud"] } }, key: DESK, held: true },
    { row: "a running turn on a team's cloud computer", f: { bots: [{ id: "ada", computer: "cloud" }], tasks: { c: ["ada", "cloud"] }, teamTurns: { r: { computerId: "c2", botId: "ada" } } }, key: teamComputerOwner("c2"), held: true },
    { row: "another bot's team turn", f: { bots: [{ id: "ada", computer: "cloud" }, { id: "bea" }], tasks: { c: ["ada", "cloud"] }, teamTurns: { r: { computerId: "c2", botId: "bea" } } }, key: teamComputerOwner("c2"), held: false },
    { row: "a pin to the desktop of a bot on a team's cloud computer", f: { team: { ada: "c1" }, tasks: { t: ["ada", "vm"], c: ["ada", "cloud"] } }, key: DESK, held: false },
  ] as Array<{ row: string; f: Fixture; key: string; held: boolean }>)("the bot list and broadcasts read a hold reaching $row from stored pins and team turns", ({ f, key, held }) => {
    const { control, vm, places } = fixture(f);
    control.take(key);
    expect(vm.botSnapshot("ada").held).toBe(held);
    expect(vm.membersOf(DESK).includes("ada")).toBe(key === DESK && held);
    expect(places(), "no turn surface plan per conversation").toBe(0);
  });

  it("the bot list and broadcasts tell an Auto bot on a VPS about the desktop's hold while one of its conversations is unplaced", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada", cloudBackend: "vps" }, { id: "cy", computer: "cloud" }], tasks: { t: ["ada", undefined], u: ["cy", undefined] } });
    control.take(DESK);
    expect([vm.botSnapshot("ada").held, vm.botSnapshot("cy").held]).toEqual([true, false]);
    expect(vm.membersOf(DESK)).toEqual(["ada"]);
  });

  it.each([
    { row: "the shared VM from a conversation Auto has not placed", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] } }, target: "local/shared", key: DESK },
    { row: "the shared VM from a cloud bot's conversation pinned to it", f: { bots: [{ id: "ada", computer: "cloud" }], tasks: { t: ["ada", "vm"] } }, target: "local/shared", key: DESK },
    { row: "the shared VM in per-bot mode", f: { mode: "per-bot" }, target: "local/shared", key: null },
    { row: "the shared VM from a conversation pinned to this computer", f: { tasks: { t: ["ada", "local"] } }, target: "local/shared", key: null },
    { row: "the shared VM from a bot set to Off", f: { bots: [{ id: "ada", computer: "off" }] }, target: "local/shared", key: null },
    { row: "the shared VM from a bot on a team's cloud computer", f: { team: { ada: "c1" } }, target: "local/shared", key: null },
    { row: "its VPS", f: { bots: [{ id: "ada", cloudBackend: "vps" }] }, target: "vps/ada", key: "ada" },
  { row: "its VPS from a conversation Auto has not placed whose turn works on the shared VM", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] }, vmTurns: { t: SHARED_LOCAL_VM_TARGET } }, target: "vps/ada", key: "ada" },
    { row: "another bot's VPS", f: { bots: [{ id: "ada", cloudBackend: "vps" }, { id: "bea", cloudBackend: "vps" }] }, target: "vps/bea", key: "ada" },
    { row: "another bot's Local VM in per-bot mode", f: { mode: "per-bot", bots: [{ id: "ada" }, { id: "bea" }] }, target: viewerTargetId(perBotLocalVmTarget("bea")), key: "ada" },
    { row: "a pool seat not its own", f: { mode: "pool" }, target: viewerTargetId(poolLocalVmTarget(1)), key: "ada" },
  ] as Array<{ row: string; f: Fixture; target: string; key: string | null }>)("a person's take naming $row holds the shared desktop only where the conversation can show it, else the bot's own key", ({ f, target, key }) => {
    const { vm, bot } = fixture(f);
    expect(vm.holdKey(bot("ada"), "t", target)).toBe(key);
  });

  it.each([
    { row: "its VPS", target: "vps/ada", vpsTurnHeld: true, vmBotHeld: false },
    { row: "the shared VM", target: "local/shared", vpsTurnHeld: false, vmBotHeld: true },
  ])("a person's take naming $row on a conversation Auto has not placed pauses the turns on that desktop", ({ target, vpsTurnHeld, vmBotHeld }) => {
    const { control, vm, bot } = fixture({ bots: [{ id: "ada", cloudBackend: "vps" }, { id: "bea" }],
      tasks: { t1: ["ada", "cloud"], t2: ["ada", undefined] }, turnBots: { t1: { id: "ada" } } });
    control.take(vm.holdKey(bot("ada"), "t2", target)!);
    expect([vm.snapshot("ada", "t1").held, vm.snapshot("bea").held]).toEqual([vpsTurnHeld, vmBotHeld]);
  });

  it.each([
    { row: "on the shared VM", vmTurns: { t: SHARED_LOCAL_VM_TARGET }, held: true },
    { row: "on its VPS", vmTurns: {}, held: false },
  ] as Array<{ row: string; vmTurns: Record<string, LocalVmTarget>; held: boolean }>)("the gate pauses a running turn Auto has not placed $row while a person holds the shared desktop", ({ vmTurns, held }) => {
    const { control, vm } = fixture({ bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] }, turnBots: { t: { id: "ada" } }, vmTurns });
    control.take(DESK);
    expect(vm.snapshot("ada", "t").held).toBe(held);
  });

  it("the gate pauses only the conversations on a held desktop, while the bot list shows the bot held", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada" }, { id: "books", computer: "cloud" }], tasks: { t: ["books", "vm"], c: ["books", "cloud"] } });
    control.take(DESK);
    expect([vm.snapshot("books", "t").held, vm.snapshot("books", "c").held, vm.snapshot("books").held]).toEqual([true, false, false]);
    expect(vm.botSnapshot("books").held).toBe(true);
    control.take("books");
    expect(vm.snapshot("books", "c").held).toBe(true);
  });

  it("the gate, the bot list and broadcasts read a conversation's key from the settings its running turn uses", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada", computer: "cloud" }], turnBots: { r: { id: "ada", computer: "vm" } } });
    control.take(DESK);
    expect([vm.snapshot("ada", "r").held, vm.snapshot("ada").held, vm.botSnapshot("ada").held]).toEqual([true, false, true]);
    expect(vm.membersOf(DESK)).toEqual(["ada"]);
  });

  it("the bot list and broadcasts read a running turn's default place from the settings it uses, as the gate does", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada", computer: "cloud" }], tasks: { t: ["ada", "local"] }, turnBots: { t: { id: "ada", computer: "vm" } } });
    control.take(DESK);
    expect([vm.snapshot("ada", "t").held, vm.botSnapshot("ada").held]).toEqual([true, true]);
    expect(vm.membersOf(DESK)).toEqual(["ada"]);
  });

  it("the gate and the control read pause a running turn on a team's cloud computer a person holds, and no other conversation", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada", computer: "cloud" }], tasks: { c: ["ada", "cloud"] }, teamTurns: { r: { computerId: "c2", botId: "ada" } } });
    control.take(teamComputerOwner("c2"));
    expect([vm.snapshot("ada", "r").held, vm.snapshot("ada", "c").held]).toEqual([true, false]);
  });

  it("opens the shared desktop's viewer only to a lease on the desktop key", () => {
    const { vm, bot, setMode } = fixture({ bots: [{ id: "ada" }, { id: "books", computer: "cloud" }] });
    expect(vm.leaseKey(bot("ada"))).toBe(DESK);
    expect(vm.leaseKey(bot("books"))).toBe(DESK);
    setMode("per-bot");
    expect(vm.leaseKey(bot("books"))).toBe("books");
  });

  it.each([
    { row: "taken on a conversation off the desktop, released without it", f: { tasks: { t: ["ada", "cloud"] } }, take: "t", release: undefined },
    { row: "taken without a conversation, released with one on a team's cloud computer",
      f: { bots: [{ id: "ada", computer: "cloud" }], teamTurns: { t: { computerId: "c2", botId: "ada" } } }, take: undefined, release: "t" },
    { row: "taken during a team turn that has ended", f: { teamTurns: { t: { computerId: "c2", botId: "ada" } } }, take: "t", release: "t",
      after: (f: Fixture) => { delete f.teamTurns!.t; } },
    { row: "taken on a conversation since re-pinned", f: { bots: [{ id: "ada", computer: "cloud" }], tasks: { t: ["ada", "vm"] } }, take: "t", release: "t",
      after: (f: Fixture) => { f.tasks!.t = ["ada", "cloud"]; } },
    { row: "taken before the bot's computer changed", f: {}, take: undefined, release: undefined,
      after: (_f: Fixture, ada: BotRecord) => { ada.computer = "cloud"; } },
    { row: "taken on the shared desktop through another bot", f: { bots: [{ id: "ada", computer: "cloud" }, { id: "bea" }], tasks: { t: ["ada", "cloud"] } }, held: DESK, release: "t" },
  ] as Array<{ row: string; f: Fixture; held?: string; take?: string; release?: string; after?: (f: Fixture, ada: BotRecord) => void }>)(
    "a lease's check and release act on the hold it owns: $row", ({ f, held, take, release, after }) => {
      vi.useFakeTimers();
      try {
        const { control, vm, bot } = fixture(f);
        const key = held ?? vm.keyFor(bot("ada"), take);
        control.acquireLease(key, "lease-0123456789abcdef", { armed: true });
        after?.(f, bot("ada"));
        expect(vm.keyFor(bot("ada"), release)).not.toBe(key);
        vi.advanceTimersByTime(50_000);
        expect(vm.check(bot("ada"), release, "lease-0123456789abcdef")).toMatchObject({ held: true, owned: true });
        expect(vm.check(bot("ada"), release, "lease-other-0123456789").owned).toBe(false);
        vi.advanceTimersByTime(50_000);
        expect(control.snapshot(key).held, "the check renewed the hold's clock").toBe(true);
        expect(vm.release(bot("ada"), release, "lease-0123456789abcdef").released).toBe(true);
        expect(control.snapshot(key).held).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

  it("a lease reused for two takes is checked and released on the conversation's own key first", () => {
    const { control, vm, bot } = fixture({ tasks: { t: ["ada", "cloud"] } });
    control.acquireLease(DESK, "lease-0123456789abcdef");
    control.acquireLease("ada", "lease-0123456789abcdef");
    expect(vm.release(bot("ada"), "t", "lease-0123456789abcdef").released).toBe(true);
    expect([control.snapshot("ada").held, control.snapshot(DESK).held]).toEqual([false, true]);
  });

  it.each([
    { row: "an Auto bot on a VPS, without a conversation", f: { bots: [{ id: "ada", cloudBackend: "vps" }] }, thread: undefined, key: "ada", armed: false },
    { row: "an Auto bot on a VPS, on an unpinned conversation", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] } }, thread: "t", key: "ada", armed: false },
    { row: "an Auto bot on a VPS, without a conversation but with an unpinned one", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", undefined] } }, thread: undefined, key: "ada", armed: false },
    { row: "an Auto bot without a VPS", f: {}, thread: undefined, key: DESK, armed: true },
    { row: "a bot set to the VM, with a VPS", f: { bots: [{ id: "ada", computer: "vm", cloudBackend: "vps" }] }, thread: undefined, key: DESK, armed: true },
    { row: "an Auto bot on a VPS, on a conversation pinned to the VM", f: { bots: [{ id: "ada", cloudBackend: "vps" }], tasks: { t: ["ada", "vm"] } }, thread: "t", key: DESK, armed: true },
    { row: "an Auto bot on a VPS in per-bot mode", f: { mode: "per-bot", bots: [{ id: "ada", cloudBackend: "vps" }] }, thread: undefined, key: "ada", armed: false },
    { row: "an Auto bot without a VPS in per-bot mode", f: { mode: "per-bot" }, thread: undefined, key: "ada", armed: true },
    { row: "an Auto bot in pool mode", f: { mode: "pool" }, thread: undefined, key: "ada", armed: false },
    { row: "a cloud bot", f: { bots: [{ id: "ada", computer: "cloud" }] }, thread: undefined, key: "ada", armed: false },
    { row: "an Auto bot without a VPS, from the desktop", f: {}, auth: desktop, thread: undefined, key: DESK, armed: false },
    { row: "an Auto bot without a VPS, from a companion device", f: {}, auth: { ...desktop, companionDevice: "phone-1" }, thread: undefined, key: DESK, armed: true },
  ] as Array<{ row: string; f: Fixture; auth?: RequestAuth; thread?: string; key: string; armed: boolean }>)("a take of $row holds its key, lapsing only when a phone took a Local VM", ({ f, auth, thread, key, armed }) => {
    vi.useFakeTimers();
    try {
      const { control, vm, bot } = fixture(f);
      expect(vm.keyFor(bot("ada"), thread)).toBe(key);
      control.acquireLease(key, "lease-0123456789abcdef", { armed: vm.armed(auth ?? phone, bot("ada"), thread, key) });
      vi.advanceTimersByTime(2 * 60 * 60_000);
      expect(control.snapshot(key).held).toBe(!armed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a phone's take naming the shared desktop, or a VPS its bot does not have, still starts the expiry clock", () => {
    const { vm, bot } = fixture({ mode: "per-bot", bots: [{ id: "ada", computer: "vm" }] });
    expect(vm.armed(phone, bot("ada"), undefined, "ada", "vps/ada")).toBe(true);
    expect(fixture().vm.armed(phone, fixture().bot("ada"), undefined, DESK, "local/shared")).toBe(true);
  });

  it.each(["shared", "per-bot"] as const)("a phone's take naming a VM bot's VPS holds the bot's own key and never lapses, in %s mode", (mode) => {
    vi.useFakeTimers();
    try {
      const { control, vm, bot } = fixture({ mode, bots: [{ id: "ada", computer: "vm", cloudBackend: "vps" }] });
      const key = vm.holdKey(bot("ada"), undefined, "vps/ada");
      expect(key).toBe("ada");
      control.acquireLease("ada", "lease-0123456789abcdef", { armed: vm.armed(phone, bot("ada"), undefined, "ada", "vps/ada") });
      vi.advanceTimersByTime(2 * 60 * 60_000);
      expect(control.snapshot("ada").held).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a desktop take while the shared VM is being changed", () => {
    expect(fixture({ busy: true }).vm.takeRefusal(DESK)).toMatch(/being updated or changed/);
    expect(fixture({ busy: true }).vm.takeRefusal("ada")).toBeNull();
    expect(fixture().vm.takeRefusal(DESK)).toBeNull();
  });

  it("keeps the held desktop, or a per-bot VM held through its bot, in use, and keeps a new turn off the shared VM", () => {
    const { control, vm } = fixture({ bots: [{ id: "ada" }] });
    expect(vm.heldOnTarget(SHARED_LOCAL_VM_TARGET)).toBe(false);
    control.take(DESK);
    expect(vm.heldOnTarget(SHARED_LOCAL_VM_TARGET)).toBe(true);
    expect(vm.personHolds("computer:vm:shared")).toBe(true);
    expect(vm.personHolds(`computer:vm:${perBotLocalVmTarget("ada").key}`)).toBe(false);
    expect(vm.heldOnTarget(perBotLocalVmTarget("ada"))).toBe(false);
    control.take("ada");
    expect(vm.heldOnTarget(perBotLocalVmTarget("ada"))).toBe(true);
  });

  it("treats the desktop and team keys as shared by several bots, and a bot's own key as its own", () => {
    const { vm } = fixture();
    expect([vm.sharedKey(DESK), vm.sharedKey(teamComputerOwner("c1")), vm.sharedKey("ada")]).toEqual([true, true, false]);
  });

  it("refuses moving a bot off the held desktop, not a move that keeps its key", () => {
    const { control, vm, bot } = fixture();
    control.take(DESK);
    expect(vm.keyMovesWhileHeld(bot("ada"), { ...bot("ada"), computer: "cloud" })).toBe(true);
    expect(vm.keyMovesWhileHeld(bot("ada"), { ...bot("ada"), computer: "vm" })).toBe(false);
  });

  it.each([
    { row: "its deletion went through", gone: true },
    { row: "its deletion was cancelled", gone: false },
  ])("a bot's pleas, on its own key and on the shared desktop, end only when $row", ({ gone }) => {
    const bots = [{ id: "ada" }, { id: "bea" }];
    const { control, vm } = fixture({ bots });
    control.requestHelp("ada", "sign in", { botId: "ada", threadId: "t", messageId: "m", site: "a.example", place: "browser" });
    control.requestHelp(DESK, "sign in", { botId: "ada", threadId: "t", messageId: "n", site: "b.example", place: "vm" });
    if (gone) bots.splice(0, 1);
    vm.botDeleted("ada");
    expect([control.snapshot("ada").helpReason, control.snapshot(DESK).helpReason]).toEqual(gone ? [null, null] : ["sign in", "sign in"]);
  });

  it.each([
    { row: "an Auto bot while a person holds the desktop through another", bots: [{ id: "ada" }, { id: "bea" }], take: DESK, refused: true },
    { row: "a cloud bot with a conversation on the held desktop", bots: [{ id: "ada", computer: "cloud" }, { id: "bea" }], pinned: true, take: DESK, refused: true },
    { row: "a cloud bot while a person holds only the desktop", bots: [{ id: "ada", computer: "cloud" }, { id: "bea" }], take: DESK, refused: false },
    { row: "a bot set to Off, its conversation still pinned to the held desktop", bots: [{ id: "ada", computer: "off" }, { id: "bea" }], pinned: true, take: DESK, refused: false },
    { row: "a cloud bot while a person holds its own computer", bots: [{ id: "ada", computer: "cloud" }], take: "ada", refused: true },
    { row: "an Auto bot nobody holds anything of", bots: [{ id: "ada" }], take: undefined, refused: false },
  ] as Array<{ row: string; bots: NonNullable<Fixture["bots"]>; pinned?: boolean; take?: string; refused: boolean }>)("refuses deleting $row only while a hold reaches it", ({ bots, pinned, take, refused }) => {
    const { control, vm } = fixture({ bots, tasks: pinned ? { t: ["ada", "vm"] } : {} });
    if (take) control.take(take);
    expect(vm.deletionRefusal("ada")).toBe(refused ? "Hand back control of this bot's computer before deleting it" : null);
  });

  it("an allowed deletion leaves a hold on the shared desktop taken through another bot", () => {
    const bots: Array<Partial<BotRecord> & { id: string }> = [{ id: "ada", computer: "cloud" }, { id: "bea" }];
    const { control, vm, bot } = fixture({ bots });
    control.take(vm.keyFor(bot("bea")));
    expect(vm.deletionRefusal("ada")).toBeNull();
    bots.splice(0, 1);
    vm.botDeleted("ada");
    expect(control.snapshot(DESK).held).toBe(true);
  });

  it("a mode change ends the desktop's hold and every hold whose key moved, and keeps the rest", () => {
    const { control, vm, setMode } = fixture({ mode: "per-bot", bots: [{ id: "ada" }, { id: "cy", computer: "cloud" }] });
    control.take("ada");
    control.take("cy");
    control.take(DESK);
    const changed = vm.modeChanging();
    setMode("shared");
    changed();
    expect([control.snapshot("ada").held, control.snapshot("cy").held, control.snapshot(DESK).held]).toEqual([false, true, false]);
  });
});
