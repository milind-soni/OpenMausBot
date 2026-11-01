#!/usr/bin/env -S node --experimental-strip-types
// The desktop app's performance baseline, on isolated fixtures only: a temporary HOME and data folder per server, the
// fake engine, and a headless Chrome with its own profile. Prints one JSON object, so a change can show before/after.
//   node --experimental-strip-types scripts/bench-desktop.ts [--only bundle,server,start,idle,stream,big,routines]
//     [--chrome PATH] [--idle-seconds 30] [--bots 150] [--threads 300] [--messages 2000] [--advanced] [--out FILE] [--keep]
//     [--screenshots DIR]
// bundle: the production build's first-load JavaScript and which libraries it pulls in eagerly.
// server: fixture server spawn to /api/health, from source and as the packaged bundle with its compile cache.
// start: page load to the sidebar and the last chat drawn; JavaScript the page downloads.
// idle: CPU, timer and frame callbacks, React commits and server work with nothing happening (and the rail's page).
// stream: one long streamed reply with tool calls: commits, components rendered per commit, main-thread time per
//   server frame, long tasks, server frames and file writes, on a React profiling build of the same app.
// big: a seeded workspace (bots, threads, one long conversation): start-up routes, page load, scrolling, memory,
//   thread switch and read-marker writes, and a streamed reply there.
// routines: routines.json with a full run history: its route, and the bytes one run rewrites.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, statSync, writeFileSync, createReadStream } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { runControlOmb, verificationServerArgs, verificationServerEnvironment } from "./control-omb.ts";
import { installedChrome } from "./testing/control-omb-ui.ts";
import { FRAMES_START, FRAMES_STOP, launchChrome, switchExpression, TRANSCRIPT_BOX, type Chrome, type Page } from "./testing/bench-desktop-page.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHASES = ["bundle", "server", "start", "idle", "stream", "big", "routines"] as const;
const { values } = parseArgs({
  options: {
    only: { type: "string" },
    chrome: { type: "string" },
    "idle-seconds": { type: "string", default: "30" },
    bots: { type: "string", default: "150" },
    threads: { type: "string", default: "300" },
    messages: { type: "string", default: "2000" },
    advanced: { type: "boolean", default: false },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    screenshots: { type: "string" },
  },
});
const only = new Set((values.only ?? PHASES.join(",")).split(",").map((phase) => phase.trim()).filter(Boolean));
for (const phase of only) if (!(PHASES as readonly string[]).includes(phase)) throw new Error(`unknown phase ${phase}; phases: ${PHASES.join(", ")}`);
const IDLE_MS = Number(values["idle-seconds"]) * 1000;
const STORAGE = { "omb-analytics-opt-out": "1", "omb-email-gate": "skipped", "omb-simple-mode-prompt": "1", "omb-advanced-mode": values.advanced ? "1" : "0" };
const log = (line: string) => process.stderr.write(`bench-desktop: ${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const median = (samples: number[]) => { const sorted = [...samples].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN; };
const percentile = (samples: number[], p: number) => { const sorted = [...samples].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? NaN; };
const kb = (bytes: number) => round(bytes / 1024);
const work = mkdtempSync(join(tmpdir(), "openmausbot-bench-work-"));
const cleanups: Array<() => Promise<void>> = [];

// A long markdown answer the fake engine streams in small chunks, after a run of tool calls.
const LONG_REPLY = Array.from({ length: 14 }, (_, i) => [
  `## Part ${i + 1}`,
  `This section walks through **step ${i + 1}** of the plan with enough words to wrap a few lines in the chat, a [link](https://example.com/${i}) and \`inline code\`.`,
  "- one point\n- another point with more detail\n- a third point",
  i % 3 === 0 ? `\`\`\`ts\n${Array.from({ length: 10 }, (_, line) => `const value${line} = compute(${line}, "part-${i}");`).join("\n")}\n\`\`\`` : "",
  i % 4 === 1 ? "| Name | Count | Share |\n|---|---:|---:|\n| Alpha | 12 | 40% |\n| Beta | 9 | 30% |\n| Gamma | 9 | 30% |" : "",
].filter(Boolean).join("\n\n")).join("\n\n");
const TOOL_CALLS = ["Bash", "Read", "Grep", "WebFetch", "Edit", "Bash"].map((name, i) => ({ name, input: { command: `step ${i}` }, ok: true }));
const STREAM_ENV = {
  FAKE_CLAUDE_REPLIES: JSON.stringify([LONG_REPLY, LONG_REPLY, LONG_REPLY]),
  FAKE_CLAUDE_STREAM_CADENCE: "6:10",
  FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(TOOL_CALLS),
};

interface Tally { cpu: { user: number; system: number }; memory: { rss: number; heapUsed: number }; fired: Record<string, number>; intervals: Record<string, number>; writes: Record<string, { bytes: number; calls: number }>; fsyncs: number; renames: number }
interface Fixture {
  url: string; dataDir: string; pid: number; readyMs: number; logPath: string;
  api(method: string, path: string, body?: unknown): Promise<{ status: number; ms: number; bytes: number; body: any }>;
  tally(): Promise<Tally>;
  close(keepData?: boolean): Promise<void>;
}

function platformEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function newDataDir(): string {
  const dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "openmausbot-bench-"));
  mkdirSync(join(dir, "tmp"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false },
    language: "en",
    instances: { claude: { driver: "claudeAgent", displayName: "Bench fixture", config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") } } },
  }, null, 2));
  return dir;
}

