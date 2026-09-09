// Real chat views and composer against a disposable fake-engine server.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  // Opt in to an actual fake-engine reply containing peer mentions. A shared
  // counter makes subsequent replies plain, so channel handoffs stay bounded.
  if (process.argv.includes("--bot-mentions")) {
    const cli = join(fixture.info.dataDir, "mention-reply.mjs");
    const reply = "@Juniper please review. @調査担当 確認してください。 @Atlas final check.\n\nReverse: @調査担当 then @Juniper.\n\nPlain prefixes: @調査担当者 @everyone調査. Neutral: @everyone.";
    await writeFile(cli, `#!/usr/bin/env node\nprocess.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};\nprocess.env.FAKE_CLAUDE_REPLY_STATE = ${JSON.stringify(join(fixture.info.dataDir, "mention-replies.txt"))};\nawait import(${JSON.stringify(new URL("../server/testing/fake-claude-cli.ts", import.meta.url).href)});\n`, { mode: 0o755 });
    const response = await fetch(`${fixture.info.url}/api/instances/claude`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cli }),
    });
    if (!response.ok) throw new Error(`Could not configure mention reply fixture: ${response.status}`);
  }
  for (const name of ["Atlas", "Juniper", "調査担当"]) {
    await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  }
  const { bots } = await fetch(`${fixture.info.url}/api/bots`).then((r) => r.json()) as { bots: Array<{ id: string; name: string }> };
  await runControlOmb(["new-channel", "--name", "Design review", "--members", bots.map((b) => b.id).join(","), "--url", fixture.info.url]);
  ui = await mountPreview(fixture, {
    entry: "/src/testing/mentions.tsx", route: "/__mentions.html", title: "Isolated mention verification",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
