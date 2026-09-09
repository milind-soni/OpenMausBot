// Right-to-left message rendering in the real app, one disposable home.
//
// A unit test can only prove the markup; whether an Arabic answer actually
// reads correctly is a question about the rendered bubble. This seeds a
// scripted reply that exercises every block a bot reply can contain — prose
// around inline code, a list, a table, a quote, a fenced block, and a trailing
// English paragraph — and mounts the real renderer against it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const ARABIC_REPLY = [
  "## تقرير الأداء الأسبوعي",
  "",
  "راجعت الملفات الثلاثة، والنتيجة أن `buildIndex()` هي المسؤولة عن التأخير الأكبر — تستهلك 340ms من أصل 512ms.",
  "",
  "الأسباب الرئيسية:",
  "",
  "- استدعاء `fs.readFileSync` داخل الحلقة بدل قراءة واحدة مسبقة",
  "- عدم وجود cache للنتائج بين الاستدعاءات المتتالية",
  "- تمرير المصفوفة كاملة إلى `sort()` في كل مرة (المشكلة الأهم)",
  "",
  "| الدالة | الزمن | النسبة |",
  "| --- | --- | --- |",
  "| buildIndex | 340ms | 66% |",
  "| parseHeaders | 118ms | 23% |",
  "| flush | 54ms | 11% |",
  "",
  "> ملاحظة: القياسات أُخذت على macOS مع Node 24، وقد تختلف على Linux.",
  "",
  "الإصلاح المقترح في `src/lib/index.ts`:",
  "",
  "```ts",
  "// hoist the read out of the loop and memoize per content hash",
  "const cache = new Map<string, Index>();",
  "",
  "export function buildIndex(paths: string[]): Index {",
  "  const hit = cache.get(paths.join(\"|\"));",
  "  if (hit) return hit;",
  "  return merge(paths.map((p) => readFileSync(p, \"utf8\")).map(parse));",
  "}",
  "```",
  "",
  "And here is an English paragraph closing the same reply — it must stay left-to-right on its own, independently of every block above it.",
].join("\n");

const ENGLISH_REPLY = [
  "## Weekly performance report",
  "",
  "`buildIndex()` owns the delay: 340ms of 512ms. Fix it in `src/lib/index.ts`.",
  "",
  "- hoist the read out of the loop",
  "- memoize per content hash",
  "",
  "وهذه فقرة عربية تُغلق ردًّا إنجليزيًّا — يجب أن تُقرأ من اليمين وحدها.",
].join("\n");

const fixture = await launchVerificationServer();
let ui: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);

  await control(["new-bot", "--name", "Probe"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const probe = bots.find((bot: { name: string }) => bot.name === "Probe");

  // Each turn spawns a fresh CLI, so the reply cursor lives in a file inside
  // this fixture's own home rather than in the process.
  const replyState = join(fixture.info.dataDir, "bidi-reply-cursor");
  const wrapper = join(fixture.info.dataDir, "bidi-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([ARABIC_REPLY, ENGLISH_REPLY]))};`,
    `process.env.FAKE_CLAUDE_REPLY_STATE = ${JSON.stringify(replyState)};`,
    `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../server/testing/fake-claude-cli.ts", import.meta.url))).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });

  // A multi-line user turn that mixes scripts: the sent bubble must resolve
  // each line on its own, not let the first line decide for all of them.
  await control(["send", "--bot", probe.id, "--text", [
    "شغّل الاختبارات وقل لي أين المشكلة",
    "Then run pnpm typecheck and paste the output",
    "وبعدها ارفع الفرع",
    "שלום עולם",
  ].join("\n")]);
  await control(["wait", "--bot", probe.id, "--timeout", "30"]);
  await control(["send", "--bot", probe.id, "--text", "Now summarise that in English"]);
  await control(["wait", "--bot", probe.id, "--timeout", "30"]);

  ui = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{ name: "isolated-bidi", configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/__bidi.html") return next();
        void server.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Isolated OpenMaus Bidi</title></head><body><div id="root"></div><script type="module" src="/scripts/testing/threads-preview.tsx"></script></body></html>')
          .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      });
    } }],
  });
  await ui.listen();
  console.log(JSON.stringify({ ...fixture.info, previewUrl: `${ui.resolvedUrls!.local[0]}__bidi.html` }));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await ui?.close();
  await fixture.close();
}
