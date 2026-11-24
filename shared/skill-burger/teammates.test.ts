import { describe, expect, it } from "vitest";

import { draftWorkflow } from "./draft.ts";
import { workflowSchema } from "./format.ts";
import { burgerLayers, type BurgerLayer, type RunMessage } from "./layers.ts";
import { flattenRun, teamLayers, type TeammateSource } from "./teammates.ts";

let n = 0;
let clock = 1_000;
const at = () => (clock += 1_000);
const ask = (text: string): RunMessage => ({ id: `u${++n}`, role: "user", kind: "text", text, at: at() });
const tool = (name: string, input: unknown, extra: Partial<NonNullable<RunMessage["tool"]>> = {}): RunMessage => ({
  id: `m${++n}`, role: "bot", kind: "activity", at: at(), tool: { name, ok: true, itemId: `i${n}`, input: JSON.stringify(input), ...extra },
});
const app = (slug: string, args: unknown) => tool("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: slug, arguments: args }] });
const coordinate = (bot: string, message: string) => tool("mcp__agents__coordinate_bots", { bot_ids: [bot], message });
/** "Sent to <bot>", in whatever language: only its fields say what it is. */
const sent = (bot: { id: string; name: string }, threadId: string, words = `Sent to ${bot.name}`): RunMessage => ({
  id: `m${++n}`, role: "bot", kind: "activity", at: at(), from: { botId: "chief", name: "Pepper" },
  tool: { name: words, ok: true }, threadRef: { botId: bot.id, threadId, title: `@${bot.name} · work` },
});
const replied = (bot: { id: string; name: string }, threadId: string, request: string, output: string, ok = true, words = `${bot.name} replied`): RunMessage => ({
  id: `m${++n}`, role: "bot", kind: "activity", at: at(), from: { botId: bot.id, name: bot.name }, roomRequest: { id: request, phase: "result" },
  tool: { name: words, ok, ...(ok ? { output } : {}) }, threadRef: { botId: bot.id, threadId, title: `@${bot.name} · work` },
});
const request = (bot: { name: string }, id: string, text: string): RunMessage => ({ id: `m${++n}`, role: "bot", kind: "text", at: at(), roomRequest: { id, phase: "request" }, text: `@${bot.name} ${text}` });
const says = (text: string): RunMessage => ({ id: `m${++n}`, role: "bot", kind: "text", at: at(), text });

const kiwi = { id: "kiwi-1234567890", name: "Kiwi" };
const rio = { id: "rio-1234567890", name: "Rio" };
const miso = { id: "miso-1234567890", name: "Miso" };
const lemon = { id: "lemon-1234567890", name: "Lemon" };

function source(threads: Record<string, RunMessage[]>, bots: Array<{ id: string; name: string }>, options: { hidden?: string[]; folders?: Record<string, string> } = {}): TeammateSource {
  return {
    messages: (threadId) => threads[threadId] ?? null,
    bot: (botId) => bots.find((bot) => bot.id === botId) ?? null,
    mayRead: (botId) => !options.hidden?.includes(botId),
    folder: (botId) => options.folders?.[botId],
  };
}

const lines = (layers: readonly BurgerLayer[]) => layers.map((layer) => `${layer.kind}:${layer.words}${layer.from ? ` <${layer.from.name}>` : ""}`);

describe("rows about handing work on are never steps", () => {
  it("leaves out sent, replied and resumed rows in any language, and keeps a command an engine titled with itself", () => {
    const run = [
      ask("Prepare the launch brief"),
      coordinate("Kiwi", "Check the price"),
      sent(kiwi, "tk", "An Kiwi gesendet"),
      replied(kiwi, "tk", "r1", "Pro is $20", true, "Kiwi hat geantwortet"),
      // "Resumed with Kiwi results, reviewing": a line the app wrote, with spaces, no input and no engine id.
      { id: "m-resume", role: "bot", kind: "activity", tool: { name: "Mit den Ergebnissen von Kiwi fortgesetzt, wird geprüft", ok: true } },
      // A result coming back from another place: only its request marks it.
      { id: "m-far", role: "bot", kind: "activity", roomRequest: { id: "r9", phase: "result" }, tool: { name: "Rio a répondu", ok: true, output: "fait" } },
      { id: "m-direct", role: "bot", kind: "activity", sentDirectly: { name: "Miso" }, tool: { name: "Miso hat es direkt bekommen", ok: true } },
      { id: "m-notice", role: "bot", kind: "activity", tool: { name: "Das Modell wurde gewechselt", ok: true, nameCode: "chat.notice.modelChanged" } },
      tool("git push origin main", {}, { summary: "git push origin main" }),
      tool("Bash", { command: "pnpm build" }),
    ];
    expect(lines(burgerLayers(run))).toEqual(["shell:git push origin main", "shell:pnpm build"]);
  });
});

describe("teammates' steps brought in", () => {
  it("brings three teammates' work in order, then a second round, leaving out a step already taken", () => {
    // Round one's staging, then round two's: the second runs after the file changed, so it stays.
    const tk = [request(kiwi, "k1", "Check the Pro plan price on example.com/pricing."), tool("mcp__browser__browser_navigate", { url: "https://example.com/pricing" }), tool("mcp__browser__browser_snapshot", {}), tool("Write", { file_path: "/work/kiwi/pricing.md", content: "Pro: $20\n" })];
    const tr = [request(rio, "r1", "Pull this week's launch emails and sum up what people ask."), app("GMAIL_FETCH_EMAILS", { query: "launch", max_results: 20 })];
    const tm = [request(miso, "m1", "Draft the announcement."), tool("Write", { file_path: "announcement.md", content: "# Hi\n" }), tool("Bash", { command: "git add announcement.md", cwd: "/work/miso" })];
    const run: RunMessage[] = [
      ask("Prepare the launch brief"),
      coordinate("Kiwi", "Check the Pro plan price on example.com/pricing."), sent(kiwi, "tk"),
      coordinate("Rio", "Pull this week's launch emails and sum up what people ask."), sent(rio, "tr"),
      coordinate("Miso", "Draft the announcement."), sent(miso, "tm"),
      replied(kiwi, "tk", "k1", "Pro is $20 a month."),
      replied(rio, "tr", "r1", "People mostly ask about pricing (5 emails), Linux support (3) and whether saved bots carry over (2). One asked for a demo; the pricing questions are the ones to answer first."),
      replied(miso, "tm", "m1", "Drafted it."),
    ];
    // Round two: Rio again (the same fetch, then a narrower one), Miso again (the same staging, a new draft).
    tr.push(request(rio, "r2", "Only the pricing emails now."), app("GMAIL_FETCH_EMAILS", { max_results: 20, query: "launch" }), app("GMAIL_FETCH_EMAILS", { query: "launch pricing", max_results: 20 }));
    tm.push(request(miso, "m2", "Add the price."), tool("Write", { file_path: "announcement.md", content: "# Hi\nPro is $20.\n" }), tool("Bash", { command: "git add announcement.md" }));
    run.push(
      tool("Mit den Ergebnissen fortgesetzt", {}, { itemId: undefined }),
      coordinate("Rio", "Only the pricing emails now."), sent(rio, "tr"),
      coordinate("Miso", "Add the price."), sent(miso, "tm"),
      replied(rio, "tr", "r2", "Pricing emails ask whether Pro is billed monthly and whether teams pay per seat; nobody minded the price itself, only how billing works, so the announcement should say both clearly."),
      replied(miso, "tm", "m2", "Added."),
      says("All done."),
    );
    const layers = teamLayers(run, source({ tk, tr, tm }, [kiwi, rio, miso], { folders: { [kiwi.id]: "/work/kiwi" } }));
    expect(lines(layers)).toEqual([
      "browser:example.com <Kiwi>", "file:pricing.md <Kiwi>",
      "app:fetch emails <Rio>", "ai:Pull this week's launch emails and sum up what people ask <Rio>",
      "file:announcement.md <Miso>", "shell:git add announcement.md <Miso>",
      // Round two: the same fetch is left out; staging again after the file changed is not a repeat.
      "app:fetch emails <Rio>", "ai:Only the pricing emails now <Rio>",
      "file:announcement.md <Miso>", "shell:git add announcement.md <Miso>",
    ]);
    expect(layers.some((layer) => /Sent to|replied|fortgesetzt/.test(layer.words))).toBe(false);
    // A teammate's folder isn't this bot's: its path is kept relative, its command's folder dropped.
    expect(layers[1]!.args).toEqual({ path: "pricing.md", content: "Pro: $20\n" });
    expect(layers[5]!.args).toEqual({ command: "git add announcement.md" });
    expect(layers[0]!.note).toBe("Check the Pro plan price on example.com/pricing");
    const part = layers[3]!;
    expect(part).toMatchObject({ brief: "Pull this week's launch emails and sum up what people ask.", replay: "ai" });
    expect(part.example).toContain("pricing (5 emails)");
    expect(part.uses).toEqual([layers[2]!.id]);
    // The second round's part reads the first round's fetch, which it repeated.
    expect(layers[7]!.uses).toEqual([layers[2]!.id, layers[6]!.id]);

    const { workflow } = draftWorkflow(run, { layers })!;
    expect(workflowSchema.safeParse(workflow).success).toBe(true);
    expect(workflow.steps[3]).toMatchObject({ kind: "ai", label: "Pull this week's launch emails and sum up what people ask", brief: part.brief, uses: [{ $step: "s3" }], from: { name: "Rio" } });
    expect(workflow.steps.map((step) => step.from?.name)).toEqual(["Kiwi", "Kiwi", "Rio", "Rio", "Miso", "Miso", "Rio", "Rio", "Miso", "Miso"]);
  });

  it("keeps a part sent again with the same brief once, with its newest answer", () => {
    const tr = [request(rio, "r1", "Sum up the launch emails."), app("GMAIL_FETCH_EMAILS", { query: "launch" }), request(rio, "r2", "Sum up the launch emails."), app("GMAIL_FETCH_EMAILS", { query: "launch" }), request(rio, "r3", "Sum up the launch emails."), app("GMAIL_FETCH_EMAILS", { query: "launch" })];
    const run = [ask("Brief"), sent(rio, "tr"), replied(rio, "tr", "r1", "First answer, long enough to be written work rather than a done: pricing, Linux, carry-over, and one demo request from a customer."), sent(rio, "tr"), replied(rio, "tr", "r2", "Second."), sent(rio, "tr"), replied(rio, "tr", "r3", "Third and newest answer.")];
    const layers = teamLayers(run, source({ tr }, [rio]));
    expect(lines(layers)).toEqual(["app:fetch emails <Rio>", "ai:Sum up the launch emails <Rio>"]);
    expect(layers[1]!.example).toBe("Third and newest answer.");
  });

  it("leaves out a change done again when nothing changed since", () => {
    const tm = [request(miso, "m1", "Stage the post."), tool("Bash", { command: "git add post.md" }), request(miso, "m2", "Stage it again to be sure."), tool("Bash", { command: "git add post.md" })];
    const run = [ask("Stage"), sent(miso, "tm"), replied(miso, "tm", "m1", "Staged."), sent(miso, "tm"), replied(miso, "tm", "m2", "Staged.")];
    expect(lines(teamLayers(run, source({ tm }, [miso])))).toEqual(["shell:git add post.md <Miso>"]);
  });

  it("follows a teammate's own hand-off one level more, and no further", () => {
    const deeper = { id: "deep-1234567890", name: "Deep" };
    // Each thread's work comes before the reply that ends it.
    const td = [request(deeper, "d1", "Check the currency."), tool("Bash", { command: "cp currency.txt out.txt" })];
    const tl = [request(lemon, "l1", "Fetch the plans."), tool("Bash", { command: "curl -s https://example.com/plans.json -o plans.json" }), coordinate("Deep", "Check the currency."), sent(deeper, "td"), replied(deeper, "td", "d1", "USD.")];
    const tk = [request(kiwi, "k1", "Build the price table."), coordinate("Lemon", "Fetch the plans."), sent(lemon, "tl"), replied(lemon, "tl", "l1", "Plans fetched."), tool("Bash", { command: "make table" })];
    const run = [ask("Make the price table"), coordinate("Kiwi", "Build the price table."), sent(kiwi, "tk"), replied(kiwi, "tk", "k1", "Table built.")];
    const layers = teamLayers(run, source({ tk, tl, td }, [kiwi, lemon, deeper]));
    expect(lines(layers)).toEqual([
      "shell:curl -s https://example.com/plans.json -o plans.json <Lemon>",
      // Two levels down: kept as one step with its brief, not followed.
      "ai:Check the currency <Deep>",
      "shell:make table <Kiwi>",
    ]);
    expect(layers[1]).toMatchObject({ brief: "Check the currency.", example: "USD." });
  });

  it("keeps a deleted teammate's part as one AI step with the brief its sender wrote", () => {
    const run = [ask("Sum up the week"), coordinate("Rio", "Sum up this week's support emails in five bullets."), sent(rio, "tr"), replied(rio, "tr", "r1", "- Billing\n- Linux\n- Refunds"), app("SLACK_SEND_MESSAGE", { channel: "#team", text: "Summary posted" })];
    const layers = teamLayers(run, source({}, []));
    expect(lines(layers)).toEqual(["ai:Sum up this week's support emails in five bullets <Rio>", "app:send message"]);
    expect(layers[0]).toMatchObject({ brief: "Sum up this week's support emails in five bullets.", example: "- Billing\n- Linux\n- Refunds" });
    expect(layers.every((layer) => !/Rio replied|Sent to/.test(layer.words))).toBe(true);
  });

  it("keeps a teammate this person may not see as one AI step, and brings in the ones they may", () => {
    const tk = [request(kiwi, "k1", "Check the price."), tool("Bash", { command: "curl -s https://example.com/price -o price.html" })];
    const tr = [request(rio, "r1", "Read the private inbox."), app("GMAIL_FETCH_EMAILS", { query: "from:ceo" })];
    const run = [ask("Brief"), coordinate("Kiwi", "Check the price."), sent(kiwi, "tk"), coordinate("Rio", "Read the private inbox."), sent(rio, "tr"), replied(kiwi, "tk", "k1", "ok"), replied(rio, "tr", "r1", "Three emails.")];
    const layers = teamLayers(run, source({ tk, tr }, [kiwi, rio], { hidden: [rio.id] }));
    expect(lines(layers)).toEqual(["shell:curl -s https://example.com/price -o price.html <Kiwi>", "ai:Read the private inbox <Rio>"]);
    expect(JSON.stringify(layers)).not.toContain("from:ceo");
  });

  it("removes a secret from a teammate's answer before it's kept as the example", () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd";
    const run = [ask("Set up the key"), coordinate("Kiwi", "Make an API key for the staging app."), sent(kiwi, "tk"), replied(kiwi, "tk", "k1", `Made it: ${key}. Saved it in the vault too.`)];
    const tk = [request(kiwi, "k1", "Make an API key for the staging app."), says(`Here it is ${key}`)];
    const layers = teamLayers(run, source({ tk }, [kiwi]));
    expect(JSON.stringify(layers)).not.toContain(key);
    expect(layers[0]!.example).toMatch(/^Made it: /);
    const { workflow } = draftWorkflow([...run, tool("Bash", { command: "git push" })], { layers: [...layers, ...burgerLayers([ask("x"), tool("Bash", { command: "git push" })])] })!;
    expect(JSON.stringify(workflow)).not.toContain(key);
  });

  it("keeps the steps a teammate finished before it failed, then the rest of its part by judgement", () => {
    const tm = [request(miso, "m1", "Publish the post."), tool("Write", { file_path: "post.md", content: "# Post\n" }), tool("Bash", { command: "git push" }, { ok: false }), tool("Bash", { command: "npm run deploy" }, { ok: undefined })];
    const run = [ask("Publish"), coordinate("Miso", "Publish the post."), sent(miso, "tm"), replied(miso, "tm", "m1", "", false, "Miso failed: push rejected")];
    expect(lines(teamLayers(run, source({ tm }, [miso])).filter((layer) => layer.status === "done"))).toEqual(["file:post.md <Miso>", "ai:Publish the post <Miso>"]);
  });

  it("brings in a teammate's work done in a room, only its own rows", () => {
    const room = [
      { id: "rq", role: "bot", kind: "text", at: at(), roomRequest: { id: "q1", phase: "request" }, text: "@Kiwi Check the price." } satisfies RunMessage,
      { ...tool("Bash", { command: "curl -s https://example.com/price -o price.html" }), from: { botId: kiwi.id, name: "Kiwi" } },
      { ...tool("Bash", { command: "rm -rf build" }), from: { botId: "someone-else", name: "Other" } },
    ];
    const sentInRoom: RunMessage = { id: "s-room", role: "bot", kind: "activity", at: 1, tool: { name: "In Launch an Kiwi gesendet", ok: true }, comm: { groupId: "g1", threadId: "room-thread", withBotId: kiwi.id, withName: "Kiwi" } };
    const back: RunMessage = { id: "b-room", role: "bot", kind: "activity", at: at(), roomRequest: { id: "q1", phase: "result" }, tool: { name: "Kiwi hat geantwortet", ok: true, output: "$20" }, comm: { groupId: "g1", threadId: "room-thread", withBotId: kiwi.id, withName: "Kiwi" } };
    const layers = flattenRun([sentInRoom, back], source({ "room-thread": room }, [kiwi]));
    expect(lines(layers)).toEqual(["shell:curl -s https://example.com/price -o price.html <Kiwi>"]);
  });

  it("keeps a teammate's look-only work as what it read, then its answer by judgement", () => {
    const tr = [request(rio, "r1", "Tell me what the dashboard says today."), tool("mcp__browser__browser_snapshot", {}), app("GOOGLESHEETS_BATCH_GET", { spreadsheet_id: "abc", ranges: ["A1:C9"] })];
    const run = [ask("Dashboard?"), coordinate("Rio", "Tell me what the dashboard says today."), sent(rio, "tr"), replied(rio, "tr", "r1", "Signups 120, churn 2%.")];
    const layers = teamLayers(run, source({ tr }, [rio]));
    expect(lines(layers)).toEqual(["app:batch get <Rio>", "ai:Tell me what the dashboard says today <Rio>"]);
    expect(layers[1]!.uses).toEqual([layers[0]!.id]);
  });
});

describe("saved burgers", () => {
  it("still loads one saved before steps kept a brief, a source or a note", () => {
    const old = {
      version: 1, summary: "Send the invoice", args: { to: { default: "priya@example.com" } },
      steps: [
        { id: "s1", kind: "app", label: "Fetch emails", app: "gmail", tool: "GMAIL_FETCH_EMAILS", args: { query: "invoice" }, where: "app" },
        { id: "s2", kind: "ai", deterministic: false, label: "Write the note", prompt: "Write it.", input: { $step: "s1" }, example: "Hi" },
        { id: "s3", kind: "browser", label: "Open example.com", action: "open", url: "https://example.com" },
      ],
    };
    expect(workflowSchema.safeParse(old).success).toBe(true);
    const rich = { ...old, steps: [old.steps[0], { ...old.steps[1], brief: "Write the note.", uses: [{ $step: "s1" }], from: { name: "Rio" } }, { ...old.steps[2], note: "the price" }] };
    expect(workflowSchema.safeParse(rich).success).toBe(true);
  });
});
