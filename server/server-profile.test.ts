import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { detectBox, type BoxDetection } from "./bot-box/detect.ts";
import { resolveLoopbackTrust } from "./request-auth.ts";
import { PROFILE_REFUSED_EXIT_CODE, admittedSignIns, startServerProfile, type ProfileBootOptions } from "./server-profile-boot.ts";
import {
  OPERATOR_TOKEN_FILE, profileOutcome, readOperatorToken, resolveServerProfile, signInListsFor, startLogLines, wideningVerdict,
  type ProfileFacts, type ServerProfile,
} from "./server-profile.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function dataDir(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-profile-"));
  roots.push(dir);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

const facts = (over: Partial<ProfileFacts> = {}): ProfileFacts => ({
  env: {}, platform: "linux", desktopManaged: false, cloudHome: false, hostedWorkspace: false, signIn: { admins: [], members: [] }, ...over,
});
const BOXED: Pick<BoxDetection, "box" | "reason"> = { box: "bwrap", reason: null };
const off = (reason: BoxDetection["reason"]): Pick<BoxDetection, "box" | "reason"> => ({ box: "off", reason });
const IN_USE = { sessions: [{ id: "s1" }] };

describe("which profile a server runs", () => {
  it("leaves a server only its one owner signs in to as it was, on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(resolveServerProfile(facts({ platform }))).toMatchObject({ name: "standard", reason: "one-owner", shared: false });
      expect(resolveServerProfile(facts({ platform, signIn: { admins: ["me@example.com"], members: [] } }))).toMatchObject({ name: "standard", reason: "one-owner" });
    }
  });

  it("is hardened wherever more than one person can sign in", () => {
    const shared: Partial<ProfileFacts>[] = [
      { signIn: { admins: ["me@example.com"], members: ["you@example.com"] } },
      { signIn: { admins: ["me@example.com", "her@example.com"], members: [] } },
      { signIn: { admins: ["@example.com"], members: [] } },
      { hostedWorkspace: true },
      { env: { OMB_LICENSE_KEY: "omb1.some.key" } },
    ];
    for (const over of shared) {
      for (const platform of ["linux", "darwin", "win32"] as const) {
        expect(resolveServerProfile(facts({ ...over, platform })), JSON.stringify(over)).toMatchObject({ name: "hardened", required: true, shared: true });
      }
    }
  });

  it("is hardened in the server image on Linux, as a default a host that cannot box may fall short of", () => {
    expect(resolveServerProfile(facts({ env: { OMB_IMAGE: "server" } }))).toMatchObject({ name: "hardened", reason: "server-image", required: false, shared: false });
    expect(resolveServerProfile(facts({ env: { OMB_IMAGE: "server" }, platform: "darwin" })).name).toBe("standard");
  });

  it("never changes the desktop app, and a Cloud home is always hardened", () => {
    const everything = { env: { OMB_IMAGE: "server", OMB_PROFILE: "hardened" }, signIn: { admins: ["@example.com"], members: ["x@example.com"] } };
    expect(resolveServerProfile(facts({ ...everything, desktopManaged: true }))).toMatchObject({ name: "standard", reason: "desktop-app" });
    expect(resolveServerProfile(facts({ cloudHome: true, env: { OMB_PROFILE: "standard" } }))).toMatchObject({ name: "hardened", reason: "cloud-home", warning: expect.stringContaining("ignored") });
  });

  it("has one switch: OMB_PROFILE asks for the profile or declines it, and an unknown value means hardened", () => {
    expect(resolveServerProfile(facts({ env: { OMB_PROFILE: "hardened" } }))).toMatchObject({ name: "hardened", reason: "requested", required: true });
    expect(resolveServerProfile(facts({ env: { OMB_PROFILE: "standard", OMB_IMAGE: "server" } }))).toEqual({ name: "standard", reason: "switched-off", required: false, shared: false });
    const declined = resolveServerProfile(facts({ env: { OMB_PROFILE: "standard" }, signIn: { admins: [], members: ["you@example.com"] } }));
    expect(declined).toMatchObject({ name: "standard", shared: true });
    expect(declined.warning).toMatch(/more than one person can sign in.*AI keys.*change its settings, including who may sign in/);
    expect(resolveServerProfile(facts({ env: { OMB_PROFILE: "off; rm -rf" } }))).toMatchObject({ name: "hardened", required: true, warning: expect.stringContaining("is not hardened or standard") });
  });

  it("is never turned on by itself in a checkout run from source, which says so when it is shared; OMB_PROFILE still decides", () => {
    const members = { admins: ["me@example.com"], members: ["you@example.com"] };
    const source = resolveServerProfile(facts({ fromSource: true, signIn: members, env: { OMB_IMAGE: "server", OMB_LICENSE_KEY: "omb1.some.key" } }));
    expect(source).toMatchObject({ name: "standard", reason: "from-source", shared: true });
    expect(source.warning).toMatch(/runs from source.*more than one person can sign in.*Set OMB_PROFILE=hardened/);
    expect(resolveServerProfile(facts({ fromSource: true }))).toEqual({ name: "standard", reason: "from-source", required: false, shared: false });
    expect(resolveServerProfile(facts({ fromSource: true, signIn: members, env: { OMB_PROFILE: "auto" } }))).toMatchObject({ name: "hardened", reason: "shared", required: true });
    expect(resolveServerProfile(facts({ fromSource: true, env: { OMB_PROFILE: "hardened" } }))).toMatchObject({ name: "hardened", reason: "requested" });
    expect(resolveServerProfile(facts({ fromSource: true, env: { OMB_PROFILE: "auto" } }))).toMatchObject({ name: "standard", reason: "one-owner" });
    expect(resolveServerProfile(facts({ signIn: members, env: { OMB_PROFILE: "auto" } }))).toMatchObject({ name: "hardened", reason: "shared" });
    expect(resolveServerProfile(facts({ fromSource: true, cloudHome: true })).name).toBe("hardened");
  });

  it("reads the sign-in lists as the server does: config.json, and the environment's when set", () => {
    const dir = dataDir({ "config.json": { signIn: { admins: ["me@example.com"], members: ["you@example.com"] } } });
    expect(signInListsFor(dir, {})).toEqual({ admins: ["me@example.com"], members: ["you@example.com"] });
    expect(signInListsFor(dir, { OMB_SIGNIN_MEMBER_EMAILS: "" })).toEqual({ admins: ["me@example.com"], members: [] });
    expect(signInListsFor(dir, { OMB_SIGNIN_EMAILS: "A@example.com, @Example.com" }).admins).toEqual(["a@example.com", "@example.com"]);
    expect(signInListsFor(dataDir(), {})).toEqual({ admins: [], members: [] });
  });
});

