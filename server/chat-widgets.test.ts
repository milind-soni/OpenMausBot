import { describe, expect, it, vi } from "vitest";

import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { WIDGET_SAMPLES } from "../shared/widget-samples.ts";
import { WIDGET_LIMITS, widgetActions, widgetToText, type WidgetNode, type WidgetPayload } from "../shared/widget.ts";
import { createAgentCard, prepareWidgetPress, reopenCancelledPress, type AgentCardStore } from "./chat-widgets.ts";
import type { Message } from "./store.ts";

const THREAD = "thread-scout";
const SCOUT = { id: "bot-scout", name: "Scout", color: "blue" as const };
// Shapes shared/redact.ts recognises: an Anthropic key and a GitHub token.
const API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123";

function fakeStore(rooms: string[] = []) {
  const threads = new Map<string, Message[]>();
  const rows = (threadId: string) => threads.get(threadId) ?? threads.set(threadId, []).get(threadId)!;
  let next = 1;
  const appendMessage = vi.fn((threadId: string, message: Omit<Message, "id" | "at">): Message => {
    const full: Message = { ...message, id: `m${next++}`, at: 1 };
    rows(threadId).push(full);
    return full;
  });
  const patchMessage = vi.fn((threadId: string, messageId: string, patch: Partial<Message>): Message | null => {
    const list = rows(threadId);
    const index = list.findIndex((message) => message.id === messageId);
    if (index === -1) return null;
    list[index] = { ...list[index], ...patch };
    return list[index];
  });
  const store: AgentCardStore = {
    groupByThread: (threadId) => (rooms.includes(threadId) ? { id: "room-1" } : undefined),
    messagesFor: rows,
    appendMessage,
    patchMessage,
  };
  return { store, rows, appendMessage, patchMessage };
}

type Fake = ReturnType<typeof fakeStore>;

function show(fake: Fake, widget: unknown, extra: Record<string, unknown> = {}, threadId = THREAD) {
  return createAgentCard({ store: fake.store, bot: SCOUT, threadId, input: { tool: "show_widget", widget, ...extra } });
}

function shown(fake: Fake, sample: string): Message {
  const result = show(fake, WIDGET_SAMPLES[sample]);
  if (!result.ok) throw new Error(result.error);
  return fake.rows(THREAD).find((message) => message.id === result.messageId)!;
}

const payloadOf = (fake: Fake, id: string): WidgetPayload => fake.rows(THREAD).find((message) => message.id === id)!.widget!;
const all = (node: WidgetNode): WidgetNode[] => [node, ...(node.children ?? []).flatMap(all)];

