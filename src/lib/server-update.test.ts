import { describe, expect, it } from "vitest";

import { serverUpdateRow, type ServerUpdateCheck } from "./server-update";

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
    const docker = check({ available: true, latest: "0.1.93", command: "docker compose pull omb && docker compose up -d", restart: false });
    expect(serverUpdateRow("available", docker)).toEqual({
      label: "Version 0.1.93 available — release notes",
      subtitle: "Update with: docker compose pull omb && docker compose up -d",
    });
    const npm = check({ install: "npm", available: true, latest: "0.1.93", command: "npm install -g openmausbot@latest", restart: true });
    expect(serverUpdateRow("available", npm).subtitle).toBe("Update with: npm install -g openmausbot@latest, then restart the server");
    // an install it cannot recognise still learns there is a new version
    expect(serverUpdateRow("available", check({ install: "unknown", available: true, latest: "0.1.93" }))).toEqual({
      label: "Version 0.1.93 available — release notes",
      subtitle: undefined,
    });
  });

  it("says when it is up to date, and with which version", () => {
    expect(serverUpdateRow("up-to-date", check({ latest: "0.1.92" }))).toEqual({ label: "You're up to date", subtitle: "v0.1.92" });
  });

  it("explains servers that are updated elsewhere", () => {
    expect(serverUpdateRow("up-to-date", check({ install: "desktop" })).label).toBe(
      "Updated from the OpenMausBot app on the computer running this server",
    );
    expect(serverUpdateRow("up-to-date", check({ install: "managed" })).label).toBe("This server is kept up to date for you");
  });

  it("reports a failed check plainly", () => {
    expect(serverUpdateRow("error", null)).toEqual({ label: "Couldn't check for updates — try again" });
  });
});