/** One fake-engine server on its own data folder, with the tally hook. `bundle` runs the packaged server entry instead of source. */
async function startFixture(options: { dataDir?: string; staticDir?: string; fake?: Record<string, string>; bundle?: { entry: string; cache: string } } = {}): Promise<Fixture> {
  const dataDir = options.dataDir ?? newDataDir();
  const port = await freePortBlock([0, 1]);
  const env = verificationServerEnvironment(platformEnv(options.fake), dataDir, port);
  const tallyPath = join(dataDir, "bench-tally.json");
  env.OMB_BENCH_TALLY = tallyPath;
  if (options.staticDir) env.OMB_STATIC_DIR = options.staticDir;
  if (options.bundle) env.OMB_SERVER_COMPILE_CACHE = options.bundle.cache;
  const hook = ["--import", pathToFileURL(join(ROOT, "scripts", "testing", "bench-server-tally.mjs")).href];
  const args = options.bundle ? [...hook, options.bundle.entry] : [...hook, ...verificationServerArgs(env)];
  const logPath = join(work, `server-${port}.log`);
  const logFd = openSync(logPath, "a", 0o600);
  const started = performance.now();
  const child: ChildProcess = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  const url = `http://127.0.0.1:${port}`;
  let readyMs = NaN;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json() as { app?: string }).app === "openmausbot") { readyMs = performance.now() - started; break; }
    } catch { /* not listening yet */ }
    await sleep(25);
  }
  let closed = false;
  const fixture: Fixture = {
    url, dataDir, pid: child.pid!, readyMs, logPath,
    async api(method, path, body) {
      const at = performance.now();
      const response = await fetch(`${url}${path}`, { method, headers: { origin: url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      const ms = performance.now() - at;
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, ms, bytes: Buffer.byteLength(text), body: parsed };
    },
    async tally() {
      const before = existsSync(tallyPath) ? statSync(tallyPath).mtimeMs : 0;
      child.kill("SIGUSR2");
      for (let i = 0; i < 100; i++) {
        if (existsSync(tallyPath) && statSync(tallyPath).mtimeMs !== before) {
          try { return JSON.parse(readFileSync(tallyPath, "utf8")) as Tally; } catch { /* mid-write */ }
        }
        await sleep(20);
      }
      throw new Error("the fixture server did not write its tally");
    },
    async close(keepData = false) {
      if (closed) return;
      closed = true;
      await waitForExit(child, { signal: "SIGTERM" });
      if (!keepData && !values.keep) await removeTempDir(dataDir);
    },
  };
  cleanups.push(() => fixture.close());
  if (!Number.isFinite(readyMs)) throw new Error(`fixture server did not become ready; see ${logPath}`);
  return fixture;
}

function tallyDelta(before: Tally, after: Tally) {
  const writes: Record<string, { kb: number; calls: number }> = {};
  for (const [file, entry] of Object.entries(after.writes)) {
    const bytes = entry.bytes - (before.writes[file]?.bytes ?? 0);
    const calls = entry.calls - (before.writes[file]?.calls ?? 0);
    if (calls > 0) writes[file] = { kb: kb(bytes), calls };
  }
  const fired: Record<string, number> = {};
  for (const [key, count] of Object.entries(after.fired)) {
    const delta = count - (before.fired[key] ?? 0);
    if (delta > 0) fired[key] = delta;
  }
  return {
    cpuMs: round((after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000),
    timerCallbacks: Object.values(fired).reduce((sum, n) => sum + n, 0),
    fired: Object.fromEntries(Object.entries(fired).sort((a, b) => b[1] - a[1]).slice(0, 20)),
    writtenKb: round(Object.values(writes).reduce((sum, entry) => sum + entry.kb, 0)),
    writes: Object.fromEntries(Object.entries(writes).sort((a, b) => b[1].kb - a[1].kb).slice(0, 15)),
    fsyncs: after.fsyncs - before.fsyncs,
    renames: after.renames - before.renames,
  };
}

const CONTENT_TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm" };
/** Serves a build folder and forwards /api and the environment probe to the fixture, as the dev preview does. */
async function serveDist(dir: string, target: string): Promise<{ url: string; close(): Promise<void> }> {
  const upstream = new URL(target);
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path.startsWith("/api") || path.startsWith("/.well-known/openmausbot")) {
      const forward = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      forward.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(forward);
      return;
    }
    const file = normalize(join(dir, path));
    const chosen = file.startsWith(dir) && existsSync(file) && statSync(file).isFile() ? file : join(dir, "index.html");
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(chosen)] ?? "application/octet-stream" });
    createReadStream(chosen).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  cleanups.push(close);
  return { url, close };
}

interface ChunkInfo { fileName: string; isEntry: boolean; isDynamicEntry: boolean; imports: string[]; dynamicImports: string[]; bytes: number; gzip: number; modules: Record<string, number>; css: string[] }
const HEAVY: Record<string, RegExp> = {
  vega: /node_modules\/(vega|vega-[\w-]+)\//,
  codemirror: /node_modules\/(@codemirror\/|codemirror\/|@lezer\/)/,
  three: /node_modules\/three\//,
  mermaid: /node_modules\/(mermaid|@mermaid-js|cytoscape|dagre|d3-|d3\/|khroma|elkjs)/,
  katex: /node_modules\/(katex|rehype-katex|remark-math)\//,
  shiki: /node_modules\/(shiki|@shikijs)\//,
  "highlight.js/prism": /node_modules\/(highlight\.js|lowlight|prismjs|refractor)\//,
  markdown: /node_modules\/(react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|unist-)/,
  novnc: /node_modules\/@novnc\//,
  duckdb: /node_modules\/@duckdb\//,
  analytics: /node_modules\/(posthog-js|@posthog)\//,
  locales: /\/src\/locales\//,
  mascot: /\/src\/(lib\/mascot|components\/(CursorAvatar|CarvedAvatar|Avatar|mascot))/i,
};
const packageOf = (id: string) => {
  const at = id.lastIndexOf("/node_modules/");
  if (at >= 0) {
    const rest = id.slice(at + "/node_modules/".length).split("/");
    return rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]!;
  }
  const src = id.indexOf("/src/");
  if (src >= 0) { const parts = id.slice(src + 1).split("/"); return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!; }
  const shared = id.indexOf("/shared/");
  return shared >= 0 ? "shared" : "other";
};