describe("show_widget", () => {
  it("posts a widget row with its text fallback, the canonical tree, and no from", () => {
    const fake = fakeStore();
    const result = show(fake, WIDGET_SAMPLES.pullRequests);
    expect(result).toEqual({ ok: true, messageId: "m1" });
    expect(fake.appendMessage).toHaveBeenCalledTimes(1);
    const [threadId, message] = fake.appendMessage.mock.calls[0];
    expect(threadId).toBe(THREAD);
    expect(Object.keys(message).sort()).toEqual(["kind", "role", "text", "widget"]);
    expect(message).toMatchObject({ role: "bot", kind: "widget" });
    expect(message).not.toHaveProperty("from");
    expect(message.text).toBe(widgetToText(message.widget!.root));
    expect(message.text!.split("\n")[0]).toBe("**Pull requests** · mausbot-mobile · 3 open");
    expect(message.widget).toEqual({ v: 1, root: expect.objectContaining({ type: "ListView", id: "n1", title: "Pull requests" }) });
    const nodes = all(message.widget!.root);
    expect(nodes.map((node) => node.id)).toEqual(nodes.map((_, index) => `n${index + 1}`));
    expect(message.widget!.root.children![0]).toMatchObject({ type: "ListViewItem", gap: 12 });
    expect(message.widget).not.toHaveProperty("settled");
    expect(message.widget).not.toHaveProperty("rev");
  });

  it("tells the caller which row it wrote, on a show and on an update, and never on a refusal", () => {
    const fake = fakeStore(["thread-room"]);
    const authored = vi.fn();
    const call = (input: unknown, threadId = THREAD) => createAgentCard({ store: fake.store, bot: SCOUT, threadId, input, authored });
    expect(call({ tool: "show_widget", widget: WIDGET_SAMPLES.buildStatus })).toEqual({ ok: true, messageId: "m1" });
    expect(call({ tool: "update_widget", widget_id: "m1", widget: WIDGET_SAMPLES.buildStatus })).toEqual({ ok: true, messageId: "m1" });
    expect(authored.mock.calls).toEqual([["m1"], ["m1"]]);
    expect(call({ tool: "show_widget", widget: { type: "Carousel" } }).ok).toBe(false);
    expect(call({ tool: "update_widget", widget_id: "nope", widget: WIDGET_SAMPLES.buildStatus }).ok).toBe(false);
    expect(call({ tool: "show_widget", widget: WIDGET_SAMPLES.buildStatus }, "thread-room").ok).toBe(false);
    expect(call({ title: "Deploy now?", subtitle: "The build is green.", options: ["Yes", "No"] }).ok).toBe(false);
    expect(authored).toHaveBeenCalledTimes(2);
  });

  it("wraps a loose node, and parses a tree sent as a JSON string", () => {
    const fake = fakeStore();
    expect(show(fake, JSON.stringify({ type: "Text", value: "Deploy finished." })).ok).toBe(true);
    expect(fake.rows(THREAD)[0]).toMatchObject({ text: "Deploy finished.", widget: { root: { type: "Card", children: [{ type: "Text", value: "Deploy finished." }] } } });
  });

  it("is refused in a room, before anything is read or written", () => {
    const fake = fakeStore(["thread-room"]);
    expect(show(fake, WIDGET_SAMPLES.pullRequests, {}, "thread-room")).toEqual({
      ok: false, status: 409, error: "Widgets are not available in rooms yet. Answer in text.",
    });
    expect(createAgentCard({ store: fake.store, bot: SCOUT, threadId: "thread-room", input: { tool: "update_widget", widget_id: "m1", widget: WIDGET_SAMPLES.pullRequests } }))
      .toMatchObject({ ok: false, status: 409 });
    expect(fake.appendMessage).not.toHaveBeenCalled();
    expect(fake.patchMessage).not.toHaveBeenCalled();
  });

  it("answers malformed input with the parser's sentence and posts nothing", () => {
    const fake = fakeStore();
    expect(show(fake, { type: "Card", children: [{ type: "Carousel" }] })).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/^widget\.children\[0\]: unknown type "Carousel"/) });
    expect(show(fake, undefined)).toEqual({ ok: false, status: 400, error: "widget: must be an object with a type." });
    expect(show(fake, { type: "Card", children: [{ type: "Input", name: "pw", inputType: "password" }] })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("request_credential") });
    expect(show(fake, WIDGET_SAMPLES.pullRequests, { fallback_text: 7 })).toEqual({ ok: false, status: 400, error: "fallback_text: must be a string." });
    expect(createAgentCard({ store: fake.store, bot: SCOUT, threadId: THREAD, input: { tool: "paint_widget", widget: WIDGET_SAMPLES.pullRequests } }))
      .toEqual({ ok: false, status: 400, error: "tool: must be show_widget or update_widget." });
    expect(fake.appendMessage).not.toHaveBeenCalled();
  });

  it("redacts a secret from every string: text, labels, options, chart rows and action payloads", () => {
    // The values really are ones the redactor rewrites.
    expect(redactSecretsInText(API_KEY)).not.toContain(API_KEY);
    expect(redactSecretsInText(GITHUB_TOKEN)).not.toContain(GITHUB_TOKEN);
    const fake = fakeStore();
    const result = show(fake, {
      type: "Card",
      title: `Key ${API_KEY}`,
      children: [
        { type: "Text", value: `Use ${API_KEY} for the deploy` },
        { type: "Markdown", value: `Authorization: Bearer ${GITHUB_TOKEN}` },
        { type: "Select", name: "which", options: [{ label: `Old ${API_KEY}`, value: "old" }, { label: "New", value: GITHUB_TOKEN }] },
        { type: "Chart", data: [{ day: GITHUB_TOKEN, [API_KEY]: 3 }], series: [{ type: "bar", dataKey: API_KEY }], xAxis: { dataKey: "day" } },
        { type: "Button", label: "Rotate", onClickAction: { type: "key.rotate", payload: { token: GITHUB_TOKEN, nested: [{ [API_KEY]: `Bearer ${GITHUB_TOKEN}` }] } } },
      ],
      confirm: { label: "Deploy", action: { type: "deploy", payload: { key: API_KEY } } },
    });
    expect(result.ok).toBe(true);
    const row = fake.rows(THREAD)[0];
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(API_KEY);
    expect(stored).not.toContain(GITHUB_TOKEN);
    const root = row.widget!.root;
    const [text, , select, chart, button] = root.children!;
    expect(root.title).toBe(`Key ${redactSecretsInText(API_KEY)}`);
    expect(text.value).toBe(`Use ${redactSecretsInText(API_KEY)} for the deploy`);
    expect(select.options).toEqual([{ label: `Old ${redactSecretsInText(API_KEY)}`, value: "old" }, { label: "New", value: redactSecretsInText(GITHUB_TOKEN) }]);
    const dataKey = (chart.series as Array<{ dataKey: string }>)[0].dataKey;
    expect(dataKey).toBe(redactSecretsInText(API_KEY));
    expect((chart.data as Array<Record<string, unknown>>)[0]).toEqual({ day: redactSecretsInText(GITHUB_TOKEN), [dataKey]: 3 });
    expect(button.onClickAction).toEqual({
      type: "key.rotate",
      payload: { token: redactSecretsInText(GITHUB_TOKEN), nested: [{ [redactSecretsInText(API_KEY)]: `Bearer ${redactSecretsInText(GITHUB_TOKEN)}` }] },
    });
    expect(root.confirm).toEqual({ label: "Deploy", action: { type: "deploy", payload: { key: redactSecretsInText(API_KEY) } } });
    expect(row.text).toContain("«redacted");
    expect(all(root).map((node) => [node.type, node.id])).toEqual([["Card", "n1"], ["Text", "n2"], ["Markdown", "n3"], ["Select", "n4"], ["Chart", "n5"], ["Button", "n6"]]);
    expect(widgetActions(root).map((entry) => entry.ref)).toEqual(["n6", "confirm"]);
  });

  it("masks a value by the name of its key under a payload and in chart rows, whatever the value looks like", () => {
    // Nothing in this value's shape gives it away: only the key it sits under does.
    const plain = "plainvalue1234567890";
    expect(redactSecretsInText(plain)).toBe(plain);
    const masked = "«redacted 20 chars»";
    const fake = fakeStore();
    const result = show(fake, {
      type: "Card",
      children: [
        { type: "Chart", data: [{ day: "Mon", db_password: plain, runs: 3 }, { day: "Tue", db_password: "hunter2", runs: 5 }], series: [{ type: "bar", dataKey: "runs" }], xAxis: { dataKey: "day" } },
        { type: "Button", label: "Rotate", onClickAction: { type: "key.rotate", payload: {
          api_key: plain, user: plain,
          deep: { list: [{ client_secret: plain, note: plain }], env: [{ name: "AUTH_TOKEN", value: plain }, { name: "REGION", value: plain }] },
        } } },
        { type: "Text", value: `the key is ${plain}` },
        { type: "Input", name: "api_key", defaultValue: plain },
      ],
      confirm: { label: "Go", action: { type: "go", payload: { password: plain, count: 2, token: null } } },
    });
    expect(result).toMatchObject({ ok: true, masked: true });
    expect(show(fakeStore(), { type: "Card", children: [{ type: "Text", value: "nothing secret here" }] })).not.toHaveProperty("masked");
    const root = fake.rows(THREAD)[0].widget!.root;
    const [chart, button, text, input] = root.children!;
    expect(chart.data).toEqual([{ day: "Mon", db_password: masked, runs: 3 }, { day: "Tue", db_password: "«redacted 7 chars»", runs: 5 }]);
    expect(button.onClickAction).toEqual({ type: "key.rotate", payload: {
      api_key: masked, user: plain,
      deep: { list: [{ client_secret: masked, note: plain }], env: [{ name: "AUTH_TOKEN", value: masked }, { name: "REGION", value: plain }] },
    } });
    expect(root.confirm).toEqual({ label: "Go", action: { type: "go", payload: { password: masked, count: 2, token: null } } });
    expect(text.value).toBe(`the key is ${plain}`);
    expect(input).toMatchObject({ name: "api_key", defaultValue: plain });
    const press = prepareWidgetPress(fake.store, THREAD, { messageId: "m1", ref: button.id }, undefined);
    expect(press).toMatchObject({ ok: true, label: "Rotate", action: { type: "key.rotate", payload: { api_key: masked, user: plain } } });
  });

  it("refuses a widget whose actions read the same once their secrets are gone", () => {
    const fake = fakeStore();
    const other = `${API_KEY.slice(0, -1)}y`;
    expect(show(fake, { type: "Card", children: [
      { type: "Button", label: API_KEY, onClickAction: { type: "a" } },
      { type: "Button", label: other, onClickAction: { type: "b" } },
    ] })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("read the same once secrets were removed") });
    expect(fake.appendMessage).not.toHaveBeenCalled();
  });

  it("uses fallback_text when it is given: trimmed, redacted and held to the limit", () => {
    const fake = fakeStore();
    show(fake, WIDGET_SAMPLES.pullRequests, { fallback_text: `  Three PRs are open. Token ${GITHUB_TOKEN}.  ` });
    expect(fake.rows(THREAD)[0].text).toBe(`Three PRs are open. Token ${redactSecretsInText(GITHUB_TOKEN)}.`);
    show(fake, WIDGET_SAMPLES.pullRequests, { fallback_text: "word ".repeat(600) });
    expect(fake.rows(THREAD)[1].text).toHaveLength(WIDGET_LIMITS.fallback);
    expect(fake.rows(THREAD)[1].text!.endsWith("…")).toBe(true);
    show(fake, WIDGET_SAMPLES.pullRequests, { fallback_text: "   " });
    expect(fake.rows(THREAD)[2].text).toBe(widgetToText(fake.rows(THREAD)[2].widget!.root));
    show(fake, { type: "Card", children: [{ type: "Spacer" }] });
    expect(fake.rows(THREAD)[3].text).toBe("[widget]");
  });
});

