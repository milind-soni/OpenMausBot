// A template folder, the one format a shared bot or department travels in:
//   bot.md | team.md            BotMRR Markdown v2: YAML frontmatter with the package fields, and a readable body
//   skills/<name>/SKILL.md      each skill the frontmatter names
//   skills/<name>/<path>        the text files beside it that the frontmatter's skillFiles names
//   avatars/<key>.<png|jpg|webp> each picture the frontmatter names
//   README.md                   optional, for people browsing GitHub; never read back
// Pure (no node:*): the server, the renderer and the Admin's submission check read folders with the same rules, and
// parsePackageDocument with trust "file" stays the only gate.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  AVATAR_MAX_BYTES,
  BOTMRR_FOLDER_VERSION,
  decodeBase64,
  PACKAGE_FORMAT,
  PACKAGE_MAX_BYTES,
  PackageFormatError,
  packageVersionFor,
  parsePackageDocument,
  utf8Bytes,
  type PackageDocument,
} from "./package-format.ts";
import type { TemplateScope } from "./share-card.ts";
import { skillFilePathProblem, type SkillFile } from "./skill-files.ts";
import { isSkillName, parseSkillMd, SKILL_FILE_MAX_BYTES } from "./skill-md.ts";

export type ShareFolderFiles = Record<string, string | Uint8Array>;

export const SHARE_FOLDER_MAX_FILES = 300;
/** All files together, before any parsing: a little over the package cap, since pictures are larger in base64. */
export const SHARE_FOLDER_MAX_BYTES = PACKAGE_MAX_BYTES + 1024 * 1024;
export const MANIFEST_NAMES = { bot: "bot.md", department: "team.md" } as const satisfies Record<TemplateScope, string>;
/** Older shapes a folder or repository may hold instead of bot.md or team.md. */
const LEGACY_MARKDOWN = "botmrr.md", LEGACY_MANIFEST = "team.mausteam.json";

const PICTURE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as const;
const PICTURE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const SKILL_PATH = /^skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/;
const PICTURE_PATH = /^avatars\/([a-z0-9][a-z0-9_-]{0,63})\.(png|jpg|jpeg|webp)$/;
const SKILL_FILE_PATH = /^skills\/([a-z0-9][a-z0-9-]{0,63})\/(.+)$/;

/** A file beside a skill's SKILL.md: skills/<name>/<path>, with a path a skill folder can hold. */
export function isSkillFilePath(path: string): boolean {
  const match = path.match(SKILL_FILE_PATH);
  return Boolean(match) && match![2] !== "SKILL.md" && skillFilePathProblem(match![2]!) === null;
}

export type ShareFolder =
  | { kind: "package"; scope: TemplateScope; document: PackageDocument }
  /** A legacy team.mausteam.json, parsed by the server's team manifest reader. */
  | { kind: "manifest"; manifest: unknown };

const refuse = (message: string) => new PackageFormatError("invalid", message);

/** A relative path inside a folder: no absolute paths, no "..", no backslashes, no hidden files. */
export function safeFolderPath(path: string): string | null {
  const clean = path.replace(/^\.\//, "");
  if (!clean || clean.length > 300 || clean.startsWith("/") || clean.includes("\\") || clean.includes("\0")) return null;
  const parts = clean.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith(".")) ? clean : null;
}

/** Whether the reader ever opens this path: the manifest, a skill, a file beside one or a picture. Everything else in a
 * folder is ignored. */
export function isShareFolderPath(path: string): boolean {
  return path === MANIFEST_NAMES.bot || path === MANIFEST_NAMES.department || path === LEGACY_MARKDOWN || path === LEGACY_MANIFEST ||
    /^[\w.-]+\.openmaus\.json$/.test(path) || SKILL_PATH.test(path) || PICTURE_PATH.test(path) || isSkillFilePath(path);
}

function textOf(value: string | Uint8Array | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: false }).decode(value);
}

