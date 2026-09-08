import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import {
  INTERACTIVE_CHOICE_EXAMPLE,
  INTERACTIVE_COMPARE_EXAMPLE,
  INTERACTIVE_HEATMAP_EXAMPLE,
} from "../shared/interactive-examples.ts";

/** Uses the same isolated launcher and mapped chat operations as normal QA.
 * All replies are scripted; no provider account, user task or quota is used. */
const fixture = await launchVerificationServer();
const { url, dataDir } = fixture.info;
try {
  const health = await (await fetch(`${url}/api/health`)).json();
  if (health.pid !== fixture.info.pid) throw new Error("Fixture ownership mismatch");
  const call = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const created = (await call("new-bot", "--name", "Interactive Studio")) as { bot: { id: string } };
  const examples = [INTERACTIVE_CHOICE_EXAMPLE, INTERACTIVE_HEATMAP_EXAMPLE, INTERACTIVE_COMPARE_EXAMPLE];
  if (process.argv.includes("--include-errors"))
    examples.push(
      'root = UnknownComponent("Unsupported content");',
      'root = NumberInput("Invalid range", 8, 1, 1, 2);',
      'root = Chart("Mismatched chart", ["A", "B"], [{name:"Series",values:[1]}], "bar");',
      'root = Heatmap("Mismatched rows", ["A", "B"], ["X"], [[1]], 0);',
      'root = Heatmap("Mismatched columns", ["A"], ["X", "Y"], [[1]], 0);',
    );
  const reply =
    "Explore a work plan, inspect the activity or compare the sample plans. Changes remain local until you send a draft.\n\n" +
    examples.map((source) => `\`\`\`openmaus-ui\n${source}\n\`\`\``).join("\n\n");
  const wrapper = join(dataDir, "interactive-fake.mjs");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};\nawait import(${JSON.stringify(pathToFileURL(resolve("server/testing/fake-claude-cli.ts")).href)});`,
  );
  const changed = await fetch(`${url}/api/instances/claude`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cli: wrapper }),
  });
  if (!changed.ok) throw new Error(`Cannot configure fixture: ${changed.status}`);
  await call(
    "send",
    "--bot",
    created.bot.id,
    "--text",
    "Build a local work-plan explorer with a time budget and estimate, and let me explore the sample data.",
  );
  const result = await call("wait", "--bot", created.bot.id, "--timeout", "30");
  console.log(JSON.stringify({ ...fixture.info, botId: created.bot.id, result }, null, 2));
  await new Promise<void>((done) => {
    const stop = () => {
      void fixture.close().finally(done);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
} finally {
  await fixture.close();
}
