// Release gate for a signed Windows build (docs/windows-signing.md): mirrors the
// macOS codesign gate. Runs on the Windows runner after `pnpm package:win`.
//
//   node scripts/verify-windows-signatures.mjs --unpacked release/win-unpacked \
//     --installer release/OpenMausBot-<version>-setup.exe --log release/windows-signing-log.jsonl
//
// Fails unless:
//   - the installer and OpenMausBot.exe are Valid, signed by WINDOWS_PUBLISHER_NAME,
//     and carry an RFC 3161 timestamp;
//   - the uninstaller was signed the same way during the build (signing log);
//   - every Portable Executable in the package (.exe, .dll, .node, whatever its
//     name) is Valid: signed by us with a timestamp, or by its vendor;
//   - cloudflared.exe still carries its vendor's signature (its hash is pinned).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { acceptableStatus, portableExecutables, readSignature } from "./windows-sign.mjs";
import { NEVER_SIGN, publisherMatches, timestampKind } from "./windows-signing.mjs";

/** Problems with one file's signature; `mustBeOurs` for the files we produce. */
export function judge({ name, signature, timestamp, mustBeOurs, publisherName, sandbox }) {
  const ours = publisherMatches(publisherName, signature.subject);
  const problems = [];
  if (NEVER_SIGN.includes(name.toLowerCase())) {
    if (signature.status !== "Valid") problems.push(`vendor signature is ${signature.status}`);
    if (ours) problems.push("re-signed by us; it must keep its vendor signature");
    return problems;
  }
  if (!acceptableStatus(signature.status, sandbox && ours)) problems.push(`signature status ${signature.status}`);
  if (mustBeOurs && !ours) problems.push(`signer ${JSON.stringify(signature.subject)} is not ${publisherName}`);
  if (ours && timestamp !== "rfc3161") problems.push(`timestamp ${timestamp}, expected rfc3161`);
  return problems;
}

/** The uninstaller never lands in release/: the build log is the evidence it was signed. */
export function uninstallerSigned(logText, publisherName) {
  return logText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .some((entry) => /__uninstaller\.exe$/i.test(entry.file) && entry.action === "signed" && publisherMatches(publisherName, entry.signer));
}

async function main() {
  const { values } = parseArgs({ options: { unpacked: { type: "string" }, installer: { type: "string" }, log: { type: "string" } } });
  if (!values.unpacked || !values.installer || !values.log) throw new Error("usage: --unpacked <dir> --installer <setup.exe> --log <windows-signing-log.jsonl>");
  const publisherName = (process.env.WINDOWS_PUBLISHER_NAME ?? "").trim();
  if (!publisherName) throw new Error("WINDOWS_PUBLISHER_NAME is not set");
  const sandbox = process.env.ESIGNER_ENVIRONMENT === "sandbox";
  const unpacked = resolve(values.unpacked);
  const mainExe = resolve(unpacked, "OpenMausBot.exe");
  const installer = resolve(values.installer);
  for (const file of [mainExe, installer, values.log]) if (!existsSync(file)) throw new Error(`missing ${file}`);

  const rows = [];
  let failed = 0;
  for (const file of [installer, ...portableExecutables(unpacked)]) {
    const signature = await readSignature(file);
    const name = relative(unpacked, file).startsWith("..") ? relative(resolve(installer, ".."), file) : relative(unpacked, file);
    const problems = judge({
      name: file.split(/[\\/]/).at(-1), signature, timestamp: timestampKind(readFileSync(file)),
      mustBeOurs: file === installer || file === mainExe, publisherName, sandbox,
    });
    if (problems.length) failed++;
    rows.push(`| ${name} | ${signature.status} | ${signature.subject.replace(/\|/g, "/") || "—"} | ${problems.join("; ") || "ok"} |`);
    if (problems.length) console.log(`::error::${name}: ${problems.join("; ")}`);
  }
  if (!uninstallerSigned(readFileSync(values.log, "utf8"), publisherName)) {
    failed++;
    console.log("::error::the signing log has no signed uninstaller");
  }
  const table = ["| File | Status | Signer | Result |", "| --- | --- | --- | --- |", ...rows].join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Windows signatures\n\n${table}\n`);
  if (failed) throw new Error(`${failed} Windows signature check(s) failed`);
  console.log(`ok: ${rows.length} files, all signed; ours by ${publisherName} with RFC 3161 timestamps`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
