// A real run, trimmed: a lead asked Kiwi, Rio and Miso to QA-test a site (three coordinate_bots calls at once), then sent
// Rio and Miso a second round, then gave a verdict (fixtures/qa-delegation-run.json, from an isolated real-engine run).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { askValues, draftWorkflow, layerLabel } from "./draft.ts";
import { renderWorkflowSkillMd, workflowSchema } from "./format.ts";
import { burgerLayers, isServerRow, redirectTarget, type RunMessage } from "./layers.ts";

const run = JSON.parse(readFileSync(new URL("./fixtures/qa-delegation-run.json", import.meta.url), "utf8")) as RunMessage[];
const roles: Record<string, string> = { Kiwi: "Accessibility tester", Rio: "Performance tester", Miso: "Content and links tester" };
const teammate = (idOrName: string) => {
  const name = /kiwi/i.test(idOrName) ? "Kiwi" : /rio/i.test(idOrName) ? "Rio" : /miso/i.test(idOrName) ? "Miso" : undefined;
  return name ? { id: `bot-${name.toLowerCase()}`, name, role: roles[name] } : undefined;
};

let n = 0;
const ask = (text: string): RunMessage => ({ id: `u${++n}`, role: "user", kind: "text", text });
const bash = (command: string, extra: Partial<NonNullable<RunMessage["tool"]>> = {}): RunMessage => ({
  id: `m${++n}`, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, itemId: `t${n}`, input: JSON.stringify({ command }), summary: command, ...extra },
});

describe("a delegation run", () => {
  it("never makes a step of the app's own rows about teammates", () => {
    const rows = run.filter((message) => message.kind === "activity" && !message.tool?.itemId);
    expect(rows.map((message) => message.tool!.name)).toEqual(expect.arrayContaining(["Sent to Kiwi", "Kiwi replied", "Resumed with Kiwi, Rio, Miso results, reviewing"]));
    expect(rows.every(isServerRow)).toBe(true);
    const layers = burgerLayers(run);
    expect(layers.map((layer) => [layer.kind, layerLabel(layer)])).toEqual([["delegate", "Ask Kiwi, Rio and Miso"], ["ai", "Review what came back and report"]]);
    expect(layers.some((layer) => /Sent to|replied|Resumed/.test(layer.words))).toBe(false);
  });

  it("drops such a row in any language, by its shape", () => {
    const rows: RunMessage[] = [
      ask("QA-test https://example.com with Kiwi"),
      { id: "r1", role: "bot", kind: "activity", tool: { name: "Enviado a Kiwi", ok: true }, threadRef: { botId: "k", threadId: "t" }, doneWhen: "3 findings" },
      { id: "r2", role: "bot", kind: "activity", tool: { name: "Kiwi respondió", ok: true, output: "done" }, roomRequest: { id: "q1", phase: "result" } },
      { id: "r3", role: "bot", kind: "activity", tool: { name: "Reanudado con los resultados de Kiwi", ok: true } },
      bash("git push origin main"),
    ];
    expect(burgerLayers(rows).map((layer) => layer.kind)).toEqual(["shell"]);
  });

  it("keeps who was asked what, what done means, the second round and the replies", () => {
    const [send] = burgerLayers(run);
    const delegation = send!.delegation!;
    expect(delegation.rounds.map((calls) => calls.map((call) => call.bots.map((bot) => bot.name).join("+")))).toEqual([["Kiwi", "Rio", "Miso"], ["Rio", "Miso"]]);
    expect(delegation.rounds[0]![0]!.doneWhen).toBe("3 findings, each naming the URL checked, with evidence.");
    expect(delegation.replies.map((reply) => [reply.name, reply.round])).toEqual([["Kiwi", 1], ["Rio", 1], ["Miso", 1], ["Rio", 2], ["Miso", 2]]);
    expect(delegation.replies[0]!.text).toContain("Kiwi: 3 findings");
  });

  it("saves one delegate step that can be remapped, with the site as an input, and the review as an AI step", () => {
    const draft = draftWorkflow(run, { teammate })!;
    expect(workflowSchema.safeParse(draft.workflow).success).toBe(true);
    const [send, review] = draft.workflow.steps;
    expect(draft.workflow.args).toEqual({ site: { default: "https://mausbot.com", label: "site" } });
    expect(send).toMatchObject({ kind: "delegate", label: "Ask Kiwi, Rio and Miso", review: { rounds: 1 } });
    if (send?.kind !== "delegate") throw new Error("not a delegate step");
    expect(send.tasks.map((task) => task.bot)).toEqual([
      { id: "bot-kiwi", name: "Kiwi", role: "Accessibility tester" },
      { id: "bot-rio", name: "Rio", role: "Performance tester" },
      { id: "bot-miso", name: "Miso", role: "Content and links tester" },
    ]);
    expect(send.tasks[0]!.message).toEqual(expect.arrayContaining([{ $arg: "site" }]));
    expect(send.tasks.every((task) => task.doneWhen?.startsWith("3 findings"))).toBe(true);
    expect(send.review?.example).toMatch(/^Rio: /);
    expect(review).toMatchObject({ kind: "ai", deterministic: false, input: { $step: "s1", path: "text" } });
    // The replies are this run's results: shown on the card, never written into the workflow.
    expect(JSON.stringify(draft.workflow)).not.toContain("each with the URL checked and evidence");
    const md = renderWorkflowSkillMd("qa-test", draft.workflow);
    expect(md).toContain("Teammates: Kiwi (Accessibility tester), Rio (Performance tester) and Miso (Content and links tester) each get their part at once");
    expect(md).toContain("Done when: 3 findings");
  });

  it("stays a running step while a teammate hasn't replied, whatever the lead said meanwhile", () => {
    // Cut the run just before the second round's replies: the lead's "sent them back" text must not read as its verdict.
    const cut = run.slice(0, run.findIndex((message) => message.roomRequest?.phase === "result" && run.slice(0, run.indexOf(message)).filter((one) => one.roomRequest?.phase === "result").length === 3));
    const layers = burgerLayers(cut);
    expect(layers.map((layer) => [layer.kind, layer.status])).toEqual([["delegate", "running"]]);
    expect(draftWorkflow(cut)).toBeNull();
  });

  it("is no card for fetches alone", () => {
    expect(draftWorkflow([ask("look at two feeds"), bash("curl -s https://example.com/a.json"), bash("curl -s https://example.com/b.json")])).toBeNull();
  });

  it("is one step, not one per call, and not a second step for the second round", () => {
    expect(draftWorkflow(run)!.workflow.steps.map((step) => step.kind)).toEqual(["delegate", "ai"]);
  });
});

