#!/usr/bin/env node
// A scripted adb with a phone that runs scrcpy-server. Its state lives beside the script, so a test runs its own
// copy in a throwaway folder:
//   calls.ndjson  every invocation's arguments, one JSON array per line
//   mode          "" | "gone" | "no-port" | "vanishes" | "exits" | "silent" | "hangs-up" | "stderr:<what the server
//                 writes to its stderr>", read on every invocation
//   video.bin     what the scrcpy server sends on its video socket: a first piece at once, the rest in further writes
//                 when `forward --remove` runs, which returns once all of it is written, so that an opened session
//                 always has several chunks waiting
//   port          the local port the last `forward tcp:0` chose
//   server.pid    the running `shell … app_process …`, once it listens
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const state = (name) => join(here, name);
const args = process.argv.slice(2);
appendFileSync(state("calls.ndjson"), `${JSON.stringify(args)}\n`);

const mode = existsSync(state("mode")) ? readFileSync(state("mode"), "utf8").trim() : "";
const [, serial, command, ...rest] = args;
const startsServer = command === "shell" && rest.includes("app_process");

if (mode === "gone" && !startsServer) {
  process.stderr.write(`adb: device '${serial}' not found\n`);
  process.exit(1);
}

if (command === "forward" && rest[0] === "tcp:0" && mode !== "no-port") {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => {
      writeFileSync(state("port"), String(port));
      if (mode === "vanishes") unlinkSync(fileURLToPath(import.meta.url));
      process.stdout.write(`${port}\n`);
    });
  });
}

if (command === "forward" && rest[0] === "--remove") {
  connect({ host: "127.0.0.1", port: Number(rest[1].slice("tcp:".length)) })
    .on("error", () => {})
    .resume();
}

if (startsServer) {
  if (mode === "exits") process.exit(1);
  if (mode.startsWith("stderr:")) process.stderr.write(`${mode.slice("stderr:".length)}\n`);
  const video = readFileSync(state("video.bin"));
  const pieceLength = Math.ceil(video.length / 4);
  const writeInTurns = (socket, bytes, written) => {
    if (bytes.length === 0) written();
    else socket.write(bytes.subarray(0, pieceLength), () => setImmediate(writeInTurns, socket, bytes.subarray(pieceLength), written));
  };
  let connections = 0;
  let viewer;
  createServer((socket) => {
    connections += 1;
    socket.on("error", () => {});
    if (mode === "silent") return;
    // Like adb before the phone listens: the first connection is accepted, then closed without a byte.
    if (connections === 1) socket.destroy();
    else if (connections === 2) (viewer = socket).write(video.subarray(0, pieceLength));
    else {
      writeInTurns(viewer, video.subarray(pieceLength), () => {
        if (mode === "hangs-up") viewer.end();
        socket.end();
      });
    }
  }).listen(Number(readFileSync(state("port"), "utf8")), "127.0.0.1", () => {
    writeFileSync(state("server.pid"), String(process.pid));
  });
}