describe("what the profile turns on", () => {
  it("boxes turns by default, as on a Cloud home; without it the box stays off outside a Cloud", () => {
    const tools = { which: (name: string) => `/usr/bin/${name}`, probe: () => true, platform: "linux" as const };
    expect(detectBox({ env: {}, ...tools }).reason).toBe("not-cloud");
    expect(detectBox({ env: {}, ...tools, hardened: true }).box).toBe("bwrap");
    expect(detectBox({ env: { OMB_BOT_BOX: "0" }, ...tools, hardened: true })).toMatchObject({ box: "off", reason: "switched-off" });
    expect(detectBox({ env: {}, ...tools, hardened: true, probe: () => false })).toMatchObject({ box: "off", reason: "userns-refused" });
    expect(detectBox({ env: {}, ...tools, hardened: true, which: () => null })).toMatchObject({ box: "off", reason: "no-bwrap" });
    expect(detectBox({ env: {}, ...tools, hardened: true, platform: "darwin" })).toMatchObject({ box: "off", reason: "not-linux" });
  });

  it("makes a local request without a session a service's, never the owner's, and closes the worker's routes to it", () => {
    expect(resolveLoopbackTrust({ env: {}, desktopManaged: false, hostedWorkspace: false })).toMatchObject({ trust: "owner", relay: true });
    expect(resolveLoopbackTrust({ env: {}, desktopManaged: false, hostedWorkspace: false, hardened: true })).toMatchObject({ trust: "service", reason: "hardened profile", relay: false });
    expect(resolveLoopbackTrust({ env: {}, desktopManaged: true, hostedWorkspace: false, hardened: true }).trust).toBe("owner");
    const optedOut = resolveLoopbackTrust({ env: { OMB_LOOPBACK_TRUST: "owner" }, desktopManaged: false, hostedWorkspace: false, hardened: true });
    expect(optedOut.trust).toBe("owner");
    expect(optedOut.warning).toMatch(/hardened profile: every bot's shell can change settings/);
    expect(resolveLoopbackTrust({ env: { OMB_LOOPBACK_TRUST: "service" }, desktopManaged: false, hostedWorkspace: false })).toMatchObject({ trust: "service", relay: true });
    expect(resolveLoopbackTrust({ env: {}, desktopManaged: false, hostedWorkspace: true, hardened: true })).toMatchObject({ trust: "service", reason: "hosted workspace", relay: true });
  });
});

describe("a server that cannot box its bots", () => {
  const shared: ServerProfile = { name: "hardened", reason: "shared", required: true, shared: true };
  const image: ServerProfile = { name: "hardened", reason: "server-image", required: false, shared: false };
  const fresh = { inUse: false, hardenedBefore: false }, inUse = { inUse: true, hardenedBefore: false };

  it("runs the whole profile where the box works", () => {
    expect(profileOutcome(shared, BOXED, fresh)).toEqual({ state: "hardened" });
    expect(profileOutcome(image, BOXED, inUse)).toEqual({ state: "hardened" });
    expect(profileOutcome({ ...shared, name: "standard" }, off("not-cloud"), inUse)).toEqual({ state: "standard" });
  });

  it("does not start a new shared server unboxed, and says what to fix in one sentence", () => {
    const fixes = { "userns-refused": /unprivileged user namespaces are off.*seccomp and AppArmor profiles.*sysctl/, "no-bwrap": /apt-get install -y bubblewrap/, "switched-off": /OMB_BOT_BOX=0/ } as const;
    for (const [reason, fix] of Object.entries(fixes)) {
      const outcome = profileOutcome(shared, off(reason as BoxDetection["reason"]), fresh);
      expect(outcome.state).toBe("refused");
      if (outcome.state !== "refused") continue;
      expect(outcome.message).toMatch(/^OpenMausBot did not start: more than one person can sign in to this server/);
      expect(outcome.message).toMatch(fix);
      expect(outcome.message).toMatch(/Nothing was changed\. To run without the sandbox anyway, set OMB_PROFILE=standard/);
      expect(outcome.message).not.toMatch(/\n/);
    }
  });

  it("keeps a shared server people already use running, as a service, and never quietly", () => {
    const outcome = profileOutcome(shared, off("userns-refused"), inUse);
    expect(outcome).toEqual({ state: "unboxed", fault: "userns-refused", serviceTrust: true });
    const [line] = startLogLines(shared, outcome as never);
    expect(line).toMatchObject({ level: "warn" });
    expect(line!.line).toMatch(/the bots are NOT sandboxed.*anyone who can chat with a bot can make it read this server's AI keys/);
  });

  it("leaves a one-owner server in the image exactly as it was when its host cannot box, and warns", () => {
    for (const record of [fresh, inUse]) {
      expect(profileOutcome(image, off("userns-refused"), record)).toEqual({ state: "unboxed", fault: "userns-refused", serviceTrust: false });
    }
  });

  it("never drops out of the profile once it has run: a box that stops working stops the server", () => {
    for (const profile of [shared, image]) {
      const outcome = profileOutcome(profile, off("userns-refused"), { inUse: true, hardenedBefore: true });
      expect(outcome.state).toBe("refused");
      if (outcome.state === "refused") expect(outcome.message).toMatch(/ran its bots in a sandbox before, and now it can't/);
    }
  });

  it("has no box on macOS or Windows: a shared server there still stops trusting local requests, and is told", () => {
    for (const record of [fresh, inUse, { inUse: true, hardenedBefore: true }]) {
      expect(profileOutcome(shared, off("not-linux"), record)).toEqual({ state: "unboxed", fault: "not-linux", serviceTrust: true });
    }
  });
});

describe("taking more people", () => {
  const one = { admins: ["me@example.com"], members: [] }, two = { admins: ["me@example.com"], members: ["you@example.com"] };
  const standard: ServerProfile = { name: "standard", reason: "one-owner", required: false, shared: false };
  const image: ServerProfile = { name: "hardened", reason: "server-image", required: false, shared: false };
  const never = () => { throw new Error("the box must not be probed here"); };

  it("is refused where the bots cannot be boxed, with the fault to fix", () => {
    expect(wideningVerdict({ profile: image, outcome: { state: "unboxed", fault: "userns-refused", serviceTrust: false }, current: one, next: two, canBox: never })).toEqual({ refuse: "userns-refused" });
    expect(wideningVerdict({ profile: standard, outcome: { state: "standard" }, current: one, next: two, canBox: () => "no-bwrap" })).toEqual({ refuse: "no-bwrap" });
  });

  it("stands where they can be, and the profile starts with the next start", () => {
    expect(wideningVerdict({ profile: standard, outcome: { state: "standard" }, current: one, next: two, canBox: () => null })).toBe("restart");
    expect(wideningVerdict({ profile: standard, outcome: { state: "standard" }, current: one, next: two, canBox: () => "not-linux" })).toBe("restart");
    expect(wideningVerdict({ profile: image, outcome: { state: "hardened" }, current: one, next: two, canBox: never })).toBeNull();
  });

  it("never stops a change that adds nobody, removes someone, or keeps a server one person's", () => {
    const unboxed = { state: "unboxed", fault: "userns-refused", serviceTrust: true } as const;
    const shared: ServerProfile = { name: "hardened", reason: "shared", required: true, shared: true };
    expect(wideningVerdict({ profile: shared, outcome: unboxed, current: two, next: one, canBox: never })).toBeNull();
    expect(wideningVerdict({ profile: shared, outcome: unboxed, current: two, next: two, canBox: never })).toBeNull();
    expect(wideningVerdict({ profile: standard, outcome: { state: "standard" }, current: { admins: [], members: [] }, next: one, canBox: never })).toBeNull();
    expect(wideningVerdict({ profile: shared, outcome: unboxed, current: two, next: { ...two, members: ["you@example.com", "new@example.com"] }, canBox: never })).toEqual({ refuse: "userns-refused" });
    for (const reason of ["switched-off", "from-source", "desktop-app"] as const) {
      expect(wideningVerdict({ profile: { name: "standard", reason, required: false, shared: false }, outcome: { state: "standard" }, current: one, next: two, canBox: never }), reason).toBeNull();
    }
  });
});

describe("starting a server in its profile", () => {
  class Refused extends Error {}
  const boot = (over: Partial<ProfileBootOptions> & Pick<ProfileBootOptions, "dataDir">, detection = BOXED) => {
    const lines: string[] = [];
    const wanted: boolean[] = [], guarded: boolean[] = [];
    const started = startServerProfile({
      port: 1, cloudHome: false, env: {}, platform: "linux", fromSource: false, checkLayout: () => ({ hidden: true }), log: (level, line) => lines.push(`${level}: ${line}`),
      startBox: async (hardened, guardHome) => { wanted.push(hardened); guarded.push(guardHome); return hardened ? detection : off("not-cloud"); },
      refuse: (message) => { throw new Refused(message); },
      ...over,
    });
    return { started, lines, wanted, guarded };
  };
  const SHARED_ENV = { OMB_SIGNIN_EMAILS: "me@example.com", OMB_SIGNIN_MEMBER_EMAILS: "you@example.com" };

  it("changes nothing for one owner: no box asked for, owner trust, no token, no notice, nothing written", async () => {
    const dir = dataDir({ "sessions.json": IN_USE });
    const { started, wanted, lines } = boot({ dataDir: dir });
    const profile = await started;
    expect(wanted).toEqual([false]);
    expect(profile).toMatchObject({ boxed: false, serviceTrust: false, operatorToken: undefined, boxesBrowser: false });
    expect(profile.status()).toEqual({ profile: "standard", boxed: false });
    expect(lines).toEqual(["log: server profile: standard (one-owner)"]);
    expect(() => statSync(join(dir, "server-profile.json"))).toThrow();
    expect(() => statSync(join(dir, OPERATOR_TOKEN_FILE))).toThrow();
  });

  it("turns the whole profile on for a shared server, and tells an admin once when the server was already in use", async () => {
    const dir = dataDir({ "sessions.json": IN_USE });
    const first = await boot({ dataDir: dir, env: SHARED_ENV }).started;
    expect(first).toMatchObject({ boxed: true, serviceTrust: true, boxesBrowser: true });
    expect(first.status()).toEqual({ profile: "hardened", boxed: true, notice: { kind: "on" } });
    expect(first.operatorToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readOperatorToken(dir)).toBe(first.operatorToken);
    if (process.platform !== "win32") expect(statSync(join(dir, OPERATOR_TOKEN_FILE)).mode & 0o077).toBe(0);

    const again = await boot({ dataDir: dir, env: SHARED_ENV }).started;
    expect(again.status().notice).toEqual({ kind: "on" });
    expect(again.operatorToken).not.toBe(first.operatorToken);
    again.dismissNotice();
    expect(again.status()).toEqual({ profile: "hardened", boxed: true });
    expect((await boot({ dataDir: dir, env: SHARED_ENV }).started).status().notice).toBeUndefined();
  });

  it("guards HOME where it is a person's own or others' bots work in it, and not in the image one owner runs or on a Cloud", async () => {
    const guards = async (over: Partial<ProfileBootOptions>) => { const run = boot({ dataDir: dataDir(), ...over }); await run.started; return run.guarded; };
    expect(await guards({ env: SHARED_ENV })).toEqual([true]);
    expect(await guards({ env: { ...SHARED_ENV, OMB_IMAGE: "server" } })).toEqual([true]);
    expect(await guards({ env: { OMB_PROFILE: "hardened" } })).toEqual([true]);
    expect(await guards({ env: { OMB_IMAGE: "server" } })).toEqual([false]);
    expect(await guards({})).toEqual([false]);
    expect(await guards({ cloudHome: true })).toEqual([false]);
  });

  it("says nothing to a new server that starts hardened", async () => {
    const profile = await boot({ dataDir: dataDir(), env: SHARED_ENV }).started;
    expect(profile.status()).toEqual({ profile: "hardened", boxed: true });
  });

  it("stops a new shared server that cannot box, before anything is written, with a code no launcher restarts on", async () => {
    const dir = dataDir();
    await expect(boot({ dataDir: dir, env: SHARED_ENV }, off("userns-refused")).started).rejects.toThrow(/did not start: more than one person can sign in/);
    expect(() => statSync(join(dir, "server-profile.json"))).toThrow();
    expect(PROFILE_REFUSED_EXIT_CODE).not.toBe(RESTART_EXIT_CODE);
    expect(PROFILE_REFUSED_EXIT_CODE).not.toBe(0);
  });

  it("keeps a shared server in use running unboxed with a notice that stays, and takes nobody new", async () => {
    const dir = dataDir({ "sessions.json": IN_USE, [OPERATOR_TOKEN_FILE]: "stale" });
    const { started, lines } = boot({ dataDir: dir, env: SHARED_ENV }, off("no-bwrap"));
    const profile = await started;
    expect(profile).toMatchObject({ boxed: false, serviceTrust: true, operatorToken: undefined });
    expect(() => statSync(join(dir, OPERATOR_TOKEN_FILE))).toThrow();
    expect(lines.join("\n")).toMatch(/warn: server profile: hardened \(shared\), but the bots are NOT sandboxed: Install bubblewrap/);
    const notice = { kind: "unboxed", fault: "no-bwrap", shared: true, dismissible: false };
    expect(profile.status().notice).toEqual(notice);
    profile.dismissNotice();
    expect(profile.status().notice).toEqual(notice);
    const lists = { admins: ["me@example.com"], members: ["you@example.com"] };
    expect(profile.wideningRefusal(lists, { ...lists, members: [...lists.members, "new@example.com"] })).toBe("no-bwrap");
    expect(profile.wideningRefusal(lists, { ...lists, members: [] })).toBeNull();
  });

  it("stops a server that ran the profile and no longer can", async () => {
    const dir = dataDir({ "sessions.json": IN_USE });
    await boot({ dataDir: dir, env: { OMB_IMAGE: "server" } }).started;
    expect(JSON.parse(readFileSync(join(dir, "server-profile.json"), "utf8")).hardenedSince).toMatch(/^\d{4}-/);
    await expect(boot({ dataDir: dir, env: { OMB_IMAGE: "server" } }, off("userns-refused")).started).rejects.toThrow(/ran its bots in a sandbox before/);
    expect((await boot({ dataDir: dir, env: { OMB_IMAGE: "server", OMB_PROFILE: "standard" } }, off("userns-refused")).started).serviceTrust).toBe(false);
  });

  it("tells the one owner of an image whose host cannot box once, keeps owner trust, and refuses to become shared", async () => {
    const dir = dataDir();
    const profile = await boot({ dataDir: dir, env: { OMB_IMAGE: "server" } }, off("userns-refused")).started;
    expect(profile).toMatchObject({ boxed: false, serviceTrust: false, operatorToken: undefined });
    expect(profile.status().notice).toEqual({ kind: "unboxed", fault: "userns-refused", shared: false, dismissible: true });
    expect(profile.wideningRefusal({ admins: [], members: [] }, { admins: ["me@example.com"], members: ["you@example.com"] })).toBe("userns-refused");
    profile.dismissNotice();
    expect(profile.status().notice).toBeUndefined();
    const { started, lines } = boot({ dataDir: dir, env: { OMB_IMAGE: "server" } }, off("userns-refused"));
    expect((await started).status().notice).toBeUndefined();
    expect(lines.join("\n")).toMatch(/NOT sandboxed/);
  });

  it("asks a standard server that takes a second person to start again, when its host can box", async () => {
    const profile = await boot({ dataDir: dataDir(), probeBox: () => BOXED }).started;
    expect(profile.wideningRefusal({ admins: ["me@example.com"], members: [] }, { admins: ["me@example.com"], members: ["you@example.com"] })).toBeNull();
    expect(profile.status()).toEqual({ profile: "standard", boxed: false, notice: { kind: "restart" } });
    const cannot = await boot({ dataDir: dataDir(), probeBox: () => off("userns-refused") }).started;
    expect(cannot.wideningRefusal({ admins: [], members: [] }, { admins: [], members: ["you@example.com"] })).toBe("userns-refused");
    expect(cannot.status().notice).toBeUndefined();
  });

  it("does not say hardened over a data folder a boxed shell can still read, and writes nothing", async () => {
    const dir = dataDir({ "sessions.json": IN_USE });
    const visible = boot({ dataDir: dir, env: SHARED_ENV, checkLayout: () => ({ hidden: false, why: "a bot can see /var/lib/openmausbot/config.json" }) });
    await expect(visible.started).rejects.toThrow(/sandbox is on, but it does not keep the server's own files from them here: a bot can see \/var\/lib\/openmausbot\/config\.json/);
    expect(() => statSync(join(dir, "server-profile.json"))).toThrow();
    expect(() => statSync(join(dir, OPERATOR_TOKEN_FILE))).toThrow();
    let asked = 0;
    await boot({ dataDir: dataDir(), checkLayout: () => { asked += 1; return { hidden: false, why: "x" }; } }).started;
    await boot({ dataDir: dataDir({ "sessions.json": IN_USE }), env: SHARED_ENV, checkLayout: () => { asked += 1; return { hidden: false, why: "x" }; } }, off("no-bwrap")).started;
    expect(asked, "only a boxed server is checked").toBe(0);
  });

  it("holds a sign-in list that lets a second person in until the next start, however it was changed", async () => {
    const one = { admins: ["me@example.com"], members: [] as string[] }, two = { admins: ["me@example.com"], members: ["you@example.com"] };
    const { started, lines } = boot({ dataDir: dataDir() });
    const profile = await started;
    expect(admittedSignIns(one)).toBe(one);
    expect(profile.status().notice).toBeUndefined();
    // Edited on disk (openmausbot access add): no route saw it, and it still lets nobody new in.
    expect(admittedSignIns(two)).toBe(one);
    expect(admittedSignIns({ admins: ["@example.com"], members: [] })).toBe(one);
    expect(profile.status().notice).toEqual({ kind: "restart" });
    expect(lines.filter((line) => line.includes("held as it was"))).toHaveLength(1);
    // Taken back: nothing is owed.
    expect(admittedSignIns(one)).toBe(one);
    expect(profile.status().notice).toBeUndefined();

    // An image whose host cannot box holds too; where the profile is on, or was declined, the list is as saved.
    await boot({ dataDir: dataDir(), env: { OMB_IMAGE: "server" } }, off("userns-refused")).started;
    expect(admittedSignIns(two)).toEqual({ admins: [], members: [] });
    await boot({ dataDir: dataDir(), env: SHARED_ENV }).started;
    expect(admittedSignIns(two)).toBe(two);
    for (const env of [{ OMB_PROFILE: "standard" }, {}]) {
      await boot({ dataDir: dataDir(), env, fromSource: env.OMB_PROFILE === undefined }).started;
      expect(admittedSignIns(two), JSON.stringify(env)).toBe(two);
    }
    // A shared server that cannot box keeps the people it started with and lets nobody new in, even from the disk.
    await boot({ dataDir: dataDir({ "sessions.json": IN_USE, "config.json": { signIn: two } }) }, off("no-bwrap")).started;
    expect(admittedSignIns(two)).toBe(two);
    expect(admittedSignIns({ admins: ["me@example.com", "boss@example.com"], members: ["You@Example.com", "new@example.com"] })).toEqual({ admins: ["me@example.com"], members: ["You@Example.com"] });
    expect(admittedSignIns({ admins: ["me@example.com"], members: [] })).toEqual({ admins: ["me@example.com"], members: [] });
  });

  it("leaves a Cloud home to its own rules: boxed by its role, no token, no notice", async () => {
    const dir = dataDir();
    const { started, wanted } = boot({ dataDir: dir, cloudHome: true }, off("userns-refused"));
    const profile = await started;
    expect(wanted).toEqual([false]);
    expect(profile).toMatchObject({ serviceTrust: true, operatorToken: undefined, boxesBrowser: false });
    expect(profile.status().notice).toBeUndefined();
    expect(() => statSync(join(dir, "server-profile.json"))).toThrow();
  });
});
