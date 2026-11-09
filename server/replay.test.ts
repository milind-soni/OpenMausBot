import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublishedPageCard } from "../shared/published-page.ts";
import type { StepRecord } from "./browser-evidence.ts";
import { buildReplay, replayDownload, replayJobs, replayPageFiles, ReplayError, type ReplayDeps } from "./replay.ts";
import { createReplayRoutes, replaySource } from "./routes/replay.ts";
import type { RouteContext } from "./routes/table.ts";
import type { Message } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const msg = (id: string, at: number, extra: Partial<Message>): Message => ({ id, at, role: "bot", kind: "text", ...extra } as Message);

function fixture(options: { record?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-replay-"));
  dirs.push(dir);
  const files = new Map<string, string>();
  const jpg = (name: string) => {
    const path = join(dir, name);
    writeFileSync(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]));
    files.set(name, path);
  };
  const messages: Message[] = [
    msg("u0", 1_000, { role: "user", text: "An earlier request" }),
    msg("b0", 2_000, { text: "Earlier answer" }),
    msg("u1", 10_000, { role: "user", text: `Sign me up for the newsletter\nmy token is ${TOKEN}` }),
    msg("a1", 11_000, { kind: "activity", tool: { name: "agent_browser_open", label: "Opened example.test", ok: true } }),
    msg("a2", 12_500, { kind: "activity", tool: { name: "read_file", label: "Read notes.md", summary: `contains ${TOKEN}`, output: "SECRET FILE BODY", ok: true } }),
    msg("b1", 20_000, { text: "Done: you're signed up." }),
    msg("u2", 30_000, { role: "user", text: "thanks" }),
  ];
  const steps: StepRecord[] = options.record === false ? [] : [
    { v: 1, step: 41, at: 11_000, threadId: "t1", generation: "gen-00001", image: "step-000041.jpg", bytes: 9, action: "Opened example.test", ok: true,
      page: { url: "https://example.test/signup?code=123456#frag", title: "Sign up", navigated: true } },
    { v: 1, step: 42, at: 13_000, threadId: "t1", generation: "gen-00001", image: "step-000042.jpg", bytes: 9, action: "Typed into Email", ok: true,
      page: { url: "https://example.test/signup", title: "Sign up" } },
    { v: 1, step: 43, at: 14_000, threadId: "t1", generation: "gen-00001", image: "step-000042.jpg", sameAsStep: 42, action: "Pressed Enter", ok: false },
    { v: 1, step: 44, at: 31_000, threadId: "t1", generation: "gen-00002", image: "step-000044.jpg", bytes: 9, action: "A later job", ok: true },
  ];
  for (const name of ["step-000041.jpg", "step-000042.jpg", "step-000044.jpg"]) jpg(name);
  const deps: ReplayDeps = {
    bot: (threadId) => (threadId === "t1" ? { id: "bot1", name: "Scout" } : null),
    messages: () => messages,
    steps: () => steps,
    imageFile: (_thread, _gen, file) => files.get(file) ?? null,
  };
  return { deps, messages };
}

describe("a finished job's replay", () => {
  it("lists the answered requests, newest first", () => {
    expect(replayJobs(fixture().messages).map((job) => job.requestId)).toEqual(["u1", "u0"]);
  });

  it("is the request, its browser steps with their pictures and its other tools' lines, and the answer, redacted", () => {
    const built = buildReplay(fixture().deps, "t1");
    expect(built.requestId).toBe("u1");
    expect(built.model.title).toBe("Sign me up for the newsletter");
    expect(built.model.answer).toBe("Done: you're signed up.");
    expect(built.model.steps.map((step) => [step.n, step.kind, step.action, step.ok, Boolean(step.image)])).toEqual([
      [1, "browser", "Opened example.test", true, true],
      [2, "tool", "Read notes.md", true, false],
      [3, "browser", "Typed into Email", true, true],
      // A repeated screenshot shows once, on the step that took it.
      [4, "browser", "Pressed Enter", false, false],
    ]);
    expect(built.model.steps[0]).toMatchObject({ site: "example.test/signup", detail: "Sign up", navigated: true });
    const said = JSON.stringify(built.model);
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain("123456");
    expect(said).not.toContain("SECRET FILE BODY");
    expect(said).not.toContain("Earlier answer");
    expect(said).not.toContain("A later job");
    expect(built.imageUrls.get(1)).toBe("/api/threads/t1/evidence/gen-00001/step-000041.jpg");
  });

  it("publishes as index.html beside its kept pictures, less the ones taken out", () => {
    const built = buildReplay(fixture().deps, "t1");
    expect(replayPageFiles(built, "My replay").map((file) => file.path)).toEqual(["index.html", "img/step-1.jpg", "img/step-3.jpg"]);
    const files = replayPageFiles(built, "My replay", [3]);
    expect(files.map((file) => file.path)).toEqual(["index.html", "img/step-1.jpg"]);
    expect(files[0]!.data.toString()).toContain("<title>My replay</title>");
    expect(files[0]!.data.toString()).not.toContain(TOKEN);
    const single = replayDownload(built, "", [1]);
    expect(single).toContain("data:image/jpeg;base64,");
    expect(single.match(/<img /g)).toHaveLength(1);
  });

  it("without recorded steps, still replays the conversation's own activity lines", () => {
    const built = buildReplay(fixture({ record: false }).deps, "t1");
    expect(built.model.steps.map((step) => step.action)).toEqual(["Opened example.test", "Read notes.md"]);
    expect(built.images.size).toBe(0);
  });

  it("refuses a room, and a request with nothing done", () => {
    const { deps } = fixture();
    expect(() => buildReplay(deps, "room1")).toThrow(ReplayError);
    expect(() => buildReplay(deps, "t1", "u2")).toThrow("no finished job");
  });
});

