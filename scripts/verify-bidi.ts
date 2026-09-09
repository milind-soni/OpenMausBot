// Right-to-left message rendering in the real app, one disposable home.
//
// A unit test can only prove the markup; whether an Arabic answer actually
// reads correctly is a question about the rendered bubble. This seeds a
// scripted reply that exercises every block a bot reply can contain — prose
// around inline code, a list, a table, a quote, a fenced block, and a trailing
// English paragraph — and mounts the real renderer against it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

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

// Each turn spawns a fresh CLI, so the reply cursor lives in a file — in this
// launcher's own scratch directory, since the fixture home does not exist
// until the server is up. The launcher forwards FAKE_CLAUDE_* to its engine.
const scratch = mkdtempSync(join(tmpdir(), "openmausbot-verify-bidi-"));
const fixture = await launchVerificationServer({
  ...process.env,
  FAKE_CLAUDE_REPLIES: JSON.stringify([ARABIC_REPLY, ENGLISH_REPLY]),
  FAKE_CLAUDE_REPLY_STATE: join(scratch, "bidi-reply-cursor"),
}).catch(async (error) => {
  await removeTempDir(scratch);
  throw error;
});
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);

  await control(["new-bot", "--name", "Probe"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const probe = bots.find((bot: { name: string }) => bot.name === "Probe");

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

  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/__bidi.html", title: "Isolated OpenMaus Bidi",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
  await removeTempDir(scratch);
}