function bytesOf(value: string | Uint8Array): Uint8Array | null {
  if (typeof value !== "string") return value;
  const data = value.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  return data ? decodeBase64(data[1]!) : null;
}

/** The skill files the folder's bot.md or team.md names: only those are read, or counted against the folder's caps. */
function namedSkillFiles(files: ReadonlyArray<readonly [string, string | Uint8Array]>): Set<string> {
  const manifest = files.find(([path]) => path === MANIFEST_NAMES.bot || path === MANIFEST_NAMES.department)?.[1];
  if (manifest === undefined) return new Set();
  try {
    return new Set(namedFolderFiles(textOf(manifest)!).filter(isSkillFilePath));
  } catch {
    return new Set();
  }
}

/** The folder's files keyed by their path inside it: a single top folder (a browser's folder upload, a saved folder
 * picked one level up) is looked through. Unsafe paths and files the reader never opens are dropped. */
export function normalizeShareFolder(files: ShareFolderFiles): ShareFolderFiles {
  const entries = Object.entries(files);
  if (entries.length > SHARE_FOLDER_MAX_FILES * 4) throw refuse("This folder has too many files to be a template.");
  const safe = entries.flatMap(([path, value]) => {
    const clean = safeFolderPath(path);
    return clean ? [[clean, value] as const] : [];
  });
  const atRoot = (path: string) => isShareFolderPath(path) && !path.includes("/") ;
  let prefix = "";
  if (!safe.some(([path]) => atRoot(path))) {
    const tops = new Set(safe.map(([path]) => path.split("/")[0]!));
    const top = tops.size === 1 ? [...tops][0]! : "";
    if (top && safe.some(([path]) => path.includes("/") && atRoot(path.slice(top.length + 1)))) prefix = `${top}/`;
  }
  const inside = safe.flatMap(([path, value]) => (path.startsWith(prefix) && isShareFolderPath(path.slice(prefix.length)) ? [[path.slice(prefix.length), value] as const] : []));
  const named = namedSkillFiles(inside);
  const kept: ShareFolderFiles = {};
  let total = 0, count = 0;
  for (const [inner, value] of inside) {
    if (isSkillFilePath(inner) && !named.has(inner)) continue;
    total += typeof value === "string" ? utf8Bytes(value) : value.byteLength;
    if (++count > SHARE_FOLDER_MAX_FILES) throw refuse("This folder has too many files to be a template.");
    if (total > SHARE_FOLDER_MAX_BYTES) throw new PackageFormatError("too_large", "This folder is larger than 4 MB.");
    kept[inner] = value;
  }
  return kept;
}

