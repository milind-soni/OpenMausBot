import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { LocalAgentJobs } from "./local-agent-jobs.ts";

const processes = vi.hoisted(() => ({ spawnCli: vi.fn(), killCliTree: vi.fn() }));
vi.mock("./procs.ts", () => processes);

it("reports unknown after the server loses a tracked process", () => {
  const result = JSON.parse(new LocalAgentJobs().result("local-missing")!);
  expect(result).toMatchObject({ processId: "local-missing", status: "unknown", exitCode: null });
  expect(result.error).toContain("cannot verify");
});

it("bounds even escaped output and reports when a stop could not be confirmed", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const other = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  processes.spawnCli.mockReturnValueOnce(child).mockReturnValueOnce(other);
  processes.killCliTree.mockResolvedValue(false);
  const jobs = new LocalAgentJobs();
  const finished = vi.fn(), stopFailed = vi.fn();
  jobs.start("done", "fixture", [], "/", finished, stopFailed);
  child.stdout.write("\0".repeat(5000));
  child.stderr.write("\0".repeat(5000));
  child.emit("close", 7, null);
  const text = jobs.result("done")!;
  expect(text.length).toBeLessThan(12_000);
  expect(JSON.parse(text)).toMatchObject({ exitCode: 7, stdoutTruncated: true, stderrTruncated: true });
  expect(finished).toHaveBeenCalledOnce();
  jobs.start("stopped", "fixture", [], "/", finished, stopFailed);
  jobs.stop("stopped"); jobs.stop("stopped");
  await Promise.resolve();
  expect(stopFailed).toHaveBeenCalledOnce();
});
