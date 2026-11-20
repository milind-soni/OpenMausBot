// Windows code signing for the desktop release (docs/windows-signing.md).
//
// Everything here is decided from the environment the release workflow passes
// in: with no signing secrets the Windows build is exactly the unsigned build it
// has always been. With a complete set of one provider's secrets, electron-builder
// signs through scripts/windows-sign.mjs, and the release gates check the result.
//
// Updates are the dangerous part. An installed app verifies a downloaded update
// against the publisherName in ITS OWN app-update.yml, so:
//   - a build without publisherName installs any update (signed or not);
//   - a build WITH publisherName refuses every update that is not validly signed
//     by that publisher, forever, until the user reinstalls by hand.
// So publisherName is only written once WINDOWS_SIGNING_REQUIRED is true: the
// same switch makes every later release fail instead of shipping unsigned.
//
// This module has no dependencies at import time: the release's prepare job runs
// `node scripts/windows-signing.mjs preflight` before anything is installed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Signing providers. Adding one is an entry here plus its signer in windows-sign.mjs. */
export const PROVIDERS = Object.freeze({
  esigner: Object.freeze({
    label: "SSL.com eSigner (cloud key, OV/IV certificate)",
    secrets: Object.freeze(["ESIGNER_USERNAME", "ESIGNER_PASSWORD", "ESIGNER_CREDENTIAL_ID", "ESIGNER_TOTP_SECRET"]),
  }),
});

/** Third-party executables we ship byte-for-byte as their vendor signed them; the release checks their hashes. */
export const NEVER_SIGN = Object.freeze(["cloudflared.exe"]);

/** Files only we produce: they must carry our signature even when another valid one is present. */
const OUR_FILES = [/^OpenMausBot\.exe$/i, /-setup\.exe$/i, /__uninstaller\.exe$/i];

const present = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

/**
 * What the Windows build should do, from the workflow's environment.
 * Throws — failing the release — on any half-configured or required-but-missing state.
 */
export function windowsSigningPlan(env = process.env) {
  const requiredValue = (env.WINDOWS_SIGNING_REQUIRED ?? "").trim();
  if (!["", "true", "false"].includes(requiredValue)) {
    throw new Error(`WINDOWS_SIGNING_REQUIRED must be "true", "false" or unset; got ${JSON.stringify(requiredValue)}`);
  }
  const required = requiredValue === "true";
  const complete = [];
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const missing = provider.secrets.filter((secret) => !present(env, secret));
    if (missing.length === 0) complete.push(name);
    else if (missing.length < provider.secrets.length) {
      throw new Error(`${provider.label} is half configured: missing ${missing.join(", ")}. Set every one of ${provider.secrets.join(", ")}, or none.`);
    }
  }
  if (complete.length > 1) throw new Error(`more than one Windows signing provider is configured (${complete.join(", ")}); keep one`);
  if (complete.length === 0) {
    if (required) {
      throw new Error("WINDOWS_SIGNING_REQUIRED is true but no Windows signing secrets are set. Refusing to build an unsigned "
        + "Windows release: installs from signed releases would refuse it as an update.");
    }
    return { mode: "unsigned" };
  }
  const environment = (env.ESIGNER_ENVIRONMENT ?? "").trim();
  if (!["", "production", "sandbox"].includes(environment)) {
    throw new Error(`ESIGNER_ENVIRONMENT must be "production", "sandbox" or unset; got ${JSON.stringify(environment)}`);
  }
  // SSL.com's public sandbox signs with a test certificate Windows does not trust: dry runs only.
  const sandbox = environment === "sandbox";
  if (sandbox && required) throw new Error("ESIGNER_ENVIRONMENT=sandbox is for dry runs; it can never build a release that requires signing");
  const publisherName = (env.WINDOWS_PUBLISHER_NAME ?? "").trim();
  if (!/(^|,)\s*CN\s*=/.test(publisherName)) {
    throw new Error("WINDOWS_PUBLISHER_NAME must be the certificate subject to expect, as a DN with at least CN=, "
      + 'for example "CN=Example Private Limited, O=Example Private Limited, C=IN"');
  }
  return { mode: "signed", provider: complete[0], publisherName, verifyUpdates: required, sandbox };
}

/**
 * The electron-builder configuration merged over electron-builder.yml for this plan,
 * or null to build from electron-builder.yml alone (the unsigned build).
 */
export function electronBuilderOverlay(plan) {
  if (plan.mode !== "signed") return null;
  return {
    // Signs the resources tree once the afterPack hook has verified its pinned bytes.
    afterSign: "./scripts/windows-sign.mjs",
    win: {
      // Everything electron-builder signs goes through our hook: the app executable and its
      // DLLs, elevate.exe, the uninstaller and the installer (resources wait for afterSign).
      signtoolOptions: {
        sign: "./scripts/windows-sign.mjs",
        signingHashAlgorithms: ["sha256"],
        ...(plan.verifyUpdates ? { publisherName: [plan.publisherName] } : {}),
      },
      signExts: [".dll", ".node"],
      // false keeps publisherName out of app-update.yml (electron-builder writes it only when this is true).
      verifyUpdateCodeSignature: plan.verifyUpdates,
      forceCodeSigning: true,
    },
  };
}