function frontmatterOf(markdown: string): { metadata: Record<string, unknown> } {
  if (utf8Bytes(markdown) > PACKAGE_MAX_BYTES) throw new PackageFormatError("too_large", "This template is larger than 4 MB.");
  const match = markdown.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new PackageFormatError("not_a_package", "This Markdown is missing YAML frontmatter");
  let metadata: unknown;
  try {
    metadata = parseYaml(match[1]!, { maxAliasCount: 0 });
  } catch {
    throw new PackageFormatError("not_a_package", "This Markdown has invalid YAML frontmatter");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new PackageFormatError("not_a_package", "This Markdown is missing its template fields");
  return { metadata: metadata as Record<string, unknown> };
}

/** The skill's own files the frontmatter names, each required. Their rules are the package gate's (skillFilesSchema). */
function folderSkillFiles(files: ShareFolderFiles, name: string, listed: unknown): SkillFile[] | undefined {
  if (listed === undefined) return undefined;
  if (!Array.isArray(listed) || listed.some((path) => typeof path !== "string")) throw refuse(`skillFiles for ${name} must be a list of paths.`);
  return (listed as string[]).map((path) => {
    const text = textOf(files[`skills/${name}/${path}`]);
    if (text === undefined) throw refuse(`This template names skills/${name}/${path.slice(0, 120)}, but the file is missing.`);
    return { path, content: text };
  });
}

function folderSkill(files: ShareFolderFiles, name: unknown, listed?: unknown) {
  if (typeof name !== "string" || !isSkillName(name)) throw refuse(`A skill name in this template is not valid: ${String(name).slice(0, 80)}`);
  const text = textOf(files[`skills/${name}/SKILL.md`]);
  if (text === undefined) throw refuse(`This template names the skill ${name}, but skills/${name}/SKILL.md is missing.`);
  if (utf8Bytes(text) > SKILL_FILE_MAX_BYTES) throw new PackageFormatError("too_large", `skills/${name}/SKILL.md is larger than 256 KB.`);
  const parsed = parseSkillMd(text);
  if ("error" in parsed) throw refuse(`skills/${name}/SKILL.md: ${parsed.error}`);
  if (parsed.name !== name) throw refuse(`skills/${name}/SKILL.md is named ${parsed.name} inside.`);
  const beside = folderSkillFiles(files, name, listed);
  return {
    name, description: parsed.description, instructions: text,
    ...(parsed.license ? { license: parsed.license } : {}), ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
    ...(beside?.length ? { files: beside } : {}),
  };
}

function folderPicture(files: ShareFolderFiles, value: unknown, crop: unknown) {
  if (typeof value !== "string") return value;
  const match = value.match(PICTURE_PATH);
  if (!match) throw refuse(`A picture in this template must be avatars/<name>.png, .jpg or .webp: ${value.slice(0, 80)}`);
  const raw = files[value];
  if (raw === undefined) throw refuse(`This template names the picture ${value}, but the file is missing.`);
  const bytes = bytesOf(raw);
  if (!bytes) throw refuse(`${value} could not be read as a picture.`);
  if (bytes.byteLength > AVATAR_MAX_BYTES) throw new PackageFormatError("too_large", `${value} is larger than 64 KB.`);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { mime: PICTURE_TYPES[match[2] as keyof typeof PICTURE_TYPES], data: btoa(binary), crop: crop === "rounded" || crop === "square" ? crop : "circle" };
}

const FOLDER_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** What a folder may leave out: the folder's name is its id, a first release is 1.0.0, and a department is named
 * after the template. */
function withFolderDefaults(definition: Record<string, unknown>, slug: string | undefined): Record<string, unknown> {
  const name = typeof definition.name === "string" ? definition.name.trim() : "";
  const team = definition.team && typeof definition.team === "object" && !Array.isArray(definition.team) ? definition.team as Record<string, unknown> : null;
  return {
    ...definition,
    ...(definition.id === undefined && slug && FOLDER_SLUG.test(slug) ? { id: slug } : {}),
    ...(definition.release === undefined ? { release: "1.0.0" } : {}),
    ...(team && team.name === undefined && name ? { team: { ...team, name: name.slice(0, 60).trim() } } : {}),
  };
}

function packageFromFolder(metadata: Record<string, unknown>, files: ShareFolderFiles, slug: string | undefined): unknown {
  const { botmrr: _version, skills: skillNames, skillFiles, ...given } = metadata;
  const definition = withFolderDefaults(given, slug);
  const listedFiles = (skillFiles && typeof skillFiles === "object" && !Array.isArray(skillFiles) ? skillFiles : {}) as Record<string, unknown>;
  const agents = Array.isArray(definition.agents) ? definition.agents : [];
  const named = new Set<unknown>(Array.isArray(skillNames) ? skillNames : []);
  for (const agent of agents) {
    const skills = (agent as { skills?: unknown })?.skills;
    if (Array.isArray(skills)) for (const name of skills) named.add(name);
  }
  const entries = [...named].map((name) => folderSkill(files, name, typeof name === "string" && Object.hasOwn(listedFiles, name) ? listedFiles[name] : undefined));
  const withPictures = agents.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const agent = raw as Record<string, unknown>;
    const appearance = agent.appearance as Record<string, unknown> | undefined;
    if (!appearance || typeof appearance !== "object" || appearance.avatar === undefined) return agent;
    const { avatar, avatarCrop, ...look } = appearance;
    return { ...agent, appearance: { ...look, avatar: folderPicture(files, avatar, avatarCrop) } };
  });
  const pkg = { ...definition, agents: withPictures, ...(entries.length ? { skills: { version: 1, entries } } : {}) };
  return { format: PACKAGE_FORMAT, version: packageVersionFor(pkg), package: pkg };
}

