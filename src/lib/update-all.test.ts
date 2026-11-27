import { beforeEach, describe, expect, it } from "vitest";
import type { Device } from "./devices";
import { setLocale } from "./i18n";
import { SERVER_UPDATE_DEADLINE_MS } from "./server-update";
import { failureText, planUpdateAll, progressText, rowFor } from "./update-all";

const device = (over: Partial<Device> & Pick<Device, "id" | "name" | "kind" | "sources">): Device => ({
  status: "online", route: "internet", routes: ["internet"], canRunBots: false, canHostComputer: false, actions: [], ...over,
});

const here = device({ id: "here", name: "Ada’s MacBook", kind: "laptop", sources: [], here: true, route: "here", routes: ["here"] });
const vps = device({ id: "place:vps", name: "Hetzner box", kind: "server", sources: [{ type: "place", id: "vps" }] });
const nuc = device({ id: "place:nuc", name: "Garage NUC", kind: "desktop", sources: [{ type: "place", id: "nuc" }] });
const npm = device({ id: "place:npm", name: "Office box", kind: "server", sources: [{ type: "place", id: "npm" }] });
const cloud = device({ id: "place:home", name: "Ada’s Cloud", kind: "cloud", sources: [{ type: "place", id: "home" }], home: true });
const oldPhone = device({ id: "phone:p1", name: "Pixel 9", kind: "phone", sources: [{ type: "phone", id: "p1" }] });
const phone = device({ id: "phone:p2", name: "Ada’s iPhone", kind: "phone", sources: [{ type: "phone", id: "p2" }] });
const lent = device({ id: "lent:l1", name: "Lent laptop", kind: "laptop", sources: [{ type: "lent", id: "l1" }] });
const ssh = device({ id: "vps:gpu", name: "GPU box", kind: "server", sources: [{ type: "vps", id: "gpu" }] });
const signedIn = device({ id: "session:s1", name: "Ada’s MacBook Air", kind: "laptop", sources: [{ type: "session", id: "s1" }] });

beforeEach(() => setLocale("en"));

describe("planUpdateAll", () => {
  const servers = [
    { id: "vps", plan: { updates: true as const, current: "0.1.170", latest: "0.1.175", activeTurns: 2 } },
    { id: "nuc", plan: { updates: false as const, why: "admin-only" as const, current: "0.1.170", latest: "0.1.175" } },
    { id: "npm", plan: { updates: false as const, why: "by-hand" as const, command: "npm install -g openmausbot@0.1.175" } },
  ];

  it("lists each updating server with the version it named, then this app last", () => {
    const plan = planUpdateAll({ devices: [here, vps, nuc, npm, cloud], servers, app: { version: "0.1.182", handoff: false } });
    expect(plan.updating).toEqual([
      { deviceId: "place:vps", name: "Hetzner box", text: "To 0.1.175" },
      { deviceId: "here", name: "Ada’s MacBook", text: "This app, to 0.1.182 · restarts last" },
    ]);
    expect(plan.serverIds).toEqual(["vps"]);
    expect(plan.withApp).toBe(true);
    expect(plan.activeTurns).toBe(2);
  });

  it("skips the rest with a plain reason, the by-hand one with its command, and a Cloud as updating by itself", () => {
    const plan = planUpdateAll({ devices: [here, vps, nuc, npm, cloud], servers, app: null });
    expect(plan.skipped).toEqual([
      { deviceId: "place:nuc", name: "Garage NUC", text: "Sign in there as an admin" },
      { deviceId: "place:npm", name: "Office box", text: "Update it by hand", command: "npm install -g openmausbot@0.1.175" },
      { deviceId: "place:home", name: "Ada’s Cloud", text: "Updates by itself" },
    ]);
    expect(plan.withApp).toBe(false);
  });

  it("lists a phone only while it runs an older app, and leaves out machines with no known version", () => {
    const plan = planUpdateAll({ devices: [here, oldPhone, phone, lent, ssh, signedIn], servers: [], app: null, olderPhones: ["p1"] });
    expect(plan.updating).toEqual([]);
    expect(plan.skipped).toEqual([{ deviceId: "phone:p1", name: "Pixel 9", text: "Update from the app store" }]);
  });

  it("names the terminal when this app's update finishes there", () => {
    const plan = planUpdateAll({ devices: [here], servers: [], app: { version: null, handoff: true } });
    expect(plan.updating[0]!.text).toBe("This app · finishes in a terminal, last");
  });

  it("lists nothing to update before the servers have answered", () => {
    expect(planUpdateAll({ devices: [here, vps], servers: null, app: null }).updating).toEqual([]);
  });
});

describe("a row's state", () => {
  it("says what is happening, then the version read back", () => {
    expect(progressText({ phase: "updating", since: 0 }, 1).text).toBe("Updating…");
    expect(progressText({ phase: "restarting", since: 0 }, 1).text).toBe("Restarting…");
    expect(progressText({ phase: "restarting", since: 0 }, SERVER_UPDATE_DEADLINE_MS).text).toBe("The server isn't back yet");
    expect(progressText({ phase: "waiting", since: 0 }, 1).text).toBe("Restarts after the others");
    expect(progressText({ phase: "done", since: 0, latest: "0.1.175", version: "0.1.175" }, 1)).toEqual({ text: "Updated to 0.1.175", busy: false });
  });

  it("words a failure as Settings → Updates does for the same outcome", () => {
    const status = { mode: "button" as const, current: "0.1.170", available: true, activeTurns: 0, run: { outcome: "rolled-back" as const, from: "0.1.170", at: 1 } };
    expect(progressText({ phase: "failed", since: 0, failure: { why: "run", status } }, 1)).toEqual({
      text: "Failed: The update didn't work, so the server went back to v0.1.170. Your data is as it was. The reason is in .update/update.log on the server.", tone: "danger", busy: false,
    });
    expect(failureText({ why: "mismatch", version: "0.1.176" }, "0.1.175")).toBe("It's on 0.1.176, not 0.1.175.");
    expect(failureText({ why: "too-soon" })).toBe("Updates were asked for too often. Try again in a few minutes.");
    expect(failureText({ why: "up-to-date" })).toBe("Up to date");
    expect(failureText({ why: "download" }, undefined, "No network")).toBe("No network");
    expect(failureText({ why: "download" })).toBe("This app couldn't get its update. Try again.");
  });

  it("finds a device's row by its saved server, and this app's for this computer", () => {
    const view = { running: true, rows: { vps: { phase: "updating" as const, since: 0 }, app: { phase: "waiting" as const, since: 0 } } };
    expect(rowFor(view, vps)?.id).toBe("vps");
    expect(rowFor(view, here)?.id).toBe("app");
    expect(rowFor(view, nuc)).toBeNull();
    expect(rowFor(null, vps)).toBeNull();
  });
});