function parseDn(value) {
  // The updater's own parser, so the gate and the installed app agree on what matches.
  const require = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
  return require("builder-util-runtime").parseDn(value);
}

/**
 * Whether a certificate subject satisfies a publisherName entry, exactly as
 * electron-updater decides it: every key of a DN entry must match, a bare name
 * must equal the CN.
 */
export function publisherMatches(expected, subject) {
  if (!expected || !subject) return false;
  const actual = parseDn(subject);
  const wanted = parseDn(expected);
  if (wanted.size) return [...wanted.keys()].every((key) => wanted.get(key) === actual.get(key));
  return expected === actual.get("CN");
}

/** What the signing hook does with one file, given its current Authenticode state. */
export function signingDecision(fileName, signature, publisherName) {
  const name = fileName.toLowerCase();
  const ours = signature.status === "Valid" && publisherMatches(publisherName, signature.subject);
  if (NEVER_SIGN.includes(name)) {
    if (signature.status === "Valid") return { action: "keep", reason: "vendor signature (never re-signed)" };
    throw new Error(`${fileName} must carry its vendor's valid signature (status ${signature.status}); it is never re-signed`);
  }
  if (OUR_FILES.some((pattern) => pattern.test(fileName))) {
    return ours ? { action: "keep", reason: "already signed by us" } : { action: "sign", reason: "our file" };
  }
  if (signature.status === "Valid") return { action: "keep", reason: ours ? "already signed by us" : "vendor signature" };
  return { action: "sign", reason: `signature status ${signature.status}` };
}

const RFC3161_TIMESTAMP_OID = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x03, 0x03, 0x01]); // 1.3.6.1.4.1.311.3.3.1
const LEGACY_COUNTERSIGNATURE_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x06]); // 1.2.840.113549.1.9.6

/** The Authenticode certificate table of a PE image, or null when it is not a PE or carries none. */
export function authenticodeBlob(bytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") return null;
  const pe = bytes.readUInt32LE(60);
  if (pe + 24 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") return null;
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  if (directories + 40 > bytes.length) return null;
  const start = bytes.readUInt32LE(directories + 32);
  const size = bytes.readUInt32LE(directories + 36);
  if (!start || !size || start + size > bytes.length) return Buffer.alloc(0);
  return bytes.subarray(start, start + size);
}

export const isPortableExecutable = (bytes) => authenticodeBlob(bytes) !== null;

/** "rfc3161", "legacy" or "none": which kind of timestamp the image's signature carries. */
export function timestampKind(bytes) {
  const blob = authenticodeBlob(bytes);
  if (!blob?.length) return "none";
  if (blob.includes(RFC3161_TIMESTAMP_OID)) return "rfc3161";
  if (blob.includes(LEGACY_COUNTERSIGNATURE_OID)) return "legacy";
  return "none";
}

/** The publisherName entries of a parsed app-update.yml (electron-builder writes a string or a list). */
export function publisherNamesOf(updateConfig) {
  const value = updateConfig?.publisherName;
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

async function main([command, ...args]) {
  if (command === "preflight") {
    // Run before the platform builds: a release that would fail its Windows signing fails here, in a minute.
    const plan = windowsSigningPlan();
    console.log(plan.mode === "signed"
      ? `Windows: signed with ${PROVIDERS[plan.provider].label} as ${plan.publisherName}; `
        + (plan.verifyUpdates ? "updates verify the publisher." : "first signed release: updates do not verify the publisher yet.")
      : "Windows: unsigned (no signing secrets set).");
    return;
  }
  if (command === "check-update-config") {
    // The packaged app-update.yml must say what the release's switch says. Reads only the
    // repository variables, never the signing secrets.
    const verify = (process.env.WINDOWS_SIGNING_REQUIRED ?? "").trim() === "true";
    const expected = (process.env.WINDOWS_PUBLISHER_NAME ?? "").trim();
    const { parse } = await import("yaml");
    const names = publisherNamesOf(parse(readFileSync(args[0], "utf8")));
    if (verify) {
      if (!expected || names.length !== 1 || names[0] !== expected) {
        throw new Error(`app-update.yml publisherName is ${JSON.stringify(names)}, expected [${JSON.stringify(expected)}]`);
      }
      console.log(`app-update.yml verifies updates against ${expected}`);
    } else if (names.length) {
      throw new Error("publisherName on a build that must not verify updates yet breaks every update");
    } else console.log("app-update.yml does not verify update signatures (as planned)");
    return;
  }
  throw new Error("usage: node scripts/windows-signing.mjs preflight | check-update-config <app-update.yml>");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
