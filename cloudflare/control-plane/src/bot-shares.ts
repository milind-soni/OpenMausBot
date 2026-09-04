import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ControlPlaneAuth } from "./auth";
import { accountSession } from "./auth";
import { HTTPError, json, readBoundedJSONWithLimit } from "./http";

export const BOT_SHARE_PACKAGE_MAX_BYTES = 1_000_000;
export const BOT_SHARE_MAX_PER_OWNER = 100;
export const BOT_SHARE_MAX_VERSIONS = 50;
// JSON.stringify can turn one UTF-8 input byte containing a JSON control
// character into a six-byte `\u00XX` escape. Keep the canonical package cap
// unchanged, but leave enough transport budget for the worst legal JSON
// representation plus the fixed envelope and optional visibility field.
const BOT_SHARE_JSON_ESCAPE_MAX_BYTES_PER_INPUT_BYTE = 6;
const BOT_SHARE_PUBLISH_BODY_FIXED_BYTES = new TextEncoder().encode(
  JSON.stringify({ packageMarkdown: "", visibility: "private" }),
).byteLength;
export const BOT_SHARE_PUBLISH_BODY_MAX_BYTES =
  BOT_SHARE_PACKAGE_MAX_BYTES * BOT_SHARE_JSON_ESCAPE_MAX_BYTES_PER_INPUT_BYTE +
  BOT_SHARE_PUBLISH_BODY_FIXED_BYTES;

const COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"] as const;

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.union([z.string(), z.null(), z.undefined()])
  .transform((value) => value?.trim() || undefined)
  .refine((value) => value === undefined || value.length <= max)
  .optional();
const key = requiredText(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
const packageDefinitionSchema = z.object({
  id: requiredText(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  release: requiredText(30).regex(/^\d+\.\d+\.\d+$/),
  name: requiredText(100),
  tagline: requiredText(160),
  summary: requiredText(2_000),
  category: requiredText(80),
  author: z.object({ name: requiredText(100), url: optionalText(500) }),
  license: requiredText(80),
  featured: z.boolean().optional(),
  tags: z.array(requiredText(80)).max(30).optional(),
  outcomes: z.array(requiredText(240)).min(1).max(12),
  setupMinutes: z.number().int().min(1).max(240),
  requirements: z.object({
    apps: z.array(z.object({
      slug: key,
      label: requiredText(100),
      reason: requiredText(240),
      optional: z.boolean().optional(),
    })).max(30),
    capabilities: z.array(requiredText(80)).max(20),
    platforms: z.array(requiredText(80)).max(10).optional(),
  }),
  agents: z.array(z.object({
    key,
    name: requiredText(100),
    title: optionalText(200),
    description: optionalText(4_000),
    appearance: z.object({
      color: z.enum(COLORS),
      mascotExpression: optionalText(80),
      mascotBody: optionalText(40),
    }),
    playbooks: z.array(key).max(40).optional(),
  })).min(1).max(200),
  chiefOfStaff: key.optional(),
  rooms: z.array(z.object({
    key,
    name: requiredText(100),
    members: z.array(key).min(1).max(200),
    bulletin: optionalText(12_000),
    defaultResponder: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("agent"), agent: key }),
      z.object({ kind: z.literal("everyone") }),
      z.object({ kind: z.literal("mentions") }),
    ]),
  })).max(30).optional(),
  routines: z.array(z.object({
    key,
    name: requiredText(80),
    agent: key,
    prompt: requiredText(20_000),
    runOn: z.enum(["maus", "cloud"]),
    schedule: z.discriminatedUnion("type", [
      z.object({ type: z.literal("once"), at: z.number().int() }),
      z.object({
        type: z.literal("daily"),
        time: requiredText(5).regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      }),
    ]),
    durationMinutes: z.number().int().min(15).max(240),
    enabledAfterInstall: z.literal(false),
  })).max(50).optional(),
  playbooks: z.array(z.object({
    key,
    name: requiredText(100),
    summary: requiredText(300),
    triggers: z.array(requiredText(100)).min(1).max(30),
    instructions: requiredText(24_000),
  })).max(80).optional(),
  examples: z.array(z.object({
    title: requiredText(120),
    input: requiredText(4_000),
    output: requiredText(8_000),
  })).max(12).optional(),
});
type PackageDefinition = z.infer<typeof packageDefinitionSchema>;
const packageFrontmatterSchema = packageDefinitionSchema.extend({ botmrr: z.literal(1) });

