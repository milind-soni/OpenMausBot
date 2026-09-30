import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_CLICK_MIN_PROBABILITY, browserClickRequest, clickByDescription, elementOption, NO_MATCH_OPTION, parseSnapshot, pickElement, rankElements,
} from "./browser-click.ts";
import type { Decider } from "./index.ts";
import { jevRequestBody } from "./jev.ts";
import { BROWSER_CLICK, OPTION_KEY_MAX, OPTION_TEXT_MAX } from "./jobs.ts";
import { RELAY_MAX_BODY_BYTES, RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import type { ChoiceAnswer, DeciderResult } from "./types.ts";

// Real agent-browser 0.37.0 snapshots (see the fixture's _source).
const SNAPSHOTS = JSON.parse(readFileSync(new URL("./fixtures/browser-snapshots.json", import.meta.url), "utf8")) as { signIn: string; wikipedia: string };
const PAGE = { url: "http://127.0.0.1:4173/", title: "Acme Store - Sign in" };

type Choose = Decider["choose"];
const answering = (result: DeciderResult<ChoiceAnswer>) => ({ choose: vi.fn(async () => result) as unknown as Choose & ReturnType<typeof vi.fn> });
const picked = (choice: string, pTop: number, rest: Record<string, number> = {}): DeciderResult<ChoiceAnswer> =>
  ({ ok: true, provider: "jev", latencyMs: 300, answers: { type: "choice", choice, pTop, margin: pTop - Math.max(0, ...Object.values(rest)), probabilities: { [choice]: pTop, ...rest } } });

describe("snapshot parsing", () => {
  it("keeps every interactive element with its ref, role, name, state and value, and drops headings", () => {
    const elements = parseSnapshot(SNAPSHOTS.signIn);
    expect(elements.map((element) => element.ref)).toEqual(["e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12", "e13", "e14", "e3", "e15", "e16", "e4"]);
    expect(elements.find((element) => element.ref === "e11")).toMatchObject({ role: "button", name: "Sign in", states: [], heading: "Welcome back" });
    expect(elements.find((element) => element.ref === "e10")).toMatchObject({ role: "checkbox", name: "Remember me", states: ["checked=false"] });
    expect(elements.find((element) => element.ref === "e3")).toMatchObject({ role: "combobox", name: "Sort by", value: "Newest", heading: "Results" });
    // An option sits inside its combobox: an interactive parent is not context.
    expect(elements.find((element) => element.ref === "e15")).toMatchObject({ role: "option", name: "Newest", states: ["selected"] });
    expect(elements.find((element) => element.ref === "e15")!.context).toBeUndefined();
  });

  it("takes the nearest labelled non-interactive ancestor as context", () => {
    const elements = parseSnapshot([
      "- cell \"Solving Factorio Quality (exyr.org)\" [ref=e17]",
      "  - link \"Solving Factorio Quality\" [ref=e121]",
      "  - link \"exyr.org\" [ref=e122]",
      "- link [ref=e263]",
      "- navigation \"Personal tools\" [ref=e4]",
      "  - link \"Log in\" [ref=e42]",
      "- button \"Say \\\"hi\\\"\" [ref=e9]",
      "not a tree line",
    ].join("\n"));
    expect(elements.map((element) => [element.ref, element.name, element.context])).toEqual([
      ["e121", "Solving Factorio Quality", "Solving Factorio Quality (exyr.org)"],
      ["e122", "exyr.org", "Solving Factorio Quality (exyr.org)"],
      ["e263", "", undefined],
      ["e42", "Log in", "Personal tools"],
      ["e9", "Say \"hi\"", undefined],
    ]);
  });

  it("parses a large real page into hundreds of clickable elements", () => {
    const elements = parseSnapshot(SNAPSHOTS.wikipedia);
    expect(elements.length).toBeGreaterThan(300);
    expect(elements.every((element) => /^e\d+$/.test(element.ref))).toBe(true);
    expect(elements.find((element) => element.name === "Search Wikipedia")).toMatchObject({ role: "searchbox" });
    expect(elements.find((element) => element.name === "Log in")).toMatchObject({ role: "link", context: "Personal tools" });
  });

  it("describes an element in plain words, clipped", () => {
    const [signIn] = parseSnapshot("- heading \"Welcome back\" [level=1, ref=e1]\n- button \"Sign in\" [ref=e11]");
    expect(elementOption(signIn!)).toBe("button \"Sign in\", under the heading \"Welcome back\"");
    const [remember] = parseSnapshot("- checkbox \"Remember me\" [checked=false, ref=e10]");
    expect(elementOption(remember!)).toBe("checkbox \"Remember me\" (checked=false)");
    const [unnamed] = parseSnapshot("- link [ref=e53]");
    expect(elementOption(unnamed!)).toBe("link with no label");
    const [long] = parseSnapshot(`- link "${"word ".repeat(200)}" [ref=e2]`);
    expect(elementOption(long!, 80).length).toBe(80);
  });
});

describe("browser click request", () => {
  it("uses the contract verbatim and passes the relay's check", () => {
    const elements = parseSnapshot(SNAPSHOTS.signIn);
    const request = browserClickRequest("the blue Sign in button", PAGE, elements)!;
    expect(request.question.instructions).toBe(BROWSER_CLICK.instructions);
    expect(Object.keys(request.state).sort()).toEqual(["page", "target"]);
    expect(request.state).toEqual({ target: "the blue Sign in button", page: PAGE });
    // every element, then "none of these" last
    expect(Object.keys(request.question.options)).toEqual([...elements.map((element) => element.ref), NO_MATCH_OPTION]);
    expect(request.question.options.e11).toBe("button \"Sign in\", under the heading \"Welcome back\"");
    expect(relayAccepts("browserClick", request.state, { answer: { type: "choice", ...request.question } })).toBe(true);
  });

  it("caps a large real page at 254 plausible elements plus \"none of these\", within the relay's size caps", () => {
    const elements = parseSnapshot(SNAPSHOTS.wikipedia);
    const request = browserClickRequest("the Log in link at the top", { url: "https://en.wikipedia.org/wiki/Web_browser", title: "Web browser - Wikipedia" }, elements)!;
    const options = request.question.options;
    const keys = Object.keys(options);
    expect(keys.length).toBe(255);
    expect(keys.at(-1)).toBe(NO_MATCH_OPTION);
    expect(keys).toContain(elements.find((element) => element.name === "Log in")!.ref);
    expect(keys.every((key) => key.length <= OPTION_KEY_MAX)).toBe(true);
    expect(Object.values(options).every((text) => text.length <= OPTION_TEXT_MAX)).toBe(true);
    const questions = { answer: { type: "choice" as const, ...request.question } };
    expect(Buffer.byteLength(JSON.stringify(request.state))).toBeLessThanOrEqual(RELAY_MAX_STATE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(jevRequestBody(request.state, questions)))).toBeLessThanOrEqual(RELAY_MAX_BODY_BYTES);
    expect(relayAccepts("browserClick", request.state, questions)).toBe(true);
  });

  it("shortens descriptions, then drops the least plausible, until the body fits", () => {
    const lines = Array.from({ length: 400 }, (_, index) => [
      `- region "${`Section ${index} `.repeat(30)}" [ref=e${10_000 + index}]`,
      `  - link "${`Article ${index} about browsers `.repeat(20)}" [ref=e${index}]`,
    ].join("\n"));
    const request = browserClickRequest("Article 7", { url: "https://example.com", title: "Long" }, parseSnapshot(lines.join("\n")))!;
    const questions = { answer: { type: "choice" as const, ...request.question } };
    expect(Buffer.byteLength(JSON.stringify(jevRequestBody(request.state, questions)))).toBeLessThanOrEqual(RELAY_MAX_BODY_BYTES);
    expect(relayAccepts("browserClick", request.state, questions)).toBe(true);
    expect(Object.keys(request.question.options)).toContain("e7");
  });

  it("clips the target and page, and asks nothing with fewer than two elements", () => {
    const request = browserClickRequest("x".repeat(1_000), { url: `https://a.test/${"p".repeat(2_000)}`, title: "t".repeat(900) }, parseSnapshot(SNAPSHOTS.signIn))!;
    expect(request.state.target.length).toBe(300);
    expect(request.state.page.url.length).toBe(500);
    expect(request.state.page.title.length).toBe(200);
    expect(browserClickRequest("Sign in", PAGE, parseSnapshot("- button \"Sign in\" [ref=e1]"))).toBeNull();
  });

  it("ranks elements sharing the target's words first, ties in page order", () => {
    const ranked = rankElements(parseSnapshot(SNAPSHOTS.signIn), "remember me checkbox");
    expect(ranked[0]!.ref).toBe("e10");
  });
});

