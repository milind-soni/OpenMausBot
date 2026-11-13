// Windows code signing (docs/windows-signing.md): the unsigned build stays exactly
// what it was, the signed build's gates exist, and installed apps never get a
// publisherName that could strand them.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { UNSIGNED_ARGS, invocation } from "./package-win.mjs";
import { judge, uninstallerSigned } from "./verify-windows-signatures.mjs";
import { CODESIGNTOOL, ESIGNER_ENVIRONMENTS, acceptableStatus, esignerArguments } from "./windows-sign.mjs";
import {
  NEVER_SIGN, PROVIDERS, authenticodeBlob, electronBuilderOverlay, isPortableExecutable, publisherMatches,
  publisherNamesOf, signingDecision, timestampKind, windowsSigningPlan,
} from "./windows-signing.mjs";

const PUBLISHER = "CN=Example Private Limited, O=Example Private Limited, C=IN";
const SUBJECT = "CN=Example Private Limited, O=Example Private Limited, L=Bengaluru, S=Karnataka, C=IN";
const SECRETS = { ESIGNER_USERNAME: "user", ESIGNER_PASSWORD: "pass", ESIGNER_CREDENTIAL_ID: "cred", ESIGNER_TOTP_SECRET: "totp" };
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const workflow = (name) => parse(read(`../.github/workflows/${name}`));
const step = (job, predicate) => job.steps.find(predicate);

describe("the Windows signing plan", () => {
  it("builds unsigned, exactly as before, when no signing secret is set", () => {
    for (const env of [{}, { ESIGNER_USERNAME: "", ESIGNER_PASSWORD: "", ESIGNER_CREDENTIAL_ID: "", ESIGNER_TOTP_SECRET: "" },
      { WINDOWS_SIGNING_REQUIRED: "", WINDOWS_PUBLISHER_NAME: PUBLISHER }, { WINDOWS_SIGNING_REQUIRED: "false" }]) {
      const plan = windowsSigningPlan(env);
      expect(plan).toEqual({ mode: "unsigned" });
      expect(electronBuilderOverlay(plan)).toBeNull();
      // The same electron-builder command package.json ran before signing existed.
      expect(invocation(plan)).toEqual({ kind: "cli", args: ["--win", "--publish", "never"] });
    }
    expect(UNSIGNED_ARGS.join(" ")).toBe("--win --publish never");
    expect(JSON.parse(read("../package.json")).scripts["package:win"])
      .toBe("pnpm package:prepare && pnpm build:cua:win && node scripts/package-win.mjs");
  });

  it("refuses to build unsigned once signing is required", () => {
    expect(() => windowsSigningPlan({ WINDOWS_SIGNING_REQUIRED: "true" })).toThrow(/Refusing to build an unsigned/);
    expect(() => windowsSigningPlan({ WINDOWS_SIGNING_REQUIRED: "true", ESIGNER_USERNAME: "" })).toThrow(/Refusing/);
  });

  it("fails a half-configured provider and names only what is missing, never a value", () => {
    const { ESIGNER_TOTP_SECRET: _, ...partial } = SECRETS;
    let message = "";
    try { windowsSigningPlan({ ...partial, WINDOWS_PUBLISHER_NAME: PUBLISHER }); } catch (error) { message = error.message; }
    expect(message).toMatch(/half configured: missing ESIGNER_TOTP_SECRET\./);
    for (const value of Object.values(partial)) expect(message).not.toContain(`=${value}`);
  });

  it("needs the expected publisher as a DN and rejects unknown switch values", () => {
    expect(() => windowsSigningPlan(SECRETS)).toThrow(/WINDOWS_PUBLISHER_NAME/);
    expect(() => windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: "Example Private Limited" })).toThrow(/CN=/);
    expect(() => windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: PUBLISHER, WINDOWS_SIGNING_REQUIRED: "yes" })).toThrow(/"true", "false"/);
    expect(() => windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: PUBLISHER, ESIGNER_ENVIRONMENT: "test" })).toThrow(/ESIGNER_ENVIRONMENT/);
  });

  it("never lets the public sandbox build a release that requires signing", () => {
    expect(windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: PUBLISHER, ESIGNER_ENVIRONMENT: "sandbox" }).sandbox).toBe(true);
    expect(() => windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: PUBLISHER, ESIGNER_ENVIRONMENT: "sandbox", WINDOWS_SIGNING_REQUIRED: "true" }))
      .toThrow(/dry runs/);
  });

  it("signs the first signed release without telling installs to verify the publisher", () => {
    const plan = windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: PUBLISHER });
    expect(plan).toEqual({ mode: "signed", provider: "esigner", publisherName: PUBLISHER, verifyUpdates: false, sandbox: false });
    const overlay = electronBuilderOverlay(plan);
    expect(overlay.win.verifyUpdateCodeSignature).toBe(false);
    expect(overlay.win.signtoolOptions).toEqual({ sign: "./scripts/windows-sign.mjs", signingHashAlgorithms: ["sha256"] });
    expect(overlay.afterSign).toBe("./scripts/windows-sign.mjs");
    expect(overlay.win.forceCodeSigning).toBe(true);
    expect(invocation(plan)).toEqual({ kind: "api", options: { win: [], publish: "never", config: overlay } });
  });

  it("writes the publisher for installs to verify only once signing is required", () => {
    const plan = windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: ` ${PUBLISHER} `, WINDOWS_SIGNING_REQUIRED: "true" });
    expect(plan.verifyUpdates).toBe(true);
    const overlay = electronBuilderOverlay(plan);
    expect(overlay.win.verifyUpdateCodeSignature).toBe(true);
    expect(overlay.win.signtoolOptions.publisherName).toEqual([PUBLISHER]);
  });

  it("has exactly one provider whose secrets the workflows pass", () => {
    expect(Object.keys(PROVIDERS)).toEqual(["esigner"]);
    expect(PROVIDERS.esigner.secrets).toEqual(Object.keys(SECRETS));
  });
});

