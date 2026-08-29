#!/usr/bin/env node
// OpenMausBot worker companion v1.
//
// Runs as the already-authenticated, non-administrative interactive worker user
// on macOS or Windows. It has no listener: OpenMausBot reaches it only over the
// operator-owned SSH alias, either as one of the two out-of-band flags the
// health probe reads, or as one of the fixed subcommands below.
//
// The `stdio` wire can name an operation, an id and a digest. It can never name
// an executable, argv, environment variable, working directory, policy, or
// capability YAML. `stage` and `fetch` are separate subcommands only because
// their payload is a raw byte stream rather than a JSON line; they still take
// no path from the caller, deriving the task root from an id-validated task id.
import readline from "node:readline";

import { pauseWorker, resumeParkedWorker } from "./driver.ts";
import { formatPermissions, readPermissions } from "./permissions.ts";
import { activateTask, fetchResults, resetTask, runTaskCommand, stageTask, validateTask } from "./task.ts";
import {
  asDigest,
  type CompanionRequest,
  type CompanionResponse,
  PROTOCOL_VERSION,
  parseRequest,
  type StageResponse,
} from "./wire.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

async function handle(request: CompanionRequest): Promise<CompanionResponse> {
  switch (request.op) {
    case "pause": {
      await pauseWorker();
      return { ok: true, version: PROTOCOL_VERSION, paused: true };
    }
    case "resume": {
      const capabilitySha256 = await resumeParkedWorker(request.expectedBasePolicySha256);
      return { ok: true, version: PROTOCOL_VERSION, paused: false, capabilitySha256 };
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
} else if (process.argv.includes("--permissions")) {
  // Never fails the caller: the probe treats absent or unparseable output as
  // "not granted", and that is the correct fail-closed reading of an error here
  // too. Diagnostics go to stderr so stdout stays machine-readable.
  void (async () => {
    try {
      process.stdout.write(`${formatPermissions(await readPermissions())}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.stdout.write(`${formatPermissions({ accessibility: false, screenRecording: false })}\n`);
      process.exitCode = 1;
    }
  })();
} else if (subcommand === "stdio") {
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  let answered = false;
  input.on("line", (line: string) => {
    // One request per invocation: a long-lived session would let a single
    // approved connection be reused for a later, unapproved operation.
    if (answered) return;
    answered = true;
    void (async () => {
      try {
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) throw new Error("request too large");
        reply(await handle(parseRequest(line)));
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
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
    "usage: openmausbot-worker-companion --version | --permissions | stdio" +
      " | stage <taskId> | fetch <taskId> <manifestSha256>\n",
  );
  process.exitCode = 2;
}
