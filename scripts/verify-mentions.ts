// Real chat views and composer against a disposable fake-engine server.
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
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
  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-mentions", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__mentions.html") return next();
        void server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated mention verification</title></head><body><div id="root"></div><script type="module" src="/src/testing/mentions.tsx"></script></body></html>')
          .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `${ui.resolvedUrls!.local[0]}__mentions.html` }));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await ui?.close();
  await fixture.close();
}