describe("the replay routes", () => {
  function call(routes: ReturnType<typeof createReplayRoutes>, method: string, path: string, body?: unknown) {
    const out: { status?: number; body?: any; headers?: Record<string, string>; text?: string } = {};
    const res = {
      setHeader: vi.fn(), writeHead: (status: number, headers: Record<string, string>) => { out.status = status; out.headers = headers; },
      end: (text: string) => { out.text = text; },
    };
    const url = new URL(`http://127.0.0.1${path}`);
    return routes({
      req: {} as never, res: res as never, url, path: url.pathname, method, auth: {} as never,
      json: ((_res: unknown, status: number, value: unknown) => { out.status = status; out.body = value; }) as never,
      readBody: (async () => body) as never,
    } as RouteContext).then(() => out);
  }

  it("previews, publishes to one link per job with a card in the chat, and downloads", async () => {
    const { deps } = fixture();
    const card: PublishedPageCard = { state: "live", title: "Signed up", pageId: "a".repeat(20), url: "https://pages.example/a", usage: { pages: 1, limit: 5 } };
    const publishFiles = vi.fn(async (input: { post: (text: string, card: PublishedPageCard) => string | null }) => {
      input.post("", card);
      return { status: 200, text: "ok", card };
    });
    const post = vi.fn(() => "m1");
    const routes = createReplayRoutes({ ...deps, publisher: { publishFiles: publishFiles as never }, post });

    const preview = await call(routes, "GET", "/api/threads/t1/replay");
    expect(preview.status).toBe(200);
    expect(preview.body.jobs.map((job: { requestId: string }) => job.requestId)).toEqual(["u1", "u0"]);
    expect(preview.body.replay.steps[0]).toMatchObject({ n: 1, pictured: true, imageUrl: "/api/threads/t1/evidence/gen-00001/step-000041.jpg" });
    expect(preview.body.replay.leftOutToFit).toBe(0);

    const published = await call(routes, "POST", "/api/threads/t1/replay/publish", { title: "Signed up", leaveOut: [3] });
    expect(published).toMatchObject({ status: 200, body: { ok: true, card } });
    expect(publishFiles).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot1", threadId: "t1", source: replaySource("t1", "u1"), title: "Signed up" }));
    expect((publishFiles.mock.calls[0]![0] as unknown as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(["index.html", "img/step-1.jpg"]);
    expect(post).toHaveBeenCalledWith("t1", expect.stringContaining("Signed up"), card);

    const file = await call(routes, "GET", "/api/threads/t1/replay.html?request=u1&leaveOut=1");
    expect(file.status).toBe(200);
    expect(file.headers?.["content-disposition"]).toBe('attachment; filename="replay-u1.html"');
    expect(file.text).toContain("Typed into Email");

    expect((await call(routes, "GET", "/api/threads/room1/replay")).status).toBe(404);
    expect((await call(routes, "POST", "/api/threads/t1/replay/publish", { extra: true })).status).toBe(400);
    expect((await call(routes, "GET", "/api/threads/t1/replay.html?leaveOut=x")).status).toBe(400);
  });
});