describe("values from the ask", () => {
  it("names each typed value by its kind", () => {
    expect(askValues("QA-test https://mausbot.com and email ana@example.com the report.csv from ~/out/x by 2026-12-01, titled \"Weekly QA\"")).toEqual(expect.arrayContaining([
      { value: "https://mausbot.com", name: "site" }, { value: "ana@example.com", name: "email" }, { value: "report.csv", name: "file" },
      { value: "~/out/x", name: "path" }, { value: "2026-12-01", name: "date" }, { value: "Weekly QA", name: "text" },
    ]));
    expect(askValues("open https://python.org/downloads/ now")).toEqual([{ value: "https://python.org/downloads/", name: "url" }]);
  });

  it("lifts a typed value inside a command's double quotes, never plain words inside code", () => {
    const draft = draftWorkflow([
      ask("Fetch https://example.com/feed.json and keep the top stories by score"),
      bash("curl -sf \"https://example.com/feed.json\" -o /tmp/feed.json && python3 -c \"import json; print(sorted(json.load(open('/tmp/feed.json')), key=lambda d: d['score']))\" > top.md"),
      bash("git add top.md && git commit -m 'top stories'"),
    ])!;
    const [fetch] = draft.workflow.steps;
    expect(draft.workflow.args).toEqual({ url: { default: "https://example.com/feed.json", label: "url" } });
    expect(fetch).toMatchObject({ kind: "shell" });
    expect(fetch?.kind === "shell" && fetch.run).toContain('curl -sf "$OMB_ARG_URL"');
    expect(fetch?.kind === "shell" && fetch.run).toContain("d['score']");
  });

  it("never turns a loop's own variable into an input", () => {
    const draft = draftWorkflow([
      ask("Which of these sites answers fastest: example.com, python.org"),
      bash("for site in example.com python.org; do curl -s -o /dev/null -w '%{time_total}' https://$site/; done > times.txt"),
      bash("sort -n times.txt > ranking.txt"),
    ])!;
    const first = draft.workflow.steps[0]!;
    expect(first.kind === "shell" && first.run).toBe('for site in "$OMB_ARG_SITE" "$OMB_ARG_SITE_2"; do curl -s -o /dev/null -w \'%{time_total}\' https://$site/; done > times.txt');
  });
});

