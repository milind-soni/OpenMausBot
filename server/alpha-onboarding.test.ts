import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serverEntry = fileURLToPath(new URL("./index.ts", import.meta.url));
const children: ChildProcess[] = [];
const homes: string[] = [];
let nextPort = 35000 + Math.floor(Math.random() * 8000);

async function server(legacy = false) {
  const home = mkdtempSync(join(tmpdir(), "gbs-onboard-"));
  homes.push(home);
  const data = join(home, "state");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    profile: legacy ? { name: "Existing User" } : undefined,
    instances: { ghost: { driver: "unavailable-for-test" } },
  }));
  const port = nextPort++;
  const child = spawn(process.execPath, [serverEntry], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, GBS_DATA_DIR: data, GBS_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Test server never started")), 10_000);
    const onExit = (code: number) => { clearTimeout(timeout); reject(new Error(`Test server exited with ${code}`)); };
    child.once("exit", onExit);
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        child.off("exit", onExit);
        resolve();
      }
    });
    child.stderr!.resume();
  });
  return {
    data,
    async request(path: string, method = "GET", body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as any };
    },
  };
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
  }));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const alphaRoute = "/api/onboarding/team";
const proposed = {
  purposes: ["Design", "Custom"],
  customGoal: "TEST · Design an accessibility checklist",
  team: [{ name: "Mira", title: "Designer", description: "Review keyboard flows.", modelSelection: null }],
};

describe("alpha workspace approval", () => {
  it("validates proposals, creates one fleet on concurrent retries, and preserves other Buddies", async () => {
    const { data, request } = await server();
    const id = (await request("/api/config")).body.alphaOnboarding.id;
    const initial = (await request("/api/bots")).body.bots;
    expect((await request(alphaRoute, "POST", { ...proposed, id })).status).toBe(400);
    expect((await request("/api/config", "PUT", { profile: { name: "TEST · Alpha" } })).status).toBe(200);
    const extra = (await request("/api/bots", "POST")).body.bot;
    const invalid = { ...proposed, id, team: [proposed.team[0], proposed.team[0]] };
    expect((await request(alphaRoute, "POST", invalid)).status).toBe(400);
    expect((await request(alphaRoute, "POST", { ...proposed, id, team: [{ ...proposed.team[0], modelSelection: { instanceId: "ghost", model: "unknown" } }] })).status).toBe(409);
    expect((await request("/api/bots")).body.bots).toHaveLength(initial.length + 1);
    const replies = await Promise.all([request(alphaRoute, "POST", { ...proposed, id }), request(alphaRoute, "POST", { ...proposed, id })]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const roster = (await request("/api/bots")).body.bots;
    expect(roster.filter((bot: { name: string }) => bot.name === "Mira")).toHaveLength(1);
    expect(roster.find((bot: { id: string }) => bot.id === extra.id).hidden).toBeFalsy();
    expect(roster.find((bot: { id: string }) => bot.id === `${id}-0`).modelSelection.label).toBe("Unassigned");
    expect((await request("/api/config")).body.alphaOnboarding.completed).toBe(true);
    const persisted = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    expect(persisted.alphaOnboarding).toMatchObject({ id, completed: true, purposes: proposed.purposes, customGoal: proposed.customGoal });
  });

  it("leaves an existing workspace outside first-run approval", async () => {
    const { request } = await server(true);
    const before = (await request("/api/bots")).body.bots;
    expect((await request("/api/config")).body.alphaOnboarding).toBeNull();
    expect((await request(alphaRoute, "POST", { ...proposed, id: "alpha" })).status).toBe(409);
    expect((await request("/api/bots")).body.bots).toEqual(before);
  });
});
