// What a template may carry when it is published. Publish reads the template's folder again, and the bot or the person
// may have edited it since it was made, so the package is rebuilt from an allow-list: a field not named here never
// leaves this computer. Security: connections (MCP addresses and value names), a bot's connections, starter memory and
// approval level, presets, the publisher stamp and every SKILL.md frontmatter field but name and description are left
// out, and each picture loses its metadata (camera, place, time, editor) with its pixels untouched.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { PackageAgent, PackageDefinition, PackageDocument, PackageSkill } from "../shared/package-format.ts";
import { withoutPictureMetadata } from "./workspace-banner.ts";

type Picked<T> = { [K in keyof T]?: T[K] };

/** Only the named fields of `value`, those it has. */
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const out: Picked<T> = {};
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out as Pick<T, K>;
}

/** What the card's "Left out" line says for each kind of field taken off. */
const LEFT_OUT = {
  connections: "connection addresses",
  agentConnections: "the connections a bot uses",
  seed: "a bot's starter memory",
  approval: "a bot's approval level",
  presets: "preset bots",
  skillFields: "skill settings other than name and description",
  picture: "a picture that couldn't be read",
  other: "fields a template doesn't carry",
} as const;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** A SKILL.md with only `name` and `description` in its frontmatter; unchanged when that is all it has. */
function skillText(instructions: string, skill: Pick<PackageSkill, "name" | "description">): { text: string; trimmed: boolean } {
  const match = FRONTMATTER.exec(instructions);
  let meta: unknown;
  try {
    meta = match ? parseYaml(match[1]!, { maxAliasCount: 0 }) : null;
  } catch {
    meta = null;
  }
  const keys = meta && typeof meta === "object" && !Array.isArray(meta) ? Object.keys(meta) : [];
  if (match && keys.every((key) => key === "name" || key === "description")) return { text: instructions, trimmed: false };
  const body = match ? instructions.slice(match[0].length) : instructions;
  const head = stringifyYaml({ name: skill.name, description: skill.description }, { lineWidth: 0 }).trimEnd();
  return { text: `---\n${head}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`, trimmed: true };
}

/** The package as it may be published, and what was taken off it, in words for the card. */
export function publicTemplate(document: PackageDocument): { document: PackageDocument; leftOut: string[] } {
  const pkg = document.package;
  const left = new Set<string>();
  const known = new Set<string>(["id", "release", "name", "tagline", "summary", "notes", "category", "author", "license", "featured", "tags", "outcomes",
    "setupMinutes", "requirements", "team", "agents", "rooms", "routines", "playbooks", "skills", "examples"]);
  if (pkg.connections?.length) left.add(LEFT_OUT.connections);
  if (pkg.presets?.length) left.add(LEFT_OUT.presets);
  if (Object.keys(pkg).some((key) => !known.has(key) && key !== "connections" && key !== "presets")) left.add(LEFT_OUT.other);
  if (pkg.author.url) left.add(LEFT_OUT.other);

  const agents = pkg.agents.map((agent): PackageAgent => {
    if (agent.connections?.length) left.add(LEFT_OUT.agentConnections);
    if (agent.seed) left.add(LEFT_OUT.seed);
    if (agent.approval) left.add(LEFT_OUT.approval);
    const { avatar, ...look } = agent.appearance;
    let picture = avatar;
    if (avatar) {
      const clean = withoutPictureMetadata(Buffer.from(avatar.data, "base64"));
      if (clean) picture = { ...avatar, data: clean.toString("base64") };
      else { picture = undefined; left.add(LEFT_OUT.picture); }
    }
    return {
      ...pick(agent, ["key", "name", "title", "description", "soul", "recordBrowserSteps", "playbooks", "skills"]),
      appearance: { ...pick(look, ["color", "mascotExpression", "mascotBody"]), ...(picture ? { avatar: pick(picture, ["mime", "data", "crop"]) } : {}) },
      ...(agent.tools?.off.length ? { tools: { off: [...agent.tools.off] } } : {}),
    } as PackageAgent;
  });

  const skills = pkg.skills && {
    version: pkg.skills.version,
    entries: pkg.skills.entries.map((skill) => {
      const { text, trimmed } = skillText(skill.instructions, skill);
      if (trimmed || skill.source || skill.license || skill.compatibility) left.add(LEFT_OUT.skillFields);
      return { ...pick(skill, ["name", "description", "files"]), instructions: text } as PackageSkill;
    }),
  };

  const definition = {
    ...pick(pkg, ["id", "release", "name", "tagline", "summary", "notes", "category", "license", "featured", "tags", "outcomes", "setupMinutes"]),
    author: { name: pkg.author.name },
    requirements: {
      apps: pkg.requirements.apps.map((app) => pick(app, ["slug", "label", "reason", "optional"])),
      capabilities: [...pkg.requirements.capabilities],
      ...(pkg.requirements.platforms ? { platforms: [...pkg.requirements.platforms] } : {}),
    },
    ...(pkg.team ? { team: pick(pkg.team, ["name", "brief", "leader"]) } : {}),
    agents,
    ...(pkg.rooms ? { rooms: pkg.rooms.map((room) => ({ ...pick(room, ["key", "name", "members", "bulletin"]),
      defaultResponder: pick(room.defaultResponder as { kind: "agent"; agent: string }, ["kind", "agent"]) })) } : {}),
    ...(pkg.routines ? { routines: pkg.routines.map((routine) => pick(routine, ["key", "name", "agent", "room", "prompt", "runOn", "schedule",
      "durationMinutes", "timeoutMinutes", "overlap", "continuity", "runOnStartup", "enabledAfterInstall"])) } : {}),
    ...(pkg.playbooks ? { playbooks: pkg.playbooks.map((playbook) => pick(playbook, ["key", "name", "summary", "triggers", "instructions"])) } : {}),
    ...(skills ? { skills } : {}),
    ...(pkg.examples ? { examples: pkg.examples.map((example) => pick(example, ["title", "input", "output"])) } : {}),
  } as PackageDefinition;
  return { document: { format: document.format, version: document.version, package: definition }, leftOut: [...left] };
}
