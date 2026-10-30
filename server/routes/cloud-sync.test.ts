import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createLentClones } from "../lent-clone.ts";
import { createCloudSyncRoutes } from "./cloud-sync.ts";
import { dispatchRoutes } from "./table.ts";

const PC = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const owner = { kind: "session", session: { id: "s1" }, via: "bearer", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { ...owner, scopes: ["client"] } as unknown as RequestAuth;
let auth: RequestAuth, cloudHome: boolean, home: string, server: Server, base: string, routes: ReturnType<typeof createCloudSyncRoutes>;

beforeEach(async () => {
  auth = owner; cloudHome = true;
  home = mkdtempSync(join(tmpdir(), "omb-sync-routes-"));
  mkdirSync(join(home, ".openmausbot"));
  // Never GitHub from a test: a repository that does not exist.
  const clones = createLentClones({ dataDir: join(home, ".openmausbot"), url: () => `file://${join(home, "no-such-repo.git")}` });
  routes = createCloudSyncRoutes({ dataDir: join(home, ".openmausbot"), cloudHome: () => cloudHome, statfs: () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 }), clones });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (!await dispatchRoutes([routes], { req, res, url, path: url.pathname, method: req.method!, auth, json, readBody })) json(res, 404, { error: "not ours" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  routes.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
});
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined || body instanceof Uint8Array ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = text; try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed, headers: response.headers };
};

it("is not there off a Cloud home, and only the owner's admin session may use it", async () => {
  cloudHome = false;
  expect((await call("GET", "/api/sync")).body).toEqual({ error: "not ours" });
  cloudHome = true; auth = client;
  expect((await call("GET", "/api/sync")).status).toBe(403);
});

it("registers, uploads in parts, lists, serves a range, deletes and restores", async () => {
  const registered = await call("POST", "/api/sync/folders", { computerId: PC, computerName: "Ash-PC", pcPath: "/Users/ash/PA", name: "PA" });
  expect(registered.status).toBe(200);
  const id = registered.body.folder.id as string;
  const begun = await call("POST", `/api/sync/folders/${id}/uploads`, { path: "a.txt", size: 11, sha256: sha("hello world"), baseSha256: null });
  const uploadId = begun.body.uploadId as string;
  expect((await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello "))).body).toEqual({ received: 6 });
  expect((await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello "))).body).toMatchObject({ received: 6 });
  await call("PUT", `/api/sync/uploads/${uploadId}?offset=6`, new TextEncoder().encode("world"));
  expect((await call("POST", `/api/sync/uploads/${uploadId}/commit`)).body).toEqual({ sha256: sha("hello world") });
  expect((await call("GET", `/api/sync/folders/${id}/files`)).body.files).toMatchObject([{ path: "a.txt", size: 11 }]);
  const ranged = await call("GET", `/api/sync/folders/${id}/file?path=a.txt`, undefined, { range: "bytes=6-" });
  expect(ranged.status).toBe(206);
  expect(ranged.body).toBe("world");
  expect(ranged.headers.get("x-omb-sha256")).toBe(sha("hello world"));
  expect((await call("POST", `/api/sync/folders/${id}/ops`, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("hello world") }] })).body).toEqual({ results: [{ ok: true }] });
  const [entry] = (await call("GET", "/api/sync/trash")).body.entries;
  expect((await call("POST", "/api/sync/trash/restore", { entryId: entry.id })).body).toEqual({ folderId: id, path: "a.txt" });
  expect((await call("DELETE", `/api/sync/folders/${id}?keepCloudCopy=1`)).status).toBe(204);
  expect((await call("GET", "/api/sync")).body.folders).toEqual([]);
});

it("answers a stale commit with what is there now", async () => {
  const id = (await call("POST", "/api/sync/folders", { computerId: PC, computerName: "PC", pcPath: "/p", name: "P" })).body.folder.id;
  const upload = async (text: string, baseSha256: string | null) => {
    const { uploadId } = (await call("POST", `/api/sync/folders/${id}/uploads`, { path: "a.txt", size: text.length, sha256: sha(text), baseSha256 })).body;
    await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode(text));
    return call("POST", `/api/sync/uploads/${uploadId}/commit`);
  };
  await upload("v1", null);
  const stale = await upload("v2", null);
  expect(stale.status).toBe(409);
  expect(stale.body.current).toMatchObject({ sha256: sha("v1") });
});

it("survives a file that cannot be read while it is being served", async () => {
  const folder = (await call("POST", "/api/sync/folders", { computerId: PC, computerName: "PC", pcPath: "/p", name: "P" })).body.folder;
  const { uploadId } = (await call("POST", `/api/sync/folders/${folder.id}/uploads`, { path: "a.txt", size: 5, sha256: sha("hello"), baseSha256: null })).body;
  await call("PUT", `/api/sync/uploads/${uploadId}?offset=0`, new TextEncoder().encode("hello"));
  await call("POST", `/api/sync/uploads/${uploadId}/commit`);
  chmodSync(join(folder.cloudPath, "a.txt"), 0o000);
  try {
    await fetch(`${base}/api/sync/folders/${folder.id}/file?path=a.txt`).then((response) => response.text()).catch(() => "");
    expect((await call("GET", "/api/sync")).status).toBe(200);
  } finally { chmodSync(join(folder.cloudPath, "a.txt"), 0o600); }
});

