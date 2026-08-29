/* oxlint-disable anti-slop/no-runtime-typeof -- Node HTTP and JSON are untyped I/O boundaries in this dependency-free Electron harness. */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function assertInside(root, candidate, label) {
  const path = relative(resolve(root), resolve(candidate));
  if (path.startsWith("..") || isAbsolute(path)) throw new Error(`${label} escaped its root`);
}

async function freePort() {
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", accept);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("loopback port probe failed");
  await new Promise((accept) => probe.close(accept));
  return address.port;
}

async function waitForHttp(origin, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) throw new Error(`product server exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/api/bots`);
      if (response.ok) return;
    } catch {}
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error("product server did not become ready within 30 seconds");
}

async function api(origin, path, init) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function seedSyntheticProfile(origin) {
  const snapshot = await api(origin, "/api/bots");
  const bot = Array.isArray(snapshot.bots) ? snapshot.bots[0] : undefined;
  if (!bot || typeof bot.id !== "string") throw new Error("synthetic product server did not seed a bot");
  await api(origin, `/api/bots/${encodeURIComponent(bot.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: "Atlas",
      title: "Fixture operator",
      description: "A generic synthetic operator used only by the local product journey.",
      autoApprove: false,
    }),
  });
  await api(origin, "/api/account-directory", {
    method: "POST",
    body: JSON.stringify({
      identity: "Fixture Profile",
      provider: "github",
      accountId: "ca_fixture_alpha",
      source: "local",
      sourceId: "benchmark-fixture-v1",
      observedAt: "2026-08-28T12:00:00.000Z",
      evidenceRef: "fixture:account-directory:v1",
    }),
  });
  return { botId: bot.id };
}

async function seedSyntheticEngine(dataRoot, repoRoot) {
  const fakeCli = `"${process.execPath}" "${join(repoRoot, "benchmarks", "agent-centipede", "canonical-action-fake-acp.mjs")}"`;
  await writeFile(join(dataRoot, "config.json"), `${JSON.stringify({
    instances: {
      benchmark: {
        driver: "cursorAgent",
        displayName: "Fixture Engine",
        environment: {
          FAKE_ACP_AUTH: "1",
          FAKE_ACP_MODE: "canonical-action",
          FAKE_ACP_ACTION_DUMP: join(dataRoot, "synthetic-action-receipts.ndjson"),
        },
        config: { cli: fakeCli },
      },
    },
  }, null, 2)}\n`, "utf8");
}

function safeStaticPath(distRoot, requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl ?? "/", "http://127.0.0.1").pathname);
  const candidate = resolve(distRoot, `.${pathname}`);
  assertInside(distRoot, candidate, "static request");
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return join(distRoot, "index.html");
}

async function createGateway({ distRoot, upstreamPort, outputDir, label }) {
  const ledger = join(outputDir, `network-${label}.ndjson`);
  await writeFile(ledger, "", "utf8");
  const record = (entry) => appendFile(ledger, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  const server = createServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
    if (path.startsWith("/api/")) {
      const upstream = httpRequest({
        host: "127.0.0.1",
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
        void record({ method: incoming.method ?? "GET", path, status: response.statusCode ?? 0 });
      });
      upstream.once("error", (error) => {
        outgoing.writeHead(502, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "local benchmark upstream unavailable" }));
        void record({ method: incoming.method ?? "GET", path, status: 502, error: error.name });
      });
      incoming.pipe(upstream);
      return;
    }
    let target;
    try {
      target = safeStaticPath(distRoot, incoming.url);
    } catch {
      outgoing.writeHead(400);
      outgoing.end();
      return;
    }
    const extension = extname(target);
    if (extension === ".html") {
      void readFile(target, "utf8").then((html) => {
        const bootstrap = "<script>localStorage.setItem('omb-email-gate','skipped');localStorage.setItem('omb-analytics-opt-out','1');</script>";
        const body = html.replace("<head>", `<head>${bootstrap}`);
        outgoing.writeHead(200, { "cache-control": "no-store", "content-type": CONTENT_TYPES[extension] });
        outgoing.end(body);
        void record({ method: incoming.method ?? "GET", path, status: 200 });
      });
      return;
    }
    outgoing.writeHead(200, { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream" });
    createReadStream(target).pipe(outgoing);
    void record({ method: incoming.method ?? "GET", path, status: 200 });
  });
  const port = await freePort();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((accept) => server.close(accept)),
  };
}

function sanitizedEnvironment(stateRoot, dataRoot, serverPort) {
  const keep = ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"];
  const env = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  const isolatedHome = join(stateRoot, "home");
  const isolatedTemp = join(stateRoot, "temp");
  return {
    ...env,
    PATH: dirname(process.execPath),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(isolatedHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
    TMP: isolatedTemp,
    TEMP: isolatedTemp,
    OMB_BENCHMARK: "1",
    OMB_DATA_DIR: dataRoot,
    OMB_PORT: String(serverPort),
    OMB_WEBHOOK_PORT: String(serverPort + 1),
  };
}

function findBrowserExecutable() {
  const candidates = [
    process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : "",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Microsoft Edge is unavailable for the isolated local benchmark");
  return executable;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((accept) => child.once("close", accept)),
    new Promise((accept) => setTimeout(accept, 5_000)),
  ]);
}

export async function runProductJourneyHost({ repoRoot, stateRoot, outputDir, mode }) {
  const absoluteRepo = resolve(repoRoot);
  const absoluteState = resolve(stateRoot);
  const absoluteOutput = resolve(outputDir);
  assertInside(absoluteRepo, absoluteState, "synthetic state root");
  assertInside(absoluteRepo, absoluteOutput, "benchmark output root");
  const dataRoot = join(absoluteState, "data");
  const distRoot = join(absoluteRepo, "dist");
  if (!existsSync(join(distRoot, "index.html"))) throw new Error("dist/index.html is required; build the product before the journey");
  await mkdir(absoluteOutput, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await mkdir(join(absoluteState, "home", "AppData", "Roaming"), { recursive: true });
  await mkdir(join(absoluteState, "home", "AppData", "Local"), { recursive: true });
  await mkdir(join(absoluteState, "temp"), { recursive: true });
  if (mode === "drive" && (await readdir(dataRoot)).length > 0) throw new Error("drive mode requires an empty synthetic data root");
  if (mode === "drive") await seedSyntheticEngine(dataRoot, absoluteRepo);

  const serverPort = await freePort();
  const environment = sanitizedEnvironment(absoluteState, dataRoot, serverPort);
  const serverChild = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
    cwd: absoluteRepo,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  serverChild.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
  serverChild.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
  let gateway;
  try {
    const serverOrigin = `http://127.0.0.1:${serverPort}`;
    await waitForHttp(serverOrigin, serverChild);
    if (mode === "drive") await seedSyntheticProfile(serverOrigin);
    gateway = await createGateway({ distRoot, upstreamPort: serverPort, outputDir: absoluteOutput, label: mode });
    const configPath = join(absoluteState, `browser-${mode}.json`);
    const browserResult = join(absoluteOutput, `${mode}-visual.json`);
    const browserProfile = join(absoluteState, `browser-profile-${mode}`);
    await mkdir(browserProfile, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ mode, origin: gateway.origin, outputDir: absoluteOutput, resultFile: browserResult, browserExecutable: findBrowserExecutable(), browserProfile })}\n`, "utf8");
    const browserChild = spawn(process.execPath, [join(absoluteRepo, "benchmarks", "agent-centipede", "product-journey-browser.mjs"), configPath], {
      cwd: absoluteRepo,
      env: { ...environment, OMB_PRODUCT_JOURNEY_CONFIG: configPath },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let browserOutput = "";
    browserChild.stdout.setEncoding("utf8").on("data", (chunk) => { browserOutput += chunk; });
    browserChild.stderr.setEncoding("utf8").on("data", (chunk) => { browserOutput += chunk; });
    const browserCode = await new Promise((accept) => browserChild.once("close", accept));
    await unlink(configPath).catch(() => {});
    if (browserCode !== 0) throw new Error(`isolated browser journey failed (${browserCode}): ${browserOutput.slice(-4_000)}`);
    const visual = JSON.parse(await readFile(browserResult, "utf8"));
    const work = await api(serverOrigin, "/api/work?limit=200");
    const journal = JSON.parse(await readFile(join(dataRoot, "work-orchestrator.json"), "utf8"));
    const result = {
      schemaVersion: 1,
      mode,
      passed: visual.passed === true,
      visual,
      work: work.work,
      journal: {
        entries: Array.isArray(journal.entries)
          ? journal.entries.map((entry) => ({ workId: entry.workId, kind: entry.kind, phase: entry.phase }))
          : [],
      },
      isolation: {
        dataRoot: relative(absoluteRepo, dataRoot).replaceAll("\\", "/"),
        externalSystemsTouched: 0,
        realProfileRead: false,
      },
    };
    await writeFile(join(absoluteOutput, `${mode}-result.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } catch (error) {
    const suffix = serverOutput.slice(-2_000);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix ? `\nProduct server tail:\n${suffix}` : ""}`);
  } finally {
    await gateway?.close();
    await stopChild(serverChild);
  }
}
