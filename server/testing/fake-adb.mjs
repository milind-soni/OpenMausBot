#!/usr/bin/env node
// A scripted adb with a phone that runs scrcpy-server. Its state lives beside the script, so a test runs its own
// copy in a throwaway folder:
//   calls.ndjson   every invocation's arguments, one JSON array per line
//   mode           "" | "gone" | "no-port" | "vanishes" | "exits" | "silent" | "hangs-up" | "no-control" |
//                  "drops-control" | "resets-control" | "outlives-adb" |
//                  "stderr:<what the server writes to its stderr>", read on every invocation
//   video.bin      what the scrcpy server sends on its video socket: the first byte at once, the rest in further
//                  writes when `forward --remove` runs, which returns once all of it is written, so that an opened
//                  session always has several chunks waiting
//   control.hex    every byte the scrcpy server has received on its control socket, in hex
//   control.closed written once the scrcpy server has seen its control connection close
//   devices        what `devices -l` lists under its heading, one line per device
//   port           the local port the last `forward tcp:0` chose
//   remove-<port>  where `forward --remove tcp:<port>` reaches the server running behind that port. A test that
//                  connects there afterwards sends more video: what it writes goes out on the video socket
//   server.pid     the running `shell … app_process …`, once it listens
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

if (args[0] === "devices") {
  const listed = mode !== "gone" && existsSync(state("devices")) ? readFileSync(state("devices"), "utf8") : "";
  process.stdout.write(`List of devices attached\n${listed}\n`);
} else if (mode === "gone" && !startsServer) {
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
  const server = state(`remove-${rest[1].slice("tcp:".length)}`);
  if (existsSync(server)) {
    connect({ host: "127.0.0.1", port: Number(readFileSync(server, "utf8")) })
      .on("error", () => {})
      .resume();
  }
}

if (startsServer) {
  if (mode === "exits") process.exit(1);
  if (mode.startsWith("stderr:")) process.stderr.write(`${mode.slice("stderr:".length)}\n`);
  // The phone's scrcpy outlives the adb child that started it and reads its control socket meanwhile: those bytes
  // reach it through the adb server.
  if (mode === "outlives-adb") process.on("SIGTERM", () => {});
  const port = Number(readFileSync(state("port"), "utf8"));
  const video = readFileSync(state("video.bin"));
  const pieceLength = Math.ceil(video.length / 4);
  const writeInTurns = (socket, bytes, written) => {
    if (bytes.length === 0) written();
    else socket.write(bytes.subarray(0, pieceLength), () => setImmediate(writeInTurns, socket, bytes.subarray(pieceLength), written));
  };
  let connections = 0;
  let viewer;
  let control;
  const phone = createServer((socket) => {
    connections += 1;
    socket.on("error", () => {});
    if (mode === "silent") return;
    // Like adb before the phone listens: the first connection is accepted, then closed without a byte.
    if (connections === 1) socket.destroy();
    else if (connections === 2) {
      if (mode === "no-control") phone.close();
      // scrcpy 5.0.1 sends one byte on its video connection, then takes its control connection before it sends more.
      (viewer = socket).write(video.subarray(0, 1));
    } else {
      phone.close();
      control = socket;
      if (mode === "drops-control") socket.end("unread");
      // scrcpy 5.0.1 stops when its control connection closes.
      else {
        socket.on("data", (bytes) => appendFileSync(state("control.hex"), bytes.toString("hex"))).on("close", () => {
          writeFileSync(state("control.closed"), "");
          process.exit();
        });
      }
    }
  }).listen(port, "127.0.0.1", () => {
    writeFileSync(state("server.pid"), String(process.pid));
  });
  let removed = false;
  const forwardRemoved = createServer((socket) => {
    socket.on("error", () => {});
    if (removed) return void socket.pipe(viewer, { end: false });
    removed = true;
    // Like adb, which takes no connection to a forward it has removed.
    phone.close();
    writeInTurns(viewer, video.subarray(1), () => {
      if (mode === "hangs-up") viewer.end();
      if (mode === "resets-control") control.resetAndDestroy();
      socket.end();
    });
  }).listen(0, "127.0.0.1", () => {
    writeFileSync(state(`remove-${port}`), String(forwardRemoved.address().port));
  });
}
