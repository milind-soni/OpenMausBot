import { StringDecoder } from "node:string_decoder";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export const LOCAL_AGENT_BOX = "local-agent";

export class LocalAgentJobs {
  private readonly jobs = new Map<string, { child: ReturnType<typeof spawnCli>; result?: string; stopFailed: () => void }>();

  start(id: string, executable: string, args: string[], cwd: string, finished: (result: string) => void, stopFailed: () => void): void {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ", "SHELL"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.PATH = augmentedPath();
    const child = spawnCli(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], botWork: true, box: { botThreads: true } }, "bot");
    const job: { child: typeof child; result?: string; stopFailed: () => void } = { child, stopFailed };
    this.jobs.set(id, job);
    child.stdin.end();
    let stdout = "", stderr = "", error: string | undefined, stdoutTruncated = false, stderrTruncated = false;
    const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
    const addOut = (text: string) => { stdout += text; if (stdout.length > 1000) { stdoutTruncated = true; stdout = stdout.slice(-1000); } };
    const addErr = (text: string) => { stderr += text; if (stderr.length > 500) { stderrTruncated = true; stderr = stderr.slice(-500); } };
    child.stdout.on("data", (part: Buffer) => addOut(out.write(part)));
    child.stderr.on("data", (part: Buffer) => addErr(err.write(part)));
    child.on("error", value => { error = value.message.slice(0, 200); });
    child.on("close", (exitCode, signal) => {
      addOut(out.end()); addErr(err.end());
      job.result = JSON.stringify({ processId: id, status: exitCode === null ? "unknown" : "finished", exitCode, ...(signal ? { signal } : {}), ...(error ? { error } : {}), stdout, stderr, stdoutTruncated, stderrTruncated });
      finished(job.result);
    });
  }

  result(id: string): string | undefined {
    const job = this.jobs.get(id);
    return job ? job.result : JSON.stringify({ processId: id, status: "unknown", exitCode: null, error: "The server cannot verify this process after restarting. Check its work before starting another." });
  }

  stop(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    if (job.result === undefined) void killCliTree(job.child).then(stopped => { if (!stopped) job.stopFailed(); }, job.stopFailed);
  }

  stopAll(): void {
    for (const id of this.jobs.keys()) this.stop(id);
  }
}