function unique(values: string[]): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error("duplicate package key");
  return result;
}

function parsePackageMarkdown(markdown: string): PackageDefinition {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error("missing frontmatter");
  const metadata: unknown = parseYaml(frontmatter[1]);
  for (const heading of ["Activation", "Mission", "Outcomes", "Connections", "Team", "Chief of Staff", "Completion rule"]) {
    if (!markdown.includes(`## ${heading}`)) throw new Error("missing required section");
  }
  const parsedFrontmatter = packageFrontmatterSchema.parse(metadata);
  const pkg = packageDefinitionSchema.parse(parsedFrontmatter);
  const agents = unique(pkg.agents.map((agent) => agent.key));
  const playbooks = unique((pkg.playbooks ?? []).map((playbook) => playbook.key));
  unique((pkg.rooms ?? []).map((room) => room.key));
  unique((pkg.routines ?? []).map((routine) => routine.key));
  if (pkg.chiefOfStaff && !agents.has(pkg.chiefOfStaff)) throw new Error("unknown chief of staff");
  for (const agent of pkg.agents) {
    for (const playbook of agent.playbooks ?? []) if (!playbooks.has(playbook)) throw new Error("unknown playbook");
  }
  for (const room of pkg.rooms ?? []) {
    const members = unique(room.members);
    for (const member of members) if (!agents.has(member)) throw new Error("unknown room member");
    if (room.defaultResponder.kind === "agent" && !members.has(room.defaultResponder.agent)) {
      throw new Error("unknown default responder");
    }
  }
  for (const routine of pkg.routines ?? []) if (!agents.has(routine.agent)) throw new Error("unknown routine agent");
  return pkg;
}

const list = (values: string[]) => values.map((value) => `- ${value}`).join("\n");

