// Real chat views and composer against a disposable fake-engine server.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

// Opt in to an actual fake-engine reply containing peer mentions. A shared
// counter makes subsequent replies plain, so channel handoffs stay bounded; it
// lives in this launcher's own scratch directory because the fixture home does
// not exist until the server is up. The launcher forwards FAKE_CLAUDE_*.
const reply = "@Juniper please review. @調査担当 確認してください。 @Atlas final check.\n\nReverse: @調査担当 then @Juniper.\n\nPlain prefixes: @調査担当者 @everyone調査. Neutral: @everyone.";
const scratch = process.argv.includes("--bot-mentions") ? mkdtempSync(join(tmpdir(), "openmausbot-verify-mentions-")) : undefined;
const fixture = await launchVerificationServer({
  ...process.env,
  ...(scratch ? { FAKE_CLAUDE_REPLIES: JSON.stringify([reply]), FAKE_CLAUDE_REPLY_STATE: join(scratch, "mention-replies.txt") } : {}),
}).catch(async (error) => {
  if (scratch) await removeTempDir(scratch);
  throw error;
});
let ui: MountedPreview | undefined;
try {
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
  if (scratch) await removeTempDir(scratch);
}