describe("picking an element", () => {
  const elements = parseSnapshot(SNAPSHOTS.signIn);

  it("clicks at the threshold and asks with the job's own timeout", async () => {
    const decider = answering(picked("e11", BROWSER_CLICK_MIN_PROBABILITY));
    const pick = await pickElement(decider, "Sign in", PAGE, elements);
    expect(pick).toMatchObject({ kind: "click", element: { ref: "e11" }, probability: 0.6 });
    expect(decider.choose).toHaveBeenCalledWith("browserClick", expect.anything(), expect.anything(), expect.objectContaining({ timeoutMs: BROWSER_CLICK.timeoutMs }));
  });

  it("clicks nothing below the threshold and lists candidates by probability", async () => {
    const pick = await pickElement(answering(picked("e11", 0.45, { e12: 0.4, e8: 0.1 })), "the button", PAGE, elements);
    expect(pick.kind).toBe("unsure");
    if (pick.kind !== "unsure") return;
    expect(pick.reason).toBe("low_confidence");
    expect(pick.candidates.slice(0, 3).map(({ element, probability }) => [element.ref, probability])).toEqual([["e11", 0.45], ["e12", 0.4], ["e8", 0.1]]);
    expect(pick.candidates).toHaveLength(5);
  });

  it("clicks nothing when Jev says none of the elements is meant, however sure it is", async () => {
    const pick = await pickElement(answering(picked(NO_MATCH_OPTION, 0.9, { e11: 0.08, e12: 0.02 })), "the thing", PAGE, elements);
    expect(pick.kind).toBe("unsure");
    if (pick.kind !== "unsure") return;
    expect(pick.reason).toBe("low_confidence");
    expect(pick.candidates.slice(0, 2).map(({ element }) => element.ref)).toEqual(["e11", "e12"]);
    expect(pick.candidates.every(({ element }) => element.ref !== NO_MATCH_OPTION)).toBe(true);
  });

  it("fails open on any decider failure, a choice never offered, or a throw", async () => {
    for (const reason of ["disabled", "timeout", "rate_limited", "misconfigured"] as const) {
      const pick = await pickElement(answering({ ok: false, reason }), "Sign in", PAGE, elements);
      expect(pick).toMatchObject({ kind: "unsure", reason });
      if (pick.kind === "unsure") expect(pick.candidates[0]!.element.ref).toBe("e11");
    }
    expect(await pickElement(answering(picked("e999", 0.99)), "Sign in", PAGE, elements)).toMatchObject({ kind: "unsure", reason: "malformed" });
    const throwing = { choose: vi.fn(async () => { throw new Error("boom"); }) } as unknown as Pick<Decider, "choose">;
    expect(await pickElement(throwing, "Sign in", PAGE, elements)).toMatchObject({ kind: "unsure", reason: "malformed" });
  });
});

