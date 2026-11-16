// What a template brings, as its Details sheet and Import's preview show it. Pure: the server builds it for a folder it
// read, and the renderer for a gallery team it fetched.
import type { PackageDocument } from "./package-format.ts";
import type { TemplateDetails, TemplateScope } from "./share-card.ts";

const picture = (avatar: { mime: string; data: string } | undefined) => avatar ? `data:${avatar.mime};base64,${avatar.data}` : undefined;

export function packageDetails(document: PackageDocument, scope?: TemplateScope): TemplateDetails {
  const pkg = document.package;
  const names = new Map(pkg.agents.map((agent) => [agent.key, agent.name]));
  const referenced = new Set(pkg.agents.flatMap((agent) => agent.skills ?? []));
  return {
    scope: scope ?? (pkg.agents.length === 1 && !pkg.rooms?.length ? "bot" : "department"),
    name: pkg.name,
    tagline: pkg.tagline,
    summary: pkg.summary,
    bots: pkg.agents.map((agent) => {
      const shown = picture(agent.appearance.avatar);
      return {
        key: agent.key, name: agent.name, color: agent.appearance.color, skills: agent.skills ?? [],
        ...(agent.title ? { title: agent.title } : {}),
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.soul ? { instructions: agent.soul } : {}),
        ...(shown ? { picture: shown } : {}),
        ...(pkg.team?.leader === agent.key ? { lead: true } : {}),
      };
    }),
    skills: (pkg.skills?.entries ?? []).filter((skill) => referenced.has(skill.name) || !pkg.agents.length)
      .map((skill) => ({ name: skill.name, description: skill.description })),
    routines: (pkg.routines ?? []).map((routine) => ({ name: routine.name, bot: names.get(routine.agent) ?? routine.agent, prompt: routine.prompt })),
    apps: [
      ...pkg.requirements.apps.map((app) => ({ label: app.label, reason: app.reason })),
      ...(pkg.connections ?? []).map((connection) => ({ label: connection.label, reason: connection.reason })),
    ],
    groupChats: (pkg.rooms ?? []).map((room) => ({ name: room.name, members: room.members.map((key) => names.get(key) ?? key) })),
    ...(pkg.team?.brief?.trim() ? { brief: pkg.team.brief } : {}),
  };
}

/** A legacy team file (`openmaus.team`) as details; null when the value is not one. */
export function manifestDetails(value: unknown): TemplateDetails | null {
  const team = (value as { format?: unknown; team?: { name?: unknown; description?: unknown; members?: unknown } } | null);
  if (team?.format !== "openmaus.team" || typeof team.team?.name !== "string" || !Array.isArray(team.team.members) || !team.team.members.length) return null;
  const members = team.team.members.flatMap((member: unknown, index: number) => {
    const entry = member as { key?: unknown; name?: unknown; title?: unknown; description?: unknown; appearance?: { color?: unknown } } | null;
    if (typeof entry?.name !== "string" || !entry.name.trim()) return [];
    return [{
      key: typeof entry.key === "string" ? entry.key : String(index),
      name: entry.name.trim(),
      color: typeof entry.appearance?.color === "string" ? entry.appearance.color : "cyan",
      skills: [],
      ...(typeof entry.title === "string" && entry.title.trim() ? { title: entry.title.trim() } : {}),
      ...(typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim() } : {}),
    }];
  });
  const description = typeof team.team.description === "string" ? team.team.description.trim() : "";
  return {
    scope: "department", name: team.team.name.trim(), tagline: description, ...(description ? { summary: description } : {}),
    bots: members, skills: [], routines: [], apps: [], groupChats: [],
  };
}
