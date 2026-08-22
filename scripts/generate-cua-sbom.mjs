// Maintainer tool: merge cargo-about's root-scoped views of the two shipped
// executables into deterministic notices, a license report, and a CycloneDX
// inventory. Raw workspace-wide `cargo metadata` must not be used here: its
// feature-unified resolve graph includes dependencies enabled only by other
// workspace members.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [
  driverReportPath,
  cursorThemeReportPath,
  cargoLockPath,
  outputDirectory,
] = process.argv.slice(2);
if (
  !driverReportPath ||
  !cursorThemeReportPath ||
  !cargoLockPath ||
  !outputDirectory
) {
  throw new Error(
    "usage: node scripts/generate-cua-sbom.mjs " +
      "<cua-driver.cargo-about.json> <cursor-theme.cargo-about.json> " +
      "<upstream-Cargo.lock> <output-directory>",
  );
}

const SOURCE_COMMIT = "a1672e7b11951275ecfba3384264d4530185d0db";
const SOURCE_ROOT = `https://github.com/trycua/cua/tree/${SOURCE_COMMIT}/libs/cua-driver/rust`;
const RELEASE_VERSION = "0.19.3";
const ARCHIVE_SHA256 =
  "3db9d4257d84bacaf7eb104d225f85613ce67edbb20d6eeb83c1384b6d8a5b10";
const CARGO_LOCK_SHA256 =
  "c1a8df7f4bedd554f6fc90c852c3625c91a89b28d9f2c642d966279e9e372362";
const INTER_LICENSE_SHA256 =
  "ecfea75d8a36217d19528567070745a516072ffe907c9fffecbab92eb3b6fc59";
const INTER_FONT_SHA256 =
  "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031";
const INTER_VERSION = "4.001";
const INTER_COMMIT = "66647c0bbbe41a850d79d9c76fb13add3378940f";
const REGISTRY_SOURCE_PREFIX =
  "registry+https://github.com/rust-lang/crates.io-index";

