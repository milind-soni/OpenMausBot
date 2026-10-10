import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(process.platform === "win32")("Stop through the isolated server", () => {
  it.each([false, true])("keeps the task busy until its stubborn helper stops (root ignores TERM: %s)", async (stubbornRoot) => {
    const fixture = await launchVerificationServer();
    const evidence: unknown[] = [{ fixture: fixture.info, stubbornRoot }];
    const pids: number[] = [];
    const control = async (args: string[]) => {
      const command = [...args, "--url", fixture.info.url];
      const result = await runControlOmb(command) as any;
      evidence.push({ command, result });
      return result;
    };
    try {
      const wrapper = join(fixture.info.dataDir, "stubborn-claude.mjs");
      const pidFile = join(fixture.info.dataDir, "owned-pids.json");
      const gate = join(fixture.info.dataDir, "finish.gate");
      const fake = pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href;
      const helper = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
      writeFileSync(wrapper, [
        "#!/usr/bin/env node",
        "import { spawn } from 'node:child_process';",
        "import { once } from 'node:events';",
        "import { writeFileSync } from 'node:fs';",
        "if (process.argv.includes('--input-format')) {",
        stubbornRoot ? "process.on('SIGTERM', () => {});" : "",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
        "await once(child.stdout, 'data');",
        `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
        "}",
        "process.env.FAKE_CLAUDE_MODE = 'slow';",
        `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(gate)};`,
        `await import(${JSON.stringify(fake)});`,
      ].join("\n"), { mode: 0o700 });
      const configured = await fetch(`${fixture.info.url}/api/instances/claude`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cli: wrapper }),
      });
      evidence.push({ method: "PATCH", path: "/api/instances/claude", body: { cli: wrapper }, status: configured.status });
      expect(configured.status).toBe(200);
      const created = await control(["new-bot", "--name", "Stop fixture"]);
      const botId = created.bot.id;
      const taskId = created.bot.activeTaskId;
      const target = ["--bot", botId, "--task", taskId];
      await control(["send", ...target, "--text", "Keep working until Stop"]);
      await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
      pids.push(...JSON.parse(readFileSync(pidFile, "utf8")) as number[]);
      expect(pids.every(alive)).toBe(true);
      expect((await control(["wait", ...target, "--timeout", "1"])).status).toBe("timed-out");

      const started = Date.now();
      await control(["interrupt", ...target]);
      // The root can already have closed, but the helper still owns work.
      expect((await control(["wait", ...target, "--timeout", "1"])).status).toBe("timed-out");
      expect(alive(pids[1]!)).toBe(true);
      expect((await control(["wait", ...target, "--timeout", "10"])).status).toBe("settled");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(pids.some(alive)).toBe(false);
      evidence.push({ stoppedPids: [...pids], alive: pids.map(alive), elapsedMs: Date.now() - started });
      await control(["messages", ...target, "--limit", "10"]);

      // A new turn works after the verified stop and starts a new CLI.
      writeFileSync(gate, "finish");
      await control(["send", ...target, "--text", "Reply after Stop"]);
      expect((await control(["wait", ...target, "--timeout", "10"])).status).toBe("settled");
      pids.push(...JSON.parse(readFileSync(pidFile, "utf8")) as number[]);
      const messages = await control(["messages", ...target, "--limit", "10"]);
      expect(messages.messages.some((message: any) => message.role === "bot" && message.text?.includes("Reply after Stop"))).toBe(true);
    } finally {
      // These are only the exact PIDs recorded by this fixture's wrapper.
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      const evidencePath = `${fixture.info.logPath}.json`;
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      console.info(JSON.stringify({ ...fixture.info, evidencePath }));
      await fixture.close();
    }
  }, 35_000);
});
