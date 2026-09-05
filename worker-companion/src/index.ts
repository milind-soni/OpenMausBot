#!/usr/bin/env node
// OpenMausBot worker companion v1.
//
// Runs as the already-authenticated, non-administrative interactive worker user
// on macOS or Windows. It has no listener: OpenMausBot reaches it only over the
// operator-owned SSH alias, either through its version flag or one of the
// fixed subcommands below.
//
// The `stdio` wire can name an operation, an id and a digest. It can never name
// an executable, argv, environment variable, working directory, policy, or
// capability YAML. `stage` and `fetch` are separate subcommands only because
// their payload is a raw byte stream rather than a JSON line; they still take
// no path from the caller, deriving the task root from an id-validated task id.
import { StringDecoder } from "node:string_decoder";

import { pauseWorker, resumeParkedWorker } from "./driver.ts";
import { activateTask, fetchResults, resetTask, runTaskCommand, stageTask, validateTask } from "./task.ts";
import {
  asDigest,
  type CompanionRequest,
  type CompanionResponse,
  PROTOCOL_VERSION,
  parseRequest,
  type StageResponse,
} from "./wire.ts";

export const MAX_REQUEST_BYTES = 1024 * 1024;

async function handle(request: CompanionRequest): Promise<CompanionResponse> {
  switch (request.op) {
    case "pause": {
      await pauseWorker();
      return { ok: true, version: PROTOCOL_VERSION, op: "pause", paused: true };
    }
    case "resume": {
      const capabilitySha256 = await resumeParkedWorker(request.expectedBasePolicySha256);
      return { ok: true, version: PROTOCOL_VERSION, op: "resume", paused: false, capabilitySha256 };
    }
    case "reset": {
      const capabilitySha256 = await resetTask(request.taskId, request.expectedBasePolicySha256);
      return { ok: true, version: PROTOCOL_VERSION, op: "reset", capabilitySha256 };
    }
    case "validate": {
      const { manifest, root } = validateTask(request.taskId, request.manifestSha256);
      return {
        ok: true,
        version: PROTOCOL_VERSION,
        op: "validate",
        taskRoot: root,
        files: manifest.files.length,
        commandIds: manifest.commands.map((command) => command.id),
      };
    }
    case "activate": {
      const capabilitySha256 = await activateTask(
        request.taskId,
        request.manifestSha256,
        request.issuedAt,
        request.expectedCapabilitySha256,
      );
      return { ok: true, version: PROTOCOL_VERSION, op: "activate", capabilitySha256 };
    }
    case "run": {
      const result = await runTaskCommand(request.taskId, request.manifestSha256, request.commandId);
      return { ok: true, version: PROTOCOL_VERSION, op: "run", ...result };
    }
  }
}

const reply = (response: CompanionResponse | StageResponse): void => {
  process.stdout.write(`${JSON.stringify(response)}\n`);
};

const [, , subcommand, firstArgument = "", secondArgument = ""] = process.argv;

if (process.argv.includes("--version")) {
  // The probe parses the trailing integer as the protocol version.
  process.stdout.write(`openmausbot-worker-companion ${PROTOCOL_VERSION}\n`);
} else if (subcommand === "stdio") {
  // Count raw bytes before decoding. readline buffers an unterminated line
  // internally, which let an SSH caller exceed the limit before our old
  // line callback had a chance to inspect it.
  let answered = false;
  let received = 0;
  let pending = "";
  const decoder = new StringDecoder("utf8");
  const answer = (line: string) => {
    answered = true;
    void (async () => {
      try {
        reply(await handle(parseRequest(line)));
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
  process.stdin.on("data", (raw: Buffer | string) => {
    if (answered) return;
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    received += chunk.length;
    if (received > MAX_REQUEST_BYTES) {
      answered = true;
      process.stdin.destroy();
      reply({ ok: false, error: "request too large" });
      process.exitCode = 1;
      return;
    }
    pending += decoder.write(chunk);
    const newline = pending.indexOf("\n");
    if (newline !== -1) answer(pending.slice(0, newline));
  });
  process.stdin.on("end", () => {
    if (answered) return;
    pending += decoder.end();
    if (pending) answer(pending);
  });
} else if (subcommand === "stage") {
  // The staged bytes arrive on stdin; the reply is one JSON line on stdout, so
  // the caller reads the same shape it gets from `stdio`.
  void (async () => {
    try {
      const result = await stageTask(firstArgument, process.stdin);
      reply({ ok: true, version: PROTOCOL_VERSION, op: "stage", files: result.files });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
  })();
} else if (subcommand === "fetch") {
  // stdout carries frames, not JSON, so a failure can only be reported on
  // stderr and by the exit status.
  try {
    fetchResults(firstArgument, asDigest(secondArgument), process.stdout);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(
    "usage: openmausbot-worker-companion --version | stdio" +
      " | stage <taskId> | fetch <taskId> <manifestSha256>\n",
  );
  process.exitCode = 2;
}
