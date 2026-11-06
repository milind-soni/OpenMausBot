import { posix } from "node:path";
import { BRAND_FIELDS, brandSchema, type Brand, type BrandField } from "./brand-schema.ts";
import { checkImageDataUri, imageDataUri, type ImageKind } from "./fleet-brand-image.ts";
import type { FleetDeps, FleetInput } from "./fleet-cli.ts";
import { assertManagedWorkspace, assertSlug, fleetLayout, parseRegistry, type CreateBrand, type FleetLayout, type FleetRegistry, type FleetStep } from "./fleet.ts";
import type { FleetReseller } from "./fleet-reseller.ts";

const { join } = posix;

const partialBrand = brandSchema.partial().strict();
type BrandFields = Partial<Brand>;

const BRAND_FILE_MODE = 0o644;
const BRAND_DIR_MODE = 0o755;
const IMAGE_FIELDS = ["logo", "favicon"] as const satisfies readonly BrandField[];

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const defaultBrandPath = (layout: FleetLayout) => join(layout.brandsDir, "_default.json");
export const overrideBrandPath = (layout: FleetLayout, slug: string) => join(layout.brandsDir, `${slug}.override.json`);
export const workspaceBrandPath = (layout: FleetLayout, slug: string) => join(layout.brandsDir, `${slug}.json`);

function assertPublicUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${field} must be an https:// URL`);
  if (url.username || url.password) throw new Error(`${field} must not carry a user name or password`);
}

function issueText(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  return `${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "invalid"}`;
}