describe("electron-builder with the signing overlay", () => {
  // electron-builder's own code: the merge, the schema, and what decides app-update.yml's publisherName.
  const builder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  // The package entry first: its modules require one another in that order.
  builder("app-builder-lib");
  const { getConfig, validateConfiguration } = builder("app-builder-lib/out/util/config/config");
  const { WinPackager } = builder("app-builder-lib/out/winPackager");
  const { WindowsSignToolManager } = builder("app-builder-lib/out/codeSign/windowsSignToolManager");
  const { DebugLogger } = builder("builder-util");
  const root = new URL("..", import.meta.url).pathname;

  /** The publisherName electron-builder would write into app-update.yml for this configuration's win options. */
  async function writtenPublisherName(win) {
    const verifies = Object.getOwnPropertyDescriptor(WinPackager.prototype, "isForceCodeSigningVerification").get.call({ platformSpecificBuildOptions: win });
    if (!verifies) return undefined;
    const manager = new WindowsSignToolManager({ platformSpecificBuildOptions: win, getCscLink: () => null, getCscPassword: () => null });
    return manager.computedPublisherName.value;
  }

  it("keeps electron-builder.yml itself free of any signing or update-verification setting", async () => {
    const yml = parse(read("../electron-builder.yml"));
    for (const key of ["signtoolOptions", "azureSignOptions", "publisherName", "verifyUpdateCodeSignature", "signExts", "forceCodeSigning", "sign"]) {
      expect(yml.win, key).not.toHaveProperty(key);
    }
    expect(yml).not.toHaveProperty("afterSign");
    expect(yml).not.toHaveProperty("forceCodeSigning");
    expect(await writtenPublisherName(yml.win)).toBeNull();
  });

  it.each([false, true])("merges a schema-valid signed configuration (verify updates: %s) without touching targets or resources", async (required) => {
    const plan = windowsSigningPlan({ ...SECRETS, WINDOWS_PUBLISHER_NAME: PUBLISHER, WINDOWS_SIGNING_REQUIRED: String(required) });
    const merged = await getConfig(root, null, structuredClone(electronBuilderOverlay(plan)));
    await validateConfiguration(merged, new DebugLogger(false));
    const base = parse(read("../electron-builder.yml"));
    expect(merged.win.target).toEqual(base.win.target);
    expect(merged.win.extraResources).toEqual(base.win.extraResources);
    expect(merged.afterPack).toBe(base.afterPack);
    expect(merged.nsis).toEqual(base.nsis);
    expect(await writtenPublisherName(merged.win)).toEqual(required ? [PUBLISHER] : undefined);
  });
});