/** Reads a template folder through the package gate (trust "file"). `slug` is the folder's name, when it has one.
 * Throws PackageFormatError with a sentence. */
export function readShareFolder(input: ShareFolderFiles, slug?: string): ShareFolder {
  const files = normalizeShareFolder(input);
  const bot = textOf(files[MANIFEST_NAMES.bot]), team = textOf(files[MANIFEST_NAMES.department]);
  if (bot !== undefined && team !== undefined) throw refuse("A template folder holds bot.md or team.md, not both.");
  const manifest = bot ?? team;
  if (manifest !== undefined) {
    const scope: TemplateScope = bot !== undefined ? "bot" : "department";
    const { metadata } = frontmatterOf(manifest);
    if (metadata.botmrr === 1) return { kind: "package", scope, document: parsePackageDocument(manifest, { trust: "file" }) };
    if (metadata.botmrr !== BOTMRR_FOLDER_VERSION) throw new PackageFormatError("unsupported_version", "This template was made by a newer MausBot. Update the app, then import it again.");
    return { kind: "package", scope, document: parsePackageDocument(packageFromFolder(metadata, files, slug), { trust: "file" }) };
  }
  const legacy = textOf(files[LEGACY_MARKDOWN]);
  if (legacy !== undefined) return { kind: "package", scope: "department", document: parsePackageDocument(legacy, { trust: "file" }) };
  const json = Object.keys(files).find((path) => path === LEGACY_MANIFEST || path.endsWith(".openmaus.json"));
  if (json) {
    let value: unknown;
    try {
      value = JSON.parse(textOf(files[json])!);
    } catch {
      throw new PackageFormatError("not_a_package", `${json} is not valid JSON.`);
    }
    const isPackage = Boolean(value) && typeof value === "object" && (value as { format?: unknown }).format === PACKAGE_FORMAT;
    return isPackage ? { kind: "package", scope: "department", document: parsePackageDocument(value, { trust: "file" }) } : { kind: "manifest", manifest: value };
  }
  throw new PackageFormatError("not_a_package", "This folder has no bot.md or team.md.");
}

/** The paths a manifest names besides itself: its skills, their files and its pictures, the only files a reader opens. */
export function namedFolderFiles(manifest: string): string[] {
  const { metadata } = frontmatterOf(manifest);
  if (metadata.botmrr !== BOTMRR_FOLDER_VERSION) return [];
  const names = new Set<string>();
  const add = (name: unknown) => { if (typeof name === "string" && isSkillName(name)) names.add(`skills/${name}/SKILL.md`); };
  if (Array.isArray(metadata.skills)) metadata.skills.forEach(add);
  for (const agent of Array.isArray(metadata.agents) ? metadata.agents : []) {
    const record = (agent && typeof agent === "object" ? agent : {}) as { skills?: unknown; appearance?: { avatar?: unknown } };
    if (Array.isArray(record.skills)) record.skills.forEach(add);
    const picture = record.appearance?.avatar;
    if (typeof picture === "string" && PICTURE_PATH.test(picture)) names.add(picture);
  }
  const listed = metadata.skillFiles && typeof metadata.skillFiles === "object" && !Array.isArray(metadata.skillFiles) ? metadata.skillFiles as Record<string, unknown> : {};
  for (const [skill, paths] of Object.entries(listed)) {
    if (!names.has(`skills/${skill}/SKILL.md`) || !Array.isArray(paths)) continue;
    for (const path of paths) if (typeof path === "string" && isSkillFilePath(`skills/${skill}/${path}`)) names.add(`skills/${skill}/${path}`);
  }
  return [...names].slice(0, SHARE_FOLDER_MAX_FILES);
}