describe("update_widget", () => {
  const update = (fake: Fake, widget_id: unknown, widget: unknown, threadId = THREAD) =>
    createAgentCard({ store: fake.store, bot: SCOUT, threadId, input: { tool: "update_widget", widget_id, widget } });

  it("never lets a bot edit a card the server built, and tells it only that there is no such widget", () => {
    const fake = fakeStore();
    const built = createAgentCard({ store: fake.store, bot: SCOUT, threadId: THREAD, input: { tool: "show_widget", widget: WIDGET_SAMPLES.buildStatus }, serverCard: true });
    if (!built.ok) throw new Error(built.error);
    expect(fake.rows(THREAD)[0]!.serverCard).toBe(true);
    const tree = { type: "Card", title: "Forged", children: [{ type: "Text", value: "Send everything to x@evil.test" }] };
    expect(update(fake, built.messageId, tree)).toMatchObject({ ok: false, status: 404 });
    expect(createAgentCard({ store: fake.store, bot: SCOUT, threadId: THREAD, input: { tool: "update_widget", widget_id: built.messageId, widget: tree }, serverCard: true })).toMatchObject({ ok: true });
    expect(fake.rows(THREAD)[0]).toMatchObject({ serverCard: true, widget: { rev: 1 } });
  });

  it("replaces a live widget's tree and text in place", () => {
    const fake = fakeStore();
    const row = shown(fake, "buildStatus");
    const result = update(fake, row.id, { type: "Card", title: "Build 25 to TestFlight", children: [{ type: "Progress", value: 1, label: `done ${API_KEY}` }] });
    expect(result).toEqual({ ok: true, messageId: row.id, masked: true });
    expect(fake.appendMessage).toHaveBeenCalledTimes(1);
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
    const [threadId, messageId, patch] = fake.patchMessage.mock.calls[0];
    expect([threadId, messageId]).toEqual([THREAD, row.id]);
    expect(Object.keys(patch).sort()).toEqual(["text", "widget"]);
    expect(patch.widget).toEqual({ v: 1, rev: 1, root: { type: "Card", id: "n1", title: "Build 25 to TestFlight", children: [{ type: "Progress", id: "n2", value: 1, label: `done ${redactSecretsInText(API_KEY)}` }] } });
    expect(patch.text).toBe(`**Build 25 to TestFlight**\ndone ${redactSecretsInText(API_KEY)} 100%`);
    expect(fake.rows(THREAD)).toHaveLength(1);
    expect(fake.rows(THREAD)[0]).toMatchObject({ id: row.id, kind: "widget", role: "bot", text: patch.text });
  });

  it("counts each replacement: a tree shown is revision 0, updated twice is revision 2", () => {
    const fake = fakeStore();
    const row = shown(fake, "buildStatus");
    expect(payloadOf(fake, row.id).rev).toBeUndefined();
    expect(update(fake, row.id, WIDGET_SAMPLES.spendTable).ok).toBe(true);
    expect(payloadOf(fake, row.id).rev).toBe(1);
    expect(update(fake, row.id, WIDGET_SAMPLES.pullRequests).ok).toBe(true);
    expect(payloadOf(fake, row.id)).toMatchObject({ v: 1, rev: 2, root: { type: "ListView", title: "Pull requests" } });
    expect(update(fake, row.id, { type: "Carousel" }).ok).toBe(false);
    expect(payloadOf(fake, row.id).rev).toBe(2);
  });

  it("refuses a widget the person already answered", () => {
    const fake = fakeStore();
    const row = shown(fake, "pullRequests");
    const press = prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "confirm" }, undefined);
    if (!press.ok) throw new Error(press.error);
    press.settle();
    fake.patchMessage.mockClear();
    expect(update(fake, row.id, WIDGET_SAMPLES.buildStatus)).toEqual({ ok: false, status: 409, error: "The person already answered that widget. Show a new one." });
    expect(fake.patchMessage).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a widget of this conversation", () => {
    const fake = fakeStore();
    const row = shown(fake, "pullRequests");
    const plain = fake.store.appendMessage(THREAD, { role: "bot", kind: "text", text: "Hello" });
    const peers = fake.store.appendMessage(THREAD, { ...row, from: { botId: "bot-other", name: "Other", color: "red" } });
    fake.patchMessage.mockClear();
    const missing = { ok: false, status: 404, error: "No widget with that id in this conversation." };
    expect(update(fake, "nope", WIDGET_SAMPLES.buildStatus)).toEqual(missing);
    expect(update(fake, undefined, WIDGET_SAMPLES.buildStatus)).toEqual(missing);
    expect(update(fake, plain.id, WIDGET_SAMPLES.buildStatus)).toEqual(missing);
    expect(update(fake, peers.id, WIDGET_SAMPLES.buildStatus)).toEqual(missing);
    expect(update(fake, row.id, WIDGET_SAMPLES.buildStatus, "thread-other")).toEqual(missing);
    expect(fake.patchMessage).not.toHaveBeenCalled();
  });

  it("leaves the widget as it was when the new tree is malformed", () => {
    const fake = fakeStore();
    const row = shown(fake, "pullRequests");
    expect(update(fake, row.id, { type: "Card", children: [{ type: "Text" }] })).toEqual({ ok: false, status: 400, error: "widget.children[0].value: is required." });
    expect(fake.patchMessage).not.toHaveBeenCalled();
  });
});

