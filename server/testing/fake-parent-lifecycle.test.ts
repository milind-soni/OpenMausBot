import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { waitForExit } from "./cleanup.ts";

it.each(["fake-acp-cli.ts", "fake-claude-cli.ts", "fake-codex-app-server.ts"])(
  "%s exits when its parent dies even if ppid stays unchanged",
  async (file) => {
    const childCode = [
      // Windows retains the spawning PID. Exercise that path on every OS.
      'Object.defineProperty(process, "ppid", { value: process.ppid });',
      "await import(" + JSON.stringify(new URL(file, import.meta.url).href) + ");",
      'setTimeout(() => console.log("FAKE_READY"), 750);',
    ].join("\n");
    const prompt = file === "fake-acp-cli.ts"
      ? { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "fixture", prompt: [] } }
      : { type: "user", message: { role: "user", content: "Hold this fixture turn." } };
    const parent = spawn(process.execPath, ["--input-type=module", "-e", [
      'import { spawn } from "node:child_process";',
      'const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", ' + JSON.stringify(childCode) + '], {',
      '  stdio: ["pipe", "inherit", "inherit"],',
      '  env: { ...process.env, FAKE_ACP_MODE: "hang", FAKE_CLAUDE_MODE: "hang", FAKE_CODEX_MODE: "happy" },',
      '});',
      'console.log("FAKE_PID:" + child.pid);',
      "child.stdin.write(" + JSON.stringify(JSON.stringify(prompt) + "\n") + ");",
    ].join("\n")], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    let ended = false;
    parent.stdout.on("data", chunk => { output += chunk; });
    parent.stderr.on("data", chunk => { errors += chunk; });
    parent.stdout.on("end", () => { ended = true; });
    try {
      await expect.poll(() => output.includes("FAKE_READY"), { timeout: 10_000 }).toBe(true);
      expect(ended, errors).toBe(false);
      const exited = once(parent, "exit");
      parent.kill("SIGKILL");
      await exited;
      // The fake inherits this pipe, so EOF proves it exited too, without
      // treating a briefly unreaped zombie as a still-running process.
      await expect.poll(() => ended, { timeout: 5_000 }).toBe(true);
    } finally {
      const pid = Number(output.match(/FAKE_PID:(\d+)/)?.[1]);
      if (!ended && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      }
      await waitForExit(parent, { signal: "SIGKILL" });
    }
  },
);
