// Measures, on this computer, which MCP tools Google's native Antigravity CLI shows its model: one tool alone at sizes
// either side of 950 bytes and up to the budget, many tools at once, long names, a deep profile folder (Windows path
// length), and a session shaped like a bot with connected apps before and after the session budget.
//   node scripts/testing/antigravity-cli-probe.ts [--cli <path to antigravity or agy.exe>]
// Without --cli it downloads the CLI the app would install, into a temporary folder. It never uses a sign-in: every run
// has a new temporary home and profile, a made-up API key and a loopback stand-in for the model. Prints one table (also
// to $GITHUB_STEP_SUMMARY); a CLI that cannot be downloaded or opened is reported in one line, and the run still exits 0.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "agp-"));
const home = join(scratch, "home");
for (const folder of ["home", "data", "appdata", "localappdata"]) mkdirSync(join(scratch, folder), { recursive: true });
process.env.OMB_DATA_DIR = join(scratch, "data");
const cliEnv: NodeJS.ProcessEnv = {
  ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(scratch, "appdata"), LOCALAPPDATA: join(scratch, "localappdata"),
};

const lines: string[] = [];
const say = (line: string) => {
  lines.push(line);
  console.log(line);
};
const finish = (): never => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  process.exit(0);
};

const { probeAntigravityCli, toolOfBytes } = await import("../../server/testing/antigravity-cli-probe.ts");
type ProbeTool = import("../../server/testing/antigravity-cli-probe.ts").ProbeTool;

