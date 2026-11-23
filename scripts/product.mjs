// Writes product.json's app name, app id and update source into electron-builder.yml.
//
//   node scripts/product.mjs           rewrite electron-builder.yml
//   node scripts/product.mjs --check   fail when it does not match product.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "electron-builder.yml");
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,48}[A-Za-z0-9]$/;
const APP_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function readProduct(file = join(ROOT, "product.json")) {
  const product = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  if (typeof product.name !== "string" || !product.name.trim()) problems.push("name must be a non-empty string");
  if (typeof product.appName !== "string" || !APP_NAME.test(product.appName)) problems.push("appName must be letters, digits, spaces, dots or dashes");
  if (typeof product.appId !== "string" || !APP_ID.test(product.appId)) problems.push("appId must be reverse-DNS, like com.example.app");
  if (!GITHUB_NAME.test(product.updates?.owner ?? "") || !GITHUB_NAME.test(product.updates?.repo ?? "")) problems.push("updates.owner and updates.repo must name a GitHub repository");
  if (problems.length) throw new Error(`product.json: ${problems.join("; ")}`);
  return product;
}

const field = (yaml, key) => yaml.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
const publishField = (yaml, key) => yaml.match(new RegExp(`^publish:\\n(?:  .*\\n)*?    ${key}: (.+)$`, "m"))?.[1];

/** electron-builder.yml as product.json says it should read. The previous app name is replaced wherever it appears, so
 * installer names, usage descriptions and helper paths follow it. */
export function applyProduct(yaml, product) {
  const previous = field(yaml, "productName");
  if (!previous) throw new Error("electron-builder.yml has no productName");
  let next = previous === product.appName ? yaml : yaml.split(previous).join(product.appName);
  next = next.replace(/^appId: .+$/m, `appId: ${product.appId}`);
  next = next.replace(/^(publish:\n(?:  .*\n)*?    owner: ).+$/m, `$1${product.updates.owner}`);
  next = next.replace(/^(publish:\n(?:  .*\n)*?    repo: ).+$/m, `$1${product.updates.repo}`);
  return next;
}

export function checkProduct(yaml, product) {
  const expected = {
    productName: product.appName,
    appId: product.appId,
    "publish owner": product.updates.owner,
    "publish repo": product.updates.repo,
  };
  const actual = {
    productName: field(yaml, "productName"),
    appId: field(yaml, "appId"),
    "publish owner": publishField(yaml, "owner"),
    "publish repo": publishField(yaml, "repo"),
  };
  return Object.keys(expected).filter((key) => expected[key] !== actual[key])
    .map((key) => `${key} is ${actual[key] ?? "missing"}, product.json says ${expected[key]}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const product = readProduct();
  const yaml = readFileSync(BUILDER, "utf8");
  if (process.argv.includes("--check")) {
    const problems = checkProduct(yaml, product);
    if (problems.length) {
      console.error(`electron-builder.yml does not match product.json (run pnpm product:apply):\n${problems.map((p) => `- ${p}`).join("\n")}`);
      process.exit(1);
    }
    console.log("electron-builder.yml matches product.json");
  } else {
    const next = applyProduct(yaml, product);
    if (next !== yaml) writeFileSync(BUILDER, next);
    console.log(next === yaml ? "electron-builder.yml already matches product.json" : "electron-builder.yml updated from product.json");
  }
}