async function buildUi(outDir: string, profiling: boolean) {
  const { build } = await import("vite");
  const chunks: ChunkInfo[] = [];
  const assets: Array<{ fileName: string; bytes: number }> = [];
  const started = performance.now();
  await build({
    configFile: join(ROOT, "vite.config.ts"), root: ROOT, logLevel: "warn", mode: "production",
    build: { outDir, emptyOutDir: true, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 },
    ...(profiling ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] }, esbuild: { keepNames: true } } : {}),
    plugins: [{
      name: "bench-stats",
      generateBundle(_options: unknown, bundle: Record<string, any>) {
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            chunks.push({
              fileName: output.fileName, isEntry: output.isEntry, isDynamicEntry: output.isDynamicEntry, imports: output.imports, dynamicImports: output.dynamicImports,
              bytes: Buffer.byteLength(output.code), gzip: gzipSync(output.code).byteLength,
              modules: Object.fromEntries(Object.entries(output.modules as Record<string, { renderedLength: number }>).map(([id, info]) => [id, info.renderedLength])),
              css: [...(output.viteMetadata?.importedCss ?? [])],
            });
          } else {
            assets.push({ fileName: output.fileName, bytes: typeof output.source === "string" ? Buffer.byteLength(output.source) : output.source.byteLength });
          }
        }
      },
    }],
  });
  const buildMs = performance.now() - started;
  if (profiling) return { buildMs: Math.round(buildMs) };
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = chunks.find((chunk) => chunk.isEntry && /index/.test(chunk.fileName)) ?? chunks.find((chunk) => chunk.isEntry)!;
  const initial = new Set<string>();
  const visit = (name: string) => { if (initial.has(name)) return; initial.add(name); for (const next of byName.get(name)?.imports ?? []) visit(next); };
  visit(entry.fileName);
  const initialChunks = [...initial].map((name) => byName.get(name)!);
  const sum = (list: ChunkInfo[], key: "bytes" | "gzip") => list.reduce((total, chunk) => total + chunk[key], 0);
  const cssBytes = (names: string[]) => names.reduce((total, name) => total + (assets.find((asset) => asset.fileName === name)?.bytes ?? 0), 0);
  const initialCss = [...new Set(initialChunks.flatMap((chunk) => chunk.css))];
  const packages = new Map<string, number>();
  const heavy: Record<string, { eagerKb: number; lazyKb: number }> = Object.fromEntries(Object.keys(HEAVY).map((name) => [name, { eagerKb: 0, lazyKb: 0 }]));
  let initialModules = 0;
  for (const chunk of chunks) {
    const eager = initial.has(chunk.fileName);
    for (const [id, length] of Object.entries(chunk.modules)) {
      if (eager) { initialModules += 1; packages.set(packageOf(id), (packages.get(packageOf(id)) ?? 0) + length); }
      for (const [name, pattern] of Object.entries(HEAVY)) if (pattern.test(id)) heavy[name]![eager ? "eagerKb" : "lazyKb"] += length / 1024;
    }
  }
  for (const entryStats of Object.values(heavy)) { entryStats.eagerKb = round(entryStats.eagerKb); entryStats.lazyKb = round(entryStats.lazyKb); }
  return {
    buildMs: Math.round(buildMs),
    chunks: chunks.length,
    totalJsKb: kb(sum(chunks, "bytes")),
    initial: {
      entry: entry.fileName,
      chunks: initialChunks.map((chunk) => ({ file: chunk.fileName, kb: kb(chunk.bytes), gzipKb: kb(chunk.gzip) })),
      jsKb: kb(sum(initialChunks, "bytes")), jsGzipKb: kb(sum(initialChunks, "gzip")), cssKb: kb(cssBytes(initialCss)), modules: initialModules,
      topPackagesKb: Object.fromEntries([...packages].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, length]) => [name, kb(length)])),
    },
    heavyLibraries: heavy,
    largestLazyChunks: chunks.filter((chunk) => !initial.has(chunk.fileName)).sort((a, b) => b.bytes - a.bytes).slice(0, 10)
      .map((chunk) => ({ file: chunk.fileName, kb: kb(chunk.bytes), top: [...new Set(Object.keys(chunk.modules).map(packageOf))].slice(0, 4) })),
    fontsAndImagesKb: kb(assets.filter((asset) => /\.(woff2?|ttf|png|svg|jpg|webp)$/.test(asset.fileName)).reduce((total, asset) => total + asset.bytes, 0)),
  };
}

/** The packaged server: index.ts bundled as the release does, run through the desktop entry with its compile cache. */
async function bundleServer(): Promise<string> {
  const { build } = await import("esbuild");
  const { serverLocalePlugin } = await import("./server-locale-plugin.mjs");
  const outdir = join(work, "dist-server");
  await build({
    entryPoints: [join(ROOT, "server", "index.ts")], bundle: true, platform: "node", target: "node20", format: "esm", outdir, logLevel: "warning",
    plugins: [{ name: "yaml-esm", setup(builder) { builder.onResolve({ filter: /^yaml$/ }, () => ({ path: join(ROOT, "node_modules", "yaml", "browser", "index.js") })); } }, serverLocalePlugin],
    banner: { js: 'import { createRequire as __ombCreateRequire } from "node:module";\nconst require = __ombCreateRequire(import.meta.url);' },
  });
  copyFileSync(join(ROOT, "scripts", "desktop-server-entry.mjs"), join(outdir, "desktop-entry.mjs"));
  return join(outdir, "desktop-entry.mjs");
}