async function obtainCli(): Promise<{ path: string; version: string } | string> {
  const given = process.argv.indexOf("--cli");
  if (given > 0 && process.argv[given + 1]) return { path: process.argv[given + 1]!, version: "given" };
  try {
    const { latestAntigravityCliRelease } = await import("../../server/drivers/antigravity-cli-release.ts");
    const { installAntigravityCli } = await import("../../server/drivers/antigravity-cli-install.ts");
    const release = await latestAntigravityCliRelease();
    if (!release) return "Google's update channel offered no CLI release for this platform";
    const installed = await installAntigravityCli(release, { root: join(scratch, "cli") });
    return { path: installed.executablePath, version: release.version };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const cli = await obtainCli();
say(`## Antigravity CLI tool probe (${process.platform}-${process.arch})`);
if (typeof cli === "string") {
  say(`RESULT: CLI not obtainable: ${cli}`);
  finish();
}
const executable = (cli as { path: string }).path;

let runs = 0;
async function shown(servers: Record<string, readonly ProbeTool[]>, profile?: string) {
  runs += 1;
  const result = await probeAntigravityCli({ executable, profile: profile ?? join(scratch, `p${runs}`), env: cliEnv, servers, settleMs: 3_000, prompt: true });
  const rows = Object.values(result.servers).flat();
  return { result, rows, kept: rows.filter((row) => row.kept), dropped: rows.filter((row) => !row.kept) };
}
const sum = (rows: Array<{ bytes: number }>) => rows.reduce((total, row) => total + row.bytes, 0);

const first = await shown({ probe: [toolOfBytes("one", 965)] });
if (first.result.session !== "ok" || first.result.modelTools === undefined || first.result.modelTools.length === 0) {
  say(`RESULT: could not open a session (CLI ${first.result.version}, session/new: ${first.result.session}, model request ${first.result.modelTools ? "had no tools" : "never came"})`);
  finish();
}
say(`CLI version: ${first.result.version}`);
say("");
say("| run | tools | bytes offered | shown | dropped | largest shown | smallest dropped |");
say("|---|---|---|---|---|---|---|");
const row = (label: string, run: Awaited<ReturnType<typeof shown>>) => say(`| ${label} | ${run.rows.length} | ${sum(run.rows)} | ${run.kept.length} | ${run.dropped.length} | ${run.kept.length ? Math.max(...run.kept.map((tool) => tool.bytes)) : "-"} | ${run.dropped.length ? Math.min(...run.dropped.map((tool) => tool.bytes)) : "-"} |`);

/** One row of the table; a row that fails says why and the rest still run. */
async function attempt(label: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    say(`| ${label} | row failed: ${(error instanceof Error ? error.message : String(error)).replace(/\|/g, "/").slice(0, 200)} | | | | | |`);
  }
}

const single: Record<number, boolean> = {};
for (const bytes of [900, 944, 950, 965, 1_000, 2_000, 4_000, 20_000, 50_000]) {
  await attempt(`one tool of ${bytes} B`, async () => {
    const run = await shown({ probe: [toolOfBytes("one", bytes)] });
    single[bytes] = run.kept.length === 1;
    row(`one tool of ${bytes} B`, run);
  });
}
let low = 50_000, high = 62_000;
await attempt("largest single tool shown", async () => {
  while (high - low > 100) {
    const middle = Math.floor((low + high) / 2);
    if ((await shown({ probe: [toolOfBytes("one", middle)] })).kept.length === 1) low = middle; else high = middle;
  }
  say(`| largest single tool shown | 1 | ${low} (dropped at ${high}) | | | | |`);
});
const missing = [965, 1_000, 4_000].filter((bytes) => single[bytes] === false);
say("");
say(`RESULT: ${missing.length
  ? `a tool of ${missing.join(", ")} B alone was NOT shown: a per-tool size limit exists on this platform`
  : `every single tool from 900 B to 50 KB was shown alone and the largest single tool shown was about ${low} B: no per-tool size limit, one budget shared by all tools`}`);
say("");
say("| run | tools | bytes offered | shown | dropped | largest shown | smallest dropped |");
say("|---|---|---|---|---|---|---|");
await attempt("20 tools, 200 B to 4 KB", async () => row("20 tools, 200 B to 4 KB", await shown({ probe: [200, 400, 600, 800, 900, 910, 920, 930, 940, 944, 950, 960, 965, 970, 980, 1_000, 1_500, 2_000, 3_000, 4_000].map((bytes) => toolOfBytes(`g${bytes}`, bytes)) })));
for (const count of [10, 40, 80, 150]) await attempt(`${count} tools of 600 B`, async () => row(`${count} tools of 600 B`, await shown({ probe: Array.from({ length: count }, (_, index) => toolOfBytes(`c${index}`, 600)) })));
await attempt("80 tools, 800 B to 1,590 B", async () => row("80 tools, 800 B to 1,590 B", await shown({ probe: Array.from({ length: 80 }, (_, index) => toolOfBytes(`s${String(index).padStart(2, "0")}`, 800 + index * 10)) })));
const named = (length: number) => (`n${length}_${"x".repeat(length)}`).slice(0, length);
await attempt("tool names", async () => {
  const names = await shown({ probe: [50, 54, 55, 60].map((length) => toolOfBytes(named(length), 900)) });
  say(`| tool names 50/54/55/60 chars (mcp_probe_ + name): shown / dropped by length | 4 | ${sum(names.rows)} | ${names.kept.map((tool) => tool.name.length).join(",") || "none"} | ${names.dropped.map((tool) => tool.name.length).join(",") || "none"} | | |`);
});
await attempt("deep profile", async () => {
  const deep = join(scratch, ...Array.from({ length: 12 }, (_, index) => `deep-profile-folder-${index}`));
  const run = await shown({ probe: Array.from({ length: 5 }, (_, index) => toolOfBytes(`${named(50)}${index}`.slice(-50), 900 + index * 30)) }, deep);
  say(`| deep profile (session ${run.result.session}), definition file paths up to ${run.result.longestPath} chars | 5 | ${sum(run.rows)} | ${run.kept.length} | ${run.dropped.length} | files written: ${run.result.files.length} | |`);
});

await attempt("bot + connected apps", async () => {
  const { workspaceAppsLikeCatalog } = await import("../../server/testing/workspace-apps-like-catalog.ts");
  const { fitToolList } = await import("../../server/mcp-tool-schema.ts");
  const { toolSchemaProfile } = await import("../../server/tool-schema-profile.ts");
  const { agentsToolList } = await import("../../server/drivers/agents-mcp.ts");
  const { TOOL_LIST: BROWSER } = await import("../../server/browser/tools.ts");
  const { DATA_TOOLS } = await import("../../server/data/tools.ts");
  const { sessionToolShares } = await import("../../server/drivers/own-mcp-session-budget.ts");
  const { ANTIGRAVITY_CLI_TOOL_BUDGET, fitToolListToShare } = await import("../../server/tool-list-budget.ts");
  const gemini = toolSchemaProfile("gemini")!;
  const own = [agentsToolList({ OMB_CHIEF_OF_STAFF: "1", OMB_COMPUTER_SELECTION: "1" }).listed, BROWSER, DATA_TOOLS] as ProbeTool[][];
  const apps = fitToolList(workspaceAppsLikeCatalog(), gemini) as ProbeTool[];
  const plain = (tools: readonly ProbeTool[]) => tools.map(({ name, description, inputSchema }) => ({ name, description: description ?? "", inputSchema: inputSchema ?? { type: "object" } }));
  const ownShares = sessionToolShares(own, ANTIGRAVITY_CLI_TOOL_BUDGET).shares;
  const before = await shown({
    agents: plain(fitToolListToShare(own[0]!, ownShares[0]!).tools), browser: plain(fitToolListToShare(own[1]!, ownShares[1]!).tools),
    data: plain(fitToolListToShare(own[2]!, ownShares[2]!).tools), composio: plain(apps),
  });
  row("bot + 74 connected-app tools, own servers budgeted only", before);
  say(`| (dropped there) | | | | ${before.dropped.map((tool) => tool.name).slice(0, 12).join(", ")}${before.dropped.length > 12 ? ", ..." : ""} | | |`);
  const everyShare = sessionToolShares([...own, apps], ANTIGRAVITY_CLI_TOOL_BUDGET).shares;
  row("same, every server budgeted", await shown({
    agents: plain(fitToolListToShare(own[0]!, everyShare[0]!).tools), browser: plain(fitToolListToShare(own[1]!, everyShare[1]!).tools),
    data: plain(fitToolListToShare(own[2]!, everyShare[2]!).tools), composio: plain(fitToolListToShare(apps, everyShare[3]!).tools),
  }));
});
writeFileSync(join(scratch, "summary.md"), `${lines.join("\n")}\n`);
finish();
