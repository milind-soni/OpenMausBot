// S4 conformance on real Chrome: the calibrated identity against the headed
// browser and across every kind of target, what a page can tell about the
// driver, Chrome's exit when its controller dies, and the latency targets.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "../../testing/cleanup.ts";
import { hostTimeout, HOST_TIMEOUT_FACTOR } from "../../testing/host-timeout.ts";
import { calibrateIdentity, loadOrCalibrateIdentity, openOwnPage, type CalibratedIdentity } from "../chrome/calibrate.ts";
import { sandboxDisabled } from "../chrome/host-setup.ts";
import { launchChrome } from "../chrome/launch.ts";
import { listProcesses, processAlive } from "../chrome/processes.ts";
import { CdpBrowser } from "./browser.ts";
import { valueInWorld } from "./evaluate.ts";
import { IDENTITY_PROBE, identityDifferences, identityFromProbe, type IdentityProbe } from "./identity.ts";
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from "./page.ts";
import { FixtureServer } from "./testing/fixtures.ts";
import { bareChromeStart, CHROME, FIRST_LAUNCH_MS, forbiddenCommands, HOST, startChrome, testRoot, type RunningChrome } from "./testing/real-chrome.ts";

const suite = CHROME ? describe : describe.skip;
const sandbox = !sandboxDisabled(process.env);
const canShowWindow = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const IDENTITY_PAGE = `<!doctype html><title>identity</title><iframe id="f"></iframe><script>
  const results = {};
  const high = () => navigator.userAgentData.getHighEntropyValues(["fullVersionList", "platformVersion", "architecture", "bitness", "uaFullVersion"]);
  const done = () => { document.body.dataset.results = JSON.stringify(results); };
  addEventListener("message", (event) => { if (event.data && event.data.from === "oopif") { results.oopif = event.data; done(); } });
  document.getElementById("f").src = "http://localhost:" + location.port + "/id-frame";
  (async () => {
    results.page = { ua: navigator.userAgent, high: await high(), webdriver: navigator.webdriver };
    results.worker = await new Promise((resolve) => { const worker = new Worker("/id-worker.js"); worker.onmessage = (event) => resolve(event.data); });
    const registration = await navigator.serviceWorker.register("/id-sw.js");
    const active = registration.active || await new Promise((resolve) => { const pending = registration.installing || registration.waiting; pending.addEventListener("statechange", () => { if (pending.state === "activated") resolve(pending); }); });
    results.serviceWorker = await new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = (event) => resolve(event.data); active.postMessage("who", [channel.port2]); });
    results.headers = await (await fetch("/id-headers?from=page")).json();
    done();
  })();
</script>`;

const WORKER_PROBE = `(async () => ({ ua: navigator.userAgent, high: await navigator.userAgentData.getHighEntropyValues(["fullVersionList", "platformVersion", "architecture", "bitness", "uaFullVersion"]) }))()`;