async function pageLoad(page: Page, url: string, timeoutMs = 60_000) {
  await page.send("Page.navigate", { url });
  const shown = await page.waitFor("window.__bench && window.__bench.marks.sidebarFrame !== undefined && window.__bench.marks.transcriptFrame !== undefined", timeoutMs);
  await sleep(1_500);
  const timing = await page.evaluate<Record<string, unknown>>(`(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paint = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]));
    const resources = performance.getEntriesByType("resource");
    const sum = (filter) => resources.filter(filter).reduce((total, entry) => total + (entry.decodedBodySize || 0), 0);
    const b = window.__bench;
    return {
      domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, firstContentfulPaint: paint["first-contentful-paint"] ?? null,
      sidebar: b.marks.sidebarFrame ?? null, transcript: b.marks.transcriptFrame ?? null, lcp: b.marks.lcp ?? null,
      scriptKb: Math.round(sum((entry) => entry.initiatorType === "script" || /\\.js$/.test(entry.name)) / 1024),
      cssKb: Math.round(sum((entry) => /\\.css$/.test(entry.name)) / 1024),
      apiRequests: resources.filter((entry) => entry.name.includes("/api/")).length,
      apiKb: Math.round(sum((entry) => entry.name.includes("/api/")) / 1024),
      commits: b.commits, componentsMounted: Object.values(b.mounts).reduce((a, n) => a + n, 0),
      longTasks: b.longTasks.length, longTaskMs: b.longTasks.reduce((a, t) => a + t[1], 0), longestTaskMs: Math.max(0, ...b.longTasks.map((t) => t[1])),
      rows: document.querySelectorAll("[data-mid]").length, domNodes: document.getElementsByTagName("*").length,
      opened: document.querySelector("[role=log]")?.getAttribute("aria-label") ?? null,
    };
  })()`);
  const metrics = await page.metrics();
  const rounded = Object.fromEntries(Object.entries(timing).map(([key, value]) => [key, typeof value === "number" ? Math.round(value) : value]));
  return { shown, ...rounded, usefulMs: Math.round(Math.max(Number(timing.sidebar), Number(timing.transcript))),
    jsHeapMb: round(metrics.JSHeapUsedSize! / 1048576), scriptMs: Math.round(metrics.ScriptDuration! * 1000), taskMs: Math.round(metrics.TaskDuration! * 1000) };
}

async function benchSnapshot(page: Page) {
  return page.evaluate<{ commits: number; commitMs: number; probeMs: number; renderedTotal: number; maxRendered: number; renders: Record<string, number>; selfMs: Record<string, number>; mounts: Record<string, number>; timerFires: Record<string, number>; sse: { frames: number; bytes: number; kinds: Record<string, { n: number; bytes: number }> }; longTasks: Array<[number, number]>; liveIntervals: string[] }>(
    "(() => { const b = window.__bench; return { ...b, liveIntervals: [...b.liveIntervals.values()], reset: undefined }; })()");
}

const METRIC_KEYS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"] as const;
function metricDelta(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key.endsWith("Duration") ? `${key[0]!.toLowerCase()}${key.slice(1, -8)}Ms` : `${key[0]!.toLowerCase()}${key.slice(1)}`,
    key.endsWith("Duration") ? Math.round((after[key]! - before[key]!) * 1000) : after[key]! - before[key]!]));
}
const cpuDelta = (before: Record<string, number>, after: Record<string, number>) =>
  Object.fromEntries(Object.keys(after).map((type) => [type, Math.round((after[type]! - (before[type] ?? 0)) * 1000)]));

const COMPONENT_GROUPS: Record<string, RegExp> = {
  sidebar: /^(Sidebar|BotThreadList|BotListItem|GroupListItem|PinnedCircle|ThreadRow|PlacesRail)/,
  composer: /Composer|MentionTextarea/,
  transcript: /^(ChatView|ChatRows?|MessagesList|Bubble|MessageActions|ReactionChips|AttachmentGallery|ActivityChip|TurnPresence|CallRecordRow)/,
  markdown: /Markdown/,
  avatars: /Avatar/,
};
function componentGroups(renders: Record<string, number>, selfMs: Record<string, number>) {
  return Object.fromEntries(Object.entries(COMPONENT_GROUPS).map(([group, pattern]) => {
    const names = Object.keys(renders).filter((name) => pattern.test(name));
    return [group, { renders: names.reduce((sum, name) => sum + renders[name]!, 0), selfMs: Math.round(names.reduce((sum, name) => sum + (selfMs[name] ?? 0), 0)) }];
  }));
}
const RUNNING_ANIMATIONS = `(() => {
  const named = {};
  for (const animation of document.getAnimations()) {
    const target = animation.effect && animation.effect.target;
    const where = target ? target.tagName.toLowerCase() + (target.getAttribute("class") ? "." + String(target.getAttribute("class")).trim().split(/\\s+/).slice(0, 2).join(".") : "") : "?";
    const owner = target && target.closest("[aria-label], [title], [data-sidebar-bot-row], [role=status]");
    const label = owner ? " in " + (owner.getAttribute("aria-label") || owner.getAttribute("title") || owner.getAttribute("role") || "sidebar row").slice(0, 40) : "";
    const key = (animation.animationName || animation.transitionProperty || animation.constructor.name) + " on " + where + label;
    named[key] = (named[key] || 0) + 1;
  }
  return named;
})()`;

