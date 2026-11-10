import { describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import { newerVersion, SERVER_UPDATE_DEADLINE_MS, serverCheckPhase, serverUpdateConfirmBody, serverUpdateRow, serverUpdateView, type ServerUpdateCheck, type ServerUpdateStatus } from "./server-update";

const check = (patch: Partial<ServerUpdateCheck> = {}): ServerUpdateCheck => ({
  current: "0.1.92",
  install: "docker",
  available: false,
  ...patch,
});

describe("self-hosted update row", () => {
  it("offers a check before anything is known", () => {
    expect(serverUpdateRow("idle", null)).toEqual({ label: "Check for updates" });
    expect(serverUpdateRow("checking", null)).toEqual({ label: "Checking for updates…" });
  });

  it("names the new version and how this install is updated", () => {
    const docker = check({ available: true, latest: "0.1.93", command: "git pull && ./update.sh", restart: false });
    expect(serverUpdateRow("available", docker)).toEqual({
      label: "Version 0.1.93 available (release notes)",
      subtitle: "Update with: git pull && ./update.sh",
    });
    const npm = check({ install: "npm", available: true, latest: "0.1.93", command: "npm install -g openmausbot@latest", restart: true });
    expect(serverUpdateRow("available", npm).subtitle).toBe("Update with: npm install -g openmausbot@latest, then restart the app");
    // an install it cannot recognise still learns there is a new version
    expect(serverUpdateRow("available", check({ install: "unknown", available: true, latest: "0.1.93" }))).toEqual({
      label: "Version 0.1.93 available (release notes)",
      subtitle: undefined,
    });
  });

  it("says when it is up to date, and with which version", () => {
    expect(serverUpdateRow("up-to-date", check({ latest: "0.1.92" }))).toEqual({ label: "You're up to date", subtitle: "v0.1.92" });
  });

  it("asks a page older than its server to reload instead of calling it up to date", () => {
    // The server was updated while this page kept running the bundle About reports
    const stale = check({ current: "0.1.114" });
    expect(serverCheckPhase(stale, "0.1.113")).toBe("reload");
    expect(serverUpdateRow("reload", stale, "0.1.113")).toEqual({
      label: "Reload for v0.1.114",
      subtitle: "This page is still running v0.1.113",
    });
  });

  it("keeps the other check results when the page matches or can't tell", () => {
    expect(serverCheckPhase(check({ current: "0.1.114" }), "0.1.114")).toBe("up-to-date");
    expect(serverCheckPhase(check({ current: "0.1.114" }), "dev")).toBe("up-to-date");
    expect(serverCheckPhase(check({ current: "0.1.114", available: true, latest: "0.1.115" }), "0.1.113")).toBe("available");
    expect(serverCheckPhase(check({ current: "0.1.114", install: "desktop" }), "0.1.113")).toBe("up-to-date");
    expect(serverCheckPhase(check({ current: "0.1.114", install: "managed" }), "0.1.113")).toBe("up-to-date");
  });

  it("explains servers that are updated elsewhere", () => {
    expect(serverUpdateRow("up-to-date", check({ install: "desktop" })).label).toBe(
      "Updates come from the MausBot app on the computer these bots run on",
    );
    expect(serverUpdateRow("up-to-date", check({ install: "managed" })).label).toBe("Kept up to date for you");
  });

  it("reports a failed check plainly", () => {
    expect(serverUpdateRow("error", null)).toEqual({ label: "Couldn't check for updates. Try again." });
  });
});

describe("the update row for another server the app shows", () => {
  const npm = check({ current: "0.1.116", install: "npm", available: true, latest: "0.1.127", command: "npm install -g openmausbot@latest", restart: true });

  it("says whose update it is, and that whoever runs that server installs it", () => {
    expect(serverUpdateRow("available", npm, "0.1.116", "Office Mac")).toEqual({
      label: "Office Mac can update to 0.1.127",
      subtitle: "Whoever runs that server updates it with: npm install -g openmausbot@latest, then restarts it",
    });
    const docker = check({ available: true, latest: "0.1.127", command: "git pull && ./update.sh", restart: false });
    expect(serverUpdateRow("available", docker, "0.1.116", "Office Mac").subtitle).toBe(
      "Whoever runs that server updates it with: git pull && ./update.sh",
    );
    expect(serverUpdateRow("up-to-date", check({ current: "0.1.127" }), "0.1.127", "Office Mac")).toEqual({
      label: "Office Mac is up to date",
      subtitle: "v0.1.127",
    });
  });

  it("keeps the rows of servers updated for their owner, and the row of this computer", () => {
    expect(serverUpdateRow("up-to-date", check({ install: "desktop" }), "0.1.116", "Office Mac").label).toBe(
      "Updates come from the MausBot app on the computer these bots run on",
    );
    expect(serverUpdateRow("up-to-date", check({ install: "managed" }), "0.1.116", "Office Mac").label).toBe("Kept up to date for you");
    expect(serverUpdateRow("available", npm, "0.1.116", null).label).toBe("Version 0.1.127 available (release notes)");
  });

  it("says it in German too", () => {
    setLocale("de");
    try {
      expect(serverUpdateRow("available", npm, "0.1.116", "Office Mac")).toEqual({
        label: "Office Mac kann auf 0.1.127 aktualisiert werden",
        subtitle: "Wer diesen Server betreibt, aktualisiert ihn mit: npm install -g openmausbot@latest und startet ihn danach neu",
      });
    } finally {
      setLocale("en");
    }
  });
});

describe("the Update server row", () => {
  const behind = check({ current: "0.1.150", available: true, latest: "0.1.151", command: "git pull && ./update.sh" });
  const button = (patch: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus => ({
    mode: "button", current: "0.1.150", latest: "0.1.151", available: true, activeTurns: 0,
    command: "cd /opt/openmausbot && sudo ./update.sh", rollback: "cd /opt/openmausbot && sudo ./update.sh --rollback",
    logs: "cd /opt/openmausbot && sudo docker compose logs --tail 50 omb", ...patch,
  });
  const view = (input: Partial<Parameters<typeof serverUpdateView>[0]>) => serverUpdateView({ check: behind, status: button(), bundle: "0.1.150", app: null, ...input });

  it("offers Update server to an admin of a server that can update itself", () => {
    expect(view({})).toEqual({ label: "Version 0.1.151 is available for this server", action: "update-server", busy: false });
  });

  it("shows the command instead wherever the button could not work, and to a member", () => {
    const command = { label: "Version 0.1.151 is available for this server", subtitle: "Update with: git pull && ./update.sh", action: null, busy: false };
    expect(view({ status: button({ mode: "command", command: "git pull && ./update.sh", rollback: undefined }) })).toEqual(command);
    expect(view({ status: null })).toEqual(command);
    const npm = check({ install: "npm", available: true, latest: "0.1.151", command: "npm install -g openmausbot@0.1.151", restart: true });
    expect(view({ check: npm, status: button({ mode: "command", command: npm.command }) }).subtitle).toBe("Update with: npm install -g openmausbot@0.1.151, then restart the app");
    expect(view({ status: button({ mode: "held" }) })).toMatchObject({ subtitle: "Updates are on hold on this server.", action: null });
  });

  it("shows nothing to press for this computer's app or a Cloud we run", () => {
    expect(view({ check: check({ install: "managed", available: false }), status: button({ mode: "none" }) })).toEqual({ label: "Kept up to date for you", action: null, busy: false });
    expect(view({ check: check({ install: "desktop", available: false }) }).action).toBeNull();
  });

  it("says the server is updating while it is asked, runs, or the page has lost it", () => {
    const updating = { label: "Updating the server…", subtitle: "It restarts and reconnects by itself. This takes a few minutes.", action: null, busy: true };
    expect(view({ pressed: true })).toEqual(updating);
    expect(view({ status: button({ run: { outcome: "requested", from: "0.1.150", at: 1 } }) })).toEqual(updating);
    expect(view({ status: button({ run: { outcome: "running", from: "0.1.150", at: 1 } }) })).toEqual(updating);
  });

  it("after 15 minutes without the server, says it is not back and what to run on it", () => {
    const running = button({ run: { outcome: "running", from: "0.1.150", at: 1 } });
    expect(view({ status: running, waitedMs: SERVER_UPDATE_DEADLINE_MS - 1 }).label).toBe("Updating the server…");
    expect(SERVER_UPDATE_DEADLINE_MS).toBe(15 * 60_000);
    expect(view({ status: running, waitedMs: SERVER_UPDATE_DEADLINE_MS })).toEqual({
      label: "The server isn't back yet", subtitle: "It has been updating for more than 15 minutes.", action: null, busy: true, noteTone: "danger",
      note: "On the server, run: cd /opt/openmausbot && sudo docker compose logs --tail 50 omb To go back to the version before: cd /opt/openmausbot && sudo ./update.sh --rollback",
    });
    expect(view({ pressed: true, status: null, waitedMs: SERVER_UPDATE_DEADLINE_MS }).label).toBe("The server isn't back yet");
  });

  it("after the update, names the new version and asks this page to reload", () => {
    const after = check({ current: "0.1.151", available: false, latest: "0.1.151" });
    expect(view({ check: after, status: button({ current: "0.1.151", available: false, run: { outcome: "updated", from: "0.1.150", to: "0.1.151", at: 1 } }) })).toEqual({
      label: "Reload for v0.1.151", subtitle: "This page is still running v0.1.150", action: "reload", busy: false, note: "The server is updated to v0.1.151.",
    });
    expect(view({ check: after, bundle: "0.1.151", status: button({ current: "0.1.151", available: false, run: { outcome: "updated", from: "0.1.150", to: "0.1.151", at: 1 } }) })).toMatchObject({
      label: "You're up to date", note: "The server is updated to v0.1.151.",
    });
  });

  it("says plainly when the server went back, and what to run when it could not", () => {
    expect(view({ status: button({ run: { outcome: "rolled-back", from: "0.1.150", to: "0.1.150", at: 1 } }) })).toMatchObject({
      action: "update-server", noteTone: "danger",
      note: "The update didn't work, so the server went back to v0.1.150. Your data is as it was. The reason is in .update/update.log on the server.",
    });
    expect(view({ status: button({ run: { outcome: "rollback-failed", from: "0.1.150", at: 1 } }) }).note).toBe(
      "The update failed, and the server couldn't go back by itself. On the server, run: cd /opt/openmausbot && sudo ./update.sh --rollback",
    );
    expect(view({ status: button({ run: { outcome: "not-changed", reason: "too-soon", from: "0.1.150", at: 1 } }) }).note).toBe(
      "The server wasn't changed. Updates were asked for too often. Try again in a few minutes.",
    );
    expect(view({ status: button({ run: { outcome: "not-started", from: "0.1.150", at: 1 } }) }).note).toBe(
      "The server didn't start the update. On the server, run: systemctl status openmausbot-update.path",
    );
  });

  it("in the desktop app, offers the app's own update once the server is newer, and both when both are behind", () => {
    const current = check({ current: "0.1.151", available: false, latest: "0.1.151" });
    expect(view({ check: current, bundle: "0.1.151", app: "0.1.149", status: button({ available: false, current: "0.1.151" }) })).toEqual({
      label: "This app is on v0.1.149, the server on v0.1.151", action: "update-app", busy: false,
    });
    expect(view({ app: "0.1.149" })).toEqual({ label: "This server can update to 0.1.151, and this app is behind too", action: "update-server", busy: false });
    // An app as new as the server, or newer, is not behind: the skew rule never forces an update.
    expect(view({ check: current, bundle: "0.1.151", app: "0.1.152", status: button({ available: false }) }).action).toBe("check");
    expect(view({ check: current, bundle: "0.1.151", app: "0.1.149", status: button({ available: false }), appAnswer: "downloading" }).note).toBe(
      "This app is getting its update. It installs when you restart the app.",
    );
  });

  it("asks first, saying the server restarts, running work stops, and how much is running", () => {
    const body = "The server restarts to update, so anything running on it stops. This takes a few minutes. If the new version doesn't work, the server goes back to this one by itself.";
    expect(serverUpdateConfirmBody(0)).toBe(body);
    expect(serverUpdateConfirmBody(1)).toBe(`${body} A bot is answering in 1 chat right now.`);
    expect(serverUpdateConfirmBody(3)).toBe(`${body} Bots are answering in 3 chats right now.`);
  });

  it("compares released versions only", () => {
    expect(newerVersion("0.1.151", "0.1.150")).toBe(true);
    expect(newerVersion("0.2.0", "0.1.999")).toBe(true);
    expect(newerVersion("0.1.150", "0.1.150")).toBe(false);
    expect(newerVersion("dev", "0.1.150")).toBe(false);
  });
});
