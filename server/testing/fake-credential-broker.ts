#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [argvReceipt, ...brokerArgs] = process.argv.slice(2);
if (!argvReceipt) process.exit(64);
appendFileSync(argvReceipt, `${JSON.stringify(brokerArgs)}\n`, { encoding: "utf8", mode: 0o600 });

const bindingAt = brokerArgs.indexOf("--env");
const separatorAt = brokerArgs.indexOf("--");
if (bindingAt < 0 || separatorAt < 0 || separatorAt <= bindingAt + 1) process.exit(64);
const binding = brokerArgs[bindingAt + 1] ?? "";
const equals = binding.indexOf("=");
if (equals < 1) process.exit(64);
const environmentName = binding.slice(0, equals);
const alias = binding.slice(equals + 1);
function credentialValue(name: string): string | undefined {
  if (name === "alias-one") return "credential-one-canary-290174";
  if (name === "alias-two") return "credential-two-canary-290174";
  if (name === "alias-three") return "credential-three-canary-290174";
  return undefined;
}
const value = credentialValue(alias);
if (!value) process.exit(1);
const command = brokerArgs[separatorAt + 1];
const args = brokerArgs.slice(separatorAt + 2);
if (!command) process.exit(64);

const child = spawn(command, args, {
  env: { ...process.env, [environmentName]: value },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let settled = false;
const finish = (code: number): void => {
  if (settled) return;
  settled = true;
  process.stdin.unpipe(child.stdin);
  process.stdin.pause();
  process.exitCode = code;
};
child.once("error", () => finish(1));
child.once("close", (code) => finish(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