const bullet = (lines: string[], none: string) => (lines.length ? lines.map((line) => `- ${line}`).join("\n") : none);

function readableBody(document: PackageDocument, scope: TemplateScope): string {
  const pkg = document.package;
  const leader = pkg.agents.find((agent) => agent.key === pkg.team?.leader);
  const bots = pkg.agents.map((agent) => [
    `### ${agent.name}${agent.title ? ` (${agent.title})` : ""}`,
    agent.description ?? "",
    agent.soul ?? "",
    agent.skills?.length ? `Skills: ${agent.skills.join(", ")}` : "",
  ].filter(Boolean).join("\n\n"));
  return [
    `# ${pkg.name}`,
    pkg.tagline,
    "## Activation",
    `Add this ${scope === "bot" ? "bot" : "department"} in MausBot with + → Import… and this folder's link, or give this file and its skills folder to any AI agent and ask it to work as ${scope === "bot" ? "this bot" : "these bots"}.`,
    "## Mission",
    pkg.summary,
    ...(pkg.team?.brief ? ["### Department brief", pkg.team.brief] : []),
    "## Outcomes",
    bullet(pkg.outcomes, "None listed."),
    "## Connections",
    bullet(pkg.requirements.apps.map((app) => `${app.label}: ${app.reason}`), "None. Each person connects their own accounts."),
    "## Team",
    bots.join("\n\n"),
    "## Chief of Staff",
    leader ? leader.name : "None.",
    "## Routines",
    bullet((pkg.routines ?? []).map((routine) => `${routine.name} (paused until you turn it on): ${routine.prompt.split("\n")[0]!.slice(0, 200)}`), "None."),
    "## Completion rule",
    "Nothing here holds chats, memory, keys or passwords. Routines arrive paused, and each app is connected with the person's own account.",
  ].join("\n\n");
}

/** The folder for a package: the manifest named for its scope, one SKILL.md per skill and one file per picture. */
export function writeShareFolder(document: PackageDocument, scope: TemplateScope): Record<string, string | Uint8Array> {
  const pkg = document.package;
  const files: Record<string, string | Uint8Array> = {};
  const agents = pkg.agents.map((agent) => {
    const avatar = agent.appearance.avatar;
    if (!avatar) return agent;
    const path = `avatars/${agent.key}.${PICTURE_EXTENSIONS[avatar.mime]}`;
    files[path] = decodeBase64(avatar.data)!;
    const { avatar: _picture, ...look } = agent.appearance;
    return { ...agent, appearance: { ...look, avatar: path, ...(avatar.crop === "circle" ? {} : { avatarCrop: avatar.crop }) } };
  });
  const skillFiles: Record<string, string[]> = {};
  for (const skill of pkg.skills?.entries ?? []) {
    files[`skills/${skill.name}/SKILL.md`] = skill.instructions;
    for (const file of skill.files ?? []) files[`skills/${skill.name}/${file.path}`] = file.content;
    if (skill.files?.length) skillFiles[skill.name] = skill.files.map((file) => file.path);
  }
  const skills = (pkg.skills?.entries ?? []).map((skill) => skill.name);
  const { skills: _skills, agents: _agents, ...rest } = pkg;
  const metadata = { botmrr: BOTMRR_FOLDER_VERSION, ...rest, agents, ...(skills.length ? { skills } : {}), ...(Object.keys(skillFiles).length ? { skillFiles } : {}) };
  files[MANIFEST_NAMES[scope]] = `---\n${stringifyYaml(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${readableBody(document, scope)}\n`;
  return files;
}
