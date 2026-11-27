// Writes product.json's app name, app id and update source into electron-builder.yml, and the app name into the web
// app manifest, the first pages' titles and the phone protocol's name file, then regenerates shared/settings-places.ts, whose English names the
// product.
//
//   node scripts/product.mjs           rewrite both
//   node scripts/product.mjs --check   fail when either does not match product.json
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "electron-builder.yml");
const MANIFEST = join(ROOT, "public", "manifest.webmanifest");
const PHONE_NAME = join(ROOT, "packages", "phone-protocol", "src", "product-name.ts");
const PAGES = ["index.html", "rail.html"].map((page) => join(ROOT, page));
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

/** A Windows checkout carries CRLF; every pattern here is written for LF. */
const lf = (text) => text.replace(/\r\n/g, "\n");

const field = (yaml, key) => yaml.match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
const publishField = (yaml, key) => yaml.match(new RegExp(`^publish:\\n(?:  .*\\n)*?    ${key}: (.+)$`, "m"))?.[1];

/** electron-builder.yml as product.json says it should read. The previous app name is replaced wherever it appears, so
 * installer names, usage descriptions and helper paths follow it. */
export function applyProduct(text, product) {
  const yaml = lf(text);
  const previous = field(yaml, "productName");
  if (!previous) throw new Error("electron-builder.yml has no productName");
  let next = previous === product.appName ? yaml : yaml.split(previous).join(product.appName);
  next = next.replace(/^appId: .+$/m, `appId: ${product.appId}`);
  next = next.replace(/^(publish:\n(?:  .*\n)*?    owner: ).+$/m, `$1${product.updates.owner}`);
  next = next.replace(/^(publish:\n(?:  .*\n)*?    repo: ).+$/m, `$1${product.updates.repo}`);
  return next;
}

export function checkProduct(text, product) {
  const yaml = lf(text);
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

/** The web app manifest with product.json's app name; the rest of it is kept as written. */
export function applyManifest(text, product) {
  const name = JSON.stringify(product.appName);
  return lf(text).replace(/^(\s*"name": )".*?"(,?)$/m, `$1${name}$2`).replace(/^(\s*"short_name": )".*?"(,?)$/m, `$1${name}$2`);
}

export function checkManifest(text, product) {
  const manifest = JSON.parse(text);
  return ["name", "short_name"].filter((key) => manifest[key] !== product.appName)
    .map((key) => `manifest ${key} is ${manifest[key] ?? "missing"}, product.json says ${product.appName}`);
}

/** The phone protocol package names the product without reaching outside itself, so its one line is written here. */
export function phoneNameFile(product) {
  return `// Written by scripts/product.mjs from product.json; run pnpm product:apply.\nexport const PRODUCT_NAME = ${JSON.stringify(product.name)};\n`;
}

/** A page that opens before the app has its own title, named by product.json. */
export function applyPage(html, product) {
  return html.replace(/<title>.*?<\/title>/, `<title>${product.name}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=)".*?"/, `$1${JSON.stringify(product.appName)}`);
}

const readOr = (file, fallback) => { try { return readFileSync(file, "utf8"); } catch { return fallback; } };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const product = readProduct();
  const yaml = readFileSync(BUILDER, "utf8");
  const manifest = readFileSync(MANIFEST, "utf8");
  if (process.argv.includes("--check")) {
    const problems = [...checkProduct(yaml, product), ...checkManifest(manifest, product),
      ...(readOr(PHONE_NAME, "") === phoneNameFile(product) ? [] : ["packages/phone-protocol/src/product-name.ts does not name product.json's product"]),
      ...PAGES.filter((page) => { const html = readFileSync(page, "utf8"); return applyPage(html, product) !== html; })
        .map((page) => `${page.slice(ROOT.length + 1)} does not carry product.json's name`)];
    if (problems.length) {
      console.error(`electron-builder.yml or the web app manifest does not match product.json (run pnpm product:apply):\n${problems.map((p) => `- ${p}`).join("\n")}`);
      process.exit(1);
    }
    console.log("electron-builder.yml and the web app manifest match product.json");
  } else {
    const next = applyProduct(yaml, product);
    if (next !== yaml) writeFileSync(BUILDER, next);
    const nextManifest = applyManifest(manifest, product);
    if (nextManifest !== manifest) writeFileSync(MANIFEST, nextManifest);
    const phone = phoneNameFile(product), phoneBefore = readOr(PHONE_NAME, "");
    if (phone !== phoneBefore) writeFileSync(PHONE_NAME, phone);
    for (const page of PAGES) {
      const html = readFileSync(page, "utf8");
      if (applyPage(html, product) !== html) writeFileSync(page, applyPage(html, product));
    }
    execFileSync(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "gen-settings-places.ts")], { stdio: "inherit" });
    console.log(next === yaml && nextManifest === manifest && phone === phoneBefore ? "already matches product.json" : "updated from product.json");
  }
}
