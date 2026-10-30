import { CLASSIC_ROLE_IDS, readyBot } from "./ready-bots";

export interface BotRole {
  id: string;
  name: string;
  title: string;
  description: string;
  soul: string;
  apps: string[];
}

export const BOT_ROLES: BotRole[] = CLASSIC_ROLE_IDS.map((id) => {
  const { name, title, description, soul, apps } = readyBot(id)!;
  return { id, name, title, description, soul, apps };
});

export function botRole(id: string): BotRole | undefined {
  return BOT_ROLES.find((role) => role.id === id);
}

export function roleProfilePatch(role: BotRole): {
  name: string;
  title: string;
  description: string;
  soul: string;
} {
  return {
    name: role.name,
    title: role.title,
    description: role.description,
    soul: role.soul,
  };
}
