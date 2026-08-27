#!/usr/bin/env node
// OpenMausBot worker companion v1.
//
// Runs as the already-authenticated, non-administrative interactive worker user
// on macOS or Windows. It has no listener: OpenMausBot reaches it only over the
// operator-owned SSH alias, either as one of the two out-of-band flags the
// health probe reads, or as the fixed `stdio` command.
//
// The wire can name an operation and a digest. It can never name an executable,
// argv, environment variable, working directory, policy, or capability YAML.
import readline from "node:readline";

import { pauseWorker, resumeParkedWorker } from "./driver.ts";
import { formatPermissions, readPermissions } from "./permissions.ts";
import { type CompanionRequest, type CompanionResponse, PROTOCOL_VERSION, parseRequest } from "./wire.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

async function handle(request: CompanionRequest): Promise<CompanionResponse> {
  if (request.op === "pause") {
    await pauseWorker();
    return { ok: true, version: PROTOCOL_VERSION, paused: true };
  }
  const capabilitySha256 = await resumeParkedWorker(request.expectedBasePolicySha256);
  return { ok: true, version: PROTOCOL_VERSION, paused: false, capabilitySha256 };
}

const reply = (response: CompanionResponse): void => {
  process.stdout.write(`${JSON.stringify(response)}\n`);
};

const [, , subcommand] = process.argv;

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
} else {
  process.stderr.write("usage: openmausbot-worker-companion --version | --permissions | stdio\n");
  process.exitCode = 2;
}