function renderPackageMarkdown(pkg: PackageDefinition): string {
  const frontmatter = stringifyYaml({ botmrr: 1, ...pkg }, { lineWidth: 0 }).trim();
  const agents = pkg.agents.map((agent) => [
    `### ${agent.name} — ${agent.title || "Specialist"}`,
    `**Role key:** \`${agent.key}\``,
    agent.playbooks?.length ? `**Use these playbooks:** ${agent.playbooks.map((value) => `\`${value}\``).join(", ")}` : "",
    "",
    agent.description,
  ].filter(Boolean).join("\n\n")).join("\n\n");
  const rooms = (pkg.rooms ?? []).map((room) => [
    `### ${room.name}`,
    `**Members:** ${room.members.map((value) => `\`${value}\``).join(", ")}`,
    `**Default responder:** ${room.defaultResponder.kind === "agent" ? `\`${room.defaultResponder.agent}\`` : room.defaultResponder.kind}`,
    "",
    room.bulletin,
  ].join("\n\n")).join("\n\n");
  const routines = (pkg.routines ?? []).map((routine) => [
    `### ${routine.name}`,
    `**Owner:** \`${routine.agent}\`  `,
    `**Schedule:** ${routine.schedule.type === "daily" ? `${routine.schedule.time} on weekdays ${routine.schedule.weekdays.join(", ")}` : `once at ${routine.schedule.at}`}  `,
    "**Initial state:** paused — the user must enable it",
    "",
    routine.prompt,
  ].join("\n")).join("\n\n");
  const playbooks = (pkg.playbooks ?? []).map((playbook) => [
    `### ${playbook.name}`,
    `**Playbook key:** \`${playbook.key}\`  `,
    `**Use when:** ${playbook.triggers.join(", ")}`,
    "",
    playbook.summary,
    "",
    playbook.instructions,
  ].join("\n")).join("\n\n");
  const examples = (pkg.examples ?? []).map((example) => [
    `### ${example.title}`,
    "**Ask**",
    "",
    example.input,
    "",
    "**Expected result**",
    "",
    example.output,
  ].join("\n")).join("\n\n");
  const connections = pkg.requirements.apps.length
    ? pkg.requirements.apps.map((app) => `- **${app.label}${app.optional ? " (optional)" : ""}:** ${app.reason}`).join("\n")
    : "- No connected apps are required.";
  return `---\n${frontmatter}\n---\n\n# ${pkg.name}\n\n${pkg.tagline}\n\n> **Give this file to your Chief of Staff.** It is the complete team blueprint. Any agent system can run it; OpenMausBot can also install it directly.\n\n## Activation\n\nYou are the Chief of Staff for this blueprint. Read the whole document before acting. Confirm the user's goal and any missing inputs, then create or delegate to the specialist roles below. Preserve their names, ownership, boundaries, shared-room rules, and playbooks. If your platform cannot literally spawn agents, perform the roles one at a time and keep their outputs clearly separated.\n\nNever request pasted passwords or secret keys. Use the platform's normal connection flow. Do not send messages, publish content, spend money, delete data, or enable a schedule without the user's explicit approval. All routines start paused.\n\n## Mission\n\n${pkg.summary}\n\n## Outcomes\n\n${list(pkg.outcomes)}\n\n## Connections\n\n${connections}\n\n## Team\n\n${agents}\n\n## Chief of Staff\n\nThe Chief of Staff role is \`${pkg.chiefOfStaff ?? pkg.agents[0].key}\`. This role owns delegation, synthesis, conflict resolution, and the final answer to the user.\n${rooms ? `\n## Shared rooms\n\n${rooms}\n` : ""}${routines ? `\n## Suggested routines\n\n${routines}\n` : ""}${playbooks ? `\n## Playbooks\n\n${playbooks}\n` : ""}${examples ? `\n## Example job\n\n${examples}\n` : ""}\n## Completion rule\n\nReturn one clear result to the user, distinguish evidence from inference, cite source links when the work uses external material, and state what still needs human approval or a connected app.\n`;
}

const SHARE_ID = /^[A-Za-z0-9_-]{21}$/;
const visibilitySchema = z.enum(["unlisted", "private"]);
const publishSchema = z.strictObject({ packageMarkdown: z.string().min(1), visibility: visibilitySchema.optional() });
const updateSchema = z.strictObject({ packageMarkdown: z.string().min(1), expectedActiveVersion: z.number().int().min(1) });
const visibilityPatchSchema = z.strictObject({ visibility: visibilitySchema });

interface ShareRow {
  id: string;
  visibility: "unlisted" | "private";
  active_version: number;
  created_at: number;
  updated_at: number;
  name: string;
  summary: string;
  package_sha256: string;
  package_bytes: number;
  version_created_at: number;
}

interface PublicShareRow extends ShareRow { package_markdown: string; }

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function newShareId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64URL(bytes).slice(0, 21);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function packageSnapshot(markdown: string) {
  if (new TextEncoder().encode(markdown).byteLength > BOT_SHARE_PACKAGE_MAX_BYTES) throw new HTTPError(413, "package_too_large");
  let parsed: PackageDefinition;
  try { parsed = parsePackageMarkdown(markdown); } catch { throw new HTTPError(400, "invalid_package"); }
  const canonicalMarkdown = renderPackageMarkdown(parsed);
  const packageBytes = new TextEncoder().encode(canonicalMarkdown).byteLength;
  if (packageBytes > BOT_SHARE_PACKAGE_MAX_BYTES) throw new HTTPError(413, "package_too_large");
  return {
    markdown: canonicalMarkdown,
    name: parsed.name,
    summary: parsed.summary,
    bytes: packageBytes,
    sha256: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalMarkdown))),
  };
}

