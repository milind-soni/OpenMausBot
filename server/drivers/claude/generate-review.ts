// One-shot Claude review calls for the driver instance. Split out of
// drivers/claude.ts.
import { killCliTree, spawnCli } from "../../procs.ts";
import type { ClaudeConfig } from "./models.ts";

/** One-shot Claude call with the prompt on stdin, never argv. Approval
 * summaries can contain paths, commands, or secrets, so the generic
 * `claude -p "prompt"` shape is not safe for review. No tools or MCP
 * servers are mounted in this isolated process. */
export function generateClaudeReview(
  config: ClaudeConfig,
  environment: (model?: string | null) => NodeJS.ProcessEnv,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(
      config.cli,
      ["-p", "--model", "claude-haiku-4-5", "--output-format", "text"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: environment("claude-haiku-4-5"),
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    const onAbort = () => {
      killCliTree(child);
      finish(new Error("Claude review aborted"));
    };
    const timer = setTimeout(() => {
      killCliTree(child);
      finish(new Error("Claude review timed out"));
    }, 60_000);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        killCliTree(child);
        finish(new Error("Claude review output exceeded 1 MB"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_192);
    });
    child.on("error", (error) => finish(error));
    // An early CLI exit EPIPEs the stdin.end below; without a handler the
    // stream error would crash the host, so settle the promise instead.
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Claude review exited ${code}`));
    });
    if (signal?.aborted) onAbort();
    else {
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.end(prompt);
    }
  });
}
