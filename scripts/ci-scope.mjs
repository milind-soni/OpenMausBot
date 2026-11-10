import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The ci.yml jobs a pull request runs only when its change can affect them;
// `static` and the `CI` gate always run. Besides these job ids a scope's checks
// name the vitest job's parts: "linux-tests", "host-tests" (Windows, and macOS
// where the event runs it), and the subsets in VITEST_SUBSETS.
export const SELECTABLE_JOBS = [
  "build", "vitest", "behavior-evals", "packaged-server", "windows-cua", "electron-smokes", "cloudflared-linux-arm64",
  "foss", "control-plane", "ui-smoke", "browser-identity", "package-linux", "browser-driver", "relay",
];

// The server imports Electron and renderer modules, and the macOS smokes run
// the packaged server inside Electron, so a server change and a desktop change
// can affect the same checks.
const SERVER_CHECKS = [
  "build", "linux-tests", "host-tests", "behavior-evals", "packaged-server", "foss", "electron-smokes",
  "ui-smoke", "browser-identity", "browser-driver", "package-linux",
];
const EVERY_CHECK = [...SERVER_CHECKS, "windows-cua", "cloudflared-linux-arm64", "control-plane", "relay"];

/** What a pull request's change in each area can affect. */
export const AREA_CHECKS = {
  docs: ["docs-tests"],
  locales: ["build", "locale-tests"],
  web: ["build", "linux-tests", "ui-smoke"],
  "script-tests": ["linux-tests", "host-tests", "ui-smoke", "browser-identity"],
  server: SERVER_CHECKS,
  desktop: SERVER_CHECKS,
  // The Windows CUA job starts these the way the installed app does, then lends the PC's screen through them.
  "windows-computer-control": [...SERVER_CHECKS, "windows-cua"],
  "control-plane": ["control-plane"],
  // The relay is its own package with its own lockfile; nothing outside relay/ reaches it except the shared vectors,
  // which it keeps a pinned copy of.
  relay: ["relay"],
  "e2e-vectors": [...SERVER_CHECKS, "relay"],
  everything: EVERY_CHECK,
};

/** The vitest files a pull request runs on Linux when it runs no full Linux
 * shards, as vitest filters. Locale tests: every test that reads a translation
 * other than English (the renderer's files take about nine minutes in one
 * process), with the Electron node tests, which compare their own copy of some
 * strings with every catalog, and the server's tests of its lines in other
 * languages (they load server/server-line-packs.ts). Docs tests: every test that
 * reads the docs. */