async function requireAccount(request: Request, auth: ControlPlaneAuth) {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  return session;
}

function shareJSON(row: ShareRow, baseURL: string) {
  return {
    id: row.id, visibility: row.visibility, activeVersion: row.active_version,
    name: row.name, summary: row.summary, sha256: row.package_sha256,
    byteSize: row.package_bytes, createdAt: row.created_at, updatedAt: row.updated_at,
    versionCreatedAt: row.version_created_at, shareUrl: `${baseURL}/s/${row.id}`,
    packageUrl: `${baseURL}/v1/bot-shares/${row.id}/package`,
  };
}

const activeShareSelect = `
  SELECT s.id, s.visibility, s.active_version, s.created_at, s.updated_at,
         v.name, v.summary, v.package_sha256, v.package_bytes,
         v.created_at AS version_created_at
    FROM bot_shares s
    JOIN bot_share_versions v ON v.share_id = s.id AND v.version = s.active_version`;

async function ownedShare(shareId: string, ownerUserId: string, env: Env): Promise<ShareRow | null> {
  if (!SHARE_ID.test(shareId)) return null;
  return env.DB.prepare(`${activeShareSelect} WHERE s.id = ? AND s.owner_user_id = ? AND s.deleted_at IS NULL`)
    .bind(shareId, ownerUserId).first<ShareRow>();
}

export async function listBotShares(request: Request, env: Env, auth: ControlPlaneAuth, baseURL: string): Promise<Response> {
  const session = await requireAccount(request, auth);
  const result = await env.DB.prepare(`${activeShareSelect} WHERE s.owner_user_id = ? AND s.deleted_at IS NULL ORDER BY s.updated_at DESC, s.id ASC LIMIT 100`)
    .bind(session.user.id).all<ShareRow>();
  return json({ shares: result.results.map((row) => shareJSON(row, baseURL)) });
}

export async function createBotShare(request: Request, env: Env, auth: ControlPlaneAuth, baseURL: string): Promise<Response> {
  const session = await requireAccount(request, auth);
  const parsed = publishSchema.safeParse(await readBoundedJSONWithLimit(request, BOT_SHARE_PUBLISH_BODY_MAX_BYTES));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const snapshot = await packageSnapshot(parsed.data.packageMarkdown);
  const shareId = newShareId();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bot_shares (id, owner_user_id, visibility, active_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
        .bind(shareId, session.user.id, parsed.data.visibility ?? "unlisted", now, now),
      env.DB.prepare(`INSERT INTO bot_share_versions (share_id, version, name, summary, package_markdown, package_sha256, package_bytes, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`)
        .bind(shareId, snapshot.name, snapshot.summary, snapshot.markdown, snapshot.sha256, snapshot.bytes, now),
    ]);
  } catch (error) {
    if (error instanceof Error && /bot_share_owner_limit/i.test(error.message)) throw new HTTPError(409, "share_limit_reached");
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new HTTPError(409, "share_id_conflict");
    throw error;
  }
  const row = await ownedShare(shareId, session.user.id, env);
  if (!row) throw new Error("created bot share is missing");
  return json({ share: shareJSON(row, baseURL) }, 201);
}