const EXPECTED_DRIVER_REGISTRY_COUNT = 325;
const EXPECTED_CURSOR_THEME_REGISTRY_COUNT = 113;
const EXPECTED_REGISTRY_UNION_COUNT = 330;
const EXPECTED_DRIVER_LOCAL = Object.freeze([
  "cua-driver@0.19.3",
  "cursor-overlay@0.19.3",
  "pip-preview@0.19.3",
  "platform-linux@0.19.3",
]);
const EXPECTED_CURSOR_THEME_LOCAL = Object.freeze(["cursor-overlay@0.19.3"]);
const EXPECTED_CURSOR_THEME_ONLY = Object.freeze([
  "bumpalo@3.20.2",
  "typed-path@0.12.3",
  "zip@8.6.0",
  "zlib-rs@0.6.6",
  "zopfli@0.8.3",
]);
const EXPECTED_MPL_COMPONENTS = Object.freeze([
  "option-ext@0.2.0",
  "uniffi@0.31.0",
  "uniffi_core@0.31.0",
  "uniffi_internal_macros@0.31.0",
  "uniffi_macros@0.31.0",
  "uniffi_meta@0.31.0",
  "uniffi_pipeline@0.31.0",
]);
const TRYCUA_COMPONENTS = Object.freeze([
  "cua-driver",
  "cua-driver-contract",
  "cua-driver-core",
  "cua-driver-sdk",
  "cursor-overlay",
  "cursor-theme-cli",
  "pip-preview",
  "platform-linux",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageKey(pkg) {
  return `${pkg.name}@${pkg.version}`;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactSet(actual, expected, label) {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${label} differs; expected ${expectedSorted.join(", ")}; found ${actualSorted.join(", ")}`,
    );
  }
}

function isRegistryPackage(pkg) {
  return (
    typeof pkg?.source === "string" &&
    pkg.source.startsWith(REGISTRY_SOURCE_PREFIX)
  );
}

function inspectCargoAboutReport(report, label) {
  if (!Array.isArray(report?.crates) || !Array.isArray(report?.licenses)) {
    throw new Error(`${label} is not cargo-about JSON output`);
  }

  const discovered = new Map();
  const local = new Set();
  for (const entry of report.crates) {
    const pkg = entry?.package;
    if (!pkg?.id || !pkg?.name || !pkg?.version) {
      throw new Error(`${label} contains incomplete package metadata`);
    }
    if (isRegistryPackage(pkg)) {
      if (discovered.has(pkg.id))
        throw new Error(`${label} contains duplicate ${pkg.id}`);
      discovered.set(pkg.id, {
        ...pkg,
        resolvedLicense: entry.license ?? pkg.license,
      });
    } else if (pkg.source == null) {
      local.add(packageKey(pkg));
    } else {
      throw new Error(
        `${label} contains an unreviewed package source: ${pkg.source}`,
      );
    }
  }

  const licensed = new Set();
  for (const license of report.licenses) {
    for (const usage of license.used_by ?? []) {
      const pkg = usage.crate;
      if (isRegistryPackage(pkg)) licensed.add(pkg.id);
    }
  }
  assertExactSet(
    licensed,
    discovered.keys(),
    `${label} licensed registry package set`,
  );
  return { report, discovered, local };
}

function mergeRegistryPackages(left, right) {
  const merged = new Map();
  for (const pkg of [...left.values(), ...right.values()]) {
    const prior = merged.get(pkg.id);
    if (
      prior &&
      JSON.stringify({
        name: prior.name,
        version: prior.version,
        source: prior.source,
        license: prior.resolvedLicense,
      }) !==
        JSON.stringify({
          name: pkg.name,
          version: pkg.version,
          source: pkg.source,
          license: pkg.resolvedLicense,
        })
    ) {
      throw new Error(`cargo-about reports disagree about ${pkg.id}`);
    }
    merged.set(pkg.id, prior ?? pkg);
  }
  return merged;
}

function parseCargoLock(lockText) {
  const packages = new Map();
  for (const block of lockText.split(/(?=^\[\[package\]\]\s*$)/m)) {
    if (!block.startsWith("[[package]]")) continue;
    const value = (name) => {
      const match = block.match(
        new RegExp(`^${name} = ("(?:[^"\\\\]|\\\\.)*")$`, "m"),
      );
      return match ? JSON.parse(match[1]) : undefined;
    };
    const name = value("name");
    const version = value("version");
    const source = value("source");
    const checksum = value("checksum");
    if (!name || !version || !source?.startsWith(REGISTRY_SOURCE_PREFIX))
      continue;
    if (!/^[a-f0-9]{64}$/.test(checksum ?? "")) {
      throw new Error(
        `Cargo.lock has no SHA-256 checksum for ${name}@${version}`,
      );
    }
    const key = `${name}@${version}`;
    const existing = packages.get(key);
    if (existing && existing.checksum !== checksum) {
      throw new Error(`Cargo.lock contains ambiguous sources for ${key}`);
    }
    packages.set(key, { checksum, source });
  }
  return packages;
}

function normalizeLicense(expression, label) {
  if (!expression) throw new Error(`missing license expression for ${label}`);
  return expression.replaceAll("/", " OR ").replace(/\s+/g, " ").trim();
}

function cargoReference(name, version) {
  return `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function registryComponent(pkg, cargoLockPackages) {
  const key = packageKey(pkg);
  const locked = cargoLockPackages.get(key);
  if (!locked)
    throw new Error(`Cargo.lock does not contain selected package ${key}`);
  const distribution = `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download`;
  return {
    type: "library",
    "bom-ref": cargoReference(pkg.name, pkg.version),
    group: "crates.io",
    name: pkg.name,
    version: pkg.version,
    purl: cargoReference(pkg.name, pkg.version),
    hashes: [{ alg: "SHA-256", content: locked.checksum }],
    licenses: [
      { expression: normalizeLicense(pkg.license ?? pkg.resolvedLicense, key) },
    ],
    ...(pkg.description ? { description: pkg.description } : {}),
    externalReferences: [
      { type: "distribution", url: distribution },
      ...(typeof pkg.repository === "string" &&
      /^https?:\/\//.test(pkg.repository)
        ? [{ type: "vcs", url: pkg.repository }]
        : []),
    ],
    properties: [
      { name: "openmausbot:cargo:package-id", value: pkg.id },
      { name: "openmausbot:cargo:crate-sha256", value: locked.checksum },
    ],
  };
}

function trycuaComponent(name) {
  return {
    type: "library",
    "bom-ref": cargoReference(name, RELEASE_VERSION),
    group: "trycua",
    name,
    version: RELEASE_VERSION,
    purl: cargoReference(name, RELEASE_VERSION),
    licenses: [{ license: { id: "MIT" } }],
    externalReferences: [{ type: "vcs", url: `${SOURCE_ROOT}/crates/${name}` }],
  };
}

function interComponent() {
  return {
    type: "file",
    "bom-ref": `pkg:generic/inter@${INTER_VERSION}`,
    group: "rsms",
    name: "Inter",
    version: INTER_VERSION,
    purl: `pkg:generic/inter@${INTER_VERSION}`,
    hashes: [{ alg: "SHA-256", content: INTER_FONT_SHA256 }],
    licenses: [{ license: { id: "OFL-1.1" } }],
    copyright:
      "Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)",
    externalReferences: [
      {
        type: "vcs",
        url: `https://github.com/rsms/inter/commit/${INTER_COMMIT}`,
      },
      {
        type: "distribution",
        url: `${SOURCE_ROOT}/crates/cursor-overlay/assets/Inter.ttf`,
      },
    ],
    properties: [
      {
        name: "openmausbot:font:name-table-version",
        value: "Version 4.001;git-66647c0bb",
      },
      { name: "openmausbot:font:embedded-sha256", value: INTER_FONT_SHA256 },
    ],
  };
}

