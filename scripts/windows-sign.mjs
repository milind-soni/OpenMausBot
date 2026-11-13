// electron-builder's Windows signing hook (win.signtoolOptions.sign), active only
// when scripts/windows-signing.mjs finds signing secrets. electron-builder calls it
// once per file: the app executable, every .exe/.dll/.node it copies into the
// package, elevate.exe, the uninstaller, then the installer.
//
// Per file: a file that already carries a valid vendor signature is left alone
// (cloudflared.exe must be, its hash is pinned); anything else is signed by the
// configured provider, then checked: Valid, signed by WINDOWS_PUBLISHER_NAME, and
// timestamped (RFC 3161) so the signature outlives the certificate. Every
// decision is appended to release/windows-signing-log.jsonl for the release gate.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isPortableExecutable, publisherMatches, signingDecision, timestampKind, windowsSigningPlan } from "./windows-signing.mjs";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SIGNING_LOG = join(root, "release", "windows-signing-log.jsonl");

/** SSL.com's CodeSignTool, pinned like every other downloaded build tool. */
export const CODESIGNTOOL = Object.freeze({
  version: "1.3.2",
  url: "https://github.com/SSLcom/CodeSignTool/releases/download/v1.3.2/CodeSignTool-v1.3.2.zip",
  sha256: "f14b1e1ef14bfa1fd00279c363aab0debbf5dcfba0e4bcdce5d22bb771de0e3a",
});

/** conf/code_sign_tool.properties for SSL.com's production service and its public sandbox (dry runs only). */
export const ESIGNER_ENVIRONMENTS = Object.freeze({
  production: [
    "CLIENT_ID=kaXTRACNijSWsFdRKg_KAfD3fqrBlzMbWs6TwWHwAn8",
    "OAUTH2_ENDPOINT=https://login.ssl.com/oauth2/token",
    "CSC_API_ENDPOINT=https://cs.ssl.com",
    "TSA_URL=http://ts.ssl.com",
    "TSA_LEGACY_URL=http://ts.ssl.com/legacy",
  ].join("\n"),
  sandbox: [
    "CLIENT_ID=qOUeZCCzSqgA93acB3LYq6lBNjgZdiOxQc-KayC3UMw",
    "OAUTH2_ENDPOINT=https://oauth-sandbox.ssl.com/oauth2/token",
    "CSC_API_ENDPOINT=https://cs-try.ssl.com",
    "TSA_URL=http://ts.ssl.com",
    "TSA_LEGACY_URL=http://ts.ssl.com/legacy",
  ].join("\n"),
});

/** The Authenticode state of one file, from Windows itself (the same cmdlet electron-updater uses). */
export async function readSignature(file) {
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:OMB_SIGNED_FILE; "
    + "[pscustomobject]@{ status = \"$($s.Status)\"; subject = \"$($s.SignerCertificate.Subject)\"; "
    + "timestamped = ($null -ne $s.TimeStamperCertificate); message = \"$($s.StatusMessage)\" } | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, OMB_SIGNED_FILE: file }, timeout: 60_000, windowsHide: true,
  });
  return JSON.parse(stdout);
}

/** In the sandbox (dry runs) the test certificate does not chain to a root Windows trusts. */
export function acceptableStatus(status, sandbox) {
  return status === "Valid" || (sandbox && ["UnknownError", "NotTrusted"].includes(status));
}

/** Throws unless `file` now carries our signature with an RFC 3161 timestamp. */
export async function assertSignedByUs(file, plan, signature) {
  const problems = [];
  if (!acceptableStatus(signature.status, plan.sandbox)) problems.push(`status ${signature.status} (${signature.message})`);
  if (!publisherMatches(plan.publisherName, signature.subject)) problems.push(`signer ${JSON.stringify(signature.subject)} is not ${plan.publisherName}`);
  if (!signature.timestamped) problems.push("no timestamp");
  const kind = timestampKind(readFileSync(file));
  if (kind !== "rfc3161") problems.push(`timestamp kind ${kind}, expected rfc3161`);
  if (problems.length) throw new Error(`${basename(file)} is not correctly signed: ${problems.join("; ")}`);
}