describe("the legacy options card", () => {
  const input = { title: "Possible match", subtitle: "Choose the next step", options: ["Ignore", "Draft"] };

  it("still reaches createOptionsCard when the body has no tool", () => {
    const fake = fakeStore();
    const watcher = { id: WATCHER_OPTIONS_CARD_BOT_ID, name: "Watcher", color: "blue" as const };
    expect(createAgentCard({ store: fake.store, bot: watcher, threadId: THREAD, input })).toEqual({ ok: true, messageId: "m1" });
    expect(fake.appendMessage).toHaveBeenCalledWith(THREAD, {
      role: "bot", kind: "options", from: { botId: WATCHER_OPTIONS_CARD_BOT_ID, name: "Watcher", color: "blue" }, card: input,
    });
  });

  it("keeps its own refusals, in a room too", () => {
    const fake = fakeStore([THREAD]);
    expect(createAgentCard({ store: fake.store, bot: SCOUT, threadId: THREAD, input }))
      .toEqual({ ok: false, status: 403, error: "create_options_card is not enabled for this bot." });
    expect(createAgentCard({ store: fake.store, bot: SCOUT, threadId: THREAD, input: null }))
      .toEqual({ ok: false, status: 403, error: "create_options_card is not enabled for this bot." });
    expect(fake.appendMessage).not.toHaveBeenCalled();
  });
});

