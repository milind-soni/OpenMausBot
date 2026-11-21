#!/usr/bin/env node
// Fake of the `t3` CLI's thread surface for driver tests. Each call appends {argv, stdin} as a JSON line to FAKE_T3_LOG.
//   FAKE_T3_NO_PROJECT  while this file exists, `thread start` finds no project; `project add` deletes it
//   FAKE_T3_DOWN=1      every server call fails as if T3 Code were closed
//   FAKE_T3_ASK=1       a turn ends waiting for an answer (exit 2)
//   FAKE_T3_HANG=1      a turn never ends
import { appendFileSync, existsSync, rmSync } from "node:fs";

const argv = process.argv.slice(2);
let stdin = "";
if (argv.includes("-")) for await (const chunk of process.stdin) stdin += chunk;
if (process.env.FAKE_T3_LOG) appendFileSync(process.env.FAKE_T3_LOG, JSON.stringify({ argv, stdin }) + "\n");

const fail = (message: string, code = 1) => {
  process.stderr.write(`[10:00:00.000] ERROR (#2): ${message}\n    at somewhere (file:///t3.mjs:1:1)\n`);
  process.exit(code);
};
const reply = (threadId: string) => {
  if (process.env.FAKE_T3_HANG) setInterval(() => {}, 1_000);
  else if (process.env.FAKE_T3_ASK) {
    process.stdout.write(JSON.stringify({ threadId, runId: "run:1", status: "waiting", reply: null, error: null }));
    process.exit(2);
  } else process.stdout.write(JSON.stringify({ threadId, runId: "run:1", status: "completed", reply: `echo: ${stdin}`, error: null }));
};

const [command, sub, target] = argv;
if (command === "--version") process.stdout.write("t3 v0.1.11\n");
else if (process.env.FAKE_T3_DOWN) fail("No running T3 Code server uses /tmp/t3. Start T3 Code, then retry.");
else if (command === "project" && sub === "add") {
  if (process.env.FAKE_T3_NO_PROJECT) rmSync(process.env.FAKE_T3_NO_PROJECT, { force: true });
  process.stdout.write(`Added project p-1 at ${target}.\n`);
} else if (command === "thread" && sub === "start") {
  if (process.env.FAKE_T3_NO_PROJECT && existsSync(process.env.FAKE_T3_NO_PROJECT)) fail(`No T3 Code project matches '${target}'. Pass a project id or a path inside a project.`);
  else reply("mcp:new-thread");
} else if (command === "thread" && sub === "send") {
  if (target === "mcp:gone") fail(`Thread ${target} was not found.`);
  else reply(target!);
} else if (command === "thread" && sub === "show") {
  process.stdout.write(JSON.stringify({ thread: { threadId: target, link: `https://app.t3.codes/threads/x/${target}` }, messages: [] }));
} else if (command === "thread" && sub === "list") process.stdout.write("[]");
else fail(`Unknown command ${argv.join(" ")}`);