function mergeLicenseRecords(reports, selectedRegistry, interLicenseText) {
  const records = new Map();
  const registryCoverage = new Set();
  const mplComponents = new Set();

  for (const report of reports) {
    for (const license of report.licenses) {
      const usedBy = (license.used_by ?? [])
        .map((usage) => usage.crate)
        .filter(
          (pkg) => isRegistryPackage(pkg) && selectedRegistry.has(pkg.id),
        );
      if (!usedBy.length) continue;
      const recordKey = sha256(
        `${license.id}\0${license.name}\0${license.text}`,
      );
      const record = records.get(recordKey) ?? {
        id: license.id,
        name: license.name,
        text: license.text,
        usedBy: new Map(),
      };
      for (const pkg of usedBy) {
        record.usedBy.set(pkg.id, pkg);
        registryCoverage.add(pkg.id);
        if (license.id === "MPL-2.0") mplComponents.add(packageKey(pkg));
      }
      records.set(recordKey, record);
    }
  }
  assertExactSet(
    registryCoverage,
    selectedRegistry.keys(),
    "merged license report coverage",
  );
  assertExactSet(
    mplComponents,
    EXPECTED_MPL_COMPONENTS,
    "MPL-2.0 component set",
  );

  records.set("inter-ofl-1.1", {
    id: "OFL-1.1",
    name: "SIL Open Font License 1.1",
    text: interLicenseText,
    usedBy: new Map([
      [
        `pkg:generic/inter@${INTER_VERSION}`,
        {
          id: `pkg:generic/inter@${INTER_VERSION}`,
          name: "Inter",
          version: INTER_VERSION,
          source: `https://github.com/rsms/inter/commit/${INTER_COMMIT}`,
        },
      ],
    ]),
  });

  return [...records.values()].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.name.localeCompare(right.name) ||
      sha256(left.text).localeCompare(sha256(right.text)),
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeEmbeddedText(value) {
  return String(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+$/gm, "");
}

function componentLink(pkg) {
  if (pkg.name === "Inter")
    return `https://github.com/rsms/inter/commit/${INTER_COMMIT}`;
  return `https://crates.io/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
}

function renderLicenseHtml(records, registryPackages) {
  const overview = new Map();
  for (const record of records) {
    const entry = overview.get(record.id) ?? {
      name: record.name,
      components: new Set(),
    };
    for (const key of record.usedBy.keys()) entry.components.add(key);
    overview.set(record.id, entry);
  }
  const overviewHtml = [...overview]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, entry]) =>
        `<li><a href="#${escapeHtml(id)}">${escapeHtml(entry.name)}</a> (${entry.components.size})</li>`,
    )
    .join("");
  const inventoryHtml = [...registryPackages.values()]
    .sort((left, right) => packageKey(left).localeCompare(packageKey(right)))
    .map(
      (pkg) =>
        `<tr data-package-id="${escapeHtml(pkg.id)}"><td><a href="${escapeHtml(componentLink(pkg))}">${escapeHtml(pkg.name)}</a></td><td>${escapeHtml(pkg.version)}</td><td><code>${escapeHtml(normalizeLicense(pkg.license ?? pkg.resolvedLicense, packageKey(pkg)))}</code></td></tr>`,
    )
    .join("\n");
  let previousId;
  const licensesHtml = records
    .map((record) => {
      const heading =
        record.id === previousId
          ? ""
          : `<h3 id="${escapeHtml(record.id)}">${escapeHtml(record.name)}</h3>`;
      previousId = record.id;
      const usedBy = [...record.usedBy.values()]
        .sort((left, right) =>
          packageKey(left).localeCompare(packageKey(right)),
        )
        .map(
          (pkg) =>
            `<li data-component-id="${escapeHtml(pkg.id)}"><a href="${escapeHtml(componentLink(pkg))}">${escapeHtml(pkg.name)} ${escapeHtml(pkg.version)}</a></li>`,
        )
        .join("");
      return `<section>${heading}<h4>${escapeHtml(record.name)}</h4><p>Used by:</p><ul>${usedBy}</ul><pre>${escapeHtml(normalizeEmbeddedText(record.text))}</pre></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenMausBot — Cua Driver third-party licenses</title>
  <style>body{font:14px system-ui,sans-serif;line-height:1.45;max-width:960px;margin:2rem auto;padding:0 1rem;color:#171717}pre{white-space:pre-wrap;border:1px solid #ddd;border-radius:6px;padding:1rem;overflow-wrap:anywhere}a{color:#2563eb}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:.45rem;text-align:left;vertical-align:top}code{overflow-wrap:anywhere}</style>
</head>
<body>
  <h1>Cua Driver ${RELEASE_VERSION} third-party licenses</h1>
  <p>This report covers all ${EXPECTED_REGISTRY_UNION_COUNT} crates.io packages in the root-scoped release build graphs for <code>cua-driver</code> and <code>cua-cursor-theme</code>, plus the embedded Inter font. Cua's eight workspace packages are covered by the accompanying MIT <code>LICENSE.md</code>.</p>
  <p>Source commit: <a href="https://github.com/trycua/cua/commit/${SOURCE_COMMIT}"><code>${SOURCE_COMMIT}</code></a>. Cargo.lock SHA-256: <code>${CARGO_LOCK_SHA256}</code>.</p>
  <h2>License overview</h2>
  <ul>${overviewHtml}</ul>
  <h2>Package inventory</h2>
  <table><thead><tr><th>Package</th><th>Version</th><th>Declared license</th></tr></thead><tbody>
${inventoryHtml}
  </tbody></table>
  <h2>License texts and attribution</h2>
${licensesHtml}
</body>
</html>
`;
}

const [driverBytes, cursorThemeBytes, cargoLockBytes] = await Promise.all([
  readFile(driverReportPath),
  readFile(cursorThemeReportPath),
  readFile(cargoLockPath),
]);
if (sha256(cargoLockBytes) !== CARGO_LOCK_SHA256) {
  throw new Error(
    "Cargo.lock does not match the reviewed Cua 0.19.3 source commit",
  );
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const recordsDirectory = path.join(repositoryRoot, "third_party", "cua-driver");
const [interLicenseBytes, cuaLicenseBytes] = await Promise.all([
  readFile(path.join(recordsDirectory, "Inter-OFL-1.1.txt")),
  readFile(path.join(recordsDirectory, "LICENSE.md")),
]);
if (sha256(interLicenseBytes) !== INTER_LICENSE_SHA256) {
  throw new Error("Inter license file differs from the reviewed OFL-1.1 text");
}
if (
  sha256(cuaLicenseBytes) !==
  "c0779290c1d4783169aa3dbfb55feb505e563ef8a004bbf55298ceffcfbda8d9"
) {
  throw new Error("Cua MIT license differs from the reviewed upstream source");
}

const driver = inspectCargoAboutReport(
  JSON.parse(driverBytes),
  "cua-driver cargo-about report",
);
const cursorTheme = inspectCargoAboutReport(
  JSON.parse(cursorThemeBytes),
  "cursor-theme cargo-about report",
);
if (driver.discovered.size !== EXPECTED_DRIVER_REGISTRY_COUNT) {
  throw new Error(
    `cua-driver report must contain ${EXPECTED_DRIVER_REGISTRY_COUNT} registry packages`,
  );
}
if (cursorTheme.discovered.size !== EXPECTED_CURSOR_THEME_REGISTRY_COUNT) {
  throw new Error(
    `cursor-theme report must contain ${EXPECTED_CURSOR_THEME_REGISTRY_COUNT} registry packages`,
  );
}
assertExactSet(
  driver.local,
  EXPECTED_DRIVER_LOCAL,
  "cua-driver local package roots",
);
assertExactSet(
  cursorTheme.local,
  EXPECTED_CURSOR_THEME_LOCAL,
  "cursor-theme local package roots",
);

const registryPackages = mergeRegistryPackages(
  driver.discovered,
  cursorTheme.discovered,
);
if (registryPackages.size !== EXPECTED_REGISTRY_UNION_COUNT) {
  throw new Error(
    `root-scoped registry union must contain ${EXPECTED_REGISTRY_UNION_COUNT} packages`,
  );
}
assertExactSet(
  [...cursorTheme.discovered.values()]
    .filter((pkg) => !driver.discovered.has(pkg.id))
    .map(packageKey),
  EXPECTED_CURSOR_THEME_ONLY,
  "cursor-theme-only registry package set",
);

const cargoLockPackages = parseCargoLock(cargoLockBytes.toString("utf8"));
const registryComponents = [...registryPackages.values()].map((pkg) =>
  registryComponent(pkg, cargoLockPackages),
);
const components = [
  ...registryComponents,
  ...TRYCUA_COMPONENTS.map(trycuaComponent),
  interComponent(),
].sort(
  (left, right) =>
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.group.localeCompare(right.group),
);
const componentReferences = new Set(
  components.map((component) => component["bom-ref"]),
);
if (componentReferences.size !== components.length)
  throw new Error("SBOM contains duplicate bom-ref values");
if (
  components.length !==
  EXPECTED_REGISTRY_UNION_COUNT + TRYCUA_COMPONENTS.length + 1
) {
  throw new Error(
    "SBOM component count is not the reviewed 330 + 8 + 1 inventory",
  );
}

const licenseRecords = mergeLicenseRecords(
  [driver.report, cursorTheme.report],
  registryPackages,
  interLicenseBytes.toString("utf8"),
);
const html = renderLicenseHtml(licenseRecords, registryPackages);

const rootReference = `pkg:generic/cua-driver-linux-x64@${RELEASE_VERSION}`;
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:3db9d425-7d84-5aca-b7eb-104d225f8561",
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": rootReference,
      name: "Cua Driver Linux x64 runtime",
      version: RELEASE_VERSION,
      licenses: [{ license: { id: "MIT" } }],
      externalReferences: [
        {
          type: "distribution",
          url: `https://github.com/trycua/cua/releases/tag/cua-driver-rs-v${RELEASE_VERSION}`,
        },
        {
          type: "vcs",
          url: `https://github.com/trycua/cua/commit/${SOURCE_COMMIT}`,
        },
      ],
      properties: [
        { name: "openmausbot:archive:sha256", value: ARCHIVE_SHA256 },
        { name: "openmausbot:cargo-lock:sha256", value: CARGO_LOCK_SHA256 },
        { name: "openmausbot:target", value: "x86_64-unknown-linux-gnu" },
        { name: "openmausbot:feature", value: "cua-driver/portal-input" },
        {
          name: "openmausbot:registry-component-count",
          value: String(EXPECTED_REGISTRY_UNION_COUNT),
        },
        {
          name: "openmausbot:trycua-component-count",
          value: String(TRYCUA_COMPONENTS.length),
        },
        {
          name: "openmausbot:file:cua-driver:sha256",
          value:
            "ed5844fadf07b9b72c4a3b3802e1c47233c166d66d6198608d5991f807aab4ac",
        },
        {
          name: "openmausbot:file:cua-cursor-theme:sha256",
          value:
            "e589b2b7521bbfeaf9e2bfce668a38e80ed1b9790b1327b13d374fc331d8312a",
        },
      ],
    },
  },
  components,
  dependencies: [
    { ref: rootReference, dependsOn: sorted(componentReferences) },
  ],
};

