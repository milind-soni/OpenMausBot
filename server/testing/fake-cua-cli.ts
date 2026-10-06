#!/usr/bin/env node
// Real subprocess stand-in for cua. The isolated API fixture owns the command
// replies and holds HTTP responses as gates; no polling, sleeps, or real Spaces.
// Keep this dependency-free so the fixture can copy it out of the checkout.
const endpoint = process.env.FAKE_CUA_API;
if (!endpoint) throw new Error("FAKE_CUA_API must name the isolated command fixture");

const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "cua", args: process.argv.slice(2) }),
});
if (!response.ok) throw new Error(`fake cua command fixture returned ${response.status}`);
const reply = await response.json() as { stdout?: string; stderr?: string; code?: number };
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exitCode = reply.code ?? 0;

export {};