export const VITEST_SUBSETS = {
  "locale-tests": {
    part: "locale tests",
    files: [
      "src/",
      "electron/cua-launch.test.mjs",
      "electron/cua-windows-isolation.test.mjs",
      "electron/menu.test.mjs",
      "electron/updater.test.mjs",
      "scripts/generate-locale.test.mjs",
      "scripts/testing/bot-tools-ui.e2e.test.ts",
      "scripts/testing/key-readback.e2e.test.ts",
      "scripts/testing/one-workspace-ui.e2e.test.ts",
      "scripts/testing/rail-profile-ui.e2e.test.ts",
      "scripts/testing/secret-card-descriptions.test.ts",
      "scripts/testing/team-own-chat.e2e.test.ts",
      "server/body-thread-guards.e2e.test.ts",
      "server/chief-operator-authority.e2e.test.ts",
      "server/chief-operator-body-race.e2e.test.ts",
      "server/client-notifications.e2e.test.ts",
      "server/cloud-connections.e2e.test.ts",
      "server/cloud-lending-browser.e2e.test.ts",
      "server/cloud-lending-chrome.e2e.test.ts",
      "server/cloud-lending-memory.e2e.test.ts",
      "server/cloud-lending.e2e.test.ts",
      "server/cloud-lent-mcp.e2e.test.ts",
      "server/cloud-send-kinds.e2e.test.ts",
      "server/cloud-send-move.e2e.test.ts",
      "server/cloud-send-rooms.e2e.test.ts",
      "server/cloud-send-routine-merge.e2e.test.ts",
      "server/cloud-send-store.e2e.test.ts",
      "server/cloud-send.e2e.test.ts",
      "server/cloud-sync.e2e.test.ts",
      "server/cloud-team-browser.e2e.test.ts",
      "server/cloud-team-connections.e2e.test.ts",
      "server/cloud-team-engine-homes.e2e.test.ts",
      "server/cloud-team-gateway-mcp.e2e.test.ts",
      "server/cloud-team-inbox.e2e.test.ts",
      "server/cloud-team-open-reach.e2e.test.ts",
      "server/cloud-team-owners.e2e.test.ts",
      "server/cloud-team-people.e2e.test.ts",
      "server/cloud-team-per-person.e2e.test.ts",
      "server/cloud-team-phones.e2e.test.ts",
      "server/cloud-team-pictures.e2e.test.ts",
      "server/cloud-team-private.e2e.test.ts",
      "server/cloud-team-profile.e2e.test.ts",
      "server/cloud-team-requests.e2e.test.ts",
      "server/cloud-team-setup-request.e2e.test.ts",
      "server/cloud-team.e2e.test.ts",
      "server/host/brief-words.test.ts",
      "server/host/lending-lifts.test.ts",
      "server/lent-folders.e2e.test.ts",
      "server/one-home-keep.e2e.test.ts",
      "server/one-home-outdated.e2e.test.ts",
      "server/one-home-retry.e2e.test.ts",
      "server/one-home-session.e2e.test.ts",
      "server/one-home-trial-key.e2e.test.ts",
      "server/one-home-two-desks.e2e.test.ts",
      "server/one-home.e2e.test.ts",
      "server/parked-cards.e2e.test.ts",
      "server/question-cards.e2e.test.ts",
      "server/shared-computers.e2e.test.ts",
      "server/shared-computers.gate.test.ts",
      "server/team-move.e2e.test.ts",
      "server/use-my-mac.e2e.test.ts",
      "server/workspace-banner.e2e.test.ts",
      "scripts/server-locale-plugin.test.ts",
      "server/server-lines.test.ts",
      "server/host/devs-reports.test.ts",
      "server/automation-reports.test.ts",
      "server/incidents.test.ts",
      "server/routine-run-card.test.ts",
      "server/host/chief-notices-retry.test.ts",
      "server/connector-card-text.test.ts",
      "server/host/secret-cards.test.ts",
      "server/notify.test.ts",
      "server/room-lines.test.ts",
      "server/post-to-room.test.ts",
      "server/teammate-lines.test.ts",
      "server/chat-notices.test.ts",
      "server/recall-disclosure.test.ts",
      "server/routine-cron-text.test.ts",
      "server/routine-requests.test.ts",
      "server/cloud-send-arrived.test.ts",
      "server/cloud-team-bot-access.e2e.test.ts",
      "server/cloud-team-one-answer.e2e.test.ts",
      "server/cloud-team-preference.e2e.test.ts",
      "server/cloud-team-rules.e2e.test.ts",
      "server/cloud-team-rules-running-turn.e2e.test.ts",
      "server/outside-work-threads.e2e.test.ts",
      "server/own-home.e2e.test.ts",
      "server/places-elsewhere.e2e.test.ts",
      "server/question-routing.e2e.test.ts",
      "server/team-protocol.e2e.test.ts",
      "server/team-small-fixes.e2e.test.ts",
      "server/team-mausbot-followup.e2e.test.ts",
      "server/team-no-ai.e2e.test.ts",
      "server/team-refused-handoff.e2e.test.ts",
      "server/two-places.e2e.test.ts",
      "scripts/ci-workflow.test.ts",
      "scripts/pre-push-check.test.ts",
      "server/host/wait-words.test.ts",
      "server/place-inbox.e2e.test.ts",
      "server/bot-api-team.e2e.test.ts",
      "server/cloud-team-first-look.e2e.test.ts",
      "server/cloud-team-mausbot-own-chat.e2e.test.ts",
      "server/connector-stayed.e2e.test.ts",
      "server/email/host.test.ts",
      "server/host/outside-lineage.test.ts",
      "server/memory-move.test.ts",
      "server/outside-lineage.e2e.test.ts",
      "server/same-name-mentions.e2e.test.ts",
      "server/skill-switch.test.ts",
    ],
    shards: 2,
    nodeTests: true,
  },
  "docs-tests": {
    part: "docs tests",
    files: ["scripts/testing/analytics-docs.test.ts", "server/model-providers-docs.test.ts", "src/locales/vocabulary.test.ts"],
    shards: 1,
    nodeTests: false,
  },
};