function parseBrandFields(value: unknown, label: string): BrandFields {
  const parsed = partialBrand.safeParse(value);
  if (!parsed.success) throw new Error(`${label}: ${issueText(parsed.error)}`);
  const fields = parsed.data;
  try {
    if (fields.supportUrl !== undefined) assertPublicUrl(fields.supportUrl, "supportUrl");
    for (const field of IMAGE_FIELDS) {
      const image = fields[field];
      if (image === undefined) continue;
      if (image.startsWith("data:")) checkImageDataUri(image, field, field);
      else assertPublicUrl(image, field);
    }
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fields;
}

function parseBrandJson(text: string, label: string): BrandFields {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return parseBrandFields(value, label);
}

function readBrandFields(deps: Pick<FleetDeps, "readText">, path: string): BrandFields {
  const text = deps.readText(path);
  return text === null || !text.trim() ? {} : parseBrandJson(text, path);
}

export function effectiveBrand(reseller: Pick<FleetReseller, "name">, brandDefault: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return { name: reseller.name, ...brandDefault, ...override };
}

function mergedBrand(reseller: FleetReseller, brandDefault: BrandFields, override: BrandFields, label: string): Brand {
  const merged = brandSchema.safeParse(effectiveBrand(reseller, brandDefault, override));
  if (!merged.success) throw new Error(`${label}: ${issueText(merged.error)}`);
  return merged.data;
}

const writeBrand = (path: string, value: unknown): FleetStep => ({ kind: "write", path, content: json(value), mode: BRAND_FILE_MODE });

export function resolveCreateBrandJson(input: Pick<FleetInput, "brandFile" | "brandJson"> & { registry: FleetRegistry }, deps: Pick<FleetDeps, "readText">): string | undefined {
  if (input.registry.reseller) return undefined;
  const brandJson = input.brandJson ?? (input.brandFile ? deps.readText(input.brandFile) : undefined);
  if (input.brandFile && brandJson === null) throw new Error(`${input.brandFile} not found`);
  if (brandJson) JSON.parse(brandJson);
  return brandJson ?? undefined;
}

function signInMailEnv(smtp: NonNullable<FleetReseller["smtp"]>, deps: Pick<FleetDeps, "readText">): string[] {
  const url = deps.readText(smtp.urlFile)?.trim();
  if (!url) throw new Error(`reseller.smtp.urlFile ${smtp.urlFile} is missing or empty`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${smtp.urlFile} does not hold an SMTP address such as smtps://user:password@smtp.example.com:465`);
  }
  if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") throw new Error(`${smtp.urlFile} must hold an smtp:// or smtps:// address`);
  if (/[\s"'\\]/.test(url)) throw new Error(`${smtp.urlFile} must not contain spaces, quotes or backslashes: percent-encode the user name and password`);
  if (/["'\\]/.test(smtp.from)) throw new Error("reseller.smtp.from must not contain quotes or backslashes");
  return [`OMB_SIGNIN_SMTP_URL=${url}`, `OMB_SIGNIN_SMTP_FROM=${smtp.from}`];
}

export function planCreateBrand(input: Pick<FleetInput, "brandFile" | "brandJson"> & { registry: FleetRegistry; layout: FleetLayout; slug: string }, deps: Pick<FleetDeps, "readText">): CreateBrand {
  const reseller = input.registry.reseller;
  if (!reseller) return { steps: [], env: [] };
  const raw = input.brandJson ?? (input.brandFile ? deps.readText(input.brandFile) : undefined);
  if (input.brandFile && raw === null) throw new Error(`${input.brandFile} not found`);
  const override = raw?.trim() ? parseBrandJson(raw, input.brandFile ?? "brand") : {};
  const brandDefault = readBrandFields(deps, defaultBrandPath(input.layout));
  const merged = mergedBrand(reseller, brandDefault, override, input.slug);
  const brandFile = workspaceBrandPath(input.layout, input.slug);
  return {
    steps: [
      { kind: "mkdir", path: input.layout.brandsDir, mode: BRAND_DIR_MODE },
      writeBrand(overrideBrandPath(input.layout, input.slug), override),
      writeBrand(brandFile, merged),
    ],
    env: [`OMB_BRAND_FILE=${brandFile}`, ...(reseller.smtp ? signInMailEnv(reseller.smtp, deps) : [])],
  };
}

export function brandCreateNotes(input: { registry: FleetRegistry; licenseKey?: string }): string[] {
  const reseller = input.registry.reseller;
  if (!reseller) return [];
  return [
    ...(input.licenseKey ? [] : [`no licence key was given: ${reseller.name}'s brand applies only on a workspace whose key grants whitelabel (pass --license-key-file)`]),
    ...(reseller.smtp ? [] : [`warning: sign-in codes go through the OpenMausBot account service, not ${reseller.name}'s own mail; set reseller.smtp in fleet.json, or give each admin access with \`openmausbot pair\` on the server`]),
  ];
}

interface BrandChange {
  set: BrandFields;
  clear: BrandField[];
}

function imageSource(deps: Pick<FleetDeps, "readBytes">, field: ImageKind, source: string): string {
  if (source.startsWith("data:")) return source;
  if (/^https:\/\//i.test(source)) {
    if (field === "favicon") throw new Error("--favicon takes an image file; an https:// address is not fetched");
    return source;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new Error(`--${field} takes an image file${field === "logo" ? " or an https:// address" : ""}`);
  if (!deps.readBytes) throw new Error("this fleet cannot read an image file; pass a data:image/... URI");
  const bytes = deps.readBytes(source);
  if (bytes === null) throw new Error(`${source} not found`);
  return imageDataUri(bytes, field, source);
}

function brandChange(input: FleetInput, deps: Pick<FleetDeps, "readBytes">): BrandChange {
  const set: BrandFields = {};
  for (const [field, value] of Object.entries(input.brandPatch ?? {})) if (value !== undefined) Object.assign(set, { [field]: value });
  if (input.logoSource !== undefined) set.logo = imageSource(deps, "logo", input.logoSource);
  if (input.faviconSource !== undefined) set.favicon = imageSource(deps, "favicon", input.faviconSource);
  const clear = [...new Set(input.brandClear ?? [])];
  const both = clear.find((field) => set[field] !== undefined);
  if (both) throw new Error(`${both} is both set and cleared in one command`);
  return { set, clear };
}

function applyChange(current: BrandFields, change: BrandChange, label: string): BrandFields {
  const next: Record<string, unknown> = { ...current, ...change.set };
  for (const field of change.clear) delete next[field];
  return parseBrandFields(next, label);
}

export function brandFieldsTouched(input: Pick<FleetInput, "brandPatch" | "brandClear" | "logoSource" | "faviconSource">): string[] {
  const set = Object.entries(input.brandPatch ?? {}).filter(([, value]) => value !== undefined).map(([field]) => field);
  return [...set, ...(input.logoSource !== undefined ? ["logo"] : []), ...(input.faviconSource !== undefined ? ["favicon"] : []), ...(input.brandClear ?? []).map((field) => `-${field}`)];
}

function readRegistry(layout: FleetLayout, deps: Pick<FleetDeps, "readText">): FleetRegistry {
  const text = deps.readText(layout.registryFile);
  if (text === null) throw new Error("no fleet on this server yet: run `openmausbot fleet init --domain your.domain` first");
  return parseRegistry(text);
}

function staleEnvNote(layout: FleetLayout, slug: string, deps: Pick<FleetDeps, "readText">): FleetStep[] {
  const env = deps.readText(join(layout.instancesDir, `${slug}.env`));
  if (env === null || env.split("\n").some((line) => line.startsWith("OMB_BRAND_FILE="))) return [];
  return [{ kind: "note", text: `${slug} was created before this fleet had a reseller, so it does not read the brand file; recreate it to apply the brand` }];
}

export function planFleetBrand(input: FleetInput, deps: FleetDeps): FleetStep[] {
  const layout = fleetLayout(input.root ?? "/");
  const registry = readRegistry(layout, deps);
  const reseller = registry.reseller;
  if (!reseller) throw new Error("fleet brand needs a reseller: run `openmausbot fleet init --domain your.domain --reseller-name NAME --yes` first");
  if (input.brandDefault && input.slug) throw new Error("fleet brand takes a workspace name or --default, not both");
  const change = brandChange(input, deps);

  if (input.brandDefault) {
    const brandDefault = applyChange(readBrandFields(deps, defaultBrandPath(layout)), change, "default brand");
    const workspaces = Object.values(registry.workspaces).sort((a, b) => a.slug.localeCompare(b.slug));
    const managed = workspaces.filter((workspace) => workspace.status === "running" || workspace.status === "suspended");
    const merged = managed.map((workspace) => ({ workspace, brand: mergedBrand(reseller, brandDefault, readBrandFields(deps, overrideBrandPath(layout, workspace.slug)), workspace.slug) }));
    return [
      { kind: "mkdir", path: layout.brandsDir, mode: BRAND_DIR_MODE },
      writeBrand(defaultBrandPath(layout), brandDefault),
      ...merged.map(({ workspace, brand }) => writeBrand(workspaceBrandPath(layout, workspace.slug), brand)),
      ...merged.flatMap(({ workspace }) => staleEnvNote(layout, workspace.slug, deps)),
      ...workspaces.filter((workspace) => !managed.includes(workspace)).map((workspace): FleetStep => ({ kind: "note", text: `skipped ${workspace.slug}: it is ${workspace.status}; run \`openmausbot fleet brand ${workspace.slug}\` once it is running again` })),
      { kind: "note", text: `default brand saved and applied to ${merged.length} workspace${merged.length === 1 ? "" : "s"}; open pages show it on their next reload, no restart needed` },
    ];
  }

  if (!input.slug) throw new Error("fleet brand needs a workspace name or --default");
  assertSlug(input.slug);
  const workspace = registry.workspaces[input.slug];
  if (!workspace) throw new Error(`no workspace "${input.slug}"`);
  assertManagedWorkspace(workspace);
  const override = applyChange(readBrandFields(deps, overrideBrandPath(layout, input.slug)), change, input.slug);
  const brand = mergedBrand(reseller, readBrandFields(deps, defaultBrandPath(layout)), override, input.slug);
  return [
    { kind: "mkdir", path: layout.brandsDir, mode: BRAND_DIR_MODE },
    writeBrand(overrideBrandPath(layout, input.slug), override),
    writeBrand(workspaceBrandPath(layout, input.slug), brand),
    ...staleEnvNote(layout, input.slug, deps),
    { kind: "note", text: `${input.slug} now shows "${brand.name}"; an open page shows it on its next reload, no restart needed` },
  ];
}

const OMITTED = (bytes: number) => `(image of about ${Math.round(bytes * 0.75)} bytes left out of this listing)`;

/** Drops the images from a view that may be logged or listed: they can be hundreds of kilobytes each. */
export function omitBrandAssets<T extends object>(view: T): T {
  const copy = { ...view } as Record<string, unknown>;
  for (const field of IMAGE_FIELDS) delete copy[field];
  if (isRecord(copy.brand)) {
    const brand = { ...copy.brand };
    for (const field of IMAGE_FIELDS) delete brand[field];
    copy.brand = brand;
  }
  return copy as T;
}

const SMTP_LINE = /^(OMB_SIGNIN_SMTP_URL=).*$/m;

/** A plan that is printed must not carry brand images (hundreds of kilobytes each) or the mail relay's password. */
export function redactPrintedSteps(steps: FleetStep[]): FleetStep[] {
  return steps.map((step) => {
    if (step.kind !== "write") return step;
    if (SMTP_LINE.test(step.content)) return { ...step, content: step.content.replace(SMTP_LINE, "$1(read from the reseller's SMTP file when this runs)") };
    if (posix.basename(posix.dirname(step.path)) !== "brands") return step;
    let value: unknown;
    try {
      value = JSON.parse(step.content);
    } catch {
      return step;
    }
    if (!isRecord(value)) return step;
    const shown: Record<string, unknown> = { ...value };
    for (const field of IMAGE_FIELDS) {
      const image = shown[field];
      if (typeof image === "string" && image.startsWith("data:")) shown[field] = OMITTED(image.length);
    }
    return { ...step, content: json(shown) };
  });
}

const BODY_FIELDS = ["name", "tagline", "accent", "supportUrl", "logo", "favicon", "clear"];

const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

/** A request carries images as data URIs only: the root agent never opens a path or fetches an address. */
export function brandInputFromBody(base: FleetInput, body: Record<string, unknown>, slug: string | undefined): FleetInput {
  for (const key of Object.keys(body)) if (!BODY_FIELDS.includes(key)) throw badRequest(`unknown brand field "${key.slice(0, 40)}"`);
  const textOf = (field: string): string | undefined => {
    const value = body[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw badRequest(`${field} must be a string`);
    return value;
  };
  const imageOf = (field: ImageKind): string | undefined => {
    const value = textOf(field);
    if (value !== undefined && !value.startsWith("data:image/")) throw badRequest(`${field} must be an inline data:image/... URI`);
    return value;
  };
  const clear = body.clear;
  if (clear !== undefined && (!Array.isArray(clear) || clear.some((field) => !BRAND_FIELDS.includes(field as BrandField)))) throw badRequest(`clear must list some of ${BRAND_FIELDS.join(", ")}`);
  const patch = { name: textOf("name"), tagline: textOf("tagline"), accent: textOf("accent"), supportUrl: textOf("supportUrl") };
  const logo = imageOf("logo");
  const favicon = imageOf("favicon");
  return {
    ...base,
    action: "brand",
    slug,
    brandDefault: slug === undefined,
    brandPatch: Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    ...(clear ? { brandClear: clear as BrandField[] } : {}),
    ...(logo !== undefined ? { logoSource: logo } : {}),
    ...(favicon !== undefined ? { faviconSource: favicon } : {}),
  };
}
