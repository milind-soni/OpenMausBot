import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { draftWorkflow } from "./draft.ts";
import { applyChoices, dependents, draftView } from "./draft-view.ts";
import { workflowSchema, type Workflow } from "./format.ts";
import type { RunMessage } from "./layers.ts";

const run = JSON.parse(readFileSync(new URL("./fixtures/qa-delegation-run.json", import.meta.url), "utf8")) as RunMessage[];

describe("the card's view of a finished run", () => {
  it("says who was asked what, what came back in which round, and that the review is judgement", () => {
    const draft = draftWorkflow(run)!;
    const view = draftView(draft.workflow, draft.layers, run);
    expect(view.inputs).toEqual([{ name: "site", value: "https://mausbot.com", label: "site" }]);
    const [send, review] = view.steps;
    expect(send).toMatchObject({ id: "s1", kind: "delegate", exact: true, rounds: 2, reviewRounds: 1, doneWhen: expect.stringContaining("3 findings") });
    expect(send!.who!.map((one) => one.name)).toEqual(["Kiwi", "Rio", "Miso"]);
    expect(send!.asked![0]!.text).toContain("QA round 1 for https://mausbot.com");
    expect(send!.back!.map((one) => [one.who, one.round])).toEqual([["Kiwi", 1], ["Rio", 1], ["Miso", 1], ["Rio", 2], ["Miso", 2]]);
    expect(review).toMatchObject({ kind: "ai", exact: false, needs: ["s1"] });
    expect(view.outcome).toBe("**Verdict:** nothing serious; every finding names the URL it checked. (Trimmed from a real run.)");
  });
});

const wf = (steps: unknown[], args: Workflow["args"]): Workflow => workflowSchema.parse({ version: 1, summary: "x", args, steps });

describe("the person's choices", () => {
  const workflow = wf([
    { id: "s1", kind: "shell", label: "Fetch", run: 'curl -s "$OMB_ARG_URL" -o feed.json' },
    { id: "s2_write", kind: "ai", deterministic: false, label: "Write top.md", prompt: "Write it for {url}.", input: { $step: "s1" } },
    { id: "s2", kind: "file", label: "Write top.md", path: "top.md", content: { $step: "s2_write" } },
    { id: "s3", kind: "browser", label: "Open the page", action: "open", url: { $arg: "page" } },
  ], { url: { default: "https://a.example/feed.json" }, page: { default: "https://a.example/" } });

  it("leaves a step out with the AI step that writes for it, and drops inputs nothing uses any more", () => {
    const chosen = applyChoices(workflow, { skip: ["s2", "s3"] }) as Workflow;
    expect(chosen.steps.map((step) => step.id)).toEqual(["s1"]);
    expect(Object.keys(chosen.args)).toEqual(["url"]);
  });

  it("refuses to keep a step whose input step was left out", () => {
    expect(applyChoices(workflow, { skip: ["s1"] })).toEqual({ error: '"Write top.md" uses what "Fetch" returns; leave both out or keep both.' });
    expect(dependents([{ id: "s1", needs: [] }, { id: "s2_write", needs: ["s1"] }, { id: "s2", needs: ["s2_write"] }], "s1")).toEqual(["s2_write", "s2"]);
  });

  it("renames an input everywhere, its command variable and prompt name included, and keeps a new saved value", () => {
    const chosen = applyChoices(workflow, { inputs: { url: { name: "feed", value: "https://b.example/feed.json" } } }) as Workflow;
    expect(chosen.args.feed).toEqual({ default: "https://b.example/feed.json" });
    expect(chosen.args.url).toBeUndefined();
    expect(chosen.steps[0]).toMatchObject({ run: 'curl -s "$OMB_ARG_FEED" -o feed.json' });
    expect(chosen.steps[1]).toMatchObject({ prompt: "Write it for {feed}." });
    expect(workflowSchema.safeParse(chosen).success).toBe(true);
    expect(applyChoices(workflow, { inputs: { url: { name: "page" } } })).toEqual({ error: "There is already an input named page." });
    expect(applyChoices(workflow, { inputs: { url: { name: "9x" } } })).toMatchObject({ error: expect.stringContaining("can't be an input's name") });
  });
});

describe("dependencies inside app record IDs", () => {
  const workflow = wf([
    { id: "s1", kind: "app", app: "airtable", tool: "AIRTABLE_LIST_RECORDS", label: "Find records", args: {} },
    { id: "s2", kind: "app", app: "airtable", tool: "AIRTABLE_UPDATE_MULTIPLE_RECORDS", label: "Update records", args: { records: [{ id: { $step: "s1", path: "records.0.id" }, fields: { Reviewed: true } }] } },
    { id: "s3", kind: "file", label: "Write receipt", path: "receipt.txt", content: { $step: "s2" } },
    { id: "s4", kind: "file", label: "Keep notes", path: "notes.txt", content: "Notes" },
  ], {});

  it("connects the card's dependent steps through a reference under id", () => {
    const view = draftView(workflow, [], []);
    expect(view.steps[1]!.needs).toEqual(["s1"]);
    expect(dependents(view.steps, "s1")).toEqual(["s2", "s3"]);
  });

  it("refuses an update without its lookup, and allows leaving the entire dependent chain out", () => {
    expect(applyChoices(workflow, { skip: ["s1"] })).toEqual({ error: '"Update records" uses what "Find records" returns; leave both out or keep both.' });
    expect(applyChoices(workflow, { skip: ["s1", "s2", "s3"] })).toMatchObject({ steps: [{ id: "s4" }] });
  });
});