/** Nothing happens for IDLE_MS: what the page, Chrome and the server still do. */
async function idleWindow(chrome: Chrome, pages: Record<string, Page>, fixture: Fixture) {
  for (const page of Object.values(pages)) await page.evaluate("window.__bench.reset()");
  const metrics0 = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, page]) => [name, await page.metrics()])));
  const cpu0 = await chrome.cpu();
  const tally0 = await fixture.tally();
  await sleep(IDLE_MS / 2);
  const animations = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, page]) => [name, await page.evaluate<Record<string, number>>(RUNNING_ANIMATIONS)])));
  await sleep(IDLE_MS / 2);
  const cpu1 = await chrome.cpu();
  const tally1 = await fixture.tally();
  const seconds = IDLE_MS / 1000;
  const perPage: Record<string, unknown> = {};
  for (const [name, page] of Object.entries(pages)) {
    const snapshot = await benchSnapshot(page);
    const delta = metricDelta(metrics0[name]!, await page.metrics());
    perPage[name] = {
      ...delta,
      reactCommits: snapshot.commits,
      componentsRendered: snapshot.renderedTotal,
      topRendered: Object.fromEntries(Object.entries(snapshot.renders).sort((a, b) => b[1] - a[1]).slice(0, 8)),
      timerCallbacksPerSec: round(Object.values(snapshot.timerFires).reduce((sum, n) => sum + n, 0) / seconds),
      timerFires: snapshot.timerFires,
      liveIntervals: snapshot.liveIntervals.reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {}),
      serverFrames: snapshot.sse.frames,
      serverFrameKinds: Object.fromEntries(Object.entries(snapshot.sse.kinds).map(([kind, entry]) => [kind, entry.n])),
      longTasks: snapshot.longTasks.length,
      runningAnimations: animations[name],
    };
  }
  const chromeCpu = cpuDelta(cpu0, cpu1);
  const server = tallyDelta(tally0, tally1);
  return {
    seconds,
    chromeCpuPct: Object.fromEntries(Object.entries(chromeCpu).map(([type, ms]) => [type, round(ms / IDLE_MS * 100, 2)])),
    serverCpuPct: round(server.cpuMs / IDLE_MS * 100, 2),
    serverTimerCallbacksPerSec: round(server.timerCallbacks / seconds),
    serverTimers: server.fired,
    serverWrites: server.writes,
    serverRssMb: round(tally1.memory.rss / 1048576),
    pages: perPage,
  };
}

async function waitTurn(fixture: Fixture, botId: string) {
  return await runControlOmb(["wait", "--bot", botId, "--timeout", "180", "--for", "turn", "--url", fixture.url]) as { status?: string; messages?: Array<{ id?: string; kind?: string; role?: string }> };
}

/** One streamed reply with tool calls into `botId`'s open chat, measured in the page, Chrome and the server. */
async function streamTurn(chrome: Chrome, page: Page, fixture: Fixture, botId: string) {
  await page.evaluate("window.__bench.reset()");
  const metrics0 = await page.metrics();
  const cpu0 = await chrome.cpu();
  const tally0 = await fixture.tally();
  const started = performance.now();
  await runControlOmb(["send", "--bot", botId, "--text", "Write the long report, please.", "--url", fixture.url]);
  await sleep(4_000);
  const animationsMidTurn = await page.evaluate<Record<string, number>>(RUNNING_ANIMATIONS);
  const settled = await waitTurn(fixture, botId);
  const newest = [...settled.messages ?? []].reverse().find((message) => message.kind === "text" && message.role === "bot" && message.id);
  const drawn = newest ? await page.waitFor(`document.querySelector('[data-mid="${newest.id}"]')`, 15_000) : false;
  const wallMs = performance.now() - started;
  await sleep(500);
  const metrics1 = await page.metrics();
  const cpu1 = await chrome.cpu();
  const tally1 = await fixture.tally();
  const snapshot = await benchSnapshot(page);
  const delta = metricDelta(metrics0, metrics1);
  const mainMs = Math.max(0, Number(delta.taskMs) - snapshot.probeMs);
  const seconds = wallMs / 1000;
  const top = Object.entries(snapshot.renders).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const server = tallyDelta(tally0, tally1);
  return {
    settled: settled.status, drawn, wallMs: Math.round(wallMs),
    serverFrames: snapshot.sse.frames, serverFrameKb: kb(snapshot.sse.bytes),
    serverFrameKinds: Object.fromEntries(Object.entries(snapshot.sse.kinds).sort((a, b) => b[1].bytes - a[1].bytes).map(([kind, entry]) => [kind, { n: entry.n, kb: kb(entry.bytes) }])),
    reactCommits: snapshot.commits, commitsPerSec: round(snapshot.commits / seconds),
    renderMsTotal: Math.round(snapshot.commitMs),
    componentsRenderedPerCommit: round(snapshot.renderedTotal / Math.max(1, snapshot.commits)), maxComponentsInOneCommit: snapshot.maxRendered,
    topRendered: Object.fromEntries(top.map(([name, count]) => [name, { renders: count, perCommit: round(count / Math.max(1, snapshot.commits), 2), selfMs: Math.round(snapshot.selfMs[name] ?? 0) }])),
    groups: componentGroups(snapshot.renders, snapshot.selfMs),
    mounts: Object.values(snapshot.mounts).reduce((sum, n) => sum + n, 0),
    animationsMidTurn,
    animationFramesPerSec: round((snapshot.timerFires.raf ?? 0) / seconds),
    timerFires: snapshot.timerFires,
    mainThreadMs: Math.round(mainMs), mainThreadMsPerServerFrame: round(mainMs / Math.max(1, snapshot.sse.frames), 2),
    ...delta,
    longTasks: snapshot.longTasks.length, longTaskMs: snapshot.longTasks.reduce((sum, task) => sum + task[1], 0), longestTaskMs: Math.max(0, ...snapshot.longTasks.map((task) => task[1])),
    chromeCpuMs: cpuDelta(cpu0, cpu1),
    server,
  };
}

async function newBot(fixture: Fixture, name: string): Promise<string> {
  const created = await runControlOmb(["new-bot", "--name", name, "--url", fixture.url]) as { bot: { id: string } };
  return created.bot.id;
}