it("answers the desktop's held changes poll \"asleep\" when a Cloud home agrees to sleep, and refuses new ones until it wakes", async () => {
  let sleeping = false, abort = new AbortController();
  routes.close();
  routes = createCloudSyncRoutes({ dataDir: join(home, ".openmausbot"), cloudHome: () => cloudHome, statfs: () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 }),
    power: () => ({ sleeping: () => sleeping, sleepSignal: () => abort.signal }) });
  const cursor = (await call("GET", "/api/sync/changes?cursor=0&waitMs=0")).body.cursor as number;
  const held = call("GET", `/api/sync/changes?cursor=${cursor}&waitMs=60000`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  sleeping = true; abort.abort();
  const answer = await held;
  expect(answer.status).toBe(503);
  expect(answer.body).toEqual({ error: "asleep" });
  expect(answer.headers.get("x-omb-cloud-power")).toBe("asleep");
  expect((await call("GET", `/api/sync/changes?cursor=${cursor}&waitMs=60000`)).status).toBe(503);
  sleeping = false; abort = new AbortController();
  expect((await call("GET", `/api/sync/changes?cursor=${cursor}&waitMs=0`)).status).toBe(200);
});

it("lent folders: says it keeps their copies, registers one out of bots' reach, takes what is lent, and serves and answers waiting changes", async () => {
  expect((await call("GET", "/api/sync")).body.lentCopies).toBe(true);
  const registered = await call("POST", "/api/sync/folders", { computerId: PC, computerName: "Ash-MBP", pcPath: "/Users/ash/Notes", name: "Notes", lent: true, git: { repo: "ash/notes", branch: "main", head: null } });
  const folder = registered.body.folder;
  expect(folder.cloudPath).toBe(join(home, ".openmausbot", "sync", "lent", "Ash-MBP", "Notes"));
  // The repository can't be cloned here: once that is known, the copy is Files'.
  expect(folder.cloning).toBe(true);
  await routes.idle();
  expect((await call("GET", "/api/sync")).body.folders.find((entry: { id: string }) => entry.id === folder.id)).toMatchObject({ staged: 0, lent: true });
  expect((await call("GET", "/api/sync")).body.folders.find((entry: { id: string }) => entry.id === folder.id).cloning).toBeUndefined();
  const lendingId = "8b6f1c1e-3d6a-4a8e-9f1e-0a1b2c3d4e5f", notes = "5d2b6a0e-1f3c-4b7a-8e9d-0c1b2a3f4e5d";
  expect((await call("POST", "/api/sync/lent", { computerId: PC, lendingId, name: "Ash-MBP", platform: "darwin", folders: [{ id: notes, name: "Notes", write: true, syncId: folder.id, git: { repo: "ash/notes", branch: "main", head: null } }] })).status).toBe(200);
  expect((await call("POST", "/api/sync/lent", { computerId: PC, lendingId, name: "Ash-MBP", folders: [{ id: notes, name: "Notes", write: true, syncId: "../x" }] })).status).toBe(400);
  expect((await call("POST", `/api/sync/folders/${folder.id}/synced`)).status).toBe(200);
  expect((await call("POST", "/api/sync/folders/nope/synced")).status).toBe(404);
  expect((await call("GET", `/api/sync/folders/${folder.id}/staged`)).body).toEqual({ staged: [] });
  const away = routes.lent.away("cloud-home", []);
  expect(away.away_computers).toMatchObject([{ folders: [{ folder_id: notes, github: "ash/notes", branch: "main", copy: "from just now" }] }]);
  expect(away.say).toContain("return code changes there as a new branch and a pull request with your GitHub tools");
  await routes.lent.answer({ action: "write_file", computer_id: lendingId, folder_id: notes, path: "idea.md", content: "an idea" }, "cloud-home");
  const [change] = (await call("GET", `/api/sync/folders/${folder.id}/staged`)).body.staged;
  expect(change).toMatchObject({ path: "idea.md", sha256: sha("an idea"), baseSha256: null });
  const served = await call("GET", `/api/sync/folders/${folder.id}/staged/${change.id}`);
  expect(served.body).toBe("an idea");
  expect(served.headers.get("x-omb-sha256")).toBe(sha("an idea"));
  expect(served.headers.get("content-disposition")).toBe("attachment");
  expect((await call("POST", `/api/sync/folders/${folder.id}/staged/${change.id}`, { sha256: sha("an idea") })).status).toBe(200);
  expect((await call("GET", `/api/sync/folders/${folder.id}/staged`)).body).toEqual({ staged: [] });
});

it("touches a clone left mid-way by a restart only on first use, once the server owns its data folder", async () => {
  const dataDir = join(home, "other");
  mkdirSync(join(dataDir, "sync"), { recursive: true });
  const record = JSON.stringify({ "pc-1": { state: "cloning", at: 1, repo: "ash/notes" } });
  writeFileSync(join(dataDir, "sync", "clones.json"), record);
  const lazy = createCloudSyncRoutes({ dataDir, cloudHome: () => true, statfs: () => ({ totalBytes: 10 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 }) });
  try {
    expect(readFileSync(join(dataDir, "sync", "clones.json"), "utf8")).toBe(record);
    const answered: unknown[] = [];
    await lazy({ req: {} as never, res: { setHeader: () => {} } as never, url: new URL("http://127.0.0.1/api/sync/folders"), path: "/api/sync/folders", method: "POST", auth: owner,
      json: ((_res: unknown, _status: number, body: unknown) => { answered.push(body); }) as never,
      readBody: (async () => ({ computerId: PC, computerName: "Ash-MBP", pcPath: "/Users/ash/Notes", name: "Notes", lent: true })) as never });
    expect(answered).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dataDir, "sync", "clones.json"), "utf8"))["pc-1"].state).toBe("failed");
  } finally { lazy.close(); }
});
