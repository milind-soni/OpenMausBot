#!/usr/bin/env node
/**
 * Offline recovery command for Agent Centipede.
 *
 * This command intentionally has no way to force a restore over a live
 * process. Keep it boring: stop the desktop app, then run restore/rollback.
 * The backup key is read from a file (never accepted as a command argument).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import {
  restoreEncryptedBackup,
  rollbackEncryptedRestore,
} from "../electron/encrypted-backup.mjs";

const DEFAULT_PORTS = [8799, 18799, 28799];
const healthResponseSchema = z.object({
  app: z.literal("openmausbot"),
  dataRootIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

function usage() {
  return [
    "Usage:",
    "  node scripts/offline-restore.mjs restore --backup <file> --data-dir <dir> --key-file <file>",
    "  node scripts/offline-restore.mjs rollback --rollback-dir <dir> --data-dir <dir> --key-file <file>",
    "",
    "The desktop app must be closed. This command never accepts a key on the command line.",
  ].join("\n");
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith("--")) return null;
  return args[index + 1];
}

function dataRootIdentity(dataDirectory) {
  const resolved = fs.existsSync(dataDirectory) ? fs.realpathSync(dataDirectory) : path.resolve(dataDirectory);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(`openmausbot-data-root-v1\0${normalized}`).digest("hex");
}

async function serverIsLive(dataDirectory) {
  const targetIdentity = dataRootIdentity(dataDirectory);
  const legacyPossibleIdentities = new Set([
    dataRootIdentity(path.resolve(os.homedir(), ".openmausbot")),
    ...(process.env.OMB_DATA_DIR ? [dataRootIdentity(process.env.OMB_DATA_DIR)] : []),
  ]);
  const configured = Number(process.env.OMB_PORT ?? 0);
  const ports = Number.isInteger(configured) && configured > 0 ? [configured, ...DEFAULT_PORTS] : DEFAULT_PORTS;
  for (const port of new Set(ports)) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(600) });
      const body = await response.json().catch(() => null);
      const parsed = healthResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) continue;
      if (parsed.data.dataRootIdentity === targetIdentity) return true;
      if (parsed.data.dataRootIdentity === undefined && legacyPossibleIdentities.has(targetIdentity)) return true;
    } catch {
      // A closed port is the expected offline state.
    }
  }
  return false;
}

function requireDirectory(value, name) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || !command) {
    console.log(usage());
    return;
  }
  if (!["restore", "rollback"].includes(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);
  const dataDirectory = requireDirectory(option(args, "--data-dir"), "--data-dir");
  if (await serverIsLive(dataDirectory)) throw new Error("Agent Centipede is still running for this data directory; close it before offline recovery");
  const keyFile = requireDirectory(option(args, "--key-file"), "--key-file");
  const keyBase64 = fs.readFileSync(keyFile, "utf8").trim();
  if (command === "restore") {
    const backupFile = requireDirectory(option(args, "--backup"), "--backup");
    const result = restoreEncryptedBackup({ backupFile, dataDirectory, keyBase64 });
    console.log(JSON.stringify({ command, ...result }));
    return;
  }
  const rollbackDirectory = requireDirectory(option(args, "--rollback-dir"), "--rollback-dir");
  const result = rollbackEncryptedRestore({ dataDirectory, rollbackDirectory, keyBase64 });
  console.log(JSON.stringify({ command, ...result }));
}

main().catch((error) => {
  console.error(`offline recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
