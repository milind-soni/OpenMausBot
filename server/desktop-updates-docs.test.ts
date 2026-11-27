// Pins the "Desktop updates" page to the updater code it describes: the page tells the person which of the three install
// routes their build takes, and each route's wording has to match what electron/updater.mjs actually does for that build.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canInstallElevated } from "../electron/elevated-install.mjs";
import { HAND_OFF_PACKAGE_TYPES, packageInstallCommand } from "../electron/package-install-command.mjs";
import { updateWords } from "../electron/update-words.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = readFileSync(join(ROOT, "apps", "docs", "content", "docs", "troubleshooting", "updates.mdx"), "utf8");
const flat = (text: string) => text.replace(/\s+/gu, " ");

/** The table row whose first cell is exactly `build`, as the page renders it. */
function row(build: string): string {
  const line = PAGE.split(/\r?\n/u).find((candidate) => candidate.startsWith(`| ${build} |`));
  expect(line, `the page has no table row for ${build}`).toBeDefined();
  return flat(line!);
}

describe("Desktop updates page", () => {
  it("gives the Ubuntu .deb the password prompt the updater actually shows, not a terminal hand-off", () => {
    // electron/updater.mjs: a .deb is one of HAND_OFF_PACKAGE_TYPES, and it installs in place through pkexec when
    // canInstallElevated() says a prompt can be shown; the terminal hand-off is what remains when it cannot.
    expect(HAND_OFF_PACKAGE_TYPES).toContain("deb");
    const deb = row("Ubuntu `.deb`");
    expect(deb).toContain("asks for your password once in the system's own prompt");
    expect(deb).toContain("installs it with `apt-get` so new dependencies are resolved");
    expect(deb).toContain("it copies the `sudo apt-get install` line and opens a terminal");
    // The claim this page used to make, and the one the removed paragraph repeated: a .deb never asks for a password.
    expect(PAGE).not.toMatch(/never asks for your administrator password/u);
    expect(PAGE).not.toMatch(/never installs a system package itself/u);
  });

  it("keeps the terminal hand-off for the package types the updater only ever hands over", () => {
    // rpm and pacman have no elevated path: canInstallElevated answers false for everything that is not a .deb.
    expect(canInstallElevated({ platform: "linux", env: { DISPLAY: ":0" } })).toBe(false);
    expect(canInstallElevated({ platform: "darwin", env: { DISPLAY: ":0" } })).toBe(false);
    // The command the hand-off copies for each type is the one the page quotes.
    expect(packageInstallCommand("rpm", "/tmp/x.rpm")).toBe("sudo rpm -Uvh '/tmp/x.rpm'");
    expect(packageInstallCommand("pacman", "/tmp/x.pacman")).toBe("sudo pacman -U '/tmp/x.pacman'");
    expect(packageInstallCommand("deb", "/tmp/x.deb")).toBe("sudo apt-get install -y '/tmp/x.deb'");
    const fedora = row("Fedora `.rpm`, Arch `pacman`");
    expect(fedora).toContain("copies the install command, and opens a terminal");
    expect(fedora).toContain("It never installs an `.rpm` or `pacman` package itself");
    expect(flat(PAGE)).toContain("On Fedora, use `sudo rpm -Uvh`");
    expect(flat(PAGE)).toContain("on Arch, `sudo pacman -U`");
  });

  it("quotes the progress line the person sees while the password prompt is up", () => {
    const shown = updateWords("native.update.installing").message;
    expect(shown).toBe("Installing the update. Enter your password if asked.");
    expect(flat(PAGE)).toContain("Closing the prompt leaves the update ready to try again.");
    expect(flat(PAGE)).toContain("only after it matches the checksum in the update feed");
  });

  it("names the switch that forces the terminal route", () => {
    // electron/elevated-install.mjs: `OMB_UPDATE_INSTALL=terminal` opts out of the prompt entirely.
    expect(canInstallElevated({ platform: "linux", env: { DISPLAY: ":0", OMB_UPDATE_INSTALL: "terminal" } })).toBe(false);
    expect(flat(PAGE)).toContain("Set `OMB_UPDATE_INSTALL=terminal` to always take the terminal route.");
  });
});
