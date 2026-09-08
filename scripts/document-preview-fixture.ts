#!/usr/bin/env -S node --experimental-strip-types
// An isolated fixture on the existing control surface. No real provider or
// user data is used. Keep this terminal open while inspecting the UI.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await launchVerificationServer();
try {
  const { url, dataDir } = fixture.info;
  const health = await (await fetch(`${url}/api/health`)).json() as { pid: number };
  if (health.pid !== fixture.info.pid) throw new Error("Fixture ownership mismatch");
  /** Pin every mapped command to this fixture's URL, never the live app. */
  const call = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const { bot } = await call("new-bot", "--name", "Document Studio") as { bot: { id: string } };
  const workspace = join(dataDir, "workspaces", bot.id);
  mkdirSync(workspace, { recursive: true });
  const documents: Array<[string, string, string | null]> = [
    ["Weekly review", "Weekly review.md", "# Weekly activity\n\nA focused review of the week, with the conversation still in view.\n\n## What changed\n\n- Morning sessions became more consistent.\n- Wednesday had the most activity.\n- Keep Friday afternoon free for review.\n\n| Day | Sessions | Focus time |\n| --- | ---: | ---: |\n| Monday | 8 | 3 h |\n| Wednesday | 12 | 4.5 h |\n| Friday | 6 | 2 h |\n\n## Next steps\n\n1. Review the heatmap.\n2. Adjust the threshold.\n3. Save the complete report.\n\n> Illustrative data for the preview fixture.\n\n### Notes\n\nUnicode text and filenames with spaces are supported: Привет, мир.\n"],
    ["Plain text notes", "Read me.txt", "Notes for the week\n\nPlain text stays plain.\n<iframe src='file:///secret'>\nUnicode: Привет, мир.\n"],
    ["Long document", "Long report.md", "# Long report\n\n" + "A paragraph for bounded preview and scrolling.\n\n".repeat(8000)],
    ["Missing document", "Missing.md", null],
    ["PDF download", "Report.pdf", "%PDF-1.4\nDownload-only fixture\n"],
    ["Untrusted content", "Untrusted.md", "# Untrusted content\n\n<script>window.untrustedRan=true</script>\n\n![Remote resource](https://invalid.example/document.png)\n\n[Local resource](file:///private/secret.txt)\n"],
  ];
  const links = documents.map(([label, name, contents]) => {
    const path = join(workspace, name);
    if (contents !== null) writeFileSync(path, contents);
    return `- [${label}](<${path.replaceAll("\\", "/")}>)`;
  });
  const outside = join(dataDir, "Private report.md");
  writeFileSync(outside, "Private fixture content outside the workspace");
  links.push(`- [Outside workspace](<${outside.replaceAll("\\", "/")}>)`);
  const reply = `## Your weekly review\n\nThe report and source notes are ready. Open a document to read it beside our conversation.\n\n${links.join("\n")}`;
  const cli = join(dataDir, "document-fake.mjs");
  writeFileSync(cli, `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};\nawait import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`);
  const configured = await fetch(`${url}/api/instances/claude`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cli }),
  });
  if (!configured.ok) throw new Error(`Cannot configure fake engine: ${configured.status}`);
  await call("send", "--bot", bot.id, "--text", "Prepare a weekly review and share the documents.");
  const result = await call("wait", "--bot", bot.id, "--timeout", "30") as { status: string };
  if (result.status !== "settled") throw new Error(`Fixture turn did not settle: ${result.status}`);
  console.log(JSON.stringify({ ok: true, ...fixture.info, botId: bot.id,
    messages: await call("messages", "--bot", bot.id, "--limit", "10") }, null, 2));
  await new Promise<void>((done) => {
    /** Release the fixture wait on shutdown; the outer finally closes its server. */
    const stop = () => done();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    fixture.child.once("close", stop);
  });
} finally {
  await fixture.close();
}