async function main() {
  const result: Record<string, unknown> = {};
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  const chromePath = values.chrome ?? installedChrome() ?? "";
  result.meta = { commit, date: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: round(totalmem() / 2 ** 30), chrome: chromePath, mode: values.advanced ? "advanced" : "simple", idleSeconds: IDLE_MS / 1000 };
  const needsUi = ["start", "idle", "stream", "big"].some((phase) => only.has(phase));
  const dist = join(work, "dist");
  const profileDist = join(work, "dist-profile");
  if (only.has("bundle") || needsUi) {
    log("building the app");
    result.bundle = await buildUi(dist, false);
    if (only.has("stream") || only.has("big")) {
      log("building the profiling variant");
      (result.bundle as Record<string, unknown>).profilingBuildMs = (await buildUi(profileDist, true)).buildMs;
    }
  }

  if (only.has("server")) {
    log("timing server start");
    const source: number[] = [];
    const rssMb = async (fixture: Fixture) => round((await fixture.tally()).memory.rss / 1048576);
    const sourceRss: number[] = [];
    for (let i = 0; i < 3; i++) {
      const fixture = await startFixture();
      source.push(Math.round(fixture.readyMs));
      await sleep(3_000);
      sourceRss.push(await rssMb(fixture));
      await fixture.close();
    }
    const server: Record<string, unknown> = { sourceReadyMs: source, sourceRssMbAt3s: sourceRss };
    try {
      const entry = await bundleServer();
      const cache = join(work, "compile-cache");
      const packaged: number[] = [];
      const memory: Record<string, number> = {};
      for (let i = 0; i < 3; i++) {
        const fixture = await startFixture({ bundle: { entry, cache } });
        packaged.push(Math.round(fixture.readyMs));
        await sleep(i === 0 ? 11_000 : 3_000);
        if (i === 2) {
          memory.at3s = await rssMb(fixture);
          await sleep(27_000);
          memory.at30s = await rssMb(fixture);
        }
        await fixture.close();
      }
      server.bundleReadyMs = { cold: packaged[0], warm: packaged.slice(1) };
      server.bundleRssMb = memory;
      server.bundleKb = kb(statSync(join(dirname(entry), "index.js")).size);
    } catch (error) {
      server.bundleError = error instanceof Error ? error.message : String(error);
    }
    result.server = server;
  }

  let chrome: Chrome | undefined;
  if (needsUi) {
    if (!chromePath) throw new Error("no Chrome: run `control-omb ui launch` once, or pass --chrome PATH");
    chrome = await launchChrome(chromePath);
    cleanups.push(() => chrome!.close());
  }

  if (chrome && (only.has("start") || only.has("idle") || only.has("stream"))) {
    log("small workspace: start, idle, stream");
    const fixture = await startFixture({ staticDir: dist, fake: STREAM_ENV });
    const botId = await newBot(fixture, "Pepper");
    const page = await chrome.newPage({ storage: STORAGE });
    if (only.has("start")) {
      const loads = [];
      for (let i = 0; i < 3; i++) loads.push(await pageLoad(page, fixture.url));
      result.start = { serverReadyMs: Math.round(fixture.readyMs), firstLoad: loads[0], reloads: loads.slice(1), rendererRssMb: Math.max(...await chrome.rendererRssMb()) };
    } else {
      await pageLoad(page, fixture.url);
    }
    if (only.has("idle")) {
      const rail = await chrome.newPage({ storage: STORAGE, railBridge: true }, 72, 900);
      await rail.send("Page.navigate", { url: `${fixture.url}/rail` });
      await sleep(5_000);
      const railMetrics = await rail.metrics();
      const railLoad = await rail.evaluate<Record<string, number>>(`(() => ({
        scriptKb: Math.round(performance.getEntriesByType("resource").filter((e) => /\\.js$/.test(e.name)).reduce((t, e) => t + (e.decodedBodySize || 0), 0) / 1024),
        domNodes: document.getElementsByTagName("*").length, commits: window.__bench.commits }))()`);
      log(`idle ${IDLE_MS / 1000}s, small workspace`);
      result.idle = { small: await idleWindow(chrome, { app: page, rail }, fixture),
        railPage: { ...railLoad, jsHeapMb: round(railMetrics.JSHeapUsedSize! / 1048576), scriptMs: Math.round(railMetrics.ScriptDuration! * 1000) } };
      await rail.close();
    }
    await page.close();
    if (only.has("stream")) {
      const preview = await serveDist(profileDist, fixture.url);
      const profiled = await chrome.newPage({ storage: STORAGE });
      await pageLoad(profiled, preview.url);
      await profiled.evaluate(`document.querySelector('[data-sidebar-bot-row="${botId}"]')?.click()`);
      await sleep(1_500);
      log("streaming a reply, small workspace");
      result.stream = { small: await streamTurn(chrome, profiled, fixture, botId) };
      await profiled.close();
      await preview.close();
    }
    await fixture.close();
  }

  if (chrome && only.has("big")) {
    log("seeding the big workspace");
    const dataDir = newDataDir();
    const seedOut = execFileSync(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "testing", "bench-desktop-seed.ts"), values.bots!, values.threads!, values.messages!], {
      cwd: ROOT, encoding: "utf8", env: { ...platformEnv(), PATH: dirname(process.execPath), HOME: dataDir, OMB_DATA_DIR: dataDir, TMPDIR: join(dataDir, "tmp") }, maxBuffer: 16 * 1024 * 1024,
    });
    const seeded = JSON.parse(seedOut.trim().split("\n").at(-1)!) as { bigBotId: string; bigThreadId: string; bigLastMessageId: string; otherBotId: string; otherThreadId: string; otherSideThreadId: string; bots: number; threads: number; bigMessages: number };
    const fixture = await startFixture({ dataDir, staticDir: dist, fake: STREAM_ENV });
    const booted = await fixture.tally();
    const big: Record<string, unknown> = { seeded: { bots: seeded.bots, threads: seeded.threads, messages: seeded.bigMessages, botsJsonKb: kb(statSync(join(dataDir, "bots.json")).size), messagesDbKb: kb(statSync(join(dataDir, "messages.db")).size) }, serverReadyMs: Math.round(fixture.readyMs) };
    const routes: Record<string, unknown> = {};
    for (const path of ["/api/bots?messages=200", "/api/bots?messages=0", "/api/config", "/api/instances", "/api/routines", "/api/notifications", "/api/live/call", "/api/auth/session", "/api/brand"]) {
      const samples = [];
      let bytes = 0;
      for (let i = 0; i < 5; i++) { const answer = await fixture.api("GET", path); samples.push(answer.ms); bytes = answer.bytes; }
      routes[path] = { firstMs: Math.round(samples[0]!), medianMs: round(median(samples.slice(1))), kb: kb(bytes) };
    }
    big.routes = routes;
    const writes: Record<string, unknown> = {};
    let before = await fixture.tally();
    const switched = await fixture.api("POST", `/api/bots/${seeded.otherBotId}/tasks/${seeded.otherSideThreadId}?messages=200`);
    let after = await fixture.tally();
    writes.threadSwitch = { ms: round(switched.ms), status: switched.status, ...tallyDelta(before, after) };
    before = after;
    const read = await fixture.api("POST", `/api/bots/${seeded.otherBotId}/read`, { threadId: seeded.otherThreadId });
    after = await fixture.tally();
    writes.readMarker = { ms: round(read.ms), status: read.status, ...tallyDelta(before, after) };
    await fixture.api("POST", `/api/bots/${seeded.otherBotId}/tasks/${seeded.otherThreadId}?messages=0`);
    await fixture.api("POST", `/api/bots/${seeded.bigBotId}/tasks/${seeded.bigThreadId}?messages=0`);
    big.writes = writes;
    big.serverMemoryMb = { afterBoot: { rss: round(booted.memory.rss / 1048576), heap: round(booted.memory.heapUsed / 1048576) },
      afterStartupRoutes: { rss: round(after.memory.rss / 1048576), heap: round(after.memory.heapUsed / 1048576) } };

    log("big workspace: page");
    const page = await chrome.newPage({ storage: STORAGE });
    const load = await pageLoad(page, fixture.url);
    const lastDrawn = await page.waitFor(`document.querySelector('[data-mid="${seeded.bigLastMessageId}"]')`, 30_000);
    big.load = { ...load, bigConversationShown: lastDrawn, rendererRssMb: Math.max(...await chrome.rendererRssMb()) };
    const switchTo = (botId: string, lastId: string | null) => page.evaluate<{ clicked: boolean; ms?: number; timedOut?: boolean }>(
      switchExpression(botId, lastId ? `document.querySelector('[data-mid="${lastId}"]')` : "document.querySelector('[data-mid]') && !document.querySelector('[data-mid=\"" + seeded.bigLastMessageId + "\"]')"));
    const away = await switchTo(seeded.otherBotId, null);
    await sleep(1_000);
    const back = await switchTo(seeded.bigBotId, seeded.bigLastMessageId);
    await sleep(1_000);
    big.switchConversation = { toSmall: away, backToBig: back };
    const memoryBefore = await page.metrics();
    const box = await page.evaluate<{ x: number; y: number; rows: number; nodes: number; top: number; height: number } | null>(TRANSCRIPT_BOX);
    if (!box) big.scroll = { error: "no scrolling transcript" };
    else {
      await page.evaluate(FRAMES_START);
      for (let i = 0; i < 400; i++) {
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -600 });
        await sleep(16);
      }
      await sleep(1_000);
      const scroll = await page.evaluate<{ frames: number[]; longTasks: Array<[number, number]>; rows: number; nodes: number; top: number; height: number }>(FRAMES_STOP);
      const memoryAfter = await page.metrics();
      big.scroll = {
        wheelEvents: 400, frames: scroll.frames.length, frameMsP50: round(percentile(scroll.frames, 50)), frameMsP95: round(percentile(scroll.frames, 95)), frameMsMax: round(Math.max(...scroll.frames)),
        framesOver33ms: scroll.frames.filter((ms) => ms > 33.4).length, longTasks: scroll.longTasks.length, longestTaskMs: Math.max(0, ...scroll.longTasks.map((task) => task[1])),
        rowsBefore: box.rows, rowsAfter: scroll.rows, domNodesBefore: box.nodes, domNodesAfter: scroll.nodes, scrollHeightBefore: box.height, scrollHeightAfter: scroll.height, scrollTopAfter: scroll.top,
        jsHeapMbBefore: round(memoryBefore.JSHeapUsedSize! / 1048576), jsHeapMbAfter: round(memoryAfter.JSHeapUsedSize! / 1048576),
        rendererRssMbAfter: Math.max(...await chrome.rendererRssMb()),
      };
    }
    await page.send("Page.reload");
    await page.waitFor(`document.querySelector('[data-mid="${seeded.bigLastMessageId}"]')`, 30_000);
    await sleep(3_000);
    if (values.screenshots) {
      mkdirSync(values.screenshots, { recursive: true });
      const shot = await page.send("Page.captureScreenshot", { format: "png" }) as { data: string };
      writeFileSync(join(values.screenshots, "big-idle.png"), Buffer.from(shot.data, "base64"));
    }
    log(`idle ${IDLE_MS / 1000}s, big workspace`);
    big.idle = await idleWindow(chrome, { app: page }, fixture);
    const slice = async (label: string, setup?: string) => {
      if (setup) await page.evaluate(setup);
      const before = await chrome.cpu();
      await sleep(10_000);
      const used = cpuDelta(before, await chrome.cpu());
      return { label, rendererPct: round(used.renderer! / 100, 1), gpuPct: round((used.GPU ?? 0) / 100, 1) };
    };
    big.idleAttribution = [
      await slice("as is"),
      await slice("CSS animations paused", `document.head.insertAdjacentHTML("beforeend", "<style>*, *::before, *::after { animation-play-state: paused !important; }</style>")`),
      await slice("CSS animations paused and no animation frames", "window.requestAnimationFrame = () => 0"),
    ];
    await page.close();
    const preview = await serveDist(profileDist, fixture.url);
    const profiled = await chrome.newPage({ storage: STORAGE });
    await pageLoad(profiled, preview.url);
    await profiled.waitFor(`document.querySelector('[data-mid="${seeded.bigLastMessageId}"]')`, 30_000);
    await sleep(1_500);
    const profiledSwitch = async (botId: string, lastId: string | null) => {
      await profiled.evaluate("window.__bench.reset()");
      const at = performance.now();
      await profiled.evaluate(`document.querySelector('[data-sidebar-bot-row="${botId}"]')?.click()`);
      await profiled.waitFor(lastId ? `document.querySelector('[data-mid="${lastId}"]')` : "document.querySelector('[data-mid]')", 30_000);
      const ms = performance.now() - at;
      await sleep(1_000);
      const snapshot = await benchSnapshot(profiled);
      const topSelf = Object.entries(snapshot.selfMs).sort((a, b) => b[1] - a[1]).slice(0, 12);
      return { ms: Math.round(ms), reactCommits: snapshot.commits, renderMs: Math.round(snapshot.commitMs), mounts: Object.values(snapshot.mounts).reduce((sum, n) => sum + n, 0),
        groups: componentGroups({ ...snapshot.renders, ...Object.fromEntries(Object.entries(snapshot.mounts).map(([name, n]) => [name, n + (snapshot.renders[name] ?? 0)])) }, snapshot.selfMs),
        topSelfMs: Object.fromEntries(topSelf.map(([name, ms]) => [name, Math.round(ms)])), longestTaskMs: Math.max(0, ...snapshot.longTasks.map((task) => task[1])) };
    };
    const awayProfiled = await profiledSwitch(seeded.otherBotId, null);
    const backProfiled = await profiledSwitch(seeded.bigBotId, seeded.bigLastMessageId);
    big.switchProfiled = { toSmall: awayProfiled, backToBig: backProfiled };
    log("streaming a reply, big workspace");
    big.stream = await streamTurn(chrome, profiled, fixture, seeded.bigBotId);
    await profiled.close();
    await preview.close();
    await fixture.close();
    result.big = big;
  }

  if (only.has("routines")) {
    log("routines with a full run history");
    let fixture = await startFixture();
    const { body: { bots } } = await fixture.api("GET", "/api/bots?messages=0");
    const botId = bots[0].id as string;
    const created = await fixture.api("POST", "/api/routines", { name: "Morning summary", prompt: "Summarise the morning.", botId, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    const routineId = created.body.routine.id as string;
    const runOnce = async () => {
      const started = await fixture.api("POST", `/api/routines/${routineId}/run`);
      const runId = started.body.run.id as string;
      for (let i = 0; i < 600; i++) {
        const { body } = await fixture.api("GET", "/api/routines?from=0");
        const run = (body.runs as Array<{ id: string; status: string }>).find((candidate) => candidate.id === runId);
        if (run && !["queued", "running", "waiting"].includes(run.status)) return run.status;
        await sleep(100);
      }
      return "timed out";
    };
    await runOnce();
    const dataDir = fixture.dataDir;
    await fixture.close(true);
    const file = join(dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { runs: Array<Record<string, unknown>> };
    const template = saved.runs[0]!;
    const output = "The summary: ".concat("calendar clear, three emails need replies, one invoice overdue. ".repeat(30)).slice(0, 2000);
    saved.runs = Array.from({ length: 1999 }, (_, i) => ({ ...template, id: `bench-run-${i}`, output, scheduledFor: Date.now() - (i + 1) * 3_600_000, startedAt: Date.now() - (i + 1) * 3_600_000, finishedAt: Date.now() - (i + 1) * 3_600_000 + 60_000, status: "completed" })).concat(saved.runs);
    writeFileSync(file, JSON.stringify(saved, null, 2));
    const fileKb = kb(statSync(file).size);
    fixture = await startFixture({ dataDir });
    const samples = [];
    let bytes = 0;
    for (let i = 0; i < 5; i++) { const answer = await fixture.api("GET", "/api/routines"); samples.push(answer.ms); bytes = answer.bytes; }
    const idleBefore = await fixture.tally();
    await sleep(Math.min(IDLE_MS, 30_000));
    const idleAfter = await fixture.tally();
    const status = await runOnce();
    const afterRun = await fixture.tally();
    const run = tallyDelta(idleAfter, afterRun);
    result.routines = {
      runs: saved.runs.length, routinesJsonKb: fileKb, serverReadyMs: Math.round(fixture.readyMs),
      getRoutines: { firstMs: Math.round(samples[0]!), medianMs: round(median(samples.slice(1))), kb: kb(bytes) },
      idleServerCpuPct: round(tallyDelta(idleBefore, idleAfter).cpuMs / Math.min(IDLE_MS, 30_000) * 100, 2),
      oneRun: { status, routinesJson: run.writes["routines.json"] ?? null, writtenKb: run.writtenKb, fsyncs: run.fsyncs, serverCpuMs: run.cpuMs },
    };
    await fixture.close();
  }

  const json = JSON.stringify(result, null, 2);
  if (values.out) writeFileSync(values.out, `${json}\n`);
  process.stdout.write(`${json}\n`);
}

let exitCode = 0;
const stop = async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  if (!values.keep) await removeTempDir(work);
};
process.once("SIGINT", () => { void stop().finally(() => process.exit(130)); });
try {
  await main();
} catch (error) {
  exitCode = 1;
  process.stderr.write(`bench-desktop failed: ${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  await stop();
}
process.exit(exitCode);
