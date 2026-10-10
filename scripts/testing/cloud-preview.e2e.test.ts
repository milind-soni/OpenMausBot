// The real panels, image decoder and fetch cancellation in a disposable
// browser/server. Only the cloud provider transport is simulated.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { mountPreview, type MountedPreview } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
interface FixtureInfo { ui: string; url: string; dataDir: string; logPath: string }

describe("cloud preview recovery in the real renderer", () => {
  let child: ChildProcess | undefined;
  let preview: MountedPreview | undefined;
  afterAll(async () => {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await preview?.close();
  });

  (enabled ? it : it.skip)("retains frames, retries contention, and pauses capture during desktop opening", async () => {
    let stdout = "";
    let stderr = "";
    let info: FixtureInfo;
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const select = (name: string, value: string) => evaluate(`(() => {
      const select = document.querySelector('select[aria-label=${JSON.stringify(name)}]');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const currentFrame = () => evaluate("document.querySelector('aside img, img[alt^=\"Screen of\"]')?.getAttribute('src') ?? document.querySelector('img')?.getAttribute('src') ?? null");
    const frameVisible = () => evaluate("Array.from(document.querySelectorAll('img')).some(img => img.src === window.cloudPreviewFixture.screenshot && img.complete && img.naturalWidth > 1 && getComputedStyle(img).visibility === 'visible')");
    const stat = (key: string) => evaluate(`window.cloudPreviewFixture.${key}`);
    const pause = (ms: number) => evaluate(`new Promise(resolve => setTimeout(() => resolve(true), ${ms}))`);

    preview = await mountPreview({ info: { url: info!.url } }, {
      entry: "/scripts/testing/cloud-preview.tsx", route: "/__cloud-preview.html", title: "Isolated cloud preview regression", logLevel: "silent",
    });
    await evaluate(`location.href = ${JSON.stringify(preview.previewUrl)}; true`);
    await expect.poll(frameVisible, { timeout: 20_000 }).toBe(true);

    // A selected thread's surface and model win over its profile defaults.
    // Auto uses the server's existing VM, never an inferred host desktop.
    for (const scenario of ["vm-pin", "auto-vm"]) {
      await select("Conversation surface", scenario);
      await expect.poll(currentFrame, { timeout: 6000 }).toBe(await stat("vmScreenshot"));
      expect((await stat("paths") as string[]).some((path) => path.endsWith(`/local-computer/screenshot?threadId=fixture-${scenario}`))).toBe(true);
      expect(await snapshot()).not.toContain("The selected model engine cannot use a Local VM");
    }
    await select("Conversation surface", "off");
    await expect.poll(currentFrame, { timeout: 5000 }).toBe(null);
    await select("Screenshot response", "held");
    await select("Conversation surface", "vm-pin");
    await expect.poll(() => stat("vmPending"), { timeout: 6000 }).toBe(true);
    const beforeCloudPin = await stat("paths") as string[];
    const provisions = beforeCloudPin.filter((path) => path.endsWith("/computer/provision")).length;
    await select("Screenshot response", "connected");
    await select("Conversation surface", "cloud-pin");
    await expect.poll(frameVisible, { timeout: 6000 }).toBe(true);
    await click("Release VM capture");
    await pause(200);
    expect(await currentFrame()).toBe(await stat("screenshot"));
    expect((await stat("paths") as string[]).filter((path) => path.endsWith("/computer/provision"))).toHaveLength(provisions);
    expect((await stat("paths") as string[]).some((path) => path.endsWith("/computer/screenshot?threadId=fixture-cloud-pin"))).toBe(true);
    await evaluate(`document.querySelector('button[aria-label$="live desktop"]')?.click(); true`);
    await expect.poll(() => stat("joining"), { timeout: 3000 }).toBe(true);
    await select("Conversation surface", "vm-pin");
    await expect.poll(() => stat("abortedJoins"), { timeout: 3000 }).toBe(1);
    await expect.poll(currentFrame, { timeout: 6000 }).toBe(await stat("vmScreenshot"));
    await click("Release desktop join");
    expect(await stat("opened")).toBe(0);
    await select("Conversation surface", "browser-pin");
    await expect.poll(() => evaluate('document.querySelector("[data-tour=computer-browser]")?.getAttribute("aria-pressed")'), { timeout: 5000 }).toBe("true");
    await click("Browser"); // Save it manually, as a real person can.
    await select("Conversation surface", "vm-pin");
    await expect.poll(currentFrame, { timeout: 6000 }).toBe(await stat("vmScreenshot"));
    expect(await evaluate('document.querySelector("[data-tour=computer-tabs] button")?.getAttribute("aria-pressed")')).toBe("true");
    await select("Conversation surface", "browser-pin");
    await expect.poll(() => evaluate('document.querySelector("[data-tour=computer-browser]")?.getAttribute("aria-pressed")'), { timeout: 5000 }).toBe("true");
    await click("Routines");
    await pause(200);
    expect(await evaluate('document.querySelector("[data-tour=computer-browser]")?.getAttribute("aria-pressed")')).toBe("false");
    await select("Conversation surface", "default");
    await evaluate('document.querySelector("[data-tour=computer-tabs] button")?.click(); true');
    await expect.poll(frameVisible, { timeout: 6000 }).toBe(true);
    const beforeBusy = await stat("paths") as string[];
    const busyProvisions = beforeBusy.filter((path) => path.endsWith("/computer/provision")).length;
    await click("Busy: false");
    await pause(200);
    expect(await frameVisible()).toBe(true);
    expect((await stat("paths") as string[]).filter((path) => path.endsWith("/computer/provision"))).toHaveLength(busyProvisions);
    await click("Routines");
    await click("Busy: true");
    await pause(200);
    expect(await evaluate('Array.from(document.querySelectorAll("[data-tour=computer-tabs] button")).find(button => button.textContent.includes("Routines"))?.getAttribute("aria-pressed")')).toBe("true");
    await evaluate('document.querySelector("[data-tour=computer-tabs] button")?.click(); true');
    await expect.poll(frameVisible, { timeout: 6000 }).toBe(true);

    // Busy changes must not cancel an expensive capture. A real abort does
    // not terminate its simulated host work; the next generation sees409.
    await select("Screenshot response", "held");
    await click("Busy: false");
    await expect.poll(() => stat("capturing"), { timeout: 6000 }).toBe(true);
    const requests = await stat("requests");
    await click("Busy: true");
    await pause(200);
    expect(await stat("aborted")).toBe(0);
    expect(await stat("requests")).toBe(requests);
    await click("Reconnect panel");
    await expect.poll(() => stat("conflicts"), { timeout: 5000 }).toBeGreaterThan(0);
    expect(await stat("aborted")).toBe(1);
    expect(await snapshot()).not.toContain("Couldn't connect to the screen");
    await select("Screenshot response", "connected");
    await click("Release held capture");
    await expect.poll(frameVisible, { timeout: 5000 }).toBe(true);
    expect(await currentFrame()).toBe(await stat("screenshot"));

    // Retrying an error preserves the decoded image.409 is quiet for a
    // short recovery window, then becomes actionable without stopping retries.
    await select("Screenshot response", "failed");
    await click("Busy: false");
    await expect.poll(snapshot, { timeout: 6000 }).toContain("Retry preview");
    expect(await frameVisible()).toBe(true);
    await select("Screenshot response", "contended");
    await click("Retry preview");
    await expect.poll(snapshot, { timeout: 3000 }).not.toContain("Retry preview");

    expect(await frameVisible()).toBe(true);
    await expect.poll(snapshot, { timeout: 14_000 }).toContain("Retry preview");
    expect(await frameVisible()).toBe(true);
    await select("Screenshot response", "connected");
    await expect.poll(snapshot, { timeout: 5000 }).not.toContain("Retry preview");
    await select("Screenshot response", "unconfigured");
    await expect.poll(snapshot, { timeout: 6000 }).toContain("VPS is not configured");
    expect(await frameVisible()).toBe(true);
    await select("Screenshot response", "connected");
    await click("Retry preview");
    await expect.poll(snapshot, { timeout: 3000 }).not.toContain("Retry preview");

    // An undecodable frame is not worth preserving: retry starts a clean
    // loader rather than redisplaying the old corrupt image's error.
    await select("Screenshot response", "corrupt");
    await expect.poll(snapshot, { timeout: 6000 }).toContain("Retry preview");
    await select("Screenshot response", "slow");
    await click("Retry preview");
    expect(await snapshot()).toContain("Connecting to the screen…");
    expect(await snapshot()).not.toContain("Retry preview");
    await select("Screenshot response", "connected");
    await expect.poll(frameVisible, { timeout: 15_000 }).toBe(true);

    // Desktop join/control owns the UI while it is pending. Neither panel
    // should continue issuing screenshot polls into that operation.
    for (const panel of ["computer", "remote"]) {
      if (panel === "remote") {
        await select("Panel", "remote");
        await expect.poll(frameVisible, { timeout: 5000 }).toBe(true);
        await select("Screenshot response", "held");
        await expect.poll(() => stat("capturing"), { timeout: 6000 }).toBe(true);
        const aborted = await stat("aborted");
        const requested = await stat("requests");
        await click("Busy: true");
        await pause(200);
        expect(await stat("aborted")).toBe(aborted);
        expect(await stat("requests")).toBe(requested);
        await click("Reconnect panel");
        await expect.poll(() => stat("aborted"), { timeout: 3000 }).toBe(aborted + 1);
        expect(await snapshot()).not.toContain("Preview unavailable");
        await select("Screenshot response", "connected");
        await click("Release held capture");
        await expect.poll(frameVisible, { timeout: 5000 }).toBe(true);
        await click("Busy: false");
      }
      await expect.poll(frameVisible, { timeout: 5000 }).toBe(true);
      const state = await ui("snapshot", "--interactive");
      const target = Object.entries(state.refs as Record<string, { role: string; name: string }>)
        .find(([, entry]) => entry.role === "button" && entry.name.startsWith("Open ") && entry.name.endsWith("live desktop"));
      expect(target).toBeDefined();
      await ui("click", "--ref", `@${target![0]}`);
      await expect.poll(() => stat("joining"), { timeout: 5000 }).toBe(true);
      const before = await stat("requests");
      await pause(4500);
      expect(await stat("requests")).toBe(before);
      expect(await stat("duringJoin")).toBe(0);
      await click("Release desktop join");
      await expect.poll(() => stat("joining")).toBe(false);
    }
    process.stdout.write(`${JSON.stringify({ fixture: info!, previewUrl: preview.previewUrl, transport: "simulated; panels and browser real" })}\n`);
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(existsSync(info!.dataDir)).toBe(false);
    expect(existsSync(info!.logPath)).toBe(true);
  }, 720_000);
});