suite("S4 identity, quietness, exit and speed on real Chrome", () => {
  let fx: FixtureServer;
  let calibrated: CalibratedIdentity;
  const running: RunningChrome[] = [];
  const headerLog: Array<{ path: string; headers: IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    fx = await FixtureServer.start();
    const record = (path: string) => (request: { headers: IncomingHttpHeaders }) => {
      headerLog.push({ path, headers: request.headers });
    };
    const accept = { "accept-ch": "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model" };
    fx.route("/identity", (request) => { record("/identity")(request); return { body: IDENTITY_PAGE, headers: accept }; });
    fx.route("/id-frame", (request) => {
      record("/id-frame")(request);
      return { body: `<!doctype html><script>(async () => parent.postMessage({ from: "oopif", ...(await ${WORKER_PROBE}) }, "*"))()</script>`, headers: accept };
    });
    fx.route("/id-worker.js", { type: "application/javascript", body: `${WORKER_PROBE}.then((data) => postMessage(data));` });
    fx.route("/id-sw.js", {
      type: "application/javascript",
      body: `self.addEventListener("install", () => self.skipWaiting());
        self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
        self.addEventListener("message", (event) => event.waitUntil(${WORKER_PROBE}.then(async (data) => {
          data.headers = await (await fetch("/id-headers?from=sw")).json();
          event.ports[0].postMessage(data);
        })));`,
    });
    fx.route("/id-headers", (request, url) => {
      record(`/id-headers?from=${url.searchParams.get("from")}`)(request);
      return { type: "application/json", body: JSON.stringify(request.headers) };
    });
    calibrated = await calibrateIdentity({ executablePath: CHROME!, host: HOST, tmpRoot: testRoot(), sandbox, handshakeTimeoutMs: FIRST_LAUNCH_MS });
  }, hostTimeout(180_000));

  afterAll(async () => {
    for (const run of running) await run.close();
    await fx?.close();
  });

  it("calibrates the binary's own headed identity, once per binary", async () => {
    expect(calibrated.userAgent).not.toContain("Headless");
    expect(calibrated.userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
    expect(calibrated.product).toMatch(/^Chrome\/\d+\.\d+\.\d+\.\d+$/);
    expect(calibrated.userAgentMetadata.fullVersionList.length).toBeGreaterThan(1);
    expect(calibrated.userAgentMetadata.fullVersion).toBe(calibrated.product.slice("Chrome/".length));
    expect(calibrated.userAgentMetadata.architecture).not.toBe("");
    expect(calibrated.userAgentMetadata.brands.map((brand) => brand.brand).join()).not.toContain("Headless");
    const data = mkdtempSync(join(testRoot(), "omb-cdp-data-"));
    try {
      const first = await loadOrCalibrateIdentity(data, { executablePath: CHROME!, host: HOST, tmpRoot: testRoot(), sandbox });
      const second = await loadOrCalibrateIdentity(data, { executablePath: CHROME!, host: HOST, tmpRoot: testRoot(), sandbox });
      expect(first.calibrated).toBe(true);
      expect(second.calibrated).toBe(false);
      expect(identityDifferences(first.identity, calibrated)).toEqual([]);
    } finally {
      await removeTempDir(data);
    }
  }, hostTimeout(60_000));

  it.runIf(canShowWindow)("matches what the same binary reports in a window, byte for byte", async () => {
    const dir = mkdtempSync(join(testRoot(), "omb-cdp-headed-"));
    const chrome = await launchChrome({ executablePath: CHROME!, userDataDir: join(dir, "profile"), mode: "window", host: HOST, sandbox, windowPosition: { x: -2400, y: -2400 }, handshakeTimeoutMs: FIRST_LAUNCH_MS });
    try {
      const browser = await CdpBrowser.connect(chrome.transport, { identity: null, headless: false, permissions: false });
      const tab = await browser.waitForPage();
      await openOwnPage(tab, fx.page("/blank", "<!doctype html><title>blank</title>"), DEFAULT_NAVIGATION_TIMEOUT_MS);
      const headed = identityFromProbe(await tab.evaluate(IDENTITY_PROBE) as IdentityProbe, chrome.version.product);
      expect(headed.userAgent).toBe(calibrated.userAgent);
      expect(identityDifferences(headed, calibrated)).toEqual([]);
      await browser.close();
    } finally {
      await chrome.close(3_000);
      await removeTempDir(dir);
    }
  }, hostTimeout(150_000));

  it("tells the same identity on the page, a worker, a service worker, a cross-site frame and in request headers", async () => {
    const run = await startChrome("identity", {
      launch: { userAgent: calibrated.userAgent },
      browser: { identity: calibrated, acceptLanguage: "en-US,en" },
    });
    running.push(run);
    const page = await run.browser.waitForPage();
    await page.navigate(fx.url("/identity"));
    await page.waitFor({ target: { selector: "body[data-results*=oopif][data-results*=serviceWorker]" }, timeoutMs: 15_000 });
    const results = JSON.parse(await page.evaluate("document.body.dataset.results") as string) as Record<string, { ua: string; high: Record<string, unknown>; headers?: Record<string, string> }>;
    const metadata = calibrated.userAgentMetadata;
    for (const where of ["page", "worker", "serviceWorker", "oopif"]) {
      expect(results[where]?.ua, where).toBe(calibrated.userAgent);
      expect(results[where]?.high, where).toMatchObject({ fullVersionList: metadata.fullVersionList, platformVersion: metadata.platformVersion, architecture: metadata.architecture, bitness: metadata.bitness });
    }
    expect((results.page as unknown as { webdriver: boolean }).webdriver).toBe(false);
    const fullList = metadata.fullVersionList.map((brand) => `"${brand.brand}";v="${brand.version}"`).join(", ");
    for (const { path, headers } of headerLog) {
      expect(headers["user-agent"], path).toBe(calibrated.userAgent);
      // Chrome sends no client hints with a service worker's own fetches, headed or not.
      if (!path.endsWith("from=sw")) expect(headers["sec-ch-ua"], path).toBe(metadata.brands.map((brand) => `"${brand.brand}";v="${brand.version}"`).join(", "));
    }
    const fetched = headerLog.filter(({ path }) => path.startsWith("/id-headers"));
    expect(fetched.map(({ path }) => path).sort()).toEqual(["/id-headers?from=page", "/id-headers?from=sw"]);
    expect(fetched.find(({ path }) => path.endsWith("page"))?.headers["sec-ch-ua-full-version-list"]).toBe(fullList);
    expect((results as unknown as { headers: Record<string, string> }).headers["accept-language"]).toBe("en-US,en;q=0.9");
  }, hostTimeout(60_000));

  it("leaves nothing a page can detect: one Error.name read per console.log while the driver works", async () => {
    const run = await startChrome("quiet", { launch: { userAgent: calibrated.userAgent }, browser: { identity: calibrated } });
    running.push(run);
    const page = await run.browser.waitForPage();
    await page.navigate(fx.page("/probe", `<!doctype html><title>probe</title><button id="b" onclick="this.dataset.clicked = 'yes'">probe button</button><input id="i"><script>
      let iterations = 0, reads = 0;
      setInterval(() => {
        iterations++;
        const error = new Error("probe");
        Object.defineProperty(error, "name", { configurable: true, get() { reads++; return "Error"; } });
        console.log(error);
        document.body.dataset.probe = JSON.stringify({ iterations, reads, webdriver: navigator.webdriver, chrome: typeof window.chrome });
      }, 40);
    </script>`));
    for (let round = 0; round < 3; round++) {
      await page.snapshot();
      await page.click({ selector: "#b" });
      await page.fill({ selector: "#i" }, `round ${round}`);
      await page.evaluate("document.title");
      await page.screenshot();
      await page.waitFor({ ms: 200 });
    }
    const probe = JSON.parse(await page.evaluate("document.body.dataset.probe") as string) as { iterations: number; reads: number; webdriver: boolean; chrome: string };
    expect(probe.iterations).toBeGreaterThan(10);
    expect(probe.reads / probe.iterations).toBe(1);
    expect(probe.webdriver).toBe(false);
    expect(probe.chrome).toBe("object");
  }, hostTimeout(60_000));

  it("runs none of the browser UI headless never shows: no omnibox popups, no top-chrome renderer", async () => {
    const run = await startChrome("browser-ui");
    running.push(run);
    const page = await run.browser.waitForPage();
    await page.navigate(fx.page("/plain", "<!doctype html><title>plain</title><p>plain page</p>"));
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const { targetInfos } = await run.browser.connection.root.send<{ targetInfos: Array<{ type: string; url: string }> }>("Target.getTargets", { filter: [{}] });
    expect(targetInfos.filter((target) => target.type === "browser_ui").map((target) => target.url)).toEqual([]);
    const processes = (await listProcesses()) ?? [];
    const tree = new Set([run.chrome.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const listed of processes) if (tree.has(listed.ppid) && !tree.has(listed.pid)) { tree.add(listed.pid); grew = true; }
    }
    // A Linux renderer can show its zygote's command line, so only renderers that name their type are checked.
    const renderers = processes.filter((listed) => tree.has(listed.pid) && listed.args.includes("--type=renderer"));
    expect(renderers.filter((listed) => listed.args.includes("--top-chrome-webui"))).toEqual([]);
  }, hostTimeout(60_000));

  it("lets Chrome exit within 5 seconds of the process that launched it being killed", async () => {
    const dir = mkdtempSync(join(testRoot(), "omb-cdp-hold-"));
    const script = fileURLToPath(new URL("./testing/hold-chrome.ts", import.meta.url));
    const holder = spawn(process.execPath, [script, CHROME!, join(dir, "profile"), HOST, sandbox ? "1" : "0"], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      const { pid } = await new Promise<{ pid: number }>((resolve, reject) => {
        let out = "";
        holder.stdout!.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]!) as { pid: number });
        });
        holder.once("exit", (code) => reject(new Error(`the holder exited (${code}) before Chrome started`)));
      });
      expect(processAlive(pid)).toBe(true);
      const killedAt = Date.now();
      holder.kill("SIGKILL");
      while (processAlive(pid) && Date.now() - killedAt < 10_000) await new Promise((resolve) => setTimeout(resolve, 50));
      const exitMs = Date.now() - killedAt;
      console.log(`chrome exited ${exitMs} ms after its controller was killed`);
      expect(processAlive(pid)).toBe(false);
      expect(exitMs).toBeLessThanOrEqual(5_000);
    } finally {
      await waitForExit(holder, { signal: "SIGKILL" });
      await removeTempDir(dir);
    }
  }, hostTimeout(60_000));

  it("meets the driver's latency targets", async () => {
    const coldPage = fx.page("/cold", "<!doctype html><title>cold</title><p>first page</p>");
    const bareStarts: number[] = [];
    const coldStarts: number[] = [];
    for (let i = 0; i < 10; i++) {
      bareStarts.push(await bareChromeStart(coldPage));
      const started = Date.now();
      const cold = await startChrome(`cold-${i}`, { takeFirstNavigation: false });
      const first = await cold.browser.waitForPage();
      await openOwnPage(first, coldPage, DEFAULT_NAVIGATION_TIMEOUT_MS);
      coldStarts.push(Date.now() - started);
      await cold.close();
    }
    const run = await startChrome("latency", { launch: { userAgent: calibrated.userAgent }, browser: { identity: calibrated } });
    running.push(run);
    const page = await run.browser.waitForPage();
    const rows = Array.from({ length: 300 }, (_, i) => `<tr><td>Row ${i}</td><td>Value ${i * 7}</td><td>Note ${i % 13}</td><td><a href="#r${i}">open ${i}</a></td><td><button onclick="this.dataset.n = (+this.dataset.n || 0) + 1">act ${i}</button></td></tr>`).join("");
    const big = fx.page("/big", `<!doctype html><title>big</title><input id="field" aria-label="Field"><table>${rows}</table>`);
    await page.navigate(big);
    const { tree } = await page.snapshot();
    const button = /- button "act 150" \[ref=(e\d+)\]/.exec(tree)![1]!;
    const nodes = await page.session.send<{ nodes: unknown[] }>("Accessibility.getFullAXTree", {});
    const timed = async (work: () => Promise<unknown>) => {
      const started = performance.now();
      await work();
      return performance.now() - started;
    };
    const sample = async (work: () => Promise<unknown>, times = 20) => {
      const samples: number[] = [];
      for (let i = 0; i < times; i++) samples.push(await timed(work));
      return samples;
    };
    // Chrome's own click on this machine: a frame, then the driver's mouse events with none of its checks.
    const at = await valueInWorld<{ x: number; y: number }>(page.frames, page.frames.mainFrameId, `(() => { const box = document.querySelectorAll("button")[150].getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
    const bareClick = async () => {
      await valueInWorld(page.frames, page.frames.mainFrameId, "new Promise((resolve) => requestAnimationFrame(resolve))", { awaitPromise: true });
      for (const [type, buttons] of [["mouseMoved", 0], ["mousePressed", 1], ["mouseReleased", 0]] as const) {
        await page.session.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
      }
    };
    const bareClicks: number[] = [];
    const click: number[] = [];
    for (let i = 0; i < 20; i++) {
      bareClicks.push(await timed(bareClick));
      click.push(await timed(() => page.click({ ref: button })));
    }
    const fill = await sample(() => page.fill({ selector: "#field" }, "twenty characters!!!"));
    const type = await sample(() => page.type({ selector: "#field" }, "typed twenty chars.."));
    const snapshot = await sample(() => page.snapshot());
    const small = fx.page("/small", `<!doctype html><title>small</title><h1>Small page</h1><a href="#x">a link</a><button>a button</button><input aria-label="q">`);
    const openOverhead: number[] = [];
    for (let i = 0; i < 10; i++) {
      await page.navigate(small);
      const started = performance.now();
      await page.snapshot();
      openOverhead.push(performance.now() - started);
    }
    const report = (samples: number[]) => ({ p50: Math.round(percentile(samples, 50)), p95: Math.round(percentile(samples, 95)) });
    // Of ten starts the slowest may be the runner alone, so the tail is the second slowest.
    const starts = (samples: number[]) => ({ p50: Math.round(percentile(samples, 50)), p90: Math.round(percentile(samples, 90)) });
    const chrome = { start: starts(bareStarts), click: report(bareClicks) };
    const measured = { axNodes: nodes.nodes.length, coldStart: starts(coldStarts), click: report(click), fill: report(fill), type20: report(type), snapshot: report(snapshot), openSnapshotOverhead: report(openOverhead) };
    console.log(`omb-cdp latency (ms): ${JSON.stringify(measured)}; Chrome alone: ${JSON.stringify(chrome)}`);
    expect(nodes.nodes.length).toBeGreaterThan(2_500);
    const factor = HOST_TIMEOUT_FACTOR;
    // On a machine where Chrome alone takes longer than a target (a shared CI runner), the driver may add only its budget.
    const target = (ms: number, chromeAlone: number, budget: number) => Math.max(ms * factor, chromeAlone + budget * factor);
    expect(measured.click.p50).toBeLessThanOrEqual(target(120, chrome.click.p50, 60));
    expect(measured.click.p95).toBeLessThanOrEqual(target(300, chrome.click.p95, 150));
    expect(measured.fill.p50).toBeLessThanOrEqual(80 * factor);
    expect(measured.fill.p95).toBeLessThanOrEqual(200 * factor);
    expect(measured.type20.p50).toBeLessThanOrEqual(250 * factor);
    expect(measured.type20.p95).toBeLessThanOrEqual(500 * factor);
    expect(measured.snapshot.p50).toBeLessThanOrEqual(600 * factor);
    expect(measured.snapshot.p95).toBeLessThanOrEqual(1_500 * factor);
    expect(measured.openSnapshotOverhead.p50).toBeLessThanOrEqual(400 * factor);
    expect(measured.openSnapshotOverhead.p95).toBeLessThanOrEqual(1_000 * factor);
    const coldTarget = HOST === "desktop" ? 1_500 : 2_500;
    expect(measured.coldStart.p50).toBeLessThanOrEqual(target(coldTarget, chrome.start.p50, 500));
    expect(measured.coldStart.p90).toBeLessThanOrEqual(target(coldTarget * 2, chrome.start.p90, 1_000));
  }, hostTimeout(180_000));

  it("sent nothing that enables Runtime, binds into pages or evaluates in the page's world uninvited", () => {
    expect(forbiddenCommands()).toEqual([]);
  });
});