export async function updateBotShare(request: Request, shareId: string, env: Env, auth: ControlPlaneAuth, baseURL: string): Promise<Response> {
  const session = await requireAccount(request, auth);
  const parsed = updateSchema.safeParse(await readBoundedJSONWithLimit(request, BOT_SHARE_PUBLISH_BODY_MAX_BYTES));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  const current = await ownedShare(shareId, session.user.id, env);
  if (!current) throw new HTTPError(404, "not_found");
  if (current.active_version !== parsed.data.expectedActiveVersion) throw new HTTPError(409, "version_conflict");
  const snapshot = await packageSnapshot(parsed.data.packageMarkdown);
  try {
    await env.DB.prepare(`INSERT INTO bot_share_versions (share_id, version, name, summary, package_markdown, package_sha256, package_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(shareId, parsed.data.expectedActiveVersion + 1, snapshot.name, snapshot.summary, snapshot.markdown, snapshot.sha256, snapshot.bytes, Date.now()).run();
  } catch (error) {
    if (error instanceof Error && /bot_share_version_limit/i.test(error.message)) throw new HTTPError(409, "version_limit_reached");
    if (error instanceof Error && /bot_share_version_conflict|UNIQUE constraint failed/i.test(error.message)) throw new HTTPError(409, "version_conflict");
    throw error;
  }
  const row = await ownedShare(shareId, session.user.id, env);
  if (!row) throw new Error("updated bot share is missing");
  return json({ share: shareJSON(row, baseURL) });
}

export async function updateBotShareVisibility(request: Request, shareId: string, env: Env, auth: ControlPlaneAuth, baseURL: string): Promise<Response> {
  const session = await requireAccount(request, auth);
  const parsed = visibilityPatchSchema.safeParse(await readBoundedJSONWithLimit(request, 16 * 1024));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  if (!SHARE_ID.test(shareId)) throw new HTTPError(404, "not_found");
  const result = await env.DB.prepare("UPDATE bot_shares SET visibility = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL")
    .bind(parsed.data.visibility, Date.now(), shareId, session.user.id).run();
  if (result.meta.changes === 0) throw new HTTPError(404, "not_found");
  const row = await ownedShare(shareId, session.user.id, env);
  if (!row) throw new Error("updated bot share is missing");
  return json({ share: shareJSON(row, baseURL) });
}

export async function deleteBotShare(request: Request, shareId: string, env: Env, auth: ControlPlaneAuth): Promise<Response> {
  const session = await requireAccount(request, auth);
  if (!SHARE_ID.test(shareId)) throw new HTTPError(404, "not_found");
  const now = Date.now();
  const result = await env.DB.prepare("UPDATE bot_shares SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL")
    .bind(now, now, shareId, session.user.id).run();
  if (result.meta.changes === 0) throw new HTTPError(404, "not_found");
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function publicShare(shareId: string, env: Env): Promise<PublicShareRow | null> {
  if (!SHARE_ID.test(shareId)) return null;
  return env.DB.prepare(`SELECT s.id, s.visibility, s.active_version, s.created_at, s.updated_at, v.name, v.summary, v.package_sha256, v.package_bytes, v.created_at AS version_created_at, v.package_markdown FROM bot_shares s JOIN bot_share_versions v ON v.share_id = s.id AND v.version = s.active_version WHERE s.id = ? AND s.visibility = 'unlisted' AND s.deleted_at IS NULL`)
    .bind(shareId).first<PublicShareRow>();
}

export async function publicBotSharePackage(shareId: string, env: Env): Promise<Response> {
  const row = await publicShare(shareId, env);
  if (!row) throw new HTTPError(404, "not_found");
  return new Response(row.package_markdown, { headers: {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `inline; filename="openmaus-${shareId}-v${row.active_version}.md"`,
    "x-content-sha256": row.package_sha256,
  }});
}

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export async function publicBotShareLanding(shareId: string, env: Env, baseURL: string): Promise<Response> {
  const row = await publicShare(shareId, env);
  if (!row) throw new HTTPError(404, "not_found");
  const packageURL = `${baseURL}/v1/bot-shares/${row.id}/package`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(row.name)} · OpenMausBot</title></head><body><main><h1>${escapeHTML(row.name)}</h1><p>${escapeHTML(row.summary)}</p><p>Version ${row.active_version}</p><p><a href="${escapeHTML(packageURL)}">Download BotMRR package</a></p><p>Import the downloaded package from Teams in OpenMausBot.</p></main></body></html>`;
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'none'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  }});
}
