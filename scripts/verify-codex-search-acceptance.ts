// Real-model search acceptance through an isolated OpenMausBot server.
// Existing sign-in is explicitly designated; personal chats/config are not copied.
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";
import { verifiedNativeSearch } from "./testing/native-search-evidence.ts";

const cli = process.env.OMB_VERIFY_CODEX_CLI;
const auth = process.env.OMB_VERIFY_CODEX_AUTH;
const output = process.env.OMB_VERIFY_OUTPUT;
const models = (process.env.OMB_VERIFY_MODELS ?? "gpt-5.6-luna").split(",").map(model => model.trim()).filter(Boolean);
if (!models.length) throw new Error("Choose at least one acceptance model.");
if (!cli || !auth || !output) throw new Error("Supply explicit CLI, sign-in and output. Uses real model quota.");
mkdirSync(output, { recursive: true });
const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
const api = fixtureApi(fixture.info.url);
const report: any = { fixture: fixture.info, cases: [] };
const save = () => writeFileSync(join(output, "acceptance.json"), JSON.stringify(report, null, 2));
try {
  const codexHome = join(fixture.info.dataDir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(auth, join(codexHome, "auth.json"));
  // No search-mode override: exercise Codex's normal default too.
  writeFileSync(join(codexHome, "config.toml"), '');
  await api("PATCH", "/api/instances/codex", { cli });
  console.log(JSON.stringify({ fixture: fixture.info }));
  for (const model of models) {
    const { bot } = await api("POST", "/api/bots", {
      name: `Search test ${model}`, description: "A helpful assistant.",
      modelSelection: { instanceId: "codex", model },
    });
    const prompt = "Check the current official OpenAI documentation: is the built-in browser available in Codex CLI? After searching, open the source URL in a separate call, read it, and cite that exact URL in your answer.";
    const entry: any = { model, prompt, botId: bot.id };
    report.cases.push(entry); save();
    entry.sent = await runControlOmb(["send", "--bot", bot.id, "--text", prompt, "--url", fixture.info.url]);
    console.log(JSON.stringify({ model, sent: entry.sent }));
    const deadline = Date.now() + 240_000;
    do {
      entry.wait = await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30", "--url", fixture.info.url]);
      save();
      if (["settled", "failed", "needs-user", "stalled"].includes(entry.wait?.status)) break;
    } while (Date.now() < deadline);
    entry.messages = await runControlOmb(["messages", "--bot", bot.id, "--limit", "50", "--url", fixture.info.url]);
    const nativePath = join(fixture.info.dataDir, "native", `${entry.sent.taskId}.ndjson`);
    const records = readFileSync(nativePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const searches = records.filter(record => record.msg?.method === "item/completed" && record.msg?.params?.item?.type === "webSearch");
    writeFileSync(join(output, `${model}-search.json`), JSON.stringify(searches, null, 2));
    entry.searches = searches.map(record => record.msg.params.item);
    // webSearch has no status field in Codex 0.154. Verify result records,
    // rather than mistaking an absent status or a completed turn for success.
    const hasResults = (item: any) => item.results?.some((result: any) => result.type === "text_result" && result.url && result.snippet && result.title !== "Internal Error");
    entry.failedSearchCalls = entry.searches.filter((item: any) => !hasResults(item));
    // A failed page fetch may be recovered. Require actual search results AND
    // a fetched source page; preserve intermediate failures in the report.
    entry.verified = verifiedNativeSearch(entry.wait?.status, entry.searches, entry.messages.messages);
    save();
    console.log(JSON.stringify({ model, status: entry.wait?.status, verified: entry.verified, searches: entry.searches }));
  }
  if (report.cases.length !== models.length || report.cases.some((entry: any) => !entry.verified)) throw new Error("Native search acceptance failed; inspect report.");
} catch (error) {
  report.error = String(error); save(); throw error;
} finally {
  try {
    if (existsSync(fixture.info.logPath)) writeFileSync(join(output, "server.log"), readFileSync(fixture.info.logPath));
    save();
  } finally {
    await fixture.close();
  }
}
