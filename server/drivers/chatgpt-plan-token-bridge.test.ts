import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startChatGptTokenBridge } from "./chatgpt-plan-token-bridge.ts";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("./chatgpt-plan-token-command.ts", import.meta.url));
const bridges: Awaited<ReturnType<typeof startChatGptTokenBridge>>[] = [];
const start = async (get: () => Promise<string>) => { const bridge = await startChatGptTokenBridge(get); bridges.push(bridge); return bridge; };
const request = (env: Record<string, string>) => exec(process.execPath, [helper], { env: { ...process.env, ...env } });
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.close(); });

describe("ChatGPT run token bridge", () => {
  it("obtains the current token without emitting it on stderr", async () => {
    let token = "synthetic-A";
    const bridge = await start(async () => token);
    expect(await request(bridge.env)).toMatchObject({ stdout: "synthetic-A", stderr: "" });
    token = "synthetic-B";
    expect((await request(bridge.env)).stdout).toBe("synthetic-B");
  });
  it("rejects other capabilities and revokes access after a run ends", async () => {
    const bridge = await start(async () => "synthetic-token");
    await expect(request({ ...bridge.env, OMB_CODEX_AUTH_SECRET: "wrong" })).rejects.toThrow();
    bridge.close();
    await expect(request(bridge.env)).rejects.toThrow();
  });
  it("does not return a token when the bridge is closed while refresh is pending", async () => {
    let resolve!: (token: string) => void;
    let started!: () => void;
    const waiting = new Promise<void>(r => { started = r; });
    const bridge = await start(() => { started(); return new Promise(r => { resolve = r; }); });
    const result = request(bridge.env);
    await waiting;
    bridge.close();
    resolve("synthetic-token");
    await expect(result).rejects.toThrow();
  });
});