describe("which files are signed", () => {
  const valid = (subject) => ({ status: "Valid", subject, timestamped: true });
  const unsigned = { status: "NotSigned", subject: "", timestamped: false };

  it("never re-signs a vendor-signed binary and refuses cloudflared without its signature", () => {
    expect(NEVER_SIGN).toEqual(["cloudflared.exe"]);
    expect(signingDecision("cloudflared.exe", valid("CN=\"Cloudflare, Inc.\", O=\"Cloudflare, Inc.\""), PUBLISHER).action).toBe("keep");
    expect(() => signingDecision("cloudflared.exe", unsigned, PUBLISHER)).toThrow(/never re-signed/);
    for (const name of ["d3dcompiler_47.dll", "duckdb.dll", "cua-driver.exe", "adb.exe", "cua_driver_node_runtime.node"]) {
      expect(signingDecision(name, valid("CN=Some Vendor"), PUBLISHER)).toEqual({ action: "keep", reason: "vendor signature" });
    }
  });

  it("signs every unsigned or broken binary, and our own files unless we already signed them", () => {
    for (const status of ["NotSigned", "HashMismatch", "NotTrusted", "UnknownError"]) {
      expect(signingDecision("ffmpeg.dll", { ...unsigned, status }, PUBLISHER).action).toBe("sign");
    }
    for (const name of ["OpenMausBot.exe", "OpenMausBot-0.1.160-setup.exe", "OpenMausBot-0.1.160-setup.__uninstaller.exe"]) {
      expect(signingDecision(name, valid("CN=Someone Else"), PUBLISHER).action).toBe("sign");
      expect(signingDecision(name, valid(SUBJECT), PUBLISHER).action).toBe("keep");
    }
  });
});

