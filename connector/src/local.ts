// Jobs from root on this server: `mausbot-connector job <type> [args]`, run with `docker exec` in the connector's
// container, sends one job over a Unix socket in the container's own /tmp, which nothing outside the container can
// open. It goes through the same checks, queue and audit log as a job from MausBot, and is recorded as `local`.
import { randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";

import type { Desk } from "./jobs.ts";
import { errorText, type Log } from "./log.ts";
import { checkCustomerRunJob } from "./customer-run.ts";
import { checkJob, type JobReply, type ServerMode } from "./protocol.ts";

const MAX_REQUEST_BYTES = 64 * 1024;

export function localJobId(): string {
  return `local-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

/** Answers one JSON line `{type, args}` per connection with the job's reply, as one JSON line. */
export function serveLocalJobs(socketPath: string, desk: Desk, log: Log, mode: ServerMode = "operated"): Promise<Server> {
  rmSync(socketPath, { force: true });
  const server = createServer((socket) => {
    let text = "";
    const answer = (reply: JobReply | { ok: false; error: { code: string; message: string } }) => socket.end(`${JSON.stringify(reply)}\n`);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > MAX_REQUEST_BYTES) {
        answer({ ok: false, error: { code: "invalid_job", message: "the job is too large" } });
        socket.destroy();
        return;
      }
      const end = text.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      let request: unknown;
      try { request = JSON.parse(text.slice(0, end)); } catch { request = null; }
      const fields = typeof request === "object" && request !== null && !Array.isArray(request) ? request as Record<string, unknown> : {};
      const message = { id: localJobId(), type: fields.type, args: fields.args };
      const checked = mode === "customer-run" ? checkCustomerRunJob(message, "local") : checkJob(message);
      if (!checked.ok) {
        answer({ ok: false, error: { code: checked.code, message: checked.message } });
        return;
      }
      log(`job ${checked.job.id}: ${checked.job.type} (from this server)`);
      desk.submit(checked.job, "local").then(
        (reply) => answer(reply ?? { ok: false, error: { code: "self_update_failed", message: "the new connector took over and answered this job" } }),
        (error) => answer({ ok: false, error: { code: "docker", message: errorText(error) } }),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}

/** Sends one job to the running connector and waits for its reply, as long as the job takes. */
export function sendLocalJob(socketPath: string, type: string, args: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ type, args })}\n`));
    socket.on("data", (chunk: string) => { text += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(text) as Record<string, unknown>); } catch { reject(new Error("the connector gave no answer")); }
    });
    socket.on("error", (error) => reject(new Error(`the connector is not running here (${error.message})`)));
  });
}