describe("prepareWidgetPress", () => {
  const SEND = "send-0123456789abcdef";

  it("turns confirm into the label and field lines, and settles with the sendId only when asked to", () => {
    const fake = fakeStore();
    const row = shown(fake, "routineForm");
    const press = prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "confirm", values: { days: "mon,tue,wed,thu,fri,sat,sun", report: "discord:releases", stopOnRed: false } }, SEND);
    expect(press).toMatchObject({
      ok: true, messageId: row.id, settles: true,
      text: "Create routine\nRuns on: Every day\nStarts: 2026-10-14\nAt: 09:00\nReport to: Discord · #releases",
      label: "Create routine", action: { type: "routine.create", payload: { name: "release-check" } },
    });
    if (!press.ok) throw new Error(press.error);
    expect(fake.patchMessage).not.toHaveBeenCalled();
    expect(payloadOf(fake, row.id).settled).toBeUndefined();
    const before = Date.now();
    press.settle();
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
    const settled = payloadOf(fake, row.id).settled!;
    expect(settled).toEqual({
      ref: "confirm", label: "Create routine", tone: "confirm", at: expect.any(Number), sendId: SEND,
      values: { days: "mon,tue,wed,thu,fri,sat,sun", starts: "2026-10-14", at: "09:00", report: "discord:releases", stopOnRed: false },
    });
    expect(settled.at).toBeGreaterThanOrEqual(before);
    expect(payloadOf(fake, row.id).root).toEqual(row.widget!.root);
    press.settle();
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
  });

  it("settles on cancel and on a form's submit button, without a sendId when there is none, and keeps values only when some were sent", () => {
    const fake = fakeStore();
    const form = shown(fake, "routineForm");
    const cancel = prepareWidgetPress(fake.store, THREAD, { messageId: form.id, ref: "cancel" }, undefined);
    expect(cancel).toMatchObject({ ok: true, text: "Discard", settles: true });
    if (cancel.ok) cancel.settle();
    expect(payloadOf(fake, form.id).settled).toEqual({ ref: "cancel", label: "Discard", tone: "cancel", at: expect.any(Number) });

    const sink = shown(fake, "kitchenSink");
    const submit = widgetActions(sink.widget!.root).find((entry) => entry.tone === "submit")!;
    const sent = prepareWidgetPress(fake.store, THREAD, { messageId: sink.id, ref: submit.ref, values: { rating: "good", note: "Fast." } }, SEND);
    expect(sent).toMatchObject({ ok: true, text: "Send feedback\nHow did the run go?: Good\nNote: Fast.", settles: true });
    if (sent.ok) sent.settle();
    expect(payloadOf(fake, sink.id).settled).toEqual({
      ref: submit.ref, label: "Send feedback", tone: "submit", at: expect.any(Number), sendId: SEND, values: { rating: "good", email: "", note: "Fast." },
    });

    const list = shown(fake, "pullRequests");
    const merged = prepareWidgetPress(fake.store, THREAD, { messageId: list.id, ref: "confirm", values: {} }, SEND);
    if (merged.ok) merged.settle();
    expect(payloadOf(fake, list.id).settled).toEqual({ ref: "confirm", label: "Merge the two ready", tone: "confirm", at: expect.any(Number), sendId: SEND });
  });

  it("sends a choice answered in the person's own words, and keeps those words on the settled widget", () => {
    const fake = fakeStore();
    const row = shown(fake, "dinnerChoice");
    const press = prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "confirm", values: { dish: "" }, other: { dish: "Leftover dal" } }, SEND);
    expect(press).toMatchObject({ ok: true, text: "Pick this\nDinner tonight: Leftover dal", settles: true });
    if (!press.ok) throw new Error(press.error);
    press.settle();
    expect(payloadOf(fake, row.id).settled).toEqual({
      ref: "confirm", label: "Pick this", tone: "confirm", at: expect.any(Number), sendId: SEND, values: { dish: "" }, other: { dish: "Leftover dal" },
    });
    const closed = show(fake, { type: "Card", confirm: { label: "Go", action: { type: "go" } }, children: [{ type: "RadioGroup", name: "size", options: ["S", "M"], allowOther: false }] });
    if (!closed.ok) throw new Error(closed.error);
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: closed.messageId, ref: "confirm", other: { size: "XL" } }, undefined))
      .toEqual({ ok: false, status: 400, error: "size takes only the offered options." });
  });

  it("leaves the widget live after a plain button or a list item", () => {
    const fake = fakeStore();
    const list = shown(fake, "pullRequests");
    const item = prepareWidgetPress(fake.store, THREAD, { messageId: list.id, ref: "n2" }, SEND);
    expect(item).toMatchObject({ ok: true, text: "iOS: mid-turn steer", settles: false });
    if (item.ok) item.settle();
    const sink = shown(fake, "kitchenSink");
    const later = widgetActions(sink.widget!.root).find((entry) => entry.label === "Ask me later")!;
    const button = prepareWidgetPress(fake.store, THREAD, { messageId: sink.id, ref: later.ref, values: null }, SEND);
    expect(button).toMatchObject({ ok: true, text: "Ask me later", settles: false });
    if (button.ok) button.settle();
    expect(fake.patchMessage).not.toHaveBeenCalled();
    expect(payloadOf(fake, list.id).settled).toBeUndefined();
    expect(payloadOf(fake, sink.id).settled).toBeUndefined();
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: list.id, ref: "confirm" }, undefined)).toMatchObject({ ok: true, text: "Merge the two ready" });
  });

  it("checks the values against the widget", () => {
    const fake = fakeStore();
    const row = shown(fake, "routineForm");
    const press = (values: unknown) => prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "confirm", values }, SEND);
    expect(press({ at: "  " })).toEqual({ ok: false, status: 400, error: "At is required." });
    expect(press({ nope: "x" })).toEqual({ ok: false, status: 400, error: 'There is no field named "nope" here.' });
    expect(press({ report: "slack" })).toEqual({ ok: false, status: 400, error: "Report to must be one of the offered options." });
    expect(press({ at: "noonish" })).toEqual({ ok: false, status: 400, error: "At must be a time like 09:30." });
    expect(press({ days: "funday" })).toEqual({ ok: false, status: 400, error: "Runs on must be days of the week." });
    expect(press({ stopOnRed: "yes" })).toEqual({ ok: false, status: 400, error: "Stop if any check is red must be on or off." });
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "n999" }, SEND)).toEqual({ ok: false, status: 404, error: "That button is no longer on this widget." });
    expect(fake.patchMessage).not.toHaveBeenCalled();
  });

  it("refuses a settled widget", () => {
    const fake = fakeStore();
    const row = shown(fake, "pullRequests");
    const first = prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "confirm" }, SEND);
    if (!first.ok) throw new Error(first.error);
    first.settle();
    const answered = { ok: false, status: 409, error: "This was already answered." };
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "confirm" }, undefined)).toEqual(answered);
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "cancel" }, "send-another-0123456789")).toEqual(answered);
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "n2" }, "send-another-0123456789")).toEqual(answered);
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
  });

  it("resolves the same sendId again after it settled, and that settle() does nothing", () => {
    const fake = fakeStore();
    const row = shown(fake, "routineForm");
    const body = { messageId: row.id, ref: "confirm", values: { days: "mon" } };
    const first = prepareWidgetPress(fake.store, THREAD, body, SEND);
    if (!first.ok) throw new Error(first.error);
    first.settle();
    const settled = payloadOf(fake, row.id).settled;
    const retry = prepareWidgetPress(fake.store, THREAD, body, SEND);
    expect(retry).toMatchObject({ ok: true, messageId: row.id, text: first.text, settles: false });
    if (!retry.ok) throw new Error(retry.error);
    retry.settle();
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
    expect(payloadOf(fake, row.id).settled).toEqual(settled);
  });

  it("refuses a press made on a tree the bot has since replaced, and takes one made on the tree that is there", () => {
    const fake = fakeStore();
    const row = shown(fake, "pullRequests");
    const press = (rev?: unknown, sendId: string | undefined = SEND) =>
      prepareWidgetPress(fake.store, THREAD, { messageId: row.id, ref: "confirm", ...(rev === undefined ? {} : { rev }) }, sendId);
    const stale = { ok: false, status: 409, error: "This widget changed. Check it and press again." };
    expect(press()).toMatchObject({ ok: true, text: "Merge the two ready" });
    expect(press(null)).toMatchObject({ ok: true });
    expect(press(0)).toMatchObject({ ok: true });
    expect(press(1)).toEqual(stale);

    // The bot replaces the list with a form: "confirm" is now another button.
    expect(createAgentCard({ store: fake.store, bot: SCOUT, threadId: THREAD, input: { tool: "update_widget", widget_id: row.id, widget: WIDGET_SAMPLES.emailDraft } }).ok).toBe(true);
    expect(press(0)).toEqual(stale);
    expect(press()).toEqual(stale);
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
    const current = press(1);
    expect(current).toMatchObject({ ok: true, text: "Send email", settles: true });

    if (!current.ok) throw new Error(current.error);
    current.settle();
    expect(payloadOf(fake, row.id)).toMatchObject({ rev: 1, settled: { ref: "confirm", label: "Send email", sendId: SEND } });
    expect(press(1)).toMatchObject({ ok: true, text: "Send email", settles: false });
    expect(press(1, "send-another-0123456789")).toEqual({ ok: false, status: 409, error: "This was already answered." });
    expect(press(0, "send-another-0123456789")).toEqual({ ok: false, status: 409, error: "This was already answered." });

    for (const rev of [-1, 1.5, "1", {}, Number.MAX_SAFE_INTEGER + 1]) {
      expect(press(rev), JSON.stringify(rev)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("remembers the queue slot of a press that had to wait, and reopens the widget when that slot is cancelled", () => {
    const fake = fakeStore();
    const queued = shown(fake, "routineForm");
    const started = shown(fake, "pullRequests");
    const waiting = prepareWidgetPress(fake.store, THREAD, { messageId: queued.id, ref: "confirm", values: { days: "sat,sun" } }, SEND);
    const running = prepareWidgetPress(fake.store, THREAD, { messageId: started.id, ref: "confirm" }, "send-another-0123456789");
    if (!waiting.ok || !running.ok) throw new Error("expected both presses to resolve");
    waiting.settle("queue-1");
    running.settle();
    expect(payloadOf(fake, queued.id).settled).toMatchObject({ ref: "confirm", label: "Create routine", sendId: SEND, queueId: "queue-1" });
    expect(payloadOf(fake, started.id).settled).not.toHaveProperty("queueId");
    fake.patchMessage.mockClear();

    reopenCancelledPress(fake.store, THREAD, "queue-2");
    reopenCancelledPress(fake.store, "thread-other", "queue-1");
    expect(fake.patchMessage).not.toHaveBeenCalled();

    reopenCancelledPress(fake.store, THREAD, "queue-1");
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
    expect(payloadOf(fake, queued.id)).toEqual({ v: 1, root: queued.widget!.root });
    expect(payloadOf(fake, started.id).settled).toMatchObject({ ref: "confirm", label: "Merge the two ready" });
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: queued.id, ref: "cancel" }, "send-third-0123456789ab")).toMatchObject({ ok: true, text: "Discard", settles: true });
    reopenCancelledPress(fake.store, THREAD, "queue-1");
    expect(fake.patchMessage).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a message that is not a widget of this conversation", () => {
    const fake = fakeStore();
    const row = shown(fake, "pullRequests");
    const plain = fake.store.appendMessage(THREAD, { role: "bot", kind: "text", text: "Hello" });
    const missing = { ok: false, status: 404, error: "That widget is not in this conversation." };
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: "m999", ref: "confirm" }, SEND)).toEqual(missing);
    expect(prepareWidgetPress(fake.store, THREAD, { messageId: plain.id, ref: "confirm" }, SEND)).toEqual(missing);
    expect(prepareWidgetPress(fake.store, "thread-other", { messageId: row.id, ref: "confirm" }, SEND)).toEqual(missing);
  });

  it("answers 400 for a malformed widgetAction", () => {
    const fake = fakeStore();
    const row = shown(fake, "routineForm");
    const malformed = [
      null, "confirm", [], {},
      { messageId: row.id },
      { ref: "confirm" },
      { messageId: 7, ref: "confirm" },
      { messageId: "../m1", ref: "confirm" },
      { messageId: row.id, ref: "" },
      { messageId: row.id, ref: "x".repeat(65) },
      { messageId: row.id, ref: 3 },
      { messageId: row.id, ref: "confirm", values: "days=mon" },
      { messageId: row.id, ref: "confirm", values: ["daily"] },
      { messageId: row.id, ref: "confirm", values: { days: 3 } },
      { messageId: row.id, ref: "confirm", values: { days: { nested: "mon" } } },
      { messageId: row.id, ref: "confirm", rev: "0" },
      { messageId: row.id, ref: "confirm", other: "sushi" },
      { messageId: row.id, ref: "confirm", other: { report: true } },
      { messageId: row.id, ref: "confirm", other: { report: ["Slack"] } },
    ];
    for (const widgetAction of malformed) {
      expect(prepareWidgetPress(fake.store, THREAD, widgetAction, SEND), JSON.stringify(widgetAction)).toEqual({
        ok: false, status: 400, error: "widgetAction must be {messageId, ref, values?, other?, rev?}, with values an object of text and on/off fields and other an object of text.",
      });
    }
    expect(fake.patchMessage).not.toHaveBeenCalled();
  });
});