const registryRows = [...registryPackages.values()]
  .sort((left, right) => packageKey(left).localeCompare(packageKey(right)))
  .map((pkg) => {
    const checksum = cargoLockPackages.get(packageKey(pkg)).checksum;
    return `| ${pkg.name.replaceAll("|", "\\|")} | ${pkg.version} | ${normalizeLicense(pkg.license ?? pkg.resolvedLicense, packageKey(pkg)).replaceAll("|", "\\|")} | \`${checksum}\` |`;
  });
const trycuaRows = TRYCUA_COMPONENTS.map(
  (name) => `| ${name} | ${RELEASE_VERSION} | MIT |`,
);
const mplSourceRows = EXPECTED_MPL_COMPONENTS.map((component) => {
  const separator = component.lastIndexOf("@");
  const name = component.slice(0, separator);
  const version = component.slice(separator + 1);
  const checksum = cargoLockPackages.get(component)?.checksum;
  if (!checksum)
    throw new Error(
      `Cargo.lock has no checksum for MPL component ${component}`,
    );
  return `- [${component} source](https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download) — crate SHA-256 \`${checksum}\`;`;
});
const notices = `# Cua Driver ${RELEASE_VERSION} third-party notices

OpenMausBot redistributes two executables from the official Cua Driver ${RELEASE_VERSION} Linux x64 release: \`cua-driver\` and \`cua-cursor-theme\`.

- Upstream source commit: [\`${SOURCE_COMMIT}\`](https://github.com/trycua/cua/commit/${SOURCE_COMMIT})
- Upstream \`Cargo.lock\` SHA-256: \`${CARGO_LOCK_SHA256}\`
- Release archive SHA-256: \`${ARCHIVE_SHA256}\`
- Cua's eight workspace components remain under the accompanying MIT \`LICENSE.md\`.
- The embedded Inter ${INTER_VERSION} font remains under the accompanying SIL OFL 1.1 \`Inter-OFL-1.1.txt\`.
- Full license texts and attribution for all ${EXPECTED_REGISTRY_UNION_COUNT} crates.io packages and Inter are in \`THIRD_PARTY_LICENSES.html\`.
- The machine-readable inventory contains ${EXPECTED_REGISTRY_UNION_COUNT} registry packages, ${TRYCUA_COMPONENTS.length} Cua packages, and Inter in \`SBOM.cdx.json\`.

## MPL-2.0 source availability

The shipped build graph contains exactly the following MPL-2.0 components. Their corresponding Source Code Form is available from the versioned crates below:

${mplSourceRows.join("\n")}

The complete MPL-2.0 text and package copyright notices appear in \`THIRD_PARTY_LICENSES.html\`. These files remain under their original licenses; OpenMausBot's and Cua's MIT licenses do not replace them.

## Scope and method

The registry inventory is the union of two root-scoped \`cargo-about 0.8.4\` graphs: \`cua-driver\` with \`portal-input\` for \`x86_64-unknown-linux-gnu\`, and \`cursor-theme-cli\` for the same target. Development-only dependencies are excluded; build dependencies are retained. Raw workspace-unified Cargo metadata is not used as the inventory because features enabled only by unrelated workspace members would overstate the shipped graph.

### Cua workspace components

| Package | Version | License |
|---|---:|---|
${trycuaRows.join("\n")}

### crates.io release-build inventory

| Package | Version | Declared license expression | Crate SHA-256 |
|---|---:|---|---|
${registryRows.join("\n")}

### Embedded non-Cargo asset

| Component | Version | License | Embedded file SHA-256 | Source |
|---|---:|---|---|---|
| Inter | ${INTER_VERSION} | OFL-1.1 | \`${INTER_FONT_SHA256}\` | [Inter commit ${INTER_COMMIT.slice(0, 9)}](https://github.com/rsms/inter/commit/${INTER_COMMIT}) |
`;

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(
    path.join(outputDirectory, "SBOM.cdx.json"),
    `${JSON.stringify(bom, null, 2)}\n`,
  ),
  writeFile(path.join(outputDirectory, "THIRD_PARTY_NOTICES.md"), notices),
  writeFile(path.join(outputDirectory, "THIRD_PARTY_LICENSES.html"), html),
]);
console.log(
  `Generated CUA compliance records: ${registryPackages.size} registry + ` +
    `${TRYCUA_COMPONENTS.length} Cua + 1 Inter component; ${EXPECTED_MPL_COMPONENTS.length} MPL components.`,
);
