import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { buildZip } from "./testing/zip-fixture.ts";

it("imports an XMind attachment over HTTP when disk reads return partial metadata", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, logPath, url } = fixture.info;
  let server = fixture.child;
  try {
    await waitForExit(server, { signal: "SIGTERM" });
    const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
    const args = verificationServerArgs(env);
    const log = openSync(logPath, "a", 0o600);
    try {
      server = spawn(process.execPath, [
        ...args.slice(0, -1), "--import", new URL("./testing/short-zip-reads.mjs", import.meta.url).href, args.at(-1)!,
      ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log] });
    } finally {
      closeSync(log);
    }
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);

    const bytes = buildZip([{ name: "content.json", data: JSON.stringify([
      { title: "Plan", rootTopic: { title: "Ship", children: { attached: [{ title: "Verify" }] } } },
    ]) }]);
    const upload = async (body: Buffer) => fetch(`${url}/api/files?name=Plan.xmind`, {
      method: "POST", headers: { "content-type": "application/vnd.xmind.workbook" }, body,
    });
    const response = await upload(bytes);
    const saved = await response.json() as { path: string; name: string; mime: string; error?: string };
    expect(response.status, JSON.stringify(saved)).toBe(201);
    expect(saved).toMatchObject({ name: "Plan.xmind.md", mime: "text/markdown" });
    expect(readFileSync(saved.path, "utf8")).toBe("# Plan\n\n- Ship\n  - Verify\n");
    const shortReads = readFileSync(join(dataDir, "zip-short-reads.jsonl"), "utf8").trim().split("\n");
    expect(shortReads.length).toBeGreaterThan(4);
    expect(shortReads.map((line) => JSON.parse(line))).toEqual(
      expect.arrayContaining([expect.objectContaining({ returned: 7 })]),
    );
    const broken = await upload(bytes.subarray(0, bytes.length - 8));
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: "not a readable XMind file" });
    expect(readdirSync(join(dataDir, "tmp")).filter((name) => name.startsWith("omb-xmind-"))).toEqual([]);
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 60_000);
