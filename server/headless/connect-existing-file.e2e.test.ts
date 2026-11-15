import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-omb.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { runHeadless } from "./main.ts";
import type { HeadlessIo } from "./output.ts";

let fixture: VerificationServer;
const dir = mkdtempSync(join(tmpdir(), "omb-connect-existing-"));

beforeAll(async () => { fixture = await launchVerificationServer(); }, 120_000);
afterAll(async () => {
  await fixture?.close();
  await removeTempDir(dir);
});

async function api(path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-openmausbot-cli": "1", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<Record<string, any>>;
}

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
  return { io, out, err };
};

it("keeps a supplied one-use pairing code usable after refusing an existing token file", async () => {
  const file = join(dir, "existing-token");
  writeFileSync(file, "previous token\n");
  const { code } = await api("/api/auth/pairing", { label: "CLI retry fixture" });
  const before = (await api("/api/auth/sessions")).sessions.length;
  const refused = capture();
  expect(await runHeadless(["connect", fixture.info.url, "--code", code, "--out", file], { io: refused.io, env: {} })).toBe(2);
  expect(refused.err[0]).toContain("already exists");
  expect(readFileSync(file, "utf8")).toBe("previous token\n");
  expect.soft((await api("/api/auth/sessions")).sessions).toHaveLength(before);

  const retried = capture();
  const status = await runHeadless(["connect", fixture.info.url, "--code", code, "--out", file, "--force", "--json"], { io: retried.io, env: {} });
  expect(status, retried.err.join("\n")).toBe(0);
  expect((await api("/api/auth/sessions")).sessions).toHaveLength(before + 1);
  const token = readFileSync(file, "utf8").trim();
  expect(token).not.toBe("previous token");
  expect(JSON.stringify([refused.out, refused.err, retried.out, retried.err])).not.toContain(token);
}, 120_000);

it("does not mint a session automatically when the output file already exists", async () => {
  const file = join(dir, "automatic-token");
  writeFileSync(file, "keep this token\n");
  const before = (await api("/api/auth/sessions")).sessions.length;
  const refused = capture();
  expect(await runHeadless(["connect", fixture.info.url, "--out", file], { io: refused.io, env: {} })).toBe(2);
  expect(refused.err[0]).toContain("already exists");
  expect(readFileSync(file, "utf8")).toBe("keep this token\n");
  expect((await api("/api/auth/sessions")).sessions).toHaveLength(before);
}, 120_000);

it.skipIf(process.platform === "win32")("refuses a dangling output link before consuming a pairing code", async () => {
  const file = join(dir, "dangling-token");
  const target = join(dir, "missing-token");
  symlinkSync(target, file);
  const { code } = await api("/api/auth/pairing", { label: "CLI symlink fixture" });
  const before = (await api("/api/auth/sessions")).sessions.length;
  const refused = capture();
  expect.soft(await runHeadless(["connect", fixture.info.url, "--code", code, "--out", file], { io: refused.io, env: {} })).toBe(2);
  expect.soft(refused.err[0]).toContain("already exists");
  expect(lstatSync(file).isSymbolicLink()).toBe(true);
  expect(readlinkSync(file)).toBe(target);
  expect(existsSync(target)).toBe(false);
  expect.soft((await api("/api/auth/sessions")).sessions).toHaveLength(before);

  const retried = capture();
  const status = await runHeadless(["connect", fixture.info.url, "--code", code, "--out", file, "--force", "--json"], { io: retried.io, env: {} });
  expect(status, retried.err.join("\n")).toBe(0);
  expect((await api("/api/auth/sessions")).sessions).toHaveLength(before + 1);
  expect(lstatSync(file).isSymbolicLink()).toBe(true);
  const token = readFileSync(target, "utf8").trim();
  expect(token).not.toBe("");
  expect(JSON.stringify([refused.out, refused.err, retried.out, retried.err])).not.toContain(token);
}, 120_000);