describe("a step's place and the run's own leftovers", () => {
  const folder = "/Users/ana/omb/task-workspaces/ae3a6bd7-afb4-4ad1-909b-5a7b6d887ac9/a48d8ea2-161f-4ca1-a80c-0591f3082283";

  it("writes in the conversation it runs in, not the one it was saved from", () => {
    const draft = draftWorkflow([ask("make notes"), bash(`cd ${folder} && echo hi > notes.md`), bash(`cp ${folder}/notes.md ${folder}/copy.md`)])!;
    expect(draft.workflow.steps.map((step) => step.kind === "shell" && step.run)).toEqual(["cd . && echo hi > notes.md", "cp ./notes.md ./copy.md"]);
    expect(draft.layers.map(layerLabel)).toEqual(["Run echo hi > notes.md", "Run cp ./notes.md ./copy.md"]);
  });

  it("gives a step that used a temporary folder of that run to the AI", () => {
    const draft = draftWorkflow([ask("convert it"), bash("D=$(mktemp -d) && curl -sf -o $D/a.json https://example.com/a.json"), bash("in2csv /var/folders/91/abc/T/tmp.HnFgmIesqF/a.json > done.csv")])!;
    expect(draft.workflow.steps[1]).toMatchObject({ kind: "ai", deterministic: false });
  });

  it("keeps the try that worked when a file is written again", () => {
    const layers = burgerLayers([ask("make the csv"), bash("curl -sf https://example.com/a.json -o a.json"), bash("in2csv a.json > done.csv"), bash("in2csv -I a.json > done.csv")]);
    expect(layers.map((layer) => [layerLabel(layer), layer.tries ?? 0])).toEqual([["Run curl -sf https://example.com/a.json -o a.json", 0], ["Run in2csv -I a.json > done.csv", 1]]);
  });

  it("writes text the AI composed after a read again from what it reads, not last time's words", () => {
    const body = "- Latest release is v27.0.0, published 2026-11-17.\n- It is an alpha, so test it in staging first.\n- Notable change: the macOS binary is now notarized.";
    const draft = draftWorkflow([
      ask("Fetch https://api.github.com/repos/nodejs/node/releases/latest and write upgrade.md with a 3-line note"),
      bash("curl -sS https://api.github.com/repos/nodejs/node/releases/latest", { output: "{\"tag_name\":\"v27.0.0\"}" }),
      bash(`cat > upgrade.md <<'EOF'\n${body}\nEOF`),
    ])!;
    expect(draft.workflow.steps.map((step) => [step.kind, step.label])).toEqual([["shell", "Fetch api.github.com"], ["ai", "Write upgrade.md"]]);
    expect(draft.workflow.steps[1]).toMatchObject({ example: body, input: { $step: "s1" } });
  });

  it("reads a redirect only outside quotes", () => {
    expect(redirectTarget("cat > a.md <<'EOF'")).toBe("a.md");
    expect(redirectTarget("echo hi >> log.txt")).toBe("log.txt");
    expect(redirectTarget("grep -o '<h1[^>]*>' home.html")).toBeNull();
    expect(redirectTarget("curl -s url 2>&1 >/dev/null")).toBeNull();
  });
});

describe("a file the person named", () => {
  it("is an input even inside a folder path", () => {
    const draft = draftWorkflow([
      ask("write the summary to top5.md"),
      bash("python3 make.py > /tmp/out.md"),
      bash('cp /tmp/out.md "./top5.md"'),
    ])!;
    expect(draft.workflow.args).toEqual({ file: { default: "top5.md", label: "file" } });
    expect(draft.workflow.steps[1]).toMatchObject({ run: 'cp /tmp/out.md "./$OMB_ARG_FILE"' });
  });
});