describe("publisher matching", () => {
  it("matches the way electron-updater does: every listed key, or the CN alone", () => {
    expect(publisherMatches(PUBLISHER, SUBJECT)).toBe(true);
    expect(publisherMatches("CN=Example Private Limited", SUBJECT)).toBe(true);
    expect(publisherMatches("Example Private Limited", SUBJECT)).toBe(true);
    expect(publisherMatches(`${PUBLISHER}, L=Mumbai`, SUBJECT)).toBe(false);
    expect(publisherMatches("CN=Example Pvt Ltd", SUBJECT)).toBe(false);
    expect(publisherMatches(PUBLISHER, "")).toBe(false);
    expect(publisherMatches('CN="Cloudflare, Inc."', 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", C=US')).toBe(true);
  });

  it("reads publisherName from app-update.yml as a list or a string", () => {
    expect(publisherNamesOf(parse("owner: milind-soni\nrepo: OpenMausBot\nprovider: github\n"))).toEqual([]);
    expect(publisherNamesOf(parse(`publisherName:\n  - ${PUBLISHER}\nowner: milind-soni\n`))).toEqual([PUBLISHER]);
    expect(publisherNamesOf(parse(`publisherName: '${PUBLISHER}'\n`))).toEqual([PUBLISHER]);
  });
});

/** A minimal PE32+ image whose certificate table holds `blob`. */
function portableExecutable(blob) {
  const header = Buffer.alloc(512);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(64, 60);
  header.write("PE\0\0", 64, "ascii");
  const optional = 64 + 24;
  header.writeUInt16LE(0x20b, optional);
  if (blob) {
    header.writeUInt32LE(512, optional + 112 + 32);
    header.writeUInt32LE(blob.length, optional + 112 + 36);
  }
  return Buffer.concat([header, blob ?? Buffer.alloc(0)]);
}

describe("signature bytes", () => {
  const RFC3161 = Buffer.from("060a2b0601040182370303 01".replace(/ /g, ""), "hex");
  const LEGACY = Buffer.from("06092a864886f70d010906", "hex");

  it("tells an RFC 3161 timestamp from a legacy one or none", () => {
    expect(timestampKind(portableExecutable(Buffer.concat([Buffer.alloc(32), RFC3161, Buffer.alloc(32)])))).toBe("rfc3161");
    expect(timestampKind(portableExecutable(Buffer.concat([Buffer.alloc(32), LEGACY])))).toBe("legacy");
    expect(timestampKind(portableExecutable(Buffer.alloc(64)))).toBe("none");
    expect(timestampKind(portableExecutable(null))).toBe("none");
  });

  it("finds Portable Executables by their headers, not their names", () => {
    expect(isPortableExecutable(portableExecutable(null))).toBe(true);
    expect(authenticodeBlob(portableExecutable(null))).toHaveLength(0);
    expect(isPortableExecutable(Buffer.from("MZ not really a program"))).toBe(false);
    expect(isPortableExecutable(Buffer.from("{\"name\":\"package.json\"}"))).toBe(false);
  });
});

describe("the signature gate", () => {
  const ours = { status: "Valid", subject: SUBJECT };
  const base = { publisherName: PUBLISHER, sandbox: false, mustBeOurs: false, timestamp: "rfc3161" };

  it("passes our timestamped files and valid vendor files", () => {
    expect(judge({ ...base, name: "OpenMausBot.exe", signature: ours, mustBeOurs: true })).toEqual([]);
    expect(judge({ ...base, name: "adb.exe", signature: { status: "Valid", subject: "CN=Google LLC" }, timestamp: "legacy" })).toEqual([]);
    expect(judge({ ...base, name: "cloudflared.exe", signature: { status: "Valid", subject: "CN=\"Cloudflare, Inc.\"" } })).toEqual([]);
  });

  it("fails anything unsigned, signed by someone else where it must be ours, untimestamped, or a re-signed cloudflared", () => {
    expect(judge({ ...base, name: "ffmpeg.dll", signature: { status: "NotSigned", subject: "" } })).toEqual(["signature status NotSigned"]);
    expect(judge({ ...base, name: "OpenMausBot.exe", signature: { status: "Valid", subject: "CN=Other" }, mustBeOurs: true })[0]).toMatch(/is not CN=Example/);
    expect(judge({ ...base, name: "libEGL.dll", signature: ours, timestamp: "none" })).toEqual(["timestamp none, expected rfc3161"]);
    expect(judge({ ...base, name: "libEGL.dll", signature: ours, timestamp: "legacy" })).toEqual(["timestamp legacy, expected rfc3161"]);
    expect(judge({ ...base, name: "cloudflared.exe", signature: ours })).toEqual(["re-signed by us; it must keep its vendor signature"]);
  });

  it("accepts the sandbox's untrusted test root only for our own signatures, only in sandbox mode", () => {
    const test = { status: "UnknownError", subject: SUBJECT };
    expect(judge({ ...base, name: "OpenMausBot.exe", signature: test, mustBeOurs: true, sandbox: true })).toEqual([]);
    expect(judge({ ...base, name: "OpenMausBot.exe", signature: test, mustBeOurs: true })).toEqual(["signature status UnknownError"]);
    expect(judge({ ...base, name: "x.dll", signature: { status: "UnknownError", subject: "CN=Other" }, sandbox: true })).toEqual(["signature status UnknownError"]);
    expect(acceptableStatus("HashMismatch", true)).toBe(false);
  });

  it("requires a signed uninstaller in the build's signing log", () => {
    const line = (entry) => JSON.stringify(entry);
    expect(uninstallerSigned([line({ file: "OpenMausBot-1.0.0-setup.__uninstaller.exe", action: "signed", signer: SUBJECT })].join("\n"), PUBLISHER)).toBe(true);
    expect(uninstallerSigned(line({ file: "OpenMausBot-1.0.0-setup.__uninstaller.exe", action: "deferred" }), PUBLISHER)).toBe(false);
    expect(uninstallerSigned(line({ file: "OpenMausBot.exe", action: "signed", signer: SUBJECT }), PUBLISHER)).toBe(false);
  });
});

describe("the eSigner provider", () => {
  it("pins CodeSignTool by SHA-256 and talks to production unless asked for the sandbox", () => {
    expect(CODESIGNTOOL.url).toBe(`https://github.com/SSLcom/CodeSignTool/releases/download/v${CODESIGNTOOL.version}/CodeSignTool-v${CODESIGNTOOL.version}.zip`);
    expect(CODESIGNTOOL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ESIGNER_ENVIRONMENTS.production).toContain("CSC_API_ENDPOINT=https://cs.ssl.com\n");
    expect(ESIGNER_ENVIRONMENTS.production).toContain("TSA_URL=http://ts.ssl.com\n");
    expect(ESIGNER_ENVIRONMENTS.sandbox).toContain("CSC_API_ENDPOINT=https://cs-try.ssl.com\n");
  });

  it("passes each secret as one argument to java, with the TOTP secret so no prompt waits", () => {
    const args = esignerArguments({ ...SECRETS, ESIGNER_PASSWORD: "a b&c\"d" }, "C:\\r\\OpenMausBot.exe", "C:\\t\\out");
    expect(args).toEqual(["sign", "-username=user", "-password=a b&c\"d", "-credential_id=cred", "-totp_secret=totp",
      "-input_file_path=C:\\r\\OpenMausBot.exe", "-output_dir_path=C:\\t\\out"]);
  });
});

describe("the release workflow", () => {
  const release = workflow("release.yml");
  const windows = release.jobs.windows;
  const secretEnv = Object.fromEntries(PROVIDERS.esigner.secrets.map((name) => [name, `\${{ secrets.${name} }}`]));

  it("passes the signing secrets to the Windows package step only, unchanged command", () => {
    const pack = step(windows, (s) => s.run === "pnpm package:win");
    expect(pack.id).toBe("package");
    expect(pack.env).toEqual({
      ...secretEnv,
      WINDOWS_PUBLISHER_NAME: "${{ vars.WINDOWS_PUBLISHER_NAME }}",
      WINDOWS_SIGNING_REQUIRED: "${{ vars.WINDOWS_SIGNING_REQUIRED }}",
    });
    const text = read("../.github/workflows/release.yml");
    // Apart from the package step, the only reference is the prepare job's presence check.
    for (const name of PROVIDERS.esigner.secrets) {
      expect(text.split(`secrets.${name} }}`).length - 1, name).toBe(1);
      expect(text.split(`secrets.${name} != '' && 'set' || '' }}`).length - 1, name).toBe(1);
    }
  });

  it("checks the signing settings before any platform builds, seeing only whether each secret is set", () => {
    const preflight = step(release.jobs.prepare, (s) => s.run === "node scripts/windows-signing.mjs preflight");
    expect(preflight.if).toBe("steps.pin.outputs.should_release == 'true'");
    for (const name of PROVIDERS.esigner.secrets) expect(preflight.env[name]).toBe(`\${{ secrets.${name} != '' && 'set' || '' }}`);
    expect(preflight.env.WINDOWS_SIGNING_REQUIRED).toBe("${{ vars.WINDOWS_SIGNING_REQUIRED }}");
    expect(preflight.env.WINDOWS_PUBLISHER_NAME).toBe("${{ vars.WINDOWS_PUBLISHER_NAME }}");
  });

  it("keeps the unsigned publisherName gate, and checks the exact publisher once signing is required", () => {
    const verify = step(windows, (s) => s.name === "Verify the packaged tree and start the packaged server");
    expect(verify.run).toContain([
      'if [ "$WINDOWS_SIGNING_REQUIRED" = "true" ]; then',
      "  # every release from here on is signed: installs must refuse anything else",
      '  node scripts/windows-signing.mjs check-update-config "$res/app-update.yml" || exit 1',
      'elif grep -q "publisherName" "$res/app-update.yml"; then',
      '  echo "::error::publisherName on an unsigned build breaks every update"; exit 1',
      "fi",
    ].join("\n"));
    expect(verify.env).toEqual({ WINDOWS_PUBLISHER_NAME: "${{ vars.WINDOWS_PUBLISHER_NAME }}", WINDOWS_SIGNING_REQUIRED: "${{ vars.WINDOWS_SIGNING_REQUIRED }}" });
  });

  it("gates a signed or signing-required build on every signature before the stable copy and upload", () => {
    const names = windows.steps.map((s) => s.name ?? s.run ?? s.uses);
    const gate = step(windows, (s) => s.name === "Gate: every Windows binary is signed and timestamped");
    expect(gate.if).toBe("steps.package.outputs.signing == 'signed' || vars.WINDOWS_SIGNING_REQUIRED == 'true'");
    expect(gate.run).toContain('test "$SIGNING" = signed ||');
    expect(gate.run).toContain("node scripts/verify-windows-signatures.mjs --unpacked release/win-unpacked");
    expect(gate.run).toContain("--log release/windows-signing-log.jsonl");
    expect(gate.env).toEqual({ SIGNING: "${{ steps.package.outputs.signing }}", WINDOWS_PUBLISHER_NAME: "${{ vars.WINDOWS_PUBLISHER_NAME }}" });
    expect(names.indexOf(gate.name)).toBeGreaterThan(names.indexOf("pnpm package:win"));
    expect(names.indexOf(gate.name)).toBeLessThan(names.indexOf("Stable-named copy"));
    // The signing log is never published.
    expect(step(windows, (s) => s.uses?.startsWith("actions/upload-artifact@")).with.path).not.toContain("jsonl");
  });

  it("lets only the Package Windows dry run use the sandbox, and never writes publisherName there", () => {
    const dry = workflow("package-win.yml").jobs.package;
    const pack = step(dry, (s) => s.run === "pnpm package:win");
    expect(pack.env).toEqual({ ...secretEnv, ESIGNER_ENVIRONMENT: "${{ vars.ESIGNER_ENVIRONMENT }}", WINDOWS_PUBLISHER_NAME: "${{ vars.WINDOWS_PUBLISHER_NAME }}" });
    expect(step(dry, (s) => s.name === "verify the Windows signatures").if).toBe("steps.package.outputs.signing == 'signed'");
    expect(read("../.github/workflows/release.yml")).not.toContain("ESIGNER_ENVIRONMENT");
    expect(read("../.github/workflows/windows-defender-check.yml")).not.toMatch(/ESIGNER_|WINDOWS_PUBLISHER_NAME/);
  });
});