/** Renderer files that also run outside the renderer: the server imports
 * them, or the macOS app-frame smoke bundles them. ci-scope.test.ts holds this
 * equal to the import graph. The language packs are left out, though the
 * server reads their "server." lines: a change to English runs every Linux test,
 * and one to another language runs every test that reads it (the locale tests). */
export const SRC_OUTSIDE_RENDERER = [
  "src/components/app/app-frame-host.ts",
  "src/lib/citations.ts",
  "src/lib/composer-attachments.ts",
  "src/lib/random-uuid.ts",
  "src/lib/receipts.ts",
];

export const DOCS = /^(?:[^/]+\.md|docs\/.+\.md|\.github\/FUNDING\.yml)$/;

// The first matching rule names a path's area; a path no rule names can affect
// anything. English is the source every test reads, so en.json is web.
const AREAS = [
  [DOCS, "docs"],
  [/^(?:apps\/)?docs\//, "docs"],
  [/^scripts\/.+\.test\.[cm]?[jt]sx?$/, "script-tests"],
  [/^src\/locales\/(?:(?!en\.json$)[^/]+\.json|[^/]+\.test\.ts)$/, "locales"],
  [/^(?:src|public)\/|^[^/]+-preview\.html$/, "web"],
  [/^companion\/src\/e2e\/vectors\//, "e2e-vectors"],
  [/^(?:server|shared|enterprise|companion|evals|skills|deploy|cloudflare\/composio-broker)\/|^(?:Dockerfile|\.dockerignore|compose\.yaml)$/, "server"],
  [/^electron\/(?:cua|cua-failure|cua-connection|capabilities|screen-status|shared-cua-connection|shared-computer-access|lent-screen-tools|lent-screen-failures|paced-typing)\.[cm]js$/, "windows-computer-control"],
  [/^(?:electron|build)\/|^(?:electron-builder\.yml|index\.html|rail\.html)$/, "desktop"],
  [/^cloudflare\/control-plane\//, "control-plane"],
  [/^relay\//, "relay"],
];

export function areaOf(file) {
  if (typeof file !== "string" || /\p{Cc}/u.test(file) || file.split("/").some((part) => !part || part === "." || part === "..")) {
    return "everything";
  }
  if (SRC_OUTSIDE_RENDERER.includes(file)) return "server";
  return AREAS.find(([pattern]) => pattern.test(file))?.[1] ?? "everything";
}

export const FULL_SCOPE = { areas: ["everything"], checks: [...EVERY_CHECK].sort() };

/** A push to main and a merge group: the build, every test file on Linux and the Windows shards, the macOS smokes and
 * the Linux checks no longer than a shard. The macOS shards, the Windows CUA smoke, the Linux package, the browser driver
 * and the ARM installer run in the full lane only: nightly, manual runs and the release lane. */
export const MAIN_SCOPE = {
  areas: ["main"],
  checks: [
    "behavior-evals", "browser-identity", "build", "control-plane", "electron-smokes", "foss", "host-tests", "linux-tests", "packaged-server",
    "ui-smoke",
  ],
};

/** A push whose commit already passed the CI gate in the merge queue: only the control-plane checks the broker deploy needs. */
export const QUEUED_SCOPE = { areas: ["tested in the merge queue"], checks: ["control-plane"] };

/** A pull request's areas and the checks they select, from its changed files. */
export function selectCiScope(files) {
  const areas = Array.isArray(files) && files.length > 0 ? [...new Set(files.map(areaOf))].sort() : ["everything"];
  if (areas.includes("everything")) return FULL_SCOPE;
  return { areas, checks: [...new Set(areas.flatMap((area) => AREA_CHECKS[area]))].sort() };
}

/** The pull request label that runs the Windows jobs whatever the change. */
export const WINDOWS_LABEL = "windows";

/** Paths whose change can break Windows first: Windows by name, the desktop app and its installer, the dependencies,
 * the scripts that build, package or smoke the app, and what decides how the Windows shards run. */
export const WINDOWS_PATH = new RegExp([
  String.raw`(?:^|[/._-])(?:win|win32|win64|windows|nsis|powershell|pwsh)(?:[/._-]|$)`,
  String.raw`\.(?:ps1|psm1|psd1|cmd|bat|exe|msi|nsh|nsi)$`,
  String.raw`^(?:electron|build|third_party)/`,
  String.raw`^(?:electron-builder\.yml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.gitattributes|vite\.config\.ts)$`,
  String.raw`^\.github/workflows/ci\.yml$|^scripts/ci-scope\.mjs$`,
  String.raw`^scripts/testing/(?:host-e2e\.ts|duration-sequencer\.ts|vitest-shard-weights\.json|ci-retry-[^/]+)$|^server/testing/host-timeout\.ts$`,
  String.raw`^scripts/(?:build|bundle|prepare|package|smoke|after-pack|stage)[^/]*$`,
].join("|"), "i");

/** A changed line of code that names Windows or one of its APIs. */
export const WINDOWS_TEXT = new RegExp([
  String.raw`\bwin32\b|\bWindows\b|\bwindows-latest\b|[Pp]ower[Ss]hell|\bpwsh\b|\bcmd\.exe\b|\.exe\b|\bpath\.win32\b`,
  String.raw`\b(?:USERPROFILE|LOCALAPPDATA|APPDATA|PATHEXT|ComSpec)\b|\bwindows(?:Hide|VerbatimArguments)\b`,
].join("|"));

/** Why a pull request runs the Windows jobs, or null when nothing in it is Windows-sensitive: its label, a path above,
 * an e2e file the Windows shards also run (`hostE2e`), or a changed line in `lines` (`git diff -U0` of its code). */
export function windowsReason({ files, labels = [], hostE2e = [], lines = () => [] }) {
  if (labels.includes(WINDOWS_LABEL)) return `the "${WINDOWS_LABEL}" label`;
  const file = files.find((path) => WINDOWS_PATH.test(path) || hostE2e.includes(path));
  if (file) return file;
  let changed;
  try {
    changed = lines();
  } catch (error) {
    return `a change whose lines could not be read (${error.message})`;
  }
  const line = changed.find((text) => /^[+-](?![+-]{2} )/.test(text) && WINDOWS_TEXT.test(text));
  return line ? `the changed line ${JSON.stringify(line.slice(0, 80))}` : null;
}

/** True when two package.json texts differ only in the top-level "version"
 * (the release bump, prepare-release.yml). Anything else that changed, a
 * reordered key included, or text that is not a JSON object, is false. */
export function versionOnlyPackageJson(before, after) {
  let a, b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return false;
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(a) || !isObject(b)) return false;
  if (typeof a.version !== "string" || typeof b.version !== "string" || a.version === b.version) return false;
  const { version: _before, ...restBefore } = a;
  const { version: _after, ...restAfter } = b;
  return JSON.stringify(restBefore) === JSON.stringify(restAfter);
}

/** A push's own diff (before..after) needs no runtime jobs when it is docs
 * only or only bumps package.json's version. `show(rev, path)` reads a file. */
export function selectPushScope(files, show) {
  if (!Array.isArray(files) || files.length === 0) return { runtime: true };
  if (files.every((file) => areaOf(file) === "docs" && DOCS.test(file))) return { runtime: false };
  if (files.length === 1 && files[0] === "package.json") {
    try {
      if (versionOnlyPackageJson(show("before", "package.json"), show("after", "package.json"))) return { runtime: false };
    } catch { /* unreadable: run everything */ }
  }
  return { runtime: true };
}

// macOS runners are the scarce ones (five at a time for the whole account),
// and only a couple of test blocks are macOS-only, so a PR runs the suite on
// Linux, and on Windows only when its change can break Windows (windowsReason);
// a push to main and a merge group run Linux and Windows. The full lane adds
// macOS. A PR that can affect the macOS smokes still runs them.
export const ALL_OS = ["macos-latest", "ubuntu-latest", "windows-latest"];
export const LINUX_OS = ["ubuntu-latest"];
export const WINDOWS_OS = ["ubuntu-latest", "windows-latest"];

/** Events whose runs test every platform: the nightly run, manual runs and the release lane (a manual run). */
export const FULL_LANE_EVENTS = ["schedule", "workflow_dispatch"];

/** Which lane an event's run is: a pull request's own areas, main's, or every check on every platform. */
export function laneOf(event) {
  if (event === "pull_request") return "pr";
  if (event === "push" || event === "merge_group") return "main";
  return "full";
}

// The slowest shard sets the run's length. Windows and macOS run only the e2e files that depend on their OS, so their
// shards stay as short as Linux's, and macOS keeps four: the account runs five macOS jobs at a time.
export const VITEST_SHARDS = { "macos-latest": 4, "ubuntu-latest": 8, "windows-latest": 8 };

// Test files at once on each platform's runner (OMB_VITEST_WORKERS, vite.config.ts). A Linux shard mostly waits on real
// servers and fake engines: its 4 vCPU sat 70% idle one file at a time, and four files take a third of the time.
export const VITEST_WORKERS = { "macos-latest": 1, "ubuntu-latest": 4, "windows-latest": 1 };

/** ci.yml's vitest matrix: every shard of every selected platform, and which e2e files that platform runs. */
export function vitestMatrix(oses) {
  return {
    include: oses.flatMap((os) => Array.from({ length: VITEST_SHARDS[os] }, (_, i) => ({
      os, part: `shard ${i + 1}/${VITEST_SHARDS[os]}`, shard: i + 1, shards: VITEST_SHARDS[os], files: "",
      e2e: os === "ubuntu-latest" ? "all" : "host", node_tests: i === 0, workers: VITEST_WORKERS[os],
    }))),
  };
}

/** What ci.yml runs for a scope on an event whose suite covers `oses`: the
 * selected job ids and the vitest matrix. */
export function ciOutputs({ checks }, oses) {
  const platforms = oses.filter((os) => checks.includes(os === "ubuntu-latest" ? "linux-tests" : "host-tests"));
  const { include } = vitestMatrix(platforms);
  for (const [check, { part, files, shards, nodeTests }] of Object.entries(VITEST_SUBSETS)) {
    if (platforms.includes("ubuntu-latest") || !checks.includes(check)) continue;
    for (let shard = 1; shard <= shards; shard++) {
      include.push({
        os: "ubuntu-latest", part: shards > 1 ? `${part} ${shard}/${shards}` : part, shard, shards,
        files: files.join(" "), e2e: "all", node_tests: nodeTests && shard === 1, workers: VITEST_WORKERS["ubuntu-latest"],
      });
    }
  }
  const jobs = SELECTABLE_JOBS.filter((job) => (job === "vitest" ? include.length > 0
    : job === "windows-cua" ? checks.includes(job) && oses.includes("windows-latest") : checks.includes(job)));
  return {
    jobs,
    vitest_os: oses,
    // macOS's packaged server smoke runs in the macOS smokes job.
    packaged_server_os: oses.filter((os) => os !== "macos-latest"),
    // GitHub refuses an empty matrix, so a vitest job its `if` skips keeps the full one.
    vitest_matrix: include.length > 0 ? { include } : vitestMatrix(oses),
  };
}

/** The outputs for a static job that does the Linux work itself (on a Boat VM, `OMB_CI_LINUX_IN_STATIC`): the Linux
 * vitest entries, behavior evals and the Linux packaged server smoke become `linux_lanes`
 * (scripts/ci-linux-lanes.mjs), and the jobs left with nothing to run drop out of the selection. */
export function moveLinuxIntoStatic(outputs) {
  const vitest = outputs.jobs.includes("vitest") ? outputs.vitest_matrix.include : [];
  const others = vitest.filter((entry) => entry.os !== "ubuntu-latest");
  const packagedOs = outputs.packaged_server_os.filter((os) => os !== "ubuntu-latest");
  const packaged = outputs.jobs.includes("packaged-server");
  return {
    ...outputs,
    jobs: outputs.jobs.filter((job) => job !== "behavior-evals" && !(job === "vitest" && others.length === 0)
      && !(job === "packaged-server" && packagedOs.length === 0)),
    // A job that drops out keeps its old matrix: GitHub refuses an empty one, even for a skipped job.
    vitest_matrix: others.length > 0 ? { include: others } : outputs.vitest_matrix,
    packaged_server_os: packaged && packagedOs.length > 0 ? packagedOs : outputs.packaged_server_os,
    linux_lanes: {
      vitest: vitest.filter((entry) => entry.os === "ubuntu-latest"),
      evals: outputs.jobs.includes("behavior-evals"),
      packaged_server: packaged && outputs.packaged_server_os.includes("ubuntu-latest"),
    },
  };
}

const SHA = /^[a-f\d]{40}(?:[a-f\d]{24})?$/i;

const git = (args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

function changedFiles(range) {
  // Disabling rename detection retains both old and new paths, including deletions.
  const diff = git(["diff", "--name-only", "--no-renames", "-z", range, "--"]);
  if (!diff || !diff.endsWith("\0")) throw new Error("Empty or invalid changed-path output");
  return diff.slice(0, -1).split("\0");
}

/** The added and removed lines of a range's code, docs and translations left out. */
function changedCodeLines(range) {
  return execFileSync("git", [
    "diff", "-U0", "--no-renames", "--no-color", "--no-ext-diff", range, "--", ".", ":(exclude)*.md", ":(exclude)docs/**", ":(exclude)src/locales/**",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).split("\n");
}

async function github(path) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL = "https://api.github.com" } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are needed to read CI runs");
  const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} reading ${path.split("?")[0]}`);
  return response.json();
}

const ciRuns = async (sha) => (await github(`/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`)).workflow_runs;

/** A pull request's labels as they are now, so a label added after the push counts when the run is re-run; the
 * event's own list when GitHub cannot be read. */
async function pullRequestLabels(pr) {
  const fromEvent = (Array.isArray(pr?.labels) ? pr.labels : []).map((label) => label?.name).filter((name) => typeof name === "string");
  if (!Number.isSafeInteger(pr?.number) || !process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) return fromEvent;
  try {
    return (await github(`/issues/${pr.number}/labels?per_page=100`)).map((label) => label.name);
  } catch (error) {
    console.warn(`CI scope: reading the pull request's labels from its event (${error.message})`);
    return fromEvent;
  }
}

/** Did the commit before this push get a green CI run of its own? Main keeps
 * one run going and one waiting, and a push replaces the waiting run: if the
 * previous commit's run was replaced, its changes were never tested, so this
 * push must run main's checks even when its own diff is docs or a version. */
async function previousCommitGreen(sha) {
  return (await ciRuns(sha)).some((run) => ["push", "merge_group", ...FULL_LANE_EVENTS].includes(run.event)
    && run.status === "completed" && run.conclusion === "success");
}

/** Did this exact commit pass the CI gate in the merge queue? The queue lands a merge group's own commit, so its run
 * already tested what this push brings; the gate job is read because the push can come before the run has finished. */
async function passedMergeQueue(sha) {
  for (const run of (await ciRuns(sha)).filter((candidate) => candidate.event === "merge_group")) {
    const { jobs } = await github(`/actions/runs/${run.id}/jobs?per_page=100`);
    if (jobs.some((job) => job.name === "CI" && job.conclusion === "success")) return true;
  }
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lane = laneOf(process.env.GITHUB_EVENT_NAME);
  let scope = lane === "main" ? MAIN_SCOPE : FULL_SCOPE;
  let vitestOs = lane === "main" ? WINDOWS_OS : ALL_OS;
  if (lane === "pr") {
    try {
      const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      const base = pr?.base?.sha;
      const head = pr?.head?.sha;
      if (![base, head].every((sha) => typeof sha === "string" && SHA.test(sha))) {
        throw new Error("Missing or invalid pull request commit SHAs");
      }
      const files = changedFiles(`${base}...${head}`);
      scope = selectCiScope(files);
      vitestOs = LINUX_OS;
      if (scope.checks.includes("host-tests")) {
        const why = windowsReason({
          files,
          labels: await pullRequestLabels(pr),
          hostE2e: Object.keys((await import("./testing/host-e2e.ts")).HOST_E2E),
          lines: () => changedCodeLines(`${base}...${head}`),
        });
        if (why) vitestOs = WINDOWS_OS;
        console.log(why ? `CI scope: Windows runs for ${why}`
          : `CI scope: nothing here can break Windows first, so its jobs wait for main (label the PR "${WINDOWS_LABEL}" and re-run to run them)`);
      }
    } catch (error) {
      console.warn(`CI scope: using all checks because the pull request diff is unavailable: ${error.message}`);
    }
  } else if (process.env.GITHUB_EVENT_NAME === "push") {
    // A push to main is scoped by its own commits; the release gate counts only
    // a run of every platform's shards as tested.
    try {
      const { before, after } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      if (![before, after].every((sha) => typeof sha === "string" && SHA.test(sha)) || /^0+$/.test(before)) {
        throw new Error("Missing or invalid push commit SHAs");
      }
      const revs = { before, after };
      const selected = selectPushScope(changedFiles(`${before}..${after}`), (rev, path) => git(["show", `${revs[rev]}:${path}`]));
      if (await passedMergeQueue(after)) {
        scope = QUEUED_SCOPE;
      } else if (!selected.runtime && !(await previousCommitGreen(before))) {
        console.warn(`CI scope: using main's checks because ${before} has no green CI run of its own`);
      } else if (!selected.runtime) {
        scope = { areas: ["docs or version only"], checks: ["build"] };
      }
    } catch (error) {
      console.warn(`CI scope: using main's checks because the push diff or its CI is unavailable: ${error.message}`);
    }
  }
  const linuxInStatic = process.env.OMB_CI_LINUX_IN_STATIC === "true";
  const outputs = linuxInStatic ? moveLinuxIntoStatic(ciOutputs(scope, vitestOs)) : ciOutputs(scope, vitestOs);
  console.log(`CI scope: ${scope.areas.join(", ")} -> ${outputs.jobs.join(", ") || "static checks only"}`);
  if (linuxInStatic) {
    const { vitest, evals, packaged_server: packaged } = outputs.linux_lanes;
    console.log(`CI scope: this job runs ${vitest.length} Linux vitest lane(s)${evals ? ", behavior evals" : ""}${packaged ? ", the packaged server smoke" : ""}`);
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${typeof value === "boolean" ? value : JSON.stringify(value)}\n`).join(""),
  );
}