describe("the click-by-description tool", () => {
  function engine(overrides: Record<string, unknown> = {}) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const text = (value: string) => ({ content: [{ type: "text", text: value }] });
    const answers: Record<string, unknown> = {
      agent_browser_snapshot: text(SNAPSHOTS.signIn),
      agent_browser_get_url: text(PAGE.url),
      agent_browser_get_title: text(PAGE.title),
      agent_browser_click: text("Done"),
      ...overrides,
    };
    return {
      calls,
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => { calls.push([name, args]); return answers[name]; }),
    };
  }

  it("snapshots, asks, and clicks the chosen ref", async () => {
    const io = engine();
    const decider = answering(picked("e11", 0.92));
    const checkpoint = vi.fn();
    const result = await clickByDescription({ target: "the blue Sign in button" }, { ...io, decider, checkpoint });
    expect(io.calls).toEqual([
      ["agent_browser_snapshot", { compact: true }],
      ["agent_browser_get_url", {}],
      ["agent_browser_get_title", {}],
      ["agent_browser_click", { selector: "@e11" }],
    ]);
    expect(decider.choose.mock.calls[0]![1]).toEqual({ target: "the blue Sign in button", page: PAGE });
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(/^Clicked button "Sign in" \[ref=e11\] \(Jev 92%\)\. Take a snapshot/);
  });

  it("never clicks when unsure: a plain message with refs to click instead", async () => {
    const io = engine();
    const result = await clickByDescription({ target: "the button" }, { ...io, decider: answering(picked("e11", 0.4, { e12: 0.35 })), checkpoint: vi.fn() });
    expect(io.calls.map(([name]) => name)).not.toContain("agent_browser_click");
    const text = (result.content[0] as { text: string }).text;
    expect(result.isError).toBeUndefined();
    expect(text).toContain("nothing was clicked");
    expect(text).toContain("button \"Sign in\", under the heading \"Welcome back\" [ref=e11] (40%)");
    expect(text).toContain("agent_browser_click");
    expect(text).toContain("\"@e11\"");
  });

  it("fails open when the decider is off, listing plausible candidates", async () => {
    const io = engine();
    const result = await clickByDescription({ target: "Remember me" }, { ...io, decider: answering({ ok: false, reason: "job_off" }), checkpoint: vi.fn() });
    expect(io.calls.map(([name]) => name)).not.toContain("agent_browser_click");
    expect((result.content[0] as { text: string }).text).toMatch(/decision model was unavailable[\s\S]*checkbox "Remember me" \(checked=false\).*\[ref=e10\]/);
  });

  it("clicks nothing on an unreadable page, and asks for a target", async () => {
    const decider = answering(picked("e11", 0.99));
    const unreadable = engine({ agent_browser_snapshot: { isError: true, content: [{ type: "text", text: "No page" }] } });
    const result = await clickByDescription({ target: "Sign in" }, { ...unreadable, decider, checkpoint: vi.fn() });
    expect((result.content[0] as { text: string }).text).toContain("Could not read the current page");
    expect(unreadable.calls.map(([name]) => name)).toEqual(["agent_browser_snapshot"]);
    expect(await clickByDescription({ target: "  " }, { ...engine(), decider, checkpoint: vi.fn() })).toMatchObject({ isError: true });
    expect(decider.choose).not.toHaveBeenCalled();
  });

  it("stops before the click when the checkpoint refuses (turn revoked, person took over)", async () => {
    const io = engine();
    const checkpoint = vi.fn(() => { throw new Error("paused"); });
    await expect(clickByDescription({ target: "Sign in" }, { ...io, decider: answering(picked("e11", 0.9)), checkpoint })).rejects.toThrow("paused");
    expect(io.calls.map(([name]) => name)).not.toContain("agent_browser_click");
  });

  it("reports a failed click as an error", async () => {
    const io = engine({ agent_browser_click: { isError: true, content: [{ type: "text", text: "Element not found" }] } });
    const result = await clickByDescription({ target: "Sign in" }, { ...io, decider: answering(picked("e11", 0.9)), checkpoint: vi.fn() });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("click failed: Element not found");
  });
});