async function codeSignTool() {
  const home = join(root, "node_modules", ".cache", "openmausbot", `codesigntool-${CODESIGNTOOL.version}`);
  const jar = () => {
    const found = readdirSync(home, { recursive: true }).map(String).find((path) => /(^|[\\/])jar[\\/]code_sign_tool-[\d.]+\.jar$/.test(path));
    return found ? join(home, found) : null;
  };
  if (!existsSync(home) || !jar()) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const response = await fetch(CODESIGNTOOL.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`CodeSignTool download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== CODESIGNTOOL.sha256) throw new Error(`CodeSignTool ${CODESIGNTOOL.version} failed its pinned SHA-256 check (got ${digest})`);
    const archive = join(home, "CodeSignTool.zip");
    writeFileSync(archive, bytes);
    await run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", home], { timeout: 120_000, windowsHide: true });
  }
  const jarPath = jar();
  if (!jarPath) throw new Error("CodeSignTool archive has no jar/code_sign_tool-*.jar");
  return { directory: dirname(dirname(jarPath)), jar: jarPath };
}

function javaExecutable(env) {
  // GitHub's Windows images carry several JDKs; CodeSignTool needs 11 or newer.
  for (const name of ["JAVA_HOME_21_X64", "JAVA_HOME_17_X64", "JAVA_HOME_11_X64"]) {
    if (env[name] && existsSync(join(env[name], "bin", "java.exe"))) return join(env[name], "bin", "java.exe");
  }
  if (env.JAVA_HOME && existsSync(join(env.JAVA_HOME, "bin", "java.exe"))) return join(env.JAVA_HOME, "bin", "java.exe");
  throw new Error("no Java 11+ runtime found for CodeSignTool (looked at JAVA_HOME_21_X64, JAVA_HOME_17_X64, JAVA_HOME_11_X64, JAVA_HOME)");
}

/** CodeSignTool's arguments for one file. Secrets go straight to java, never through a shell. */
export function esignerArguments(env, file, outputDirectory) {
  return [
    "sign",
    `-username=${env.ESIGNER_USERNAME}`,
    `-password=${env.ESIGNER_PASSWORD}`,
    `-credential_id=${env.ESIGNER_CREDENTIAL_ID}`,
    `-totp_secret=${env.ESIGNER_TOTP_SECRET}`,
    `-input_file_path=${file}`,
    `-output_dir_path=${outputDirectory}`,
  ];
}

/** Provider signers: sign `file` in place. */
export const SIGNERS = {
  async esigner(file, plan, env) {
    const tool = await codeSignTool();
    writeFileSync(join(tool.directory, "conf", "code_sign_tool.properties"), ESIGNER_ENVIRONMENTS[plan.sandbox ? "sandbox" : "production"]);
    const java = javaExecutable(env);
    let lastError = null;
    // A one-time password is good for one use; a retry waits for the next 30-second window.
    // CodeSignTool picks the signature format by extension and knows nothing of Node's .node
    // modules, which are ordinary DLLs: sign a copy under a name it understands.
    const name = /\.(exe|dll)$/i.test(file) ? basename(file) : `${basename(file)}.dll`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const work = mkdtempSync(join(tmpdir(), "omb-sign-"));
      try {
        const input = join(work, "in", name);
        const output = join(work, "out");
        mkdirSync(dirname(input));
        mkdirSync(output);
        copyFileSync(file, input);
        const result = await run(java, ["-jar", tool.jar, ...esignerArguments(env, input, output)], {
          cwd: tool.directory, timeout: 300_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
        // error.message would repeat the command line, secrets and all: keep only the output and exit code.
        }).catch((error) => ({ stdout: error.stdout ?? "", stderr: `${error.stderr ?? ""}\nexit ${error.code ?? error.signal}` }));
        const signed = join(output, name);
        // CodeSignTool can report an error and still exit 0: trust only a signed file on disk.
        if (existsSync(signed) && !/\b(Error|Exception)\b/.test(`${result.stdout}\n${result.stderr}`)) {
          copyFileSync(signed, file);
          return;
        }
        lastError = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((line) => line.trim()).slice(-3).join(" | ");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 31_000));
    }
    throw new Error(`eSigner could not sign ${basename(file)}: ${lastError}`);
  },
};

function record(entry) {
  mkdirSync(dirname(SIGNING_LOG), { recursive: true });
  appendFileSync(SIGNING_LOG, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
}

async function signOne(file, plan) {
  const before = await readSignature(file);
  const decision = signingDecision(basename(file), before, plan.publisherName);
  if (decision.action === "keep") {
    record({ file: basename(file), action: "kept", reason: decision.reason, signer: before.subject });
    console.log(`  • kept ${basename(file)}: ${decision.reason}`);
    return;
  }
  await SIGNERS[plan.provider](file, plan, process.env);
  const after = await readSignature(file);
  await assertSignedByUs(file, plan, after);
  record({ file: basename(file), action: "signed", reason: decision.reason, signer: after.subject });
  console.log(`  • signed ${basename(file)} (${decision.reason})`);
}

function signedPlan() {
  const plan = windowsSigningPlan(process.env);
  if (plan.mode !== "signed") throw new Error("the Windows signing hook ran without signing secrets");
  return plan;
}

// electron-builder signs extra resources while it copies them, before the afterPack
// hook re-verifies the pinned browser, CUA and DuckDB bytes. Signing changes those
// bytes, so files under resources/ wait until afterSign, which signs the whole tree.
let resourcesSigned = false;
const insideResources = (file) => /[\\/]win-[^\\/]*unpacked[\\/]resources[\\/]/i.test(file) && !/[\\/]app\.asar\.unpacked[\\/]/i.test(file);

/** electron-builder's custom sign hook (win.signtoolOptions.sign). */
export async function sign(configuration) {
  const file = configuration.path;
  const plan = signedPlan();
  if (!resourcesSigned && insideResources(file)) {
    record({ file: basename(file), action: "deferred", reason: "signed after afterPack verifies pinned bytes" });
    return;
  }
  await signOne(file, plan);
}

/** Every Portable Executable under `directory`, whatever its extension. */
export function portableExecutables(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => isPortableExecutable(readHead(file)));
}

function readHead(file) {
  // The DOS and PE headers sit in the first 4 KB; whether it is a PE is all this asks.
  const head = Buffer.alloc(4096);
  const descriptor = openSync(file, "r");
  try {
    return head.subarray(0, readSync(descriptor, head, 0, head.length, 0));
  } finally {
    closeSync(descriptor);
  }
}

/** electron-builder's afterSign hook: sign the resources tree once afterPack has verified it. */
export async function afterSign(context) {
  if (context.electronPlatformName !== "win32") return;
  const plan = signedPlan();
  resourcesSigned = true;
  for (const file of portableExecutables(join(context.appOutDir, "resources"))) await signOne(file, plan);
}
